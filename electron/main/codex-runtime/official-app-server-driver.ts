
import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { DETACH_FOR_TREE_KILL, killProcessTree } from '../kill-process-tree';
import { getCodexBinaryStatus, isCodexAvailable } from './binary';
import { CodexUnavailableError, CodexAuthError } from './errors';
import { getAppVersion } from '../app-version';
import { createLogger } from '../logger';
import {
  CodexLifecycleRegistry,
  detectThreadLeak,
  OFFICIAL_APP_SERVER_IDLE_SWEEP_MS,
} from './lifecycle-registry';
import type { LoadedThread } from './lifecycle-registry';
import {
  createAccumulator,
  translateEvent,
  finalizeResponse,
  approvalToWire,
  extractCodexErrorCode,
} from './official-event-translator';
import type { AppServerEvent, TurnOutcome } from './official-event-translator';
import { runOfficialPreFlight } from './windows-preflight';
import { getPipelineCodexHomeFallbackExtras } from '../codex-pipeline-config';
import type {
  CodexAvailability,
  CodexDriver,
  CodexRunHandle,
  CodexRunOptions,
  CodexRunSessionKey,
  CodexStreamCallbacks,
  CodexResponse,
  SyncCodexSession,
} from './types';

import { notifyObservedCodexCliUserAgent } from './model-capabilities';

const logger = createLogger('codex-runtime:official-app-server');

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function readElicitationQuestionId(id: unknown, params: Record<string, unknown>): string | null {
  if (typeof id === 'string' && id.startsWith('mcp_tool_call_approval_')) return id;
  const request = asRec(params['request']);
  const meta = asRec(params['meta'] ?? request['meta']);
  for (const src of [params, request, meta]) {
    const q = src['question_id'] ?? src['questionId'] ?? src['id'];
    if (typeof q === 'string' && q) return q;
  }
  return null;
}

export class CodexTurnInFlightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexTurnInFlightError';
  }
}

const DEFAULT_HARD_TIMEOUT_MS = 7_200_000;
export const APP_SERVER_HANDSHAKE_TIMEOUT_MS = 10_000;

export const DEFAULT_IDLE_TIMEOUT_MS = 1_200_000;


export interface AppServerTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (event: AppServerEvent) => void): () => void;
  onError(handler: (err: Error) => void): () => void;
  kill(reason: string): void;
  waitClosed(timeoutMs: number): Promise<boolean>;
}

export interface AppServerSpawnConfig {
  binary: string;
  cwd: string;
  env?: Record<string, string>;
  extraArgs?: string[];
}

export type AppServerTransportFactory = (
  config: AppServerSpawnConfig,
) => Promise<AppServerTransport>;


class StdioJsonRpcTransport implements AppServerTransport {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly notificationHandlers = new Set<(event: AppServerEvent) => void>();
  private readonly errorHandlers = new Set<(err: Error) => void>();
  private buffer = '';
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr.on('data', () => {
    });
    child.on('exit', (code) => {
      this.closed = true;
      const err = new CodexUnavailableError(
        `codex app-server exited (code=${String(code)})`,
      );
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      for (const h of this.errorHandlers) h(err);
    });
    child.on('error', (err) => {
      this.closed = true;
      const wrapped = new CodexUnavailableError(
        `codex app-server process error: ${err.message}`,
      );
      for (const { reject } of this.pending.values()) reject(wrapped);
      this.pending.clear();
      for (const h of this.errorHandlers) h(wrapped);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        logger.warn({ line: line.slice(0, 200) }, 'unparseable app-server line ignored');
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = msg['id'];
    if (typeof id === 'number' && this.pending.has(id)) {
      const entry = this.pending.get(id)!;
      this.pending.delete(id);
      if (msg['error']) {
        const errObj = msg['error'] as { message?: string };
        entry.reject(new Error(errObj.message ?? 'app-server JSON-RPC error'));
      } else {
        entry.resolve(msg['result']);
      }
      return;
    }
    const method = typeof msg['method'] === 'string' ? (msg['method'] as string) : '';
    if (!method) return;
    if (msg['id'] !== undefined && msg['result'] === undefined && msg['error'] === undefined) {
      this.replyToServerRequest(msg['id'], method, asRec(msg['params']));
      return;
    }
    const event: AppServerEvent = {
      method,
      params: (msg['params'] as Record<string, unknown>) ?? {},
    };
    for (const h of this.notificationHandlers) h(event);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new CodexUnavailableError('app-server transport closed'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        reject(new CodexUnavailableError(`app-server write failed: ${(err as Error).message}`));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {
    }
  }

  private respond(id: unknown, result: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    } catch {
    }
  }

  private replyToServerRequest(id: unknown, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'item/commandExecution/requestApproval': // CommandExecutionApprovalDecision
      case 'item/fileChange/requestApproval': // FileChangeApprovalDecision
        this.respond(id, { decision: 'acceptForSession' });
        return;

      case 'item/permissions/requestApproval': {
        const requested = asRec(params['permissions']);
        this.respond(id, {
          permissions: Object.keys(requested).length > 0 ? requested : { network: { enabled: true } },
          scope: 'session',
        });
        return;
      }

      case 'execCommandApproval':
      case 'applyPatchApproval':
      case 'exec_approval_request':
      case 'apply_patch_approval_request':
        this.respond(id, { decision: 'approved' });
        return;

      case 'mcpServer/elicitation/request':
      case 'elicitation/create': {
        const request = asRec(params['request']);
        const meta = asRec(params['meta'] ?? request['meta']);
        const questionId = readElicitationQuestionId(id, params);
        if (meta['codex_approval_kind'] === 'mcp_tool_call' && questionId) {
          this.respond(id, { action: 'accept', content: { [questionId]: 'Allow' } });
        } else {
          this.respond(id, { action: 'decline', content: null });
        }
        return;
      }

      case 'item/tool/requestUserInput':
        this.respond(id, { answers: {} });
        return;

      default:
        logger.warn({ method }, 'unhandled server-initiated app-server request; replied empty result');
        this.respond(id, {});
        return;
    }
  }

  onNotification(handler: (event: AppServerEvent) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onError(handler: (err: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  kill(reason: string): void {
    if (this.closed) return;
    logger.info({ reason }, 'killing codex app-server process');
    killProcessTree(this.child, 'SIGKILL');
  }

  waitClosed(timeoutMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

export const defaultTransportFactory: AppServerTransportFactory = async (config) => {
  const useShell =
    process.platform === 'win32' && config.binary.toLowerCase().endsWith('.cmd');
  const child = spawn(
    config.binary,
    [
      'app-server',
      '-c',
      'sandbox_workspace_write.network_access=true',
      ...(config.extraArgs ?? []),
    ],
    {
      cwd: config.cwd,
      detached: DETACH_FOR_TREE_KILL,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell,
      env: { ...process.env, ...(config.env ?? {}) },
    },
  ) as ChildProcessWithoutNullStreams;
  return new StdioJsonRpcTransport(child);
};


interface TurnTimers {
  hard?: ReturnType<typeof setTimeout>;
  idle?: ReturnType<typeof setTimeout>;
}

class OfficialAppServerRunHandle implements CodexRunHandle {
  public readonly key: CodexRunSessionKey;
  public readonly implementation = 'official-app-server' as const;
  public threadId: string | null = null;
  public turnId: string | null = null;
  public status: CodexRunHandle['status'] = 'idle';

  public createdAt: number = Date.now();
  public lastActivityAt: number = Date.now();

  public hasStartedTurn = false;

  private turnEffort: CodexRunOptions['reasoningEffort'];
  public observedCliUserAgent: string | null = null;

  private generation = 0;
  private turnGuardHeld = false;
  private closed = false;
  private unsubscribeNotifications: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;
  private lastTransportError: Error | null = null;

  constructor(
    private readonly transport: AppServerTransport,
    private readonly opts: CodexRunOptions,
    private readonly registry: CodexLifecycleRegistry,
  ) {
    this.key = opts.key;
    this.unsubscribeError = transport.onError((err) => {
      this.lastTransportError = err;
    });
  }

  setReasoningEffort(effort: NonNullable<CodexRunOptions['reasoningEffort']>): void {
    this.turnEffort = effort;
  }

  private bumpActivity(): void {
    this.lastActivityAt = Date.now();
  }

  get sessionId(): string | null {
    return this.threadId;
  }

  async handshake(timeoutMs: number = APP_SERVER_HANDSHAKE_TIMEOUT_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const initResult = (await Promise.race([
        this.transport.request('initialize', {
          clientInfo: { name: 'LionClaw', version: getAppVersion() },
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new CodexUnavailableError('codex app-server initialize timeout')),
            timeoutMs,
          );
        }),
      ])) as Record<string, unknown> | undefined;
      const ua = typeof initResult?.['userAgent'] === 'string' ? initResult['userAgent'] : null;
      this.observedCliUserAgent = ua;
      notifyObservedCodexCliUserAgent(ua);
      this.transport.notify('initialized', {});
    } catch (err) {
      throw new CodexUnavailableError(
        `codex app-server handshake failed: ${(err as Error).message}`,
        { cause: err },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private acquireTurnGuard(entry: 'send' | 'reply'): void {
    if (this.turnGuardHeld) {
      logger.warn(
        { entry, runId: this.key.runId, threadId: this.threadId, turnId: this.turnId },
        'turno ja em andamento neste handle; segundo turno rejeitado (one-in-flight)',
      );
      throw new CodexTurnInFlightError(
        `${entry}() rejected: a turn is already in flight on this handle`,
      );
    }
    this.turnGuardHeld = true;
  }

  async send(
    prompt: string,
    cb?: CodexStreamCallbacks,
    abortSignal?: AbortSignal,
  ): Promise<CodexResponse> {
    this.acquireTurnGuard('send');
    try {
      this.rejectUnsafePolicy();
      if (this.threadId === null) {
        const startResult = (await this.transport.request('thread/start', {
          cwd: this.opts.cwd,
          sandbox: this.opts.sandbox,
          approvalPolicy: approvalToWire(this.opts.approvalPolicy),
        })) as
          | { thread?: { id?: string; sessionId?: string }; threadId?: string; thread_id?: string }
          | undefined;
        const threadId =
          startResult?.thread?.id ??
          startResult?.threadId ??
          startResult?.thread_id ??
          null;
        if (!threadId) {
          throw new CodexUnavailableError('thread/start returned no threadId');
        }
        this.threadId = threadId;
      }
      const firstInput = this.opts.systemPrompt
        ? `${this.opts.systemPrompt}\n\n${prompt}`
        : prompt;
      return await this.runTurn(firstInput, cb, abortSignal);
    } finally {
      this.turnGuardHeld = false;
    }
  }

  async reply(
    message: string,
    cb?: CodexStreamCallbacks,
    abortSignal?: AbortSignal,
  ): Promise<CodexResponse> {
    this.acquireTurnGuard('reply');
    try {
      this.rejectUnsafePolicy();
      if (this.threadId === null) {
        throw new CodexUnavailableError('reply() called before thread was started');
      }
      return await this.runTurn(message, cb, abortSignal);
    } finally {
      this.turnGuardHeld = false;
    }
  }

  private rejectUnsafePolicy(): void {
    if (
      this.opts.approvalPolicy === 'never' &&
      this.opts.sandbox === 'danger-full-access'
    ) {
      logger.info(
        { approvalPolicy: this.opts.approvalPolicy, sandbox: this.opts.sandbox },
        'LionClaw bypass: full-autonomy sandbox (never + danger-full-access) by design',
      );
    }
  }

  private async runTurn(
    input: string,
    cb?: CodexStreamCallbacks,
    abortSignal?: AbortSignal,
  ): Promise<CodexResponse> {
    const gen = this.generation;
    const acc = createAccumulator(this.threadId);
    this.status = 'running';
    this.hasStartedTurn = true; // KI-2: past the idle-window; a sibling-reap is now governed by status.
    this.bumpActivity(); // KI-2: a turn is starting; this handle is busy, never idle-reapable.

    const timers: TurnTimers = {};
    const hardMs = this.opts.timeoutMs ?? DEFAULT_HARD_TIMEOUT_MS;
    const idleMs = this.opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    return new Promise<CodexResponse>((resolve, reject) => {
      let settled = false;
      let detach: (() => void) | null = null;

      const clearTimers = (): void => {
        if (timers.hard) clearTimeout(timers.hard);
        if (timers.idle) clearTimeout(timers.idle);
        timers.hard = undefined;
        timers.idle = undefined;
      };

      const finish = (outcome: TurnOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (detach) detach();
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        this.turnId = null;
        const stale = gen !== this.generation || this.closed;
        if (outcome === 'completed') this.status = stale ? 'closed' : 'completed';
        else if (outcome === 'interrupted') this.status = stale ? 'closed' : 'interrupted';
        else if (outcome === 'failed') this.status = 'failed';
        else this.status = stale ? 'closed' : 'interrupted';
        resolve(finalizeResponse(acc, outcome));
      };

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (detach) detach();
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        this.turnId = null;
        this.status = 'failed';
        reject(err);
      };

      const armIdle = (): void => {
        if (idleMs === undefined) return;
        if (timers.idle) clearTimeout(timers.idle);
        timers.idle = setTimeout(() => {
          acc.timedOut = true;
          void this.transport
            .request('turn/interrupt', { turnId: this.turnId })
            .catch(() => undefined);
          finish('timeout');
        }, idleMs);
      };

      timers.hard = setTimeout(() => {
        acc.timedOut = true;
        void this.transport
          .request('turn/interrupt', { turnId: this.turnId })
          .catch(() => undefined);
        finish('timeout');
      }, hardMs);
      armIdle();

      const onEvent = (event: AppServerEvent): void => {
        if (gen !== this.generation) return;
        this.bumpActivity(); // KI-2: any inbound turn event marks the handle active.

        const isErrorEvent = event.method === 'error';
        const evThreadObj = event.params?.['thread'] as { id?: string } | undefined;
        const evThreadId =
          (event.params?.['threadId'] as string | undefined) ??
          (event.params?.['thread_id'] as string | undefined) ??
          evThreadObj?.id;
        if (!isErrorEvent && evThreadId && this.threadId && evThreadId !== this.threadId) {
          armIdle();
          return;
        }

        if (event.method.startsWith('item/') && this.turnId && event.params) {
          const itemTurnObj = event.params['turn'] as { id?: string } | undefined;
          const itemTid =
            itemTurnObj?.id ??
            (event.params['turnId'] as string | undefined) ??
            (event.params['turn_id'] as string | undefined);
          if (itemTid && itemTid !== this.turnId) {
            armIdle();
            return;
          }
        }

        if (event.params) {
          const turnObj = event.params['turn'] as { id?: string } | undefined;
          const tid =
            turnObj?.id ??
            (event.params['turnId'] as string | undefined) ??
            (event.params['turn_id'] as string | undefined);
          const isRootScoped = evThreadId !== undefined && evThreadId === this.threadId;
          if (tid && (isRootScoped || this.turnId === null || tid === this.turnId)) {
            this.turnId = tid;
          }
        }
        armIdle();

        translateEvent(event, acc, {
          callbacks: cb,
          onUnknownEvent: (e) =>
            logger.debug({ method: e.method }, 'unknown app-server event (audited)'),
        });

        if (event.method === 'turn/completed' || event.method === 'turn/complete') {
          const turnObj = event.params?.['turn'] as
            | { status?: string; error?: unknown }
            | undefined;
          const reported =
            turnObj?.status ??
            (event.params?.['status'] as string | undefined) ??
            'completed';
          const hasError = turnObj?.error != null;
          if (acc.authRequired || reported === 'auth_required') finish('auth_required');
          else if (acc.timedOut) finish('timeout');
          else if (reported === 'interrupted') finish('interrupted');
          else if (reported === 'failed' || reported === 'error' || hasError) {
            const errorCode = extractCodexErrorCode(event);
            if (errorCode !== undefined) acc.errorCode = errorCode;
            acc.failed = true;
            finish('failed');
          } else finish('completed');
        } else if (event.method === 'turn/failed' || event.method === 'turn/error') {
          const reason = (event.params?.['reason'] as string | undefined) ?? '';
          if (reason === 'unauthorized' || reported(event) === 'auth_required') {
            fail(new CodexAuthError(`codex app-server auth error: ${reason || 'unauthorized'}`));
          } else {
            acc.failed = true;
            finish('failed');
          }
        } else if (event.method === 'error') {
          if (event.params?.['willRetry'] === true) return;
          const errInfo = event.params?.['error'];
          const code =
            typeof errInfo === 'string'
              ? errInfo
              : errInfo && typeof errInfo === 'object'
                ? Object.keys(errInfo as Record<string, unknown>)[0]
                : undefined;
          if (code === 'unauthorized') {
            fail(new CodexAuthError('codex app-server error: unauthorized'));
          } else {
            const errorCode = extractCodexErrorCode(event);
            if (errorCode !== undefined) acc.errorCode = errorCode;
            acc.failed = true;
            finish('failed');
          }
        }
      };

      const onAbort = (): void => {
        void this.transport
          .request('turn/interrupt', { turnId: this.turnId })
          .catch(() => undefined);
        finish('interrupted');
      };

      const onErr = (err: Error): void => {
        fail(
          err instanceof CodexUnavailableError
            ? err
            : new CodexUnavailableError(err.message),
        );
      };

      const offEvent = this.transport.onNotification(onEvent);
      const offErr = this.transport.onError(onErr);
      detach = (): void => {
        offEvent();
        offErr();
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      const turnParams: Record<string, unknown> = {
        threadId: this.threadId,
        input: [{ type: 'text', text: input }],
      };
      {
        const effectiveEffort = this.turnEffort ?? this.opts.reasoningEffort;
        if (effectiveEffort) turnParams['effort'] = effectiveEffort;
      }
      if (this.opts.model) turnParams['model'] = this.opts.model;
      this.transport
        .request('turn/start', turnParams)
        .then((res) => {
          const r = res as
            | { turn?: { id?: string }; turnId?: string; turn_id?: string }
            | undefined;
          const id = r?.turn?.id ?? r?.turnId ?? r?.turn_id;
          if (id && !this.turnId) this.turnId = id;
        })
        .catch((err: Error) => {
          if (this.lastTransportError) onErr(this.lastTransportError);
          else fail(new CodexUnavailableError(`turn/start failed: ${err.message}`));
        });
    });
  }

  async interrupt(reason?: string): Promise<void> {
    if (this.turnId) {
      try {
        await this.transport.request('turn/interrupt', { turnId: this.turnId, reason });
      } catch (err) {
        logger.warn(
          { reason, turnId: this.turnId, err: (err as Error).message },
          'turn/interrupt failed',
        );
      }
    }
    this.status = 'interrupted';
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1; // invalidate late events
    this.turnGuardHeld = false;

    if (this.status === 'running') {
      await this.interrupt('close');
    }

    if (this.threadId) {
      try {
        await this.transport.request('thread/unsubscribe', { threadId: this.threadId });
      } catch (err) {
        logger.warn(
          { threadId: this.threadId, err: (err as Error).message },
          'thread/unsubscribe failed',
        );
      }
      if (this.key.ownerKind === 'pipeline') {
        try {
          await this.transport.request('thread/archive', { threadId: this.threadId });
        } catch {
        }
      }
    }

    let leaked = false;
    try {
      const list = (await this.transport.request('thread/loaded/list', {})) as
        | { threads?: LoadedThread[] }
        | LoadedThread[]
        | undefined;
      const loaded: LoadedThread[] = Array.isArray(list) ? list : list?.threads ?? [];
      const owned = this.threadId ? [this.threadId] : [];
      leaked = detectThreadLeak(loaded, owned).leaked;
    } catch {
    }

    this.transport.kill('scope-close');
    const exited = await this.transport.waitClosed(2000);
    if (this.unsubscribeNotifications) this.unsubscribeNotifications();
    if (this.unsubscribeError) this.unsubscribeError();
    this.registry.remove(this.key);

    if (leaked || !exited) {
      await this.forceKillFallback(leaked ? 'loaded-thread-leak' : 'process-did-not-exit');
    }
    this.status = 'closed';
  }

  async waitClosed(timeoutMs: number): Promise<boolean> {
    return this.transport.waitClosed(timeoutMs);
  }

  async forceKillFallback(reason: string): Promise<void> {
    const hasSiblings = this.registry.hasActiveRunsOutsideScope({
      surface: this.key.surface,
      projectId: this.key.projectId,
      ownerKind: this.key.ownerKind,
      runId: this.key.runId,
    });
    if (hasSiblings) {
      logger.warn(
        {
          reason,
          runId: this.key.runId,
          threadId: this.threadId,
          turnId: this.turnId,
          status: this.status,
        },
        'forceKillFallback skipped: out-of-scope handles share this process (SPEC-009 §6.9)',
      );
      return;
    }
    logger.warn(
      {
        reason,
        runKey: this.key,
        threadId: this.threadId,
        turnId: this.turnId,
        status: this.status,
      },
      'forceKillFallback: killing dedicated app-server process',
    );
    this.transport.kill(`force-kill:${reason}`);
    await this.transport.waitClosed(2000);
  }

  resetNow(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.turnGuardHeld = false;
    this.status = 'closed';
    this.unsubscribeNotifications?.();
    this.unsubscribeError?.();
    this.unsubscribeNotifications = null;
    this.unsubscribeError = null;
    this.registry.remove(this.key);
    this.transport.kill(`reset-now:${reason}`);
    void this.transport.waitClosed(2_000).then((exited) => {
      if (!exited) {
        logger.warn({ reason, runId: this.key.runId }, 'app-server nao saiu apos reset');
      }
    });
  }

  toSyncCodexSession(): SyncCodexSession {
    const self = this;
    return {
      get threadId(): string | null {
        return self.threadId;
      },
      send: (prompt, cb, abortSignal) => self.send(prompt, cb, abortSignal),
      reply: (message, cb, abortSignal) => self.reply(message, cb, abortSignal),
      setReasoningEffort: (effort) => self.setReasoningEffort(effort),
      close: (): void => {
        self.resetNow('sync-session-close');
      },
    };
  }
}


export class OfficialAppServerDriver implements CodexDriver {
  public readonly implementation = 'official-app-server' as const;
  private readonly registry = new CodexLifecycleRegistry();

  private idleReaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly transportFactory: AppServerTransportFactory = defaultTransportFactory,
  ) {}

  async createRun(opts: CodexRunOptions): Promise<CodexRunHandle> {
    runOfficialPreFlight(opts.cwd, opts.key.projectId, opts.key.agentId);

    const availability = await getCodexBinaryStatus();
    if (!availability.installed || !availability.binaryPath) {
      throw new CodexUnavailableError(availability.error ?? 'codex binary not found');
    }
    if (!availability.appServerSupported) {
      throw new CodexUnavailableError(
        availability.error ?? 'codex CLI does not support app-server',
      );
    }
    if (!availability.authenticated) {
      throw new CodexAuthError('codex CLI is not authenticated; run `codex login`');
    }
    const binary = availability.binaryPath;

    let spawnEnv: Record<string, string> | undefined;
    if (opts.disableGlobalMcp === true) {
      try {
        const extrasEnv = getPipelineCodexHomeFallbackExtras().env ?? {};
        spawnEnv = {};
        for (const [k, v] of Object.entries(extrasEnv)) {
          if (typeof v === 'string') spawnEnv[k] = v;
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error(
          { reason },
          'failed to prepare dedicated CODEX_HOME for disableGlobalMcp; aborting official run',
        );
        throw new CodexUnavailableError(
          `failed to isolate global MCP (dedicated CODEX_HOME): ${reason}`,
        );
      }
    }

    const transport = await this.transportFactory({
      binary,
      cwd: opts.cwd,
      env: spawnEnv,
      extraArgs: opts.extraArgs,
    });
    const handle = new OfficialAppServerRunHandle(transport, opts, this.registry);
    try {
      await handle.handshake();
    } catch (error) {
      handle.resetNow('pre-register-handshake-failed');
      await transport.waitClosed(2_000);
      if (error instanceof CodexUnavailableError) throw error;
      throw new CodexUnavailableError('codex app-server handshake failed', { cause: error });
    }
    this.reapHandles(this.registry.reapSameScope(opts.key), 'reap-on-register-same-scope');
    this.reapHandles(this.registry.reapForCap(), 'cap');
    this.registry.register(opts.key, handle);
    this.ensureIdleReaper();
    return handle;
  }

  private reapHandles(handles: CodexRunHandle[], reason: string): void {
    for (const handle of handles) {
      logger.warn(
        {
          reason,
          runId: handle.key.runId,
          surface: handle.key.surface,
          ownerKind: handle.key.ownerKind,
          status: handle.status,
        },
        'KI-2: reaping official app-server handle (killing dedicated process)',
      );
      void handle.close().catch(() => undefined);
    }
  }

  private ensureIdleReaper(): void {
    if (this.idleReaperTimer) return;
    this.idleReaperTimer = setInterval(() => {
      this.reapHandles(this.registry.reapIdle(), 'idle-reaper');
    }, OFFICIAL_APP_SERVER_IDLE_SWEEP_MS);
    (this.idleReaperTimer as unknown as { unref?: () => void }).unref?.();
  }

  toSyncCodexSession(handle: CodexRunHandle): SyncCodexSession {
    if (handle instanceof OfficialAppServerRunHandle) {
      return handle.toSyncCodexSession();
    }
    return {
      get threadId(): string | null {
        return handle.threadId;
      },
      send: (prompt, cb, abortSignal) => handle.send(prompt, cb, abortSignal),
      reply: (message, cb, abortSignal) => handle.reply(message, cb, abortSignal),
      close: (): void => {
        void handle.close();
      },
    };
  }

  hasActiveRun(scope: Partial<CodexRunSessionKey>): boolean {
    return this.registry.hasActiveRun(scope);
  }

  async closeScope(scope: Partial<CodexRunSessionKey>, reason: string): Promise<void> {
    await this.registry.closeScope(scope, reason);
  }

  resetProjectNow(projectId: string, reason: string): void {
    const handles = this.registry.takeMatching({ surface: 'pipeline', projectId });
    for (const handle of handles) {
      if (handle instanceof OfficialAppServerRunHandle) handle.resetNow(reason);
    }
  }

  async closeAll(reason: string): Promise<void> {
    const handles = this.registry.takeAll();
    const results = await Promise.allSettled(handles.map((handle) => handle.close()));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.warn(
          { reason, runId: handles[index]?.key.runId, err: String(result.reason) },
          'falha ao fechar run oficial; demais runs continuaram',
        );
      }
    });
  }

  async resetProjectFallback(projectId: string, reason: string): Promise<void> {
    await this.registry.closeScope({ surface: 'pipeline', projectId }, reason);
  }

  async isAvailable(): Promise<CodexAvailability> {
    const a = await isCodexAvailable();
    return {
      installed: a.installed,
      authenticated: a.authenticated,
      appServerSupported: a.appServerSupported,
      implementation: 'official-app-server',
      version: a.version ?? undefined,
      error: a.error,
    };
  }

  async shutdown(): Promise<void> {
    if (this.idleReaperTimer) {
      clearInterval(this.idleReaperTimer);
      this.idleReaperTimer = null;
    }
    await this.closeAll('driver-shutdown');
  }
}

export function createOfficialAppServerDriver(
  transportFactory?: AppServerTransportFactory,
): OfficialAppServerDriver {
  return new OfficialAppServerDriver(transportFactory);
}

function reported(event: AppServerEvent): string {
  return (event.params?.['status'] as string | undefined) ?? '';
}

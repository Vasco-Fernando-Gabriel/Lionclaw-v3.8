import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger';
import type {
  CliAgenticRuntime,
  CliRunHandle,
  CliStreamCallbacks,
} from '../agent-runtime/cli-agentic/contract';
import {
  buildGrokChildEnv,
  isSuccessfulGrokAuthResponse,
  inspectGrokSessionModelAttestation,
  assertGrokChildEnv,
  ensureGrokHome,
  isGrokAvailable,
  resolveGrokBinary,
  resolveGrokHome,
  GrokAuthError,
  GrokBackendError,
  GrokJsonRpcError,
  GrokProcessError,
  GrokUnavailableError,
} from '../agent-runtime/grok-availability';
import {
  createGrokAccumulator,
  finalizeGrokResponse,
  grokStopReasonOutcome,
  translateGrokSessionUpdate,
  type GrokAcpResponse,
} from './acp-translator';
import {
  defaultGrokAcpTransportFactory,
  type GrokAcpTransport,
  type GrokAcpTransportFactory,
} from './acp-transport';
import { GrokAcpLifecycleRegistry } from './lifecycle-registry';
import { stopAllGrokMcpBridges } from './mcp-http-bridge';
import { shutdownGrokConcurrency } from '../agent-runtime/grok-concurrency';
import type {
  GrokAcpNotification,
  GrokAcpRunOptions,
  GrokAcpRunSessionKey,
  GrokAcpSessionUpdate,
} from './types';

const logger = createLogger('grok-acp:driver');

export const GROK_DEFAULT_IDLE_TIMEOUT_MS = 1_200_000;
export const GROK_DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
export const GROK_DEFAULT_CANCEL_GRACE_MS = 2_000;
const GROK_DEFAULT_HARD_TIMEOUT_MS = 7_200_000;
const GROK_HANDLE_IDLE_REAP_MS = 120_000;
const GROK_HANDLE_IDLE_SWEEP_MS = 60_000;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function authMethodIds(initialize: unknown): string[] {
  const methods = record(initialize)['authMethods'];
  if (!Array.isArray(methods)) return [];
  return methods.flatMap((method) => {
    const id = record(method)['id'];
    return typeof id === 'string' ? [id] : [];
  });
}

function assertTerminalModel(terminal: unknown, expectedModel: string): void {
  const terminalRecord = record(terminal);
  const meta = record(terminalRecord['_meta']);
  const modelId = meta['modelId'];
  if (typeof modelId !== 'string' || modelId.length === 0) {
    throw new GrokBackendError('Grok terminal response did not attest the effective model.');
  }
  if (modelId !== expectedModel) {
    throw new GrokBackendError(
      `Grok terminal response selected model "${modelId}" instead of required "${expectedModel}".`,
    );
  }

  const usage = record(meta['usage']);
  const rawModelUsage = usage['modelUsage'];
  if (rawModelUsage === undefined) return;
  if (rawModelUsage === null || typeof rawModelUsage !== 'object' || Array.isArray(rawModelUsage)) {
    throw new GrokBackendError('Grok terminal usage returned invalid modelUsage attestation.');
  }
  const mismatched = Object.keys(rawModelUsage as Record<string, unknown>)
    .find((usageModel) => usageModel !== expectedModel && usageModel !== `${expectedModel}-build`);
  if (mismatched) {
    throw new GrokBackendError(
      `Grok terminal usage reported model "${mismatched}" instead of required "${expectedModel}".`,
    );
  }
}

function authErrorFrom(error: unknown, context: string): GrokAuthError | null {
  if (error instanceof GrokAuthError) return error;
  if (!(error instanceof GrokJsonRpcError)) return null;
  const data = record(error.data);
  const codes = [error.code, data['code'], data['status'], data['statusCode'], data['errorCode']]
    .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number');
  const numericAuthCode = codes.some((value) => value === 401 || value === -32001);
  const structuredText = [error.message, ...codes.map(String), JSON.stringify(error.data ?? '')].join(' ');
  const namedAuthCode = /(?:^|[^a-z])(unauthenticated|unauthorized|auth(?:entication)?[_ -]?required|token[_ -]?(?:expired|invalid)|login[_ -]?required)(?:[^a-z]|$)/i
    .test(structuredText);
  return numericAuthCode || namedAuthCode
    ? new GrokAuthError(`Grok authentication failed during ${context}.`, { cause: error })
    : null;
}

export function buildGrokAgentArgv(opts: Pick<
  GrokAcpRunOptions,
  'model' | 'effort' | 'permission' | 'sandbox' | 'nativeToolArgs'
>): string[] {
  const global = [
    '--no-auto-update',
    '--no-subagents',
    '--no-memory',
    ...(opts.sandbox ? ['--sandbox', opts.sandbox] : []),
    ...(opts.nativeToolArgs ?? []),
  ];
  const agent = [
    'agent',
    '--no-leader',
    '--model',
    opts.model,
    '--effort',
    opts.effort ?? 'high',
    ...(opts.permission?.dangerouslySkipPermissions ? ['--always-approve'] : []),
    'stdio',
  ];
  return [...global, ...agent];
}

export function buildGrokAcpRunKey(opts: GrokAcpRunOptions): GrokAcpRunSessionKey {
  const surface = opts.surface ?? 'oneshot';
  return {
    surface,
    ownerKind: opts.ownerKind ?? surface,
    runId: opts.runId ?? `grok-acp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
  };
}

function optionId(
  options: unknown,
  decision: 'allow' | 'deny',
  preferAlways = false,
): string | undefined {
  if (!Array.isArray(options)) return undefined;
  const rows = options.map(record);
  const kindMatches = decision === 'allow'
    ? preferAlways
      ? ['allow_always', 'allow-once', 'allow_once']
      : ['allow_once', 'allow-once']
    : ['reject_once', 'reject-once', 'deny_once'];
  for (const expected of kindMatches) {
    const found = rows.find((row) => row['kind'] === expected || row['optionId'] === expected);
    if (typeof found?.['optionId'] === 'string') return found['optionId'];
  }
  return undefined;
}

function canonicalToolInput(toolCall: Record<string, unknown>): {
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
} | null {
  const rawInput = record(toolCall['rawInput']);
  const variant = typeof rawInput['variant'] === 'string' ? rawInput['variant'] : '';
  const normalized = variant.replace(/[\s_-]/g, '').toLowerCase();
  if (normalized === 'usetool') {
    const qualified = rawInput['tool_name'];
    const toolUseID = toolCall['toolCallId'];
    if (typeof qualified !== 'string' || qualified.length === 0) return null;
    if (typeof toolUseID !== 'string' || toolUseID.length === 0) return null;
    const separator = qualified.indexOf('__');
    if (separator <= 0 || separator >= qualified.length - 2) return null;
    const server = qualified.slice(0, separator);
    const inner = qualified.slice(separator + 2);
    return {
      toolName: `mcp__${server}__${inner}`,
      input: { ...record(rawInput['tool_input']) },
      toolUseID,
    };
  }
  let toolName: string;
  if (/^(read|readfile)$/.test(normalized)) toolName = 'Read';
  else if (/^(write|writefile)$/.test(normalized)) toolName = 'Write';
  else if (/^(edit|searchreplace)$/.test(normalized)) toolName = 'Edit';
  else if (/^(bash|runterminalcmd)$/.test(normalized)) toolName = 'Bash';
  else if (/^(glob|listdir)$/.test(normalized)) toolName = 'Glob';
  else if (normalized === 'grep') toolName = 'Grep';
  else if (normalized === 'websearch') toolName = 'WebSearch';
  else if (normalized === 'webfetch') toolName = 'WebFetch';
  else return null;
  const toolUseID = toolCall['toolCallId'];
  if (typeof toolUseID !== 'string' || toolUseID.length === 0) return null;
  const input = { ...rawInput };
  delete input['variant'];
  const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') {
    const aliasNames = ['file_path', 'filePath', 'path'] as const;
    const aliases = aliasNames
      .filter((name) => Object.prototype.hasOwnProperty.call(input, name))
      .map((name) => input[name]);
    if (aliases.length === 0 || aliases.some((value) => !nonEmpty(value))) return null;
    if (aliases.some((value) => value !== aliases[0])) return null;
    input['file_path'] = aliases[0];
  }
  if (toolName === 'Bash' && input['command'] === undefined && typeof input['cmd'] === 'string') {
    input['command'] = input['cmd'];
  }
  if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') && !nonEmpty(input['file_path'])) {
    return null;
  }
  if (toolName === 'Write' && typeof input['content'] !== 'string') return null;
  if (toolName === 'Edit') {
    const hasReplacement = (
      typeof input['old_string'] === 'string' && typeof input['new_string'] === 'string'
    ) || (
      typeof input['oldText'] === 'string' && typeof input['newText'] === 'string'
    );
    if (!hasReplacement) return null;
  }
  if (toolName === 'Bash' && !nonEmpty(input['command'])) return null;
  if (toolName === 'Grep' && !nonEmpty(input['pattern'])) return null;
  if (toolName === 'WebSearch' && !nonEmpty(input['query'])) return null;
  if (toolName === 'WebFetch' && !nonEmpty(input['url'])) return null;
  return {
    toolName,
    input,
    toolUseID,
  };
}

export class GrokAcpRunHandle implements CliRunHandle {
  public status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed' | 'closed' = 'idle';
  public sessionId: string | null = null;
  public readonly createdAt = Date.now();
  public lastActivityAt = Date.now();
  public hasStartedTurn = false;
  private closePromise: Promise<void> | null = null;
  private generation = 0;
  private cancelSent = false;
  private activeTurnAbort: ((error: Error) => void) | null = null;
  private readonly detachTransportError: () => void;
  private readonly detachServerRequest: () => void;

  constructor(
    private readonly transport: GrokAcpTransport,
    private readonly opts: GrokAcpRunOptions,
    public readonly key: GrokAcpRunSessionKey,
    private readonly registry: GrokAcpLifecycleRegistry,
  ) {
    this.detachTransportError = transport.onError(() => undefined);
    this.detachServerRequest = transport.onServerRequest((id, method, params) => {
      void this.handleServerRequest(id, method, params);
    });
  }

  async handshake(): Promise<void> {
    const requestOptions = {
      timeoutMs: this.opts.handshakeTimeoutMs ?? GROK_DEFAULT_HANDSHAKE_TIMEOUT_MS,
      ...(this.opts.abortSignal ? { signal: this.opts.abortSignal } : {}),
    };
    let initialized: unknown;
    try {
      initialized = await this.transport.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      }, requestOptions);
    } catch (error) {
      const authError = authErrorFrom(error, 'initialize');
      if (authError) throw authError;
      if (error instanceof GrokJsonRpcError) throw error;
      throw new GrokProcessError(`Grok ACP initialize failed: ${(error as Error).message}`, { cause: error });
    }
    if (!authMethodIds(initialized).includes('cached_token')) {
      throw new GrokAuthError('Grok ACP did not advertise cached_token authentication.');
    }
    try {
      const auth = record(await this.transport.request('authenticate', {
        methodId: 'cached_token',
        _meta: { headless: true },
      }, requestOptions));
      if (!isSuccessfulGrokAuthResponse(auth)) {
        throw new GrokAuthError('Grok cached_token authentication was not accepted.');
      }
    } catch (error) {
      if (error instanceof GrokAuthError) throw error;
      if (error instanceof GrokBackendError) throw error;
      const authError = authErrorFrom(error, 'cached_token authentication');
      if (authError) throw authError;
      throw error;
    }
  }

  private async ensureSession(signal?: AbortSignal): Promise<void> {
    if (this.sessionId !== null) return;
    let rawResult: unknown;
    try {
      rawResult = await this.transport.request('session/new', {
        cwd: this.opts.workDir,
        mcpServers: this.opts.mcpServers ?? [],
      }, {
        timeoutMs: this.opts.handshakeTimeoutMs ?? GROK_DEFAULT_HANDSHAKE_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const authError = authErrorFrom(error, 'session/new');
      if (authError) throw authError;
      throw error;
    }
    const result = record(rawResult);
    const sessionId = result['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new GrokProcessError('Grok session/new returned no sessionId.');
    }
    const modelAttestation = inspectGrokSessionModelAttestation(result);
    if (modelAttestation.conflicting) {
      throw new GrokBackendError('Grok session/new returned conflicting effective model attestations.');
    }
    const effectiveModel = modelAttestation.model;
    if (effectiveModel === null) {
      throw new GrokBackendError('Grok session/new did not attest the effective model.');
    }
    if (effectiveModel !== this.opts.model) {
      throw new GrokBackendError(
        `Grok selected model "${effectiveModel}" instead of required "${this.opts.model}".`,
      );
    }
    await this.opts.attestSession?.(sessionId);
    await this.opts.assertWorkspaceUnchanged?.();
    this.sessionId = sessionId;
    this.lastActivityAt = Date.now();
  }

  private async handleServerRequest(
    id: unknown,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (method !== 'session/request_permission') {
      this.transport.respond(id, null);
      return;
    }
    const toolCall = record(params['toolCall']);
    const options = params['options'];
    const deny = (): void => {
      const selected = optionId(options, 'deny');
      if (!selected) {
        this.transport.respond(id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      this.transport.respond(id, { outcome: { outcome: 'selected', optionId: selected } });
    };

    try {
      await this.opts.assertWorkspaceUnchanged?.();

      const toolCallId = toolCall['toolCallId'];
      if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
        deny();
        return;
      }

      if (this.opts.permission?.dangerouslySkipPermissions) {
        const selected = optionId(options, 'allow', true);
        if (!selected) {
          deny();
          return;
        }
        this.transport.respond(id, { outcome: { outcome: 'selected', optionId: selected } });
        return;
      }

      const canonical = canonicalToolInput(toolCall);
      if (!canonical) {
        deny();
        return;
      }

      const guard = this.opts.permission?.canUseTool;
      if (!guard) {
        deny();
        return;
      }
      const signal = this.opts.abortSignal ?? new AbortController().signal;
      const decision = await guard(canonical.toolName, canonical.input, {
        signal,
        toolUseID: canonical.toolUseID,
        requestId: randomUUID(),
      });
      if (decision === null) {
        logger.warn(
          { toolName: canonical.toolName, toolUseID: canonical.toolUseID },
          'grok acp permission guard sem decisao (null); negado fail-closed',
        );
        deny();
        return;
      }
      if (decision.behavior !== 'allow') {
        deny();
        return;
      }
      const selected = optionId(options, 'allow');
      if (!selected) {
        deny();
        return;
      }
      this.transport.respond(id, { outcome: { outcome: 'selected', optionId: selected } });
    } catch {
      deny();
    }
  }

  async send(
    prompt: string,
    callbacks?: CliStreamCallbacks,
    abortSignal?: AbortSignal,
  ): Promise<GrokAcpResponse> {
    await this.ensureSession(abortSignal ?? this.opts.abortSignal);
    return this.runTurn(prompt, callbacks, abortSignal);
  }

  async reply(
    message: string,
    callbacks?: CliStreamCallbacks,
    abortSignal?: AbortSignal,
  ): Promise<GrokAcpResponse> {
    if (this.sessionId === null) throw new GrokProcessError('Grok reply() called before send().');
    return this.runTurn(message, callbacks, abortSignal);
  }

  private runTurn(
    prompt: string,
    callbacks?: CliStreamCallbacks,
    abortSignal?: AbortSignal,
  ): Promise<GrokAcpResponse> {
    const generation = this.generation;
    const handle = this;
    const accumulator = createGrokAccumulator();
    const sessionId = this.sessionId!;
    const idleMs = this.opts.idleTimeoutMs ?? GROK_DEFAULT_IDLE_TIMEOUT_MS;
    const hardMs = this.opts.timeoutMs ?? GROK_DEFAULT_HARD_TIMEOUT_MS;
    const cancelGraceMs = this.opts.cancelGraceMs ?? GROK_DEFAULT_CANCEL_GRACE_MS;
    this.status = 'running';
    this.hasStartedTurn = true;
    this.lastActivityAt = Date.now();
    this.cancelSent = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      let cancelRequested = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;

      const detachNotification = this.transport.onNotification(onNotification);
      const detachError = this.transport.onError((error) => fail(error));

      const cleanup = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        if (hardTimer) clearTimeout(hardTimer);
        if (cancelTimer) clearTimeout(cancelTimer);
        detachNotification();
        detachError();
        abortSignal?.removeEventListener('abort', onAbort);
        if (this.activeTurnAbort === fail) this.activeTurnAbort = null;
      };

      const fail = (error: Error): void => {
        if (settled || generation !== handle.generation) return;
        settled = true;
        cleanup();
        this.status = 'failed';
        const authError = authErrorFrom(error, 'active turn');
        reject(authError ?? (error instanceof GrokUnavailableError
          ? error
          : new GrokProcessError(error.message, { cause: error })));
      };
      this.activeTurnAbort = fail;

      const finish = async (terminal: unknown): Promise<void> => {
        if (settled || generation !== this.generation) return;
        try {
          await this.opts.assertWorkspaceUnchanged?.();
          assertTerminalModel(terminal, this.opts.model);
        } catch (error) {
          fail(error as Error);
          return;
        }
        if (settled || generation !== this.generation) return;
        const terminalRecord = record(terminal);
        const rawOutcome = grokStopReasonOutcome(terminalRecord['stopReason']);
        if (cancelRequested && rawOutcome !== 'cancelled') {
          this.transport.kill('cancel-terminal-mismatch');
          fail(new GrokProcessError(
            `Grok cancel was not confirmed: stopReason=${String(terminalRecord['stopReason'] ?? 'unknown')}`,
          ));
          return;
        }
        const outcome = rawOutcome;
        if (outcome === 'failed') {
          fail(new GrokProcessError(
            `Grok turn failed with stopReason=${String(terminalRecord['stopReason'] ?? 'unknown')}`,
          ));
          return;
        }
        settled = true;
        cleanup();
        this.status = outcome === 'cancelled' ? 'cancelled' : 'completed';
        resolve(finalizeGrokResponse(accumulator, outcome, terminal));
      };

      const sendCancel = (): void => {
        if (this.cancelSent) return;
        this.cancelSent = true;
        this.transport.notify('session/cancel', { sessionId });
      };

      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          sendCancel();
          fail(new GrokProcessError(`Grok turn idle-timeout (${idleMs}ms).`));
        }, idleMs);
        idleTimer.unref?.();
      };

      function onNotification(notification: GrokAcpNotification): void {
        if (settled || generation !== handle.generation) return;
        handle.lastActivityAt = Date.now();
        callbacks?.onActivity?.();
        if (!cancelRequested) armIdle();
        if (notification.method === 'session/update') {
          const update = record(notification.params)['update'] as GrokAcpSessionUpdate | undefined;
          if (!update) return;
          try {
            translateGrokSessionUpdate(update, accumulator, callbacks, (unknown) => {
              logger.debug({ sessionUpdate: unknown.sessionUpdate }, 'unknown Grok ACP update');
            });
          } catch (error) {
            fail(error as Error);
          }
          return;
        }
        if (notification.method === 'error' && notification.params['willRetry'] !== true) {
          const error = record(notification.params['error']);
          const code = typeof error['code'] === 'number' || typeof error['code'] === 'string'
            ? error['code']
            : undefined;
          fail(new GrokJsonRpcError(
            typeof error['message'] === 'string' ? error['message'] : 'Grok ACP error notification',
            {
              method: 'notification:error',
              ...(code !== undefined ? { code } : {}),
              ...(Object.prototype.hasOwnProperty.call(error, 'data') ? { data: error['data'] } : {}),
            },
          ));
        }
      }

      let promptStarted = false;

      const onAbort = (): void => {
        if (cancelRequested || settled) return;
        if (!promptStarted) {
          fail(new GrokUnavailableError('Grok turn aborted before session/prompt.'));
          return;
        }
        cancelRequested = true;
        sendCancel();
        if (idleTimer) clearTimeout(idleTimer);
        cancelTimer = setTimeout(() => {
          this.transport.kill('cancel-grace-timeout');
          fail(new GrokProcessError(`Grok turn did not stop within cancel grace (${cancelGraceMs}ms).`));
        }, cancelGraceMs);
        cancelTimer.unref?.();
      };

      armIdle();
      hardTimer = setTimeout(() => {
        sendCancel();
        fail(new GrokProcessError(`Grok turn hard-timeout (${hardMs}ms).`));
      }, hardMs);
      hardTimer.unref?.();

      if (abortSignal?.aborted) onAbort();
      else abortSignal?.addEventListener('abort', onAbort, { once: true });

      void Promise.resolve(this.opts.assertWorkspaceUnchanged?.())
        .then(() => {
          if (settled || abortSignal?.aborted) {
            if (!settled) onAbort();
            return;
          }
          promptStarted = true;
          return this.transport.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: prompt }],
          }).then(
            (terminal) => { void finish(terminal); },
            (error: unknown) => fail(error as Error),
          );
        }, (error: unknown) => fail(error as Error));
    });
  }

  async interrupt(_reason?: string): Promise<void> {
    if (this.sessionId === null || this.status !== 'running' || this.cancelSent) return;
    this.cancelSent = true;
    this.transport.notify('session/cancel', { sessionId: this.sessionId });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      try {
        if (this.status === 'running') {
          try { await this.interrupt('close'); } catch { /* continue teardown */ }
        }
        this.activeTurnAbort?.(new GrokProcessError('Grok run closed during an active turn.'));
        this.generation += 1;
        this.transport.kill('scope-close');
        const exited = await this.transport.waitClosed(2_000);
        if (!exited) await this.forceKillFallback('process-did-not-exit');
      } finally {
        this.detachTransportError();
        this.detachServerRequest();
        this.registry.remove(this.key);
        this.status = 'closed';
      }
    })();
    return this.closePromise;
  }

  async forceKillFallback(reason: string): Promise<void> {
    this.transport.kill(`force-kill:${reason}`);
    await this.transport.waitClosed(2_000);
  }
}

export class GrokAcpDriver implements CliAgenticRuntime {
  private readonly registry = new GrokAcpLifecycleRegistry();
  private readonly pendingCreations = new Set<Promise<CliRunHandle>>();
  private readonly creatingHandles = new Set<GrokAcpRunHandle>();
  private idleReaper: ReturnType<typeof setInterval> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(private readonly transportFactory: GrokAcpTransportFactory = defaultGrokAcpTransportFactory) {}

  async isAvailable(): Promise<{
    installed: boolean;
    authenticated: boolean;
    authMode: 'subscription' | 'none';
    version?: string;
    error?: string;
  }> {
    try {
      const availability = await isGrokAvailable();
      return {
        installed: availability.installed,
        authenticated: availability.authenticated,
        authMode: availability.authMode,
        ...(availability.version ? { version: availability.version } : {}),
        ...(availability.reason ? { error: availability.reason } : {}),
      };
    } catch (error) {
      return {
        installed: false,
        authenticated: false,
        authMode: 'none',
        error: (error as Error).message,
      };
    }
  }

  createRun(opts: GrokAcpRunOptions): Promise<CliRunHandle> {
    if (this.shuttingDown) return Promise.reject(new GrokProcessError('Grok runtime is shutting down.'));
    const creation = this.createRunInternal(opts);
    this.pendingCreations.add(creation);
    void creation.then(
      () => this.pendingCreations.delete(creation),
      () => this.pendingCreations.delete(creation),
    );
    return creation;
  }

  private async createRunInternal(opts: GrokAcpRunOptions): Promise<CliRunHandle> {
    if (opts.abortSignal?.aborted) throw new GrokUnavailableError('Grok run aborted before start.');
    ensureGrokHome();
    const binary = opts.executable ?? await resolveGrokBinary();
    if (!binary) throw new GrokUnavailableError('grok binary not found.');
    const env = opts.env ?? buildGrokChildEnv(resolveGrokHome());
    assertGrokChildEnv(env);
    const transport = await this.transportFactory({
      binary,
      args: buildGrokAgentArgv(opts),
      cwd: opts.processCwd ?? opts.workDir,
      env,
    });
    const key = buildGrokAcpRunKey(opts);
    const handle = new GrokAcpRunHandle(transport, opts, key, this.registry);
    this.creatingHandles.add(handle);
    try {
      if (this.shuttingDown) throw new GrokProcessError('Grok runtime is shutting down.');
      await handle.handshake();
      if (this.shuttingDown) throw new GrokProcessError('Grok runtime is shutting down.');
      this.registry.register(handle);
      this.ensureIdleReaper();
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    } finally {
      this.creatingHandles.delete(handle);
    }
  }

  closeMatching(scope: Partial<GrokAcpRunSessionKey>): Promise<void> {
    return this.registry.closeMatching(scope);
  }

  private ensureIdleReaper(): void {
    if (this.idleReaper) return;
    this.idleReaper = setInterval(() => {
      for (const handle of this.registry.idleHandles(GROK_HANDLE_IDLE_REAP_MS)) {
        void handle.close().catch(() => undefined);
      }
    }, GROK_HANDLE_IDLE_SWEEP_MS);
    this.idleReaper.unref?.();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      if (this.idleReaper) {
        clearInterval(this.idleReaper);
        this.idleReaper = null;
      }
      shutdownGrokConcurrency();
      await Promise.allSettled([...this.creatingHandles].map((handle) => handle.close()));
      await Promise.allSettled([...this.pendingCreations]);
      await this.registry.closeAll();
      await stopAllGrokMcpBridges();
    })().finally(() => {
      this.shuttingDown = false;
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }

  _registrySizeForTests(): number {
    return this.registry.size();
  }
}

let singleton: GrokAcpDriver | null = null;

export function getGrokAcpDriver(): GrokAcpDriver {
  singleton ??= new GrokAcpDriver();
  return singleton;
}

import {
  KimiAuthError,
  KimiUnavailableError,
  resolveKimiBinary,
  resolveKimiHome,
  buildKimiChildEnv,
  isKimiAvailable,
} from '../agent-runtime/kimi-availability';
import { getKimiModel, resolveKimiEffectiveThinking } from '../../../src/constants/kimi-models';
import {
  deriveKimiSessionDir,
  snapshotKimiWireOffsets,
  readKimiWireUsageDelta,
  type KimiWireOffsetSnapshot,
} from './wire-usage';
import { createLogger } from '../logger';
import type {
  CliRunHandle,
  CliAgenticRuntime,
  CliAgenticResponse,
  CliStreamCallbacks,
} from '../agent-runtime/cli-agentic/contract';
import {
  defaultAcpTransportFactory,
  KimiAcpJsonRpcError,
  type AcpTransport,
  type AcpTransportFactory,
} from './acp-transport';
import {
  createAccumulator,
  translateSessionUpdate,
  finalizeResponse,
  stopReasonToOutcome,
  type KimiTurnOutcome,
} from './acp-translator';
import { KimiAcpLifecycleRegistry, KIMI_ACP_IDLE_SWEEP_MS } from './acp-lifecycle-registry';
import { getKimiBridgeRegistry } from './mcp-bridge-registry';
import type {
  KimiAcpRunOptions,
  KimiAcpRunSessionKey,
  KimiAcpProfile,
  KimiAcpMcpServerEntry,
  AcpSessionUpdate,
  AcpNotification,
} from './types';
import type { AgentPermissionProfile } from '../agent-runtime/types';
import { shutdownKimiConcurrency } from '../agent-runtime/kimi-concurrency';
import { randomUUID } from 'node:crypto';

const logger = createLogger('kimi-acp:driver');

function kimiAuthErrorFrom(error: unknown, context: string): KimiAuthError | null {
  if (error instanceof KimiAuthError) return error;
  if (!(error instanceof KimiAcpJsonRpcError)) return null;
  const text = [error.message, String(error.code ?? ''), JSON.stringify(error.data ?? '')].join(' ');
  return ['401', '403', '-32001'].includes(String(error.code ?? '')) ||
    /unauthenticated|unauthorized|auth(?:entication)?[_ -]?required|token[_ -]?(?:expired|invalid)|login[_ -]?required/i.test(
      text,
    )
    ? new KimiAuthError(`Kimi authentication failed during ${context}.`)
    : null;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 1_200_000;

const DEFAULT_HARD_TIMEOUT_MS = 7_200_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
export const DEFAULT_CANCEL_GRACE_MS = 2_000;

type HandleStatus = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed' | 'closed';

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function isDeniedKimiNativeTool(title: string): boolean {
  const t = title.replace(/[\s_-]/g, '').toLowerCase();
  return t.includes('agentswarm') || t === 'swarm';
}

function rejectPermissionOption(params: Record<string, unknown>): string | undefined {
  const options = Array.isArray(params['options']) ? (params['options'] as Array<Record<string, unknown>>) : [];
  const option = options.find((item) => /reject|deny/i.test(String(item['kind'] ?? item['optionId'] ?? '')));
  return typeof option?.['optionId'] === 'string' ? option['optionId'] : undefined;
}

function allowPermissionOption(params: Record<string, unknown>, always: boolean): string | undefined {
  const options = Array.isArray(params['options']) ? (params['options'] as Array<Record<string, unknown>>) : [];
  const wanted = always ? /allow_always|approve_always/i : /allow_once|approve_once/i;
  const option = options.find((item) => wanted.test(String(item['kind'] ?? item['optionId'] ?? '')));
  return typeof option?.['optionId'] === 'string' ? option['optionId'] : undefined;
}

function permissionToolInput(params: Record<string, unknown>): {
  name: string;
  input: Record<string, unknown>;
  toolUseID: string;
} | null {
  const toolCall = asRec(params['toolCall']);
  const title = typeof toolCall['title'] === 'string' ? toolCall['title'] : '';
  const rawInput = asRec(toolCall['rawInput']);
  const variant = typeof rawInput['variant'] === 'string' ? rawInput['variant'] : title;
  const normalized = variant.replace(/[\s_-]/g, '').toLowerCase();
  let name: string;
  if (/^(read|readfile|readtextfile)$/.test(normalized)) name = 'Read';
  else if (/^(write|writefile|writetextfile)$/.test(normalized)) name = 'Write';
  else if (/^(edit|editfile|strreplace)$/.test(normalized)) name = 'Edit';
  else if (/^(bash|shell|execute|terminal)$/.test(normalized)) name = 'Bash';
  else if (/^(glob|findfiles)$/.test(normalized)) name = 'Glob';
  else if (/^(grep|search|searchfiles)$/.test(normalized)) name = 'Grep';
  else if (/^(websearch)$/.test(normalized)) name = 'WebSearch';
  else if (/^(webfetch|fetch)$/.test(normalized)) name = 'WebFetch';
  else return null;
  const toolUseID = typeof toolCall['toolCallId'] === 'string' ? toolCall['toolCallId'] : '';
  if (!toolUseID) return null;
  const input = { ...rawInput };
  delete input['variant'];
  if (name === 'Bash' && input['command'] === undefined && typeof input['cmd'] === 'string') {
    input['command'] = input['cmd'];
  }
  const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  if (name === 'Read' || name === 'Write' || name === 'Edit') {
    const aliasNames = ['file_path', 'filePath', 'path'] as const;
    const aliases = aliasNames
      .filter((alias) => Object.prototype.hasOwnProperty.call(input, alias))
      .map((alias) => input[alias]);
    if (aliases.length === 0 || aliases.some((value) => !nonEmpty(value))) return null;
    if (aliases.some((value) => value !== aliases[0])) return null;
    input['file_path'] = aliases[0];
  }
  const pathValue = input['file_path'];
  if ((name === 'Read' || name === 'Write' || name === 'Edit') && !nonEmpty(pathValue)) return null;
  if (name === 'Write' && typeof input['content'] !== 'string') return null;
  if (name === 'Edit') {
    const hasReplacement =
      (typeof input['old_string'] === 'string' && typeof input['new_string'] === 'string') ||
      (typeof input['oldText'] === 'string' && typeof input['newText'] === 'string');
    if (!hasReplacement) return null;
  }
  if (name === 'Bash' && !nonEmpty(input['command'])) return null;
  if (name === 'Grep' && !nonEmpty(input['pattern'])) return null;
  if (name === 'WebSearch' && !nonEmpty(input['query'])) return null;
  if (name === 'WebFetch' && !nonEmpty(input['url'])) return null;
  return { name, input, toolUseID };
}

function configuredCurrentValue(value: unknown, configId: string): string | undefined {
  const record = asRec(value);
  if (typeof record['currentValue'] === 'string') return record['currentValue'];
  for (const key of ['configOptions', 'options']) {
    const options = record[key];
    if (!Array.isArray(options)) continue;
    const option = options.map(asRec).find((item) => item['id'] === configId || item['configId'] === configId);
    if (typeof option?.['currentValue'] === 'string') return option['currentValue'];
  }
  return undefined;
}

function sessionConfigOption(value: Record<string, unknown>, configId: string): Record<string, unknown> {
  const options = value['configOptions'];
  if (!Array.isArray(options)) return {};
  return options.map(asRec).find((item) => item['id'] === configId) ?? {};
}

function sessionConfigValues(option: Record<string, unknown>): string[] {
  const values = option['options'];
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const candidate = asRec(value)['value'];
    return typeof candidate === 'string' ? [candidate] : [];
  });
}

export function buildKimiAcpRunKey(opts: KimiAcpRunOptions): KimiAcpRunSessionKey {
  const surface: KimiAcpRunSessionKey['surface'] = opts.surface ?? 'oneshot';
  const ownerKind: KimiAcpRunSessionKey['ownerKind'] = opts.ownerKind ?? surface;
  const runId = opts.runId ?? `kimi-acp-${randomUUID()}`;
  return {
    surface,
    ownerKind,
    runId,
    projectId: opts.projectId,
    agentId: opts.agentId,
    ownerId: opts.ownerId,
  };
}

export class KimiAcpRunHandle implements CliRunHandle {
  public sessionId: string | null = null;
  public status: HandleStatus = 'idle';
  public readonly createdAt: number = Date.now();
  public lastActivityAt: number = Date.now();
  public hasStartedTurn = false;
  private generation = 0;
  private closePromise: Promise<void> | null = null;
  private lastTransportError: Error | null = null;
  private activeTurnAbort: ((error: Error) => void) | null = null;
  private activeRequestAbort: ((error: Error) => void) | null = null;

  private readonly detachError: () => void;
  private readonly detachServerRequest: () => void;
  private readonly permission: AgentPermissionProfile;

  constructor(
    private readonly transport: AcpTransport,
    private readonly opts: KimiAcpRunOptions,
    private readonly profile: KimiAcpProfile,
    public readonly key: KimiAcpRunSessionKey,
    private readonly registry: KimiAcpLifecycleRegistry,
  ) {
    this.permission = opts.permission ?? {
      mode: 'bypassPermissions',
      dangerouslySkipPermissions: true,
    };
    this.detachError = this.transport.onError((err) => {
      this.lastTransportError = err;
    });
    this.detachServerRequest = this.transport.onServerRequest((id, method, params) =>
      this.replyToServerRequest(id, method, params),
    );
  }

  private bumpActivity(): void {
    this.lastActivityAt = Date.now();
  }

  private requestWithDeadline(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
  ): Promise<unknown> {
    const signal = this.opts.abortSignal;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.activeRequestAbort = null;
        callback();
      };
      const onAbort = (): void => finish(() => reject(new KimiUnavailableError(`${method} aborted`)));
      const timer = setTimeout(() => {
        finish(() => reject(new KimiUnavailableError(`${method} timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      this.activeRequestAbort = (error) => finish(() => reject(error));
      timer.unref?.();
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.transport.request(method, params).then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private buildMcpServers(): KimiAcpMcpServerEntry[] {
    void this.profile;
    return this.opts.mcpServers ?? [];
  }

  async handshake(): Promise<void> {
    try {
      await this.requestWithDeadline('initialize', { protocolVersion: 1, clientCapabilities: {} });
    } catch (err) {
      const authError = kimiAuthErrorFrom(err, 'initialize');
      if (authError) throw authError;
      throw new KimiUnavailableError(`kimi acp handshake failed: ${(err as Error).message}`);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionId !== null) return;
    let rawResult: unknown;
    try {
      rawResult = await this.requestWithDeadline('session/new', {
        cwd: this.opts.workDir,
        mcpServers: this.buildMcpServers(),
      });
    } catch (err) {
      const authError = kimiAuthErrorFrom(err, 'session/new');
      if (authError) throw authError;
      throw err;
    }
    const result = asRec(rawResult);
    const sessionId = result['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new KimiUnavailableError('session/new returned no sessionId');
    }
    this.sessionId = sessionId;
    const modelOption = sessionConfigOption(result, 'model');
    if (!sessionConfigValues(modelOption).includes(this.opts.model)) {
      throw new KimiUnavailableError(`kimi acp session/new nao anunciou o modelo ${this.opts.model}`);
    }
    const thinkingOption = sessionConfigOption(result, 'thinking');
    const thinkingValues = sessionConfigValues(thinkingOption);
    const thinkingCurrent =
      typeof thinkingOption['currentValue'] === 'string' ? (thinkingOption['currentValue'] as string) : undefined;
    const tieredDesired = this.opts.effectiveThinking?.envEffort;
    const desiredThinking = thinkingValues.includes('on')
      ? 'on'
      : tieredDesired && thinkingValues.includes(tieredDesired)
        ? tieredDesired
        : ['max', 'high', 'low'].find((v) => thinkingValues.includes(v));
    if (!desiredThinking) {
      throw new KimiUnavailableError(
        `kimi acp session/new nao anunciou nenhum valor de thinking utilizavel para o modelo managed (valores: ${thinkingValues.join(', ') || 'nenhum'}).`,
      );
    }
    if (thinkingCurrent !== desiredThinking) {
      let thinkingConfigured: unknown;
      try {
        thinkingConfigured = await this.requestWithDeadline('session/set_config_option', {
          sessionId,
          configId: 'thinking',
          value: desiredThinking,
        });
      } catch (err) {
        const authError = kimiAuthErrorFrom(err, 'session/set_config_option');
        if (authError) throw authError;
        throw new KimiUnavailableError(`kimi acp nao aplicou thinking=${desiredThinking}: ${(err as Error).message}`);
      }
      const confirmedThinking = configuredCurrentValue(thinkingConfigured, 'thinking');
      if (confirmedThinking !== desiredThinking) {
        throw new KimiUnavailableError(
          confirmedThinking === undefined
            ? `kimi acp nao confirmou thinking=${desiredThinking}`
            : `kimi acp selecionou thinking inesperado: ${confirmedThinking}`,
        );
      }
    }
    const bypass = this.permission.dangerouslySkipPermissions === true || this.permission.mode === 'bypassPermissions';
    const requiredMode = bypass ? 'yolo' : 'default';
    if (!sessionConfigValues(sessionConfigOption(result, 'mode')).includes(requiredMode)) {
      throw new KimiUnavailableError(`kimi acp session/new nao anunciou o permission mode ${requiredMode}.`);
    }
    let configured: unknown;
    try {
      configured = await this.requestWithDeadline('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: this.opts.model,
      });
    } catch (err) {
      const authError = kimiAuthErrorFrom(err, 'session/set_config_option');
      if (authError) throw authError;
      throw err;
    }
    const currentModel = configuredCurrentValue(configured, 'model');
    if (currentModel !== this.opts.model) {
      throw new KimiUnavailableError(
        currentModel === undefined
          ? 'kimi acp nao confirmou o modelo efetivo'
          : `kimi acp selecionou modelo inesperado: ${currentModel}`,
      );
    }

    try {
      await this.requestWithDeadline('session/set_mode', {
        sessionId,
        modeId: requiredMode,
      });
    } catch (err) {
      const authError = kimiAuthErrorFrom(err, 'session/set_mode');
      if (authError) throw authError;
      throw new KimiUnavailableError(
        `kimi acp nao aplicou o permission mode ${requiredMode}; execucao bloqueada: ${(err as Error).message}`,
      );
    }
  }

  async send(prompt: string, cb?: CliStreamCallbacks, abortSignal?: AbortSignal): Promise<CliAgenticResponse> {
    await this.ensureSession();
    return this.runTurn(prompt, cb, abortSignal);
  }

  async reply(message: string, cb?: CliStreamCallbacks, abortSignal?: AbortSignal): Promise<CliAgenticResponse> {
    if (this.sessionId === null) {
      throw new KimiUnavailableError('kimi acp reply() called before a session exists');
    }
    return this.runTurn(message, cb, abortSignal);
  }

  private runTurn(input: string, cb?: CliStreamCallbacks, abortSignal?: AbortSignal): Promise<CliAgenticResponse> {
    const gen = this.generation;
    const acc = createAccumulator(this.sessionId);
    this.status = 'running';
    this.hasStartedTurn = true;
    this.bumpActivity();

    let usageSnapshot: KimiWireOffsetSnapshot | null = null;

    const hardMs = this.opts.timeoutMs ?? DEFAULT_HARD_TIMEOUT_MS;
    const idleMs = this.opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const cancelGraceMs = this.opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;

    return new Promise<CliAgenticResponse>((resolve, reject) => {
      let settled = false;
      let cancelRequested = false;
      let promptStarted = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let hardTimer: ReturnType<typeof setTimeout> | null = null;
      let cancelTimer: ReturnType<typeof setTimeout> | null = null;
      let detachNotification: (() => void) | null = null;
      let detachTurnError: (() => void) | null = null;

      const clearTimers = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        if (hardTimer) clearTimeout(hardTimer);
        if (cancelTimer) clearTimeout(cancelTimer);
        idleTimer = null;
        hardTimer = null;
        cancelTimer = null;
      };

      const cleanup = (): void => {
        clearTimers();
        if (detachNotification) detachNotification();
        detachNotification = null;
        if (detachTurnError) detachTurnError();
        detachTurnError = null;
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        this.activeTurnAbort = null;
      };

      const finish = (outcome: KimiTurnOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.status = outcome === 'cancelled' ? 'cancelled' : 'completed';
        const usage = usageSnapshot ? readKimiWireUsageDelta(usageSnapshot) : null;
        if (usageSnapshot && usage === null) {
          logger.warn(
            { runId: this.key.runId, sessionDir: usageSnapshot.sessionDir },
            'kimi acp: wire.jsonl truncado/rotacionado durante o turno; usage not_reported',
          );
        }
        resolve(finalizeResponse(acc, outcome, usage));
      };

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.status = 'failed';
        reject(err instanceof KimiUnavailableError ? err : new KimiUnavailableError(err.message));
      };
      this.activeTurnAbort = fail;

      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        if (this.opts.swarmSupervised) return;
        idleTimer = setTimeout(() => {
          if (this.sessionId) this.transport.notify('session/cancel', { sessionId: this.sessionId });
          logger.warn(
            { runId: this.key.runId, reason: 'idle-timeout', idleMs },
            'kimi acp turn idle-timeout (no progress)',
          );
          fail(new KimiUnavailableError(`kimi acp turn idle-timeout (no progress for ${idleMs}ms)`));
        }, idleMs);
        if (typeof idleTimer.unref === 'function') idleTimer.unref();
      };

      if (!this.opts.swarmSupervised)
        hardTimer = setTimeout(() => {
          if (this.sessionId) this.transport.notify('session/cancel', { sessionId: this.sessionId });
          logger.warn({ runId: this.key.runId, reason: 'hard-timeout', hardMs }, 'kimi acp turn hard-timeout');
          fail(new KimiUnavailableError(`kimi acp turn hard-timeout (${hardMs}ms)`));
        }, hardMs);
      if (hardTimer && typeof hardTimer.unref === 'function') hardTimer.unref();
      armIdle();

      const onError = (err: Error): void => {
        if (gen !== this.generation) return;
        fail(err instanceof KimiUnavailableError ? err : new KimiUnavailableError(err.message));
      };
      detachTurnError = this.transport.onError(onError);

      const onAbort = (): void => {
        if (settled || cancelRequested) return;
        if (!promptStarted) {
          acc.cancelled = true;
          finish('cancelled');
          return;
        }
        cancelRequested = true;
        if (this.sessionId) this.transport.notify('session/cancel', { sessionId: this.sessionId });
        acc.cancelled = true;
        if (idleTimer) clearTimeout(idleTimer);
        if (hardTimer) clearTimeout(hardTimer);
        idleTimer = null;
        hardTimer = null;
        cancelTimer = setTimeout(() => {
          this.transport.kill('cancel-grace-timeout');
          fail(new KimiUnavailableError(`kimi acp turn did not stop within cancel grace (${cancelGraceMs}ms)`));
        }, cancelGraceMs);
        cancelTimer.unref?.();
      };

      const onNotification = (n: AcpNotification): void => {
        if (gen !== this.generation) return;
        this.bumpActivity();
        cb?.onActivity?.();
        if (!cancelRequested) armIdle();

        if (n.method === 'session/update') {
          const update = asRec(n.params)['update'] as AcpSessionUpdate | undefined;
          if (update) {
            translateSessionUpdate(update, acc, {
              callbacks: cb,
              onUnknownUpdate: (u) => logger.debug({ sessionUpdate: u.sessionUpdate }, 'unknown acp update (audited)'),
            });
          }
          return;
        }

        if (n.method === 'error') {
          const params = asRec(n.params);
          if (params['willRetry'] === true) {
            return;
          }
          acc.failed = true;
          const errObj = asRec(params['error']);
          const code =
            (typeof params['code'] === 'string' || typeof params['code'] === 'number'
              ? String(params['code'])
              : undefined) ??
            (typeof errObj['code'] === 'string' || typeof errObj['code'] === 'number'
              ? String(errObj['code'])
              : undefined) ??
            (typeof errObj['message'] === 'string' ? String(errObj['message']) : undefined) ??
            Object.keys(errObj)[0] ??
            'unknown';
          const wireError = new KimiAcpJsonRpcError(
            `kimi acp error notification: ${code}`,
            typeof code === 'string' || typeof code === 'number' ? code : undefined,
            params,
          );
          fail(kimiAuthErrorFrom(wireError, 'active turn') ?? new KimiUnavailableError(wireError.message));
          return;
        }
      };

      detachNotification = this.transport.onNotification(onNotification);

      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
        abortSignal.addEventListener('abort', onAbort);
      }

      usageSnapshot = this.snapshotWireOffsets();

      promptStarted = true;
      this.transport
        .request('session/prompt', {
          sessionId: this.sessionId,
          prompt: [{ type: 'text', text: input }],
        })
        .then((res) => {
          const stop = (asRec(res)['stopReason'] as string | undefined) ?? undefined;
          const outcome = stopReasonToOutcome(stop);
          if (cancelRequested && outcome !== 'cancelled') {
            this.transport.kill('cancel-terminal-mismatch');
            fail(new KimiUnavailableError(`kimi acp cancel was not confirmed: stopReason=${String(stop)}`));
            return;
          }
          if (outcome === 'failed') {
            acc.failed = true;
            fail(new KimiUnavailableError(`kimi acp turn failed: stopReason=${String(stop)}`));
          } else {
            if (outcome === 'cancelled') acc.cancelled = true;
            finish(outcome);
          }
        })
        .catch((err: Error) => {
          if (this.lastTransportError) onError(this.lastTransportError);
          else
            fail(
              kimiAuthErrorFrom(err, 'session/prompt') ??
                new KimiUnavailableError(`session/prompt failed: ${err.message}`),
            );
        });
    });
  }

  private snapshotWireOffsets(): KimiWireOffsetSnapshot | null {
    if (this.sessionId === null) return null;
    try {
      const kimiHome = resolveKimiHome();
      if (kimiHome === undefined) {
        logger.warn(
          { runId: this.key.runId },
          'kimi acp: home nao resolvido (resolveKimiHome); usage do turno ficara not_reported',
        );
        return null;
      }
      const sessionDir = deriveKimiSessionDir(kimiHome, this.opts.workDir, this.sessionId);
      const snapshot = snapshotKimiWireOffsets(sessionDir);
      if (snapshot === null) {
        logger.warn(
          { runId: this.key.runId, sessionDir },
          'kimi acp: diretorio da sessao nao encontrado no caminho derivado; usage not_reported',
        );
      }
      return snapshot;
    } catch (err) {
      logger.warn(
        { runId: this.key.runId, err: (err as Error).message },
        'kimi acp: snapshot de offsets do wire.jsonl falhou; usage not_reported',
      );
      return null;
    }
  }

  private replyToServerRequest(id: unknown, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'session/request_permission': {
        const toolCall = asRec(params['toolCall']);
        const title = typeof toolCall['title'] === 'string' ? toolCall['title'] : '';
        if (isDeniedKimiNativeTool(title)) {
          const reject = rejectPermissionOption(params);
          if (reject) {
            this.transport.respond(id, { outcome: { outcome: 'selected', optionId: reject } });
          } else {
            this.transport.respond(id, { outcome: { outcome: 'cancelled' } });
          }
          logger.info({ title }, 'kimi acp: denied native swarm tool (unsupported over ACP); kimi falls back');
          return;
        }
        const toolCallId = toolCall['toolCallId'];
        if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
          const reject = rejectPermissionOption(params);
          this.transport.respond(
            id,
            reject ? { outcome: { outcome: 'selected', optionId: reject } } : { outcome: { outcome: 'cancelled' } },
          );
          return;
        }
        const bypass =
          this.permission.dangerouslySkipPermissions === true || this.permission.mode === 'bypassPermissions';
        if (bypass) {
          const allow = allowPermissionOption(params, true);
          this.transport.respond(
            id,
            allow ? { outcome: { outcome: 'selected', optionId: allow } } : { outcome: { outcome: 'cancelled' } },
          );
          return;
        }
        const translated = permissionToolInput(params);
        if (!translated) {
          const reject = rejectPermissionOption(params);
          this.transport.respond(
            id,
            reject ? { outcome: { outcome: 'selected', optionId: reject } } : { outcome: { outcome: 'cancelled' } },
          );
          return;
        }
        if (!this.permission.canUseTool) {
          const reject = rejectPermissionOption(params);
          this.transport.respond(
            id,
            reject ? { outcome: { outcome: 'selected', optionId: reject } } : { outcome: { outcome: 'cancelled' } },
          );
          return;
        }
        const signal = this.opts.abortSignal ?? new AbortController().signal;
        void this.permission
          .canUseTool(translated.name, translated.input, {
            signal,
            toolUseID: translated.toolUseID,
            requestId: randomUUID(),
          })
          .then((decision) => {
            if (decision === null) {
              logger.warn(
                { toolName: translated.name, toolUseID: translated.toolUseID },
                'kimi acp permission guard sem decisao (null); negado fail-closed',
              );
            }
            const optionId =
              decision?.behavior === 'allow'
                ? (allowPermissionOption(params, false) ?? rejectPermissionOption(params))
                : rejectPermissionOption(params);
            this.transport.respond(
              id,
              optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } },
            );
          })
          .catch((err) => {
            logger.warn({ err: (err as Error).message }, 'kimi acp permission guard failed closed');
            const reject = rejectPermissionOption(params);
            this.transport.respond(
              id,
              reject ? { outcome: { outcome: 'selected', optionId: reject } } : { outcome: { outcome: 'cancelled' } },
            );
          });
        return;
      }
      case 'fs/read_text_file':
      case 'fs/write_text_file':
        logger.warn({ method }, 'unexpected acp fs server request under minimal caps; replied empty');
        this.transport.respond(id, {});
        return;
      default:
        if (method.startsWith('terminal/')) {
          logger.warn({ method }, 'unexpected acp terminal server request under minimal caps; replied empty');
          this.transport.respond(id, {});
          return;
        }
        logger.warn({ method }, 'unhandled acp server request; replied empty');
        this.transport.respond(id, {});
        return;
    }
  }

  async interrupt(_reason?: string): Promise<void> {
    if (this.sessionId && this.status === 'running') {
      this.transport.notify('session/cancel', { sessionId: this.sessionId });
      this.status = 'cancelled';
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      try {
        if (this.status === 'running') await this.interrupt('close');
        this.activeRequestAbort?.(new KimiUnavailableError('kimi acp run closed during an active request'));
        this.activeTurnAbort?.(new KimiUnavailableError('kimi acp run closed during an active turn'));
        this.generation += 1;
        this.transport.kill('scope-close');
        const exited = await this.transport.waitClosed(2000);
        if (this.opts.swarmSupervised) {
          while (!(await this.transport.waitClosed(60_000))) this.transport.kill('swarm-await-exit');
        }
        if (!exited) await this.forceKillFallback('process-did-not-exit');
      } finally {
        this.detachError();
        this.detachServerRequest();
        this.registry.remove(this.key, this);
        this.status = 'closed';
      }
    })();
    return this.closePromise;
  }

  async forceKillFallback(reason: string): Promise<void> {
    this.transport.kill(`force-kill:${reason}`);
    await this.transport.waitClosed(2000);
  }
}

export class KimiAcpDriver implements CliAgenticRuntime {
  private readonly registry = new KimiAcpLifecycleRegistry();
  private idleReaperTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pendingCreations = new Set<Promise<CliRunHandle>>();
  private readonly creatingHandles = new Set<KimiAcpRunHandle>();
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(private readonly transportFactory: AcpTransportFactory = defaultAcpTransportFactory) {}

  async isAvailable(): Promise<{
    installed: boolean;
    authenticated: boolean;
    authMode: 'subscription' | 'none';
    version?: string;
    error?: string;
  }> {
    try {
      const a = await isKimiAvailable();
      const usable = a.usable ?? a.authenticated;
      return {
        installed: a.installed,
        authenticated: usable,
        authMode: usable ? 'subscription' : 'none',
        version: a.version ?? undefined,
        ...(!usable
          ? { error: a.authenticated ? 'provider/modelo Kimi managed nao verificado' : 'OAuth Kimi ausente' }
          : {}),
      };
    } catch (err) {
      return {
        installed: false,
        authenticated: false,
        authMode: 'none',
        error: (err as Error).message,
      };
    }
  }

  createRun(opts: KimiAcpRunOptions): Promise<CliRunHandle> {
    if (this.shuttingDown) return Promise.reject(new KimiUnavailableError('Kimi runtime is shutting down'));
    const creation = this.createRunInternal(opts);
    this.pendingCreations.add(creation);
    void creation.then(
      () => this.pendingCreations.delete(creation),
      () => this.pendingCreations.delete(creation),
    );
    return creation;
  }

  private async createRunInternal(opts: KimiAcpRunOptions): Promise<CliRunHandle> {
    if (opts.abortSignal?.aborted) {
      throw new KimiUnavailableError('kimi acp run aborted before start');
    }
    if ((opts.profile ?? 'one-shot') === 'one-shot' && !opts.permission) {
      throw new KimiUnavailableError('kimi one-shot exige permission profile fail-closed explicito');
    }
    const metadata = getKimiModel(opts.model);
    if (!metadata) throw new KimiUnavailableError(`modelo Kimi nao suportado: ${opts.model}`);
    const availability = await isKimiAvailable(opts.model);
    if (availability.managedProviderVerified === false || availability.modelAvailable === false) {
      throw new KimiUnavailableError(`modelo Kimi nao esta disponivel no provider managed: ${opts.model}`);
    }
    const effectiveThinking = resolveKimiEffectiveThinking(opts.model, opts.effort, opts.thinking);
    const resolvedOpts: KimiAcpRunOptions = {
      ...opts,
      effectiveThinking,
    };
    const binary = opts.executable ?? (await resolveKimiBinary());
    if (!binary) {
      throw new KimiUnavailableError('kimi binary not found');
    }
    if (opts.swarmSupervised) opts.abortSignal?.throwIfAborted();
    const transport = await this.transportFactory({
      binary,
      cwd: opts.workDir,
      swarmSupervised: opts.swarmSupervised,
      swarmOwnerDirectory: opts.swarmOwnerDirectory,
      env: buildKimiChildEnv({
        overrides: opts.env,
        effort: effectiveThinking.envEffort,
        home: resolveKimiHome(),
      }),
    });
    const key = buildKimiAcpRunKey(resolvedOpts);
    const handle = new KimiAcpRunHandle(
      transport,
      resolvedOpts,
      resolvedOpts.profile ?? 'one-shot',
      key,
      this.registry,
    );
    this.creatingHandles.add(handle);
    try {
      if (this.shuttingDown) throw new KimiUnavailableError('Kimi runtime is shutting down');
      await handle.handshake();
      if (this.shuttingDown) throw new KimiUnavailableError('Kimi runtime is shutting down');
      this.reapHandles(this.registry.reapSameScope(key), 'reap-on-register-same-scope');
      this.reapHandles(this.registry.reapForCap(), 'cap');
      this.registry.register(key, handle);
      this.ensureIdleReaper();
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    } finally {
      this.creatingHandles.delete(handle);
    }
  }

  private reapHandles(handles: ReadonlyArray<{ close(): Promise<void> }>, reason: string): void {
    for (const handle of handles) {
      logger.warn({ reason }, 'KI-2: reaping kimi acp handle');
      void handle.close().catch(() => {});
    }
  }

  private ensureIdleReaper(): void {
    if (this.idleReaperTimer) return;
    this.idleReaperTimer = setInterval(() => {
      this.reapHandles(this.registry.reapIdle(), 'idle-reaper');
    }, KIMI_ACP_IDLE_SWEEP_MS);
    if (typeof this.idleReaperTimer.unref === 'function') this.idleReaperTimer.unref();
  }

  async closeMatching(scope: Partial<KimiAcpRunSessionKey>): Promise<void> {
    await Promise.allSettled(this.registry.matching(scope).map((handle) => handle.close()));
  }

  _registrySizeForTests(): number {
    return this.registry.size();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      if (this.idleReaperTimer) {
        clearInterval(this.idleReaperTimer);
        this.idleReaperTimer = null;
      }
      shutdownKimiConcurrency();
      await Promise.allSettled([...this.creatingHandles].map((handle) => handle.close()));
      await Promise.allSettled([...this.pendingCreations]);
      await Promise.allSettled(this.registry.matching({}).map((handle) => handle.close()));
      this.registry.clear();
      await getKimiBridgeRegistry().stopAll();
    })().finally(() => {
      this.shuttingDown = false;
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }
}

let cachedDriver: KimiAcpDriver | null = null;
let runtimeShutdownPromise: Promise<void> | null = null;
let runtimeShuttingDown = false;

export function getKimiAcpDriver(): KimiAcpDriver {
  if (runtimeShuttingDown) throw new KimiUnavailableError('Kimi runtime is shutting down');
  if (!cachedDriver) {
    cachedDriver = new KimiAcpDriver();
  }
  return cachedDriver;
}

export async function shutdownKimiRuntime(): Promise<void> {
  if (runtimeShutdownPromise) return runtimeShutdownPromise;
  runtimeShuttingDown = true;
  const driver = cachedDriver;
  cachedDriver = null;
  runtimeShutdownPromise = (driver ? driver.shutdown() : getKimiBridgeRegistry().stopAll()).finally(() => {
    runtimeShuttingDown = false;
    runtimeShutdownPromise = null;
  });
  return runtimeShutdownPromise;
}

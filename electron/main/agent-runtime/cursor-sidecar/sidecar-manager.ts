
import { spawn, type ChildProcess } from 'child_process';
import { createLogger } from '../../logger';
import {
  createSidecarLineDecoder,
  encodeSidecarLine,
  type CursorSidecarExecuteConfig,
  type CursorSidecarHostMessage,
  type CursorSidecarResultMessage,
} from './protocol';
import { resolveCursorSidecarEntry, resolveCursorSidecarNode } from './node-resolver';

const logger = createLogger('cursor-sidecar');

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 8_000;
const DEFAULT_HEALTH_PING_INTERVAL_MS = 15_000;
const DEFAULT_HEALTH_PONG_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 2_000;


export interface CursorToolInvocation {
  executionId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface CursorToolDispatchContext {
  signal: AbortSignal;
}

export type CursorToolDispatcher = (
  invocation: CursorToolInvocation,
  ctx: CursorToolDispatchContext,
) => Promise<string>;

export interface CursorSidecarStreamEvent {
  executionId: string;
  event: unknown;
}

export interface CursorSidecarExecutionResult {
  status: string;
  finalText: string;
  resultText?: string;
  usage?: CursorSidecarResultMessage['usage'];
  errorMessage?: string;
  errorCode?: string;
  agentId?: string;
  runId?: string;
  model?: string;
  durationMs?: number;
}

export type CursorSidecarFailureKind =
  | 'spawn-failed'
  | 'ready-timeout'
  | 'sidecar-crash'
  | 'sidecar-fatal'
  | 'health-timeout'
  | 'aborted'
  | 'execute-error';

export class CursorSidecarError extends Error {
  constructor(
    message: string,
    public readonly kind: CursorSidecarFailureKind,
  ) {
    super(message);
    this.name = 'CursorSidecarError';
  }
}

export interface CursorSidecarExecutionOptions {
  config: CursorSidecarExecuteConfig;
  abortController: AbortController;
  dispatchTool: CursorToolDispatcher;
  onEvent?: (event: CursorSidecarStreamEvent) => void;
  onStarted?: (info: { runId: string; agentId: string }) => void;
  nodePathOverride?: string;
  entryPathOverride?: string;
  readyTimeoutMs?: number;
  killGraceMs?: number;
  healthPingIntervalMs?: number;
  healthPongTimeoutMs?: number;
  extraEnv?: Record<string, string>;
}


interface ActiveSidecarEntry {
  executionId: string;
  child: ChildProcess;
}

const activeSidecars = new Map<string, ActiveSidecarEntry>();

export function getActiveCursorSidecarCount(): number {
  return activeSidecars.size;
}

export async function shutdownCursorSidecars(reason: string): Promise<void> {
  const entries = [...activeSidecars.values()];
  if (entries.length === 0) return;
  logger.info({ reason, count: entries.length }, 'Encerrando sidecars Cursor no shutdown');
  for (const entry of entries) {
    try {
      writeHostMessage(entry.child, { type: 'shutdown' });
    } catch {
    }
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
    timer.unref?.();
  });
  for (const entry of entries) {
    if (entry.child.exitCode === null && !entry.child.killed) {
      try {
        entry.child.kill();
      } catch {
      }
    }
    activeSidecars.delete(entry.executionId);
  }
}


function writeHostMessage(child: ChildProcess, msg: CursorSidecarHostMessage): void {
  if (!child.stdin || child.stdin.destroyed) return;
  child.stdin.write(encodeSidecarLine(msg));
}

export async function runCursorSidecarExecution(
  opts: CursorSidecarExecutionOptions,
): Promise<CursorSidecarExecutionResult> {
  const { config, abortController, dispatchTool } = opts;
  const executionId = config.executionId;
  const signal = abortController.signal;

  if (signal.aborted) {
    throw new CursorSidecarError(
      `Execucao cursor ${executionId} abortada antes do spawn do sidecar`,
      'aborted',
    );
  }
  if (activeSidecars.has(executionId)) {
    throw new CursorSidecarError(
      `Ja existe um sidecar vivo para a execucao ${executionId}`,
      'spawn-failed',
    );
  }

  const nodePath =
    opts.nodePathOverride ?? (await resolveCursorSidecarNode()).nodePath;
  const entryPath = opts.entryPathOverride ?? resolveCursorSidecarEntry();

  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const pingIntervalMs = opts.healthPingIntervalMs ?? DEFAULT_HEALTH_PING_INTERVAL_MS;
  const pongTimeoutMs = opts.healthPongTimeoutMs ?? DEFAULT_HEALTH_PONG_TIMEOUT_MS;

  let child: ChildProcess;
  try {
    child = spawn(nodePath, [entryPath], {
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.extraEnv ?? {}) },
      windowsHide: true,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CursorSidecarError(
      `Falha ao spawnar o sidecar Cursor (${nodePath}): ${detail}`,
      'spawn-failed',
    );
  }

  activeSidecars.set(executionId, { executionId, child });

  child.stdin?.on('error', (err) => {
    logger.debug({ executionId, err: err.message }, 'stdin do sidecar Cursor fechado');
  });

  return new Promise<CursorSidecarExecutionResult>((resolve, reject) => {
    let settled = false;
    let aborted = false;
    let readyTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let pingTimer: NodeJS.Timeout | null = null;
    let pongTimer: NodeJS.Timeout | null = null;
    let pingSeq = 0;

    const clearTimers = (): void => {
      if (readyTimer) clearTimeout(readyTimer);
      if (killTimer) clearTimeout(killTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (pongTimer) clearTimeout(pongTimer);
      readyTimer = null;
      killTimer = null;
      pingTimer = null;
      pongTimer = null;
    };

    const killSidecar = (why: string): void => {
      if (child.exitCode !== null || child.killed) return;
      logger.warn({ executionId, why }, 'Matando sidecar Cursor (ultima linha)');
      try {
        child.kill();
      } catch {
      }
    };

    const cleanup = (): void => {
      clearTimers();
      signal.removeEventListener('abort', onAbort);
      activeSidecars.delete(executionId);
      try {
        writeHostMessage(child, { type: 'shutdown' });
      } catch {
      }
      const graceTimer = setTimeout(() => killSidecar('shutdown-grace'), SHUTDOWN_GRACE_MS);
      graceTimer.unref?.();
    };

    const settleResolve = (result: CursorSidecarExecutionResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const settleReject = (error: CursorSidecarError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      killSidecar(`reject:${error.kind}`);
      reject(error);
    };

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      logger.info({ executionId }, 'Abort da execucao cursor: cancelamento RPC enviado ao sidecar');
      writeHostMessage(child, { type: 'abort', executionId, reason: 'user-abort' });
      killTimer = setTimeout(() => {
        if (settled) return;
        killSidecar('abort-grace-expired');
      }, killGraceMs);
      killTimer.unref?.();
    };

    const armPongTimeout = (): void => {
      if (pongTimer) return;
      pongTimer = setTimeout(() => {
        settleReject(
          new CursorSidecarError(
            `Sidecar Cursor da execucao ${executionId} parou de responder ao health check ` +
              `(${pongTimeoutMs}ms sem pong)`,
            'health-timeout',
          ),
        );
      }, pongTimeoutMs);
      pongTimer.unref?.();
    };

    const startHealthChecks = (): void => {
      pingTimer = setInterval(() => {
        if (settled) return;
        pingSeq += 1;
        writeHostMessage(child, { type: 'ping', id: `ping-${pingSeq}` });
        armPongTimeout();
      }, pingIntervalMs);
      pingTimer.unref?.();
    };

    const handleToolInvoke = (id: string, toolName: string, args: Record<string, unknown>): void => {
      if (aborted || signal.aborted) {
        writeHostMessage(child, { type: 'tool-result', executionId, id, error: 'session-aborted' });
        return;
      }
      void (async () => {
        try {
          const ok = await dispatchTool({ executionId, toolName, args }, { signal });
          if (aborted || signal.aborted) {
            writeHostMessage(child, {
              type: 'tool-result',
              executionId,
              id,
              error: 'session-aborted',
            });
            return;
          }
          writeHostMessage(child, { type: 'tool-result', executionId, id, ok });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const error = aborted || signal.aborted ? 'session-aborted' : message;
          writeHostMessage(child, { type: 'tool-result', executionId, id, error });
        }
      })();
    };

    const decoder = createSidecarLineDecoder(
      (raw) => {
        const type = typeof raw['type'] === 'string' ? (raw['type'] as string) : '';
        switch (type) {
          case 'ready': {
            if (readyTimer) {
              clearTimeout(readyTimer);
              readyTimer = null;
            }
            logger.debug(
              { executionId, sidecarPid: raw['pid'], nodeVersion: raw['nodeVersion'] },
              'Sidecar Cursor pronto',
            );
            writeHostMessage(child, { type: 'execute', config });
            startHealthChecks();
            break;
          }
          case 'execute-started': {
            const runId = typeof raw['runId'] === 'string' ? (raw['runId'] as string) : '';
            const agentId = typeof raw['agentId'] === 'string' ? (raw['agentId'] as string) : '';
            opts.onStarted?.({ runId, agentId });
            break;
          }
          case 'stream-event': {
            opts.onEvent?.({ executionId, event: raw['event'] });
            break;
          }
          case 'tool-invoke': {
            const id = typeof raw['id'] === 'string' ? (raw['id'] as string) : '';
            const toolName = typeof raw['toolName'] === 'string' ? (raw['toolName'] as string) : '';
            const args =
              raw['args'] && typeof raw['args'] === 'object' && !Array.isArray(raw['args'])
                ? (raw['args'] as Record<string, unknown>)
                : {};
            if (!id) break;
            handleToolInvoke(id, toolName, args);
            break;
          }
          case 'execute-result': {
            const msg = raw as unknown as CursorSidecarResultMessage;
            settleResolve({
              status: msg.status,
              finalText: msg.finalText,
              ...(msg.resultText !== undefined ? { resultText: msg.resultText } : {}),
              ...(msg.usage !== undefined ? { usage: msg.usage } : {}),
              ...(msg.errorMessage !== undefined ? { errorMessage: msg.errorMessage } : {}),
              ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
              ...(msg.agentId !== undefined ? { agentId: msg.agentId } : {}),
              ...(msg.runId !== undefined ? { runId: msg.runId } : {}),
              ...(msg.model !== undefined ? { model: msg.model } : {}),
              ...(msg.durationMs !== undefined ? { durationMs: msg.durationMs } : {}),
            });
            break;
          }
          case 'execute-error': {
            const message =
              typeof raw['message'] === 'string' ? (raw['message'] as string) : 'erro desconhecido';
            settleReject(
              new CursorSidecarError(
                `Execucao cursor ${executionId} falhou no sidecar: ${message}`,
                aborted ? 'aborted' : 'execute-error',
              ),
            );
            break;
          }
          case 'pong': {
            if (pongTimer) {
              clearTimeout(pongTimer);
              pongTimer = null;
            }
            break;
          }
          case 'fatal': {
            const message = typeof raw['error'] === 'string' ? (raw['error'] as string) : 'fatal';
            settleReject(
              new CursorSidecarError(
                `Sidecar Cursor da execucao ${executionId} reportou erro fatal: ${message}`,
                'sidecar-fatal',
              ),
            );
            break;
          }
          default:
            logger.debug({ executionId, type }, 'Mensagem desconhecida do sidecar Cursor ignorada');
        }
      },
      (line) => {
        logger.debug({ executionId, line: line.slice(0, 300) }, 'Linha nao-RPC no stdout do sidecar');
      },
    );

    child.stdout?.on('data', decoder);
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text.length > 0) logger.debug({ executionId }, `[sidecar] ${text.slice(0, 500)}`);
    });

    child.on('error', (err) => {
      settleReject(
        new CursorSidecarError(
          `Falha no processo sidecar Cursor (${nodePath}): ${err.message}`,
          'spawn-failed',
        ),
      );
    });

    child.on('exit', (code, exitSignal) => {
      activeSidecars.delete(executionId);
      if (settled) return;
      if (aborted) {
        settleReject(
          new CursorSidecarError(
            `Execucao cursor ${executionId} abortada (sidecar encerrado, code=${code}, signal=${exitSignal})`,
            'aborted',
          ),
        );
        return;
      }
      settleReject(
        new CursorSidecarError(
          `Sidecar Cursor da execucao ${executionId} morreu antes do resultado ` +
            `(code=${code}, signal=${exitSignal})`,
          'sidecar-crash',
        ),
      );
    });

    readyTimer = setTimeout(() => {
      settleReject(
        new CursorSidecarError(
          `Sidecar Cursor da execucao ${executionId} nao ficou pronto em ${readyTimeoutMs}ms`,
          'ready-timeout',
        ),
      );
    }, readyTimeoutMs);
    readyTimer.unref?.();

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function _resetCursorSidecarsForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error('_resetCursorSidecarsForTesting can only be called in test environment');
  }
  for (const entry of activeSidecars.values()) {
    try {
      entry.child.kill();
    } catch {
    }
  }
  activeSidecars.clear();
}

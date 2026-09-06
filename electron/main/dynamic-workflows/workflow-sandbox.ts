
import { createLogger } from '../logger';
import {
  parseChildMessage,
  isSafeArtifactRelativePath,
  SANDBOX_PROTOCOL_VERSION,
  type SandboxChildMessage,
  type SandboxParentMessage,
  type SandboxPrimitive,
} from './sandbox-protocol';

const logger = createLogger('dynamic-workflow-sandbox');


export interface SandboxProcessHandle {
  send(message: SandboxParentMessage): void;
  onMessage(cb: (raw: unknown) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(): void;
  readonly pid?: number;
}

export interface SandboxProcessFactory {
  spawn(): SandboxProcessHandle;
}


export interface WorkflowSandboxOptions {
  transformedSource: string;
  input?: Record<string, unknown>;
  maxPlanRounds?: number;
  maxDevRounds?: number;
  agentCatalog?: Array<{ id: string; name: string; description?: string }>;
  wallTimeoutMs?: number;
  idleTimeoutMs: number;
  factory: SandboxProcessFactory;
  handlers: WorkflowSandboxHandlers;
  onLifecycle?: (event: WorkflowSandboxLifecycleEvent) => void;
}

export type WorkflowSandboxHandlers = {
  [K in SandboxPrimitive]?: (arg: unknown) => Promise<unknown> | unknown;
};

export type WorkflowSandboxLifecycleEvent =
  | { type: 'hello' }
  | { type: 'heartbeat'; uptimeMs: number }
  | { type: 'primitive'; primitive: SandboxPrimitive }
  | { type: 'killed'; reason: WorkflowSandboxKillReason };

export type WorkflowSandboxKillReason =
  | 'wall-timeout'
  | 'idle-timeout'
  | 'protocol-violation'
  | 'crash'
  | 'parent-abort';

export type WorkflowSandboxResult =
  | { status: 'completed'; value: unknown }
  | { status: 'failed'; reason: WorkflowSandboxKillReason; message: string };

export class WorkflowSandboxError extends Error {
  readonly reason: WorkflowSandboxKillReason;
  constructor(reason: WorkflowSandboxKillReason, message: string) {
    super(message);
    this.name = 'WorkflowSandboxError';
    this.reason = reason;
  }
}


export function runWorkflowSandbox(options: WorkflowSandboxOptions): Promise<WorkflowSandboxResult> {
  const {
    transformedSource,
    input,
    maxPlanRounds,
    maxDevRounds,
    agentCatalog,
    wallTimeoutMs,
    idleTimeoutMs,
    factory,
    handlers,
    onLifecycle,
  } = options;

  return new Promise<WorkflowSandboxResult>((resolve) => {
    const child = factory.spawn();
    let settled = false;
    let helloSeen = false;

    let wallTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (wallTimer) {
        clearTimeout(wallTimer);
        wallTimer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const finish = (result: WorkflowSandboxResult, killReason?: WorkflowSandboxKillReason) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (killReason) {
        onLifecycle?.({ type: 'killed', reason: killReason });
        try {
          child.kill();
        } catch (err) {
          logger.warn({ err }, 'falha ao matar filho do sandbox (provavelmente ja morto)');
        }
      }
      resolve(result);
    };

    const killWith = (reason: WorkflowSandboxKillReason, message: string) => {
      logger.warn({ reason, message }, 'sandbox: matando filho');
      finish({ status: 'failed', reason, message }, reason);
    };

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killWith('idle-timeout', `filho sem heartbeat por ${idleTimeoutMs}ms`);
      }, idleTimeoutMs);
      if (typeof idleTimer.unref === 'function') idleTimer.unref();
    };

    if (wallTimeoutMs !== undefined) {
      wallTimer = setTimeout(() => {
        killWith('wall-timeout', `coordinator excedeu ${wallTimeoutMs}ms de wall-clock`);
      }, wallTimeoutMs);
      if (typeof wallTimer.unref === 'function') wallTimer.unref();
    }

    armIdle();

    child.onExit((code, signal) => {
      if (settled) return;
      const msg = `filho do sandbox saiu antes do resultado (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      finish({ status: 'failed', reason: 'crash', message: msg }, undefined);
    });

    child.onMessage((raw) => {
      if (settled) return;
      const msg: SandboxChildMessage | null = parseChildMessage(raw);
      if (!msg) {
        killWith('protocol-violation', 'mensagem do filho fora do protocolo allowlist');
        return;
      }
      switch (msg.t) {
        case 'hello': {
          if (msg.protocol !== SANDBOX_PROTOCOL_VERSION) {
            killWith('protocol-violation', `protocolo do filho incompativel: ${msg.protocol}`);
            return;
          }
          helloSeen = true;
          onLifecycle?.({ type: 'hello' });
          const runMsg: SandboxParentMessage = { t: 'run', transformedSource };
          if (input !== undefined) runMsg.input = input;
          if (maxPlanRounds !== undefined) runMsg.maxPlanRounds = maxPlanRounds;
          if (maxDevRounds !== undefined) runMsg.maxDevRounds = maxDevRounds;
          if (agentCatalog !== undefined) runMsg.agentCatalog = agentCatalog;
          child.send(runMsg);
          return;
        }
        case 'heartbeat':
          armIdle();
          onLifecycle?.({ type: 'heartbeat', uptimeMs: msg.uptimeMs });
          return;
        case 'call':
          if (!helloSeen) {
            killWith('protocol-violation', 'call antes do handshake hello');
            return;
          }
          void dispatchCall(msg.callId, msg.primitive, msg.arg);
          return;
        case 'result':
          finish({ status: 'completed', value: msg.value }, undefined);
          try {
            child.kill();
          } catch {
          }
          return;
        case 'fatal':
          finish({ status: 'failed', reason: 'crash', message: msg.message }, undefined);
          try {
            child.kill();
          } catch {
          }
          return;
      }
    });

    async function dispatchCall(callId: number, primitive: SandboxPrimitive, arg: unknown): Promise<void> {
      onLifecycle?.({ type: 'primitive', primitive });

      if (primitive === 'artifact') {
        const rel = (arg as { path?: unknown } | null)?.path;
        if (!isSafeArtifactRelativePath(rel)) {
          reject(callId, 'artifact path invalido: deve ser relativo e dentro do run dir');
          return;
        }
      }

      const handler = handlers[primitive];
      if (!handler) {
        reject(callId, `primitiva ${primitive} sem handler no host`);
        return;
      }
      try {
        const value = await handler(arg);
        resolveCall(callId, value);
      } catch (err) {
        reject(callId, err instanceof Error ? err.message : String(err), isHostFatalError(err));
      }
    }

    function resolveCall(callId: number, value: unknown): void {
      if (settled) return;
      child.send({ t: 'primitive-result', callId, value });
    }

    function reject(callId: number, message: string, fatal = false): void {
      if (settled) return;
      child.send({ t: 'primitive-error', callId, message, fatal });
    }
  });
}


export const SANDBOX_CHILD_ENTRY_BASENAME = 'workflow-sandbox-child.js';

export function createUtilityProcessFactory(childEntryPath: string): SandboxProcessFactory {
  return {
    spawn(): SandboxProcessHandle {
      const electron = loadElectron();
      const utilityProcess = electron?.utilityProcess as
        | {
            fork(
              modulePath: string,
              args?: string[],
              options?: Record<string, unknown>,
            ): UtilityChild;
          }
        | undefined;
      if (!utilityProcess || typeof utilityProcess.fork !== 'function') {
        throw new WorkflowSandboxError(
          'crash',
          'utilityProcess indisponivel; use createNodeForkFactory como fallback',
        );
      }
      const proc: UtilityChild = utilityProcess.fork(childEntryPath, [], {
        env: { ...process.env, LIONCLAW_WORKFLOW_SANDBOX_CHILD: '1' },
        serviceName: 'lionclaw-dynamic-workflow-sandbox',
        stdio: 'ignore',
      });
      let killed = false;
      return {
        get pid() {
          return proc.pid;
        },
        send: (message) => proc.postMessage(message),
        onMessage: (cb) => proc.on('message', (value: unknown) => cb(value)),
        onExit: (cb) => proc.on('exit', (code: number) => cb(code ?? null, null)),
        kill: () => {
          if (killed) return;
          killed = true;
          try {
            proc.kill();
          } catch {
          }
        },
      };
    },
  };
}

interface UtilityChild {
  readonly pid?: number;
  postMessage(message: unknown): void;
  on(event: 'message', cb: (value: unknown) => void): void;
  on(event: 'exit', cb: (code: number) => void): void;
  kill(): boolean;
}

export function createNodeForkFactory(childEntry: string, extraEnv?: Record<string, string>): SandboxProcessFactory {
  return {
    spawn(): SandboxProcessHandle {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { fork } = require('child_process') as typeof import('child_process');
      const child = fork(childEntry, [], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          LIONCLAW_WORKFLOW_SANDBOX_CHILD: '1',
          ...extraEnv,
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      let killed = false;
      return {
        get pid() {
          return child.pid;
        },
        send: (message) => {
          try {
            child.send(message);
          } catch (err) {
            logger.warn({ err }, 'falha ao enviar mensagem ao filho (provavelmente morto)');
          }
        },
        onMessage: (cb) => child.on('message', (value: unknown) => cb(value)),
        onExit: (cb) => child.on('exit', (code, signal) => cb(code, signal)),
        kill: () => {
          if (killed) return;
          killed = true;
          try {
            child.kill('SIGKILL');
          } catch {
          }
        },
      };
    },
  };
}

function loadElectron(): { utilityProcess?: unknown } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('electron') as { utilityProcess?: unknown };
  } catch {
    return null;
  }
}

function isHostFatalError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { isWorkflowHostFatal?: unknown; name?: unknown };
  return e.isWorkflowHostFatal === true || e.name === 'WorkflowHostFatalError';
}

import vm from 'node:vm';
import {
  PROXIED_PRIMITIVES,
  SANDBOX_PROTOCOL_VERSION,
  parseParentMessage,
  type SandboxChildMessage,
  type SandboxParentMessage,
  type SandboxParentRun,
} from './sandbox-protocol';

const CHILD_PARALLEL_HARD_CAP = 64;

interface ChildTransport {
  send(msg: SandboxChildMessage): void;
  onMessage(cb: (msg: unknown) => void): void;
}

function resolveTransport(): ChildTransport | null {
  const proc = process as unknown as {
    parentPort?: {
      postMessage(value: unknown): void;
      on(event: 'message', cb: (e: { data: unknown }) => void): void;
    };
    send?: (msg: unknown) => void;
    on?: (event: 'message', cb: (msg: unknown) => void) => void;
  };
  if (proc.parentPort && typeof proc.parentPort.postMessage === 'function') {
    const port = proc.parentPort;
    return {
      send: (msg) => port.postMessage(msg),
      onMessage: (cb) => port.on('message', (e) => cb(e?.data)),
    };
  }
  if (typeof proc.send === 'function' && typeof proc.on === 'function') {
    const send = proc.send.bind(process);
    return {
      send: (msg) => send(msg),
      onMessage: (cb) => proc.on!('message', (msg) => cb(msg)),
    };
  }
  return null;
}

const HEARTBEAT_INTERVAL_MS = 1_000;
const startedAt = Date.now();

let transport: ChildTransport | null = null;
let nextCallId = 1;
const pendingCalls = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

function sendToParent(msg: SandboxChildMessage): void {
  if (transport) transport.send(msg);
}

function fatal(message: string, stack?: string): void {
  sendToParent({ t: 'fatal', message, stack });
}

class PrimitiveRejection extends Error {
  readonly fatal: boolean;
  constructor(message: string, fatal: boolean) {
    super(message);
    this.name = 'PrimitiveRejection';
    this.fatal = fatal;
  }
}

function isFatalRejection(err: unknown): boolean {
  return err instanceof PrimitiveRejection && err.fatal === true;
}

function callPrimitive(primitive: string, arg: unknown): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const callId = nextCallId++;
    pendingCalls.set(callId, { resolve, reject });
    sendToParent({ t: 'call', callId, primitive: primitive as never, arg });
  });
}

export function normalizeAgentArgs(args: unknown[]): unknown {
  const [arg0, arg1] = args;
  if (typeof arg0 === 'string') {
    const opts = arg1 && typeof arg1 === 'object' ? (arg1 as Record<string, unknown>) : {};
    return { prompt: arg0, ...opts };
  }
  return arg0;
}

const DETERMINISM_BOOTSTRAP = `
(() => {
  'use strict';
  const nativeDate = Date;
  const throwDateNow = () => {
    throw new Error('Determinismo do workflow: Date.now() e proibido dentro do workflow.js (o resume reexecuta o script e o valor mudaria). Receba timestamps dos nodes/ctx e use new Date(ts).');
  };
  // Neutraliza tambem o intrinsic: mesmo que o script apague o shadow global,
  // o Date.now original do contexto continua lancando.
  nativeDate.now = throwDateNow;
  class DeterministicDate extends nativeDate {
    constructor(...args) {
      if (args.length === 0) {
        throw new Error('Determinismo do workflow: new Date() sem argumentos e proibido dentro do workflow.js (o resume reexecuta o script e o valor mudaria). Use new Date(ts) com timestamp vindo dos nodes/ctx.');
      }
      super(...args);
    }
  }
  DeterministicDate.now = throwDateNow;
  Object.freeze(DeterministicDate);
  globalThis.Date = DeterministicDate;
  Math.random = () => {
    throw new Error('Determinismo do workflow: Math.random() e proibido dentro do workflow.js (o resume reexecuta o script e o valor mudaria). Derive qualquer variacao dos dados dos nodes.');
  };
  Object.freeze(Math);
})();
`;

export function createSandboxVmContext(sandbox: Record<string, unknown>): vm.Context {
  const context = vm.createContext(sandbox, {
    name: 'dynamic-workflow-coordinator',
    codeGeneration: { strings: false, wasm: false }, // bloqueia eval/new Function dentro do vm
  });
  new vm.Script(DETERMINISM_BOOTSTRAP, { filename: 'determinism-bootstrap.js' }).runInContext(context);
  return context;
}

interface ChildParallelOptions {
  id?: string;
  maxConcurrency?: number;
  failFast?: boolean;
}

type ChildThunk = () => Promise<unknown> | unknown;
type ChildStage = (prevResult: unknown, originalItem: unknown, index: number) => Promise<unknown> | unknown;

async function runParallelLocal(thunksArg: unknown, optionsArg: unknown): Promise<unknown[]> {
  const thunks: ChildThunk[] = Array.isArray(thunksArg)
    ? (thunksArg.filter((t) => typeof t === 'function') as ChildThunk[])
    : [];
  const options: ChildParallelOptions =
    optionsArg && typeof optionsArg === 'object' ? (optionsArg as ChildParallelOptions) : {};
  const requested =
    typeof options.maxConcurrency === 'number' && options.maxConcurrency > 0
      ? Math.floor(options.maxConcurrency)
      : thunks.length || 1;
  const concurrency = Math.max(1, Math.min(requested, CHILD_PARALLEL_HARD_CAP, thunks.length || 1));
  const failFast = options.failFast === true;

  const results = new Array<unknown>(thunks.length);
  let nextIndex = 0;
  let cancelled = false;
  let fatalErr: unknown = null;

  async function worker(): Promise<void> {
    while (true) {
      if (cancelled || fatalErr) return;
      const idx = nextIndex++;
      if (idx >= thunks.length) return;
      try {
        results[idx] = await thunks[idx]();
      } catch (err) {
        if (isFatalRejection(err)) {
          if (!fatalErr) fatalErr = err;
          return;
        }
        results[idx] = null;
        if (failFast) {
          cancelled = true;
          return;
        }
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  if (fatalErr) throw fatalErr;
  return results;
}

async function runPipelineLocal(itemsArg: unknown, stagesArg: unknown): Promise<unknown[]> {
  const items: unknown[] = Array.isArray(itemsArg) ? itemsArg : [];
  const stages: ChildStage[] = Array.isArray(stagesArg)
    ? (stagesArg.filter((s) => typeof s === 'function') as ChildStage[])
    : [];
  const concurrency = Math.max(1, Math.min(CHILD_PARALLEL_HARD_CAP, items.length || 1));

  const results = new Array<unknown>(items.length);
  let nextIndex = 0;
  let fatalErr: unknown = null;

  async function runItem(item: unknown, index: number): Promise<unknown> {
    let acc: unknown = item;
    for (const stage of stages) {
      if (fatalErr) return null;
      acc = await stage(acc, item, index);
    }
    return acc;
  }

  async function worker(): Promise<void> {
    while (true) {
      if (fatalErr) return;
      const idx = nextIndex++;
      if (idx >= items.length) return;
      try {
        results[idx] = await runItem(items[idx], idx);
      } catch (err) {
        if (isFatalRejection(err)) {
          if (!fatalErr) fatalErr = err;
          return;
        }
        results[idx] = null;
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  if (fatalErr) throw fatalErr;
  return results;
}

interface SandboxCtxState {
  input?: Record<string, unknown>;
  maxPlanRounds?: number;
  maxDevRounds?: number;
  agentCatalog?: Array<{ id: string; name: string; description?: string }>;
}

export function buildSandboxGlobals(ctxState: SandboxCtxState): Record<string, unknown> {
  const globals: Record<string, unknown> = {};
  for (const primitive of PROXIED_PRIMITIVES) {
    if (primitive === 'agent') {
      globals[primitive] = (...args: unknown[]) => callPrimitive(primitive, normalizeAgentArgs(args));
      continue;
    }
    globals[primitive] = (arg: unknown) => callPrimitive(primitive, arg);
  }
  globals.parallel = (thunks: unknown, options?: unknown) => runParallelLocal(thunks, options);
  globals.pipeline = (items: unknown, ...stages: unknown[]) => runPipelineLocal(items, stages);
  globals.autonomy = 'auto';
  const inputValue = ctxState.input ?? {};
  globals.input = inputValue;
  globals.args = inputValue;
  if (ctxState.maxPlanRounds !== undefined) globals.maxPlanRounds = ctxState.maxPlanRounds;
  if (ctxState.maxDevRounds !== undefined) globals.maxDevRounds = ctxState.maxDevRounds;
  globals.agentCatalog = ctxState.agentCatalog ?? [];
  globals.console = {
    log: (...args: unknown[]) => callPrimitive('log', { message: joinArgs(args) }),
    error: (...args: unknown[]) => callPrimitive('log', { message: joinArgs(args), level: 'error' }),
    warn: (...args: unknown[]) => callPrimitive('log', { message: joinArgs(args), level: 'warn' }),
  };
  return globals;
}

function joinArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

async function runWorkflow(payload: SandboxParentRun): Promise<void> {
  const sandbox = buildSandboxGlobals({
    input: payload.input,
    maxPlanRounds: payload.maxPlanRounds,
    maxDevRounds: payload.maxDevRounds,
    agentCatalog: payload.agentCatalog,
  });
  const context = createSandboxVmContext(sandbox);

  let script: vm.Script;
  try {
    script = new vm.Script(payload.transformedSource, { filename: 'workflow.js' });
  } catch (err) {
    fatal(`falha ao compilar workflow.js no vm: ${errMessage(err)}`, errStack(err));
    return;
  }

  try {
    script.runInContext(context, { displayErrors: true });
  } catch (err) {
    fatal(`erro ao avaliar workflow.js: ${errMessage(err)}`, errStack(err));
    return;
  }

  const runFn = (sandbox as { __run?: unknown }).__run;
  if (typeof runFn !== 'function') {
    fatal('workflow.js nao definiu run(ctx) executavel apos transform');
    return;
  }

  const ctx = sandbox;
  try {
    const value = await (runFn as (c: unknown) => unknown)(ctx);
    sendToParent({ t: 'result', value: serializable(value) });
  } catch (err) {
    fatal(`run(ctx) lancou: ${errMessage(err)}`, errStack(err));
  }
}

function serializable(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function errStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

function handleParentMessage(raw: unknown): void {
  const msg: SandboxParentMessage | null = parseParentMessage(raw);
  if (!msg) return;
  switch (msg.t) {
    case 'run':
      void runWorkflow(msg);
      return;
    case 'primitive-result': {
      const pending = pendingCalls.get(msg.callId);
      if (pending) {
        pendingCalls.delete(msg.callId);
        pending.resolve(msg.value);
      }
      return;
    }
    case 'primitive-error': {
      const pending = pendingCalls.get(msg.callId);
      if (pending) {
        pendingCalls.delete(msg.callId);
        pending.reject(new PrimitiveRejection(msg.message, msg.fatal === true));
      }
      return;
    }
  }
}

export function startSandboxChild(): void {
  transport = resolveTransport();
  if (!transport) {
    return;
  }
  transport.onMessage(handleParentMessage);

  const heartbeat = setInterval(() => {
    sendToParent({ t: 'heartbeat', uptimeMs: Date.now() - startedAt });
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  sendToParent({ t: 'hello', protocol: SANDBOX_PROTOCOL_VERSION });

  process.on('uncaughtException', (err) => {
    fatal(`uncaughtException no filho: ${errMessage(err)}`, errStack(err));
  });
  process.on('unhandledRejection', (reason) => {
    fatal(`unhandledRejection no filho: ${errMessage(reason)}`);
  });
}

if (process.env.LIONCLAW_WORKFLOW_SANDBOX_CHILD === '1') {
  startSandboxChild();
}

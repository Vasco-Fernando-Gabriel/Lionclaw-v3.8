import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWorkflowSandbox, createNodeForkFactory } from '../dynamic-workflows/workflow-sandbox';
import { PROXIED_PRIMITIVES } from '../dynamic-workflows/sandbox-protocol';
import { createAgentSemaphore } from '../dynamic-workflows/workflow-host-api';

const tmpDirs: string[] = [];
function writeTmpChild(name: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-wf-par-e2e-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  tmpDirs.push(dir);
  return file;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try {
      if (d) fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function childRuntimeSource(buildExtra: string, appendix = ''): string {
  return (
    `
const vm = require('node:vm');
const PROXIED = ${JSON.stringify([...PROXIED_PRIMITIVES])};
let nextCallId = 1;
const pending = new Map();

function send(msg) { process.send(msg); }
function callPrimitive(primitive, arg) {
  return new Promise((resolve, reject) => {
    const callId = nextCallId++;
    pending.set(callId, { resolve, reject });
    send({ t: 'call', callId, primitive, arg });
  });
}

function buildGlobals() {
  const g = {};
  ${buildExtra}
  g.console = { log: () => {}, error: () => {}, warn: () => {} };
  return g;
}

async function runWorkflow(transformedSource) {
  const sandbox = buildGlobals();
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script(transformedSource, { filename: 'workflow.js' });
  script.runInContext(context);
  const runFn = sandbox.__run;
  if (typeof runFn !== 'function') { send({ t: 'fatal', message: 'no __run' }); return; }
  try {
    const value = await runFn(sandbox);
    send({ t: 'result', value: JSON.parse(JSON.stringify(value == null ? null : value)) });
  } catch (e) {
    send({ t: 'fatal', message: String(e && e.message ? e.message : e) });
  }
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'run') { void runWorkflow(msg.transformedSource); return; }
  if (msg.t === 'primitive-result') {
    const p = pending.get(msg.callId);
    if (p) { pending.delete(msg.callId); p.resolve(msg.value); }
    return;
  }
  if (msg.t === 'primitive-error') {
    const p = pending.get(msg.callId);
    if (p) { pending.delete(msg.callId); p.reject(new Error(msg.message)); }
    return;
  }
});

// Heartbeat (o pai arma idle timer). unref para nao segurar o event loop.
const hb = setInterval(() => send({ t: 'heartbeat', uptimeMs: 1 }), 200);
if (hb.unref) hb.unref();
send({ t: 'hello', protocol: 1 });
` + appendix
  );
}

const NEW_DESIGN_GLOBALS = `
  for (const primitive of PROXIED) {
    g[primitive] = (arg) => callPrimitive(primitive, arg);
  }
  g.parallel = async (thunks, options) => {
    const list = Array.isArray(thunks) ? thunks.filter((t) => typeof t === 'function') : [];
    const opt = options && typeof options === 'object' ? options : {};
    const requested = typeof opt.maxConcurrency === 'number' && opt.maxConcurrency > 0
      ? Math.floor(opt.maxConcurrency) : (list.length || 1);
    const concurrency = Math.max(1, Math.min(requested, 64, list.length || 1));
    const failFast = opt.failFast === true;
    const results = new Array(list.length);
    let nextIndex = 0; let cancelled = false;
    async function worker() {
      while (true) {
        if (cancelled) return;
        const idx = nextIndex++;
        if (idx >= list.length) return;
        try { results[idx] = await list[idx](); }
        catch { results[idx] = null; if (failFast) { cancelled = true; return; } }
      }
    }
    const ws = [];
    for (let i = 0; i < concurrency; i++) ws.push(worker());
    await Promise.all(ws);
    return results;
  };
  g.pipeline = async (items, ...stages) => {
    const list = Array.isArray(items) ? items : [];
    const st = stages.filter((s) => typeof s === 'function');
    const concurrency = Math.max(1, Math.min(64, list.length || 1));
    const results = new Array(list.length);
    let nextIndex = 0;
    async function runItem(item, index) {
      let acc = item;
      for (const stage of st) acc = await stage(acc, item, index);
      return acc;
    }
    async function worker() {
      while (true) {
        const idx = nextIndex++;
        if (idx >= list.length) return;
        try { results[idx] = await runItem(list[idx], idx); }
        catch { results[idx] = null; }
      }
    }
    const ws = [];
    for (let i = 0; i < concurrency; i++) ws.push(worker());
    await Promise.all(ws);
    return results;
  };
`;

const OLD_DESIGN_GLOBALS = `
  const ALL = PROXIED.concat(['parallel', 'pipeline']);
  for (const primitive of ALL) {
    g[primitive] = (arg) => callPrimitive(primitive, arg);
  }
`;

const NEW_DESIGN_GLOBALS_FATAL = `
  for (const primitive of PROXIED) {
    g[primitive] = (arg) => callPrimitive(primitive, arg);
  }
  function isFatalRej(e) { return !!(e && e.__fatal === true); }
  g.parallel = async (thunks, options) => {
    const list = Array.isArray(thunks) ? thunks.filter((t) => typeof t === 'function') : [];
    const opt = options && typeof options === 'object' ? options : {};
    const requested = typeof opt.maxConcurrency === 'number' && opt.maxConcurrency > 0
      ? Math.floor(opt.maxConcurrency) : (list.length || 1);
    const concurrency = Math.max(1, Math.min(requested, 64, list.length || 1));
    const failFast = opt.failFast === true;
    const results = new Array(list.length);
    let nextIndex = 0; let cancelled = false; let fatalErr = null;
    async function worker() {
      while (true) {
        if (cancelled || fatalErr) return;
        const idx = nextIndex++;
        if (idx >= list.length) return;
        try { results[idx] = await list[idx](); }
        catch (e) {
          if (isFatalRej(e)) { if (!fatalErr) fatalErr = e; return; }
          results[idx] = null; if (failFast) { cancelled = true; return; }
        }
      }
    }
    const ws = [];
    for (let i = 0; i < concurrency; i++) ws.push(worker());
    await Promise.all(ws);
    if (fatalErr) throw fatalErr;
    return results;
  };
  g.pipeline = async (items, ...stages) => {
    const list = Array.isArray(items) ? items : [];
    const st = stages.filter((s) => typeof s === 'function');
    const concurrency = Math.max(1, Math.min(64, list.length || 1));
    const results = new Array(list.length);
    let nextIndex = 0; let fatalErr = null;
    async function runItem(item, index) {
      let acc = item;
      for (const stage of st) { if (fatalErr) return null; acc = await stage(acc, item, index); }
      return acc;
    }
    async function worker() {
      while (true) {
        if (fatalErr) return;
        const idx = nextIndex++;
        if (idx >= list.length) return;
        try { results[idx] = await runItem(list[idx], idx); }
        catch (e) { if (isFatalRej(e)) { if (!fatalErr) fatalErr = e; return; } results[idx] = null; }
      }
    }
    const ws = [];
    for (let i = 0; i < concurrency; i++) ws.push(worker());
    await Promise.all(ws);
    if (fatalErr) throw fatalErr;
    return results;
  };
`;

const FATAL_PRIMERR_OVERRIDE = `
process.removeAllListeners('message');
process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'run') { void runWorkflow(msg.transformedSource); return; }
  if (msg.t === 'primitive-result') {
    const p = pending.get(msg.callId);
    if (p) { pending.delete(msg.callId); p.resolve(msg.value); }
    return;
  }
  if (msg.t === 'primitive-error') {
    const p = pending.get(msg.callId);
    if (p) {
      pending.delete(msg.callId);
      const err = new Error(msg.message);
      err.__fatal = msg.fatal === true;
      p.reject(err);
    }
    return;
  }
});
`;

const PARALLEL_WORKFLOW = `
globalThis.__run = async function run(ctx) {
  const { parallel, agent } = ctx;
  const results = await parallel([
    () => agent({ id: 'val-a', agentId: 'validator', axis: 'spec' }),
    () => agent({ id: 'val-b', agentId: 'validator', axis: 'race' }),
    () => agent({ id: 'val-c', agentId: 'validator', axis: 'tests' }),
  ], { id: 'validators-r0', maxConcurrency: 3 });
  return { results };
};
`;

const PIPELINE_WORKFLOW = `
globalThis.__run = async function run(ctx) {
  const { pipeline, agent } = ctx;
  const out = await pipeline(['x', 'y'],
    (item, original, index) => agent({ id: 'scan-' + index, agentId: 'scanner', item: item }),
    (prev) => ({ scanned: prev }),
  );
  return { out };
};
`;

const FATAL_PARALLEL_WORKFLOW = `
globalThis.__run = async function run(ctx) {
  const { parallel, agent } = ctx;
  const results = await parallel([
    () => agent({ id: 'val-a', agentId: 'validator' }),
    () => agent({ id: 'boom', agentId: 'validator' }),
    () => agent({ id: 'val-c', agentId: 'validator' }),
  ], { id: 'validators-r0' });
  // Se chegar aqui (nao deveria, no caso fatal), devolve para inspecao.
  return { reached: true, results };
};
`;

const RECOVERABLE_PARALLEL_WORKFLOW = `
globalThis.__run = async function run(ctx) {
  const { parallel, agent } = ctx;
  const results = await parallel([
    () => agent({ id: 'val-a', agentId: 'validator' }),
    () => agent({ id: 'soft-fail', agentId: 'validator' }),
    () => agent({ id: 'val-c', agentId: 'validator' }),
  ], { id: 'validators-r0' });
  return { reached: true, results };
};
`;

const CEILING_PARALLEL_WORKFLOW = `
globalThis.__run = async function run(ctx) {
  const { parallel, agent } = ctx;
  const ids = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'];
  const results = await parallel(
    ids.map((id) => () => agent({ id: id, agentId: 'validator' })),
    { id: 'validators-r0' },
  );
  return { count: results.length };
};
`;

const FAILFAST_PARALLEL_WORKFLOW = `
globalThis.__run = async function run(ctx) {
  const { parallel, agent } = ctx;
  const results = await parallel([
    () => agent({ id: 'boom-soft', agentId: 'validator' }),
    () => agent({ id: 'never-1', agentId: 'validator' }),
    () => agent({ id: 'never-2', agentId: 'validator' }),
  ], { id: 'validators-r0', maxConcurrency: 1, failFast: true });
  return { results };
};
`;

const PIPELINE_NOBARRIER_WORKFLOW = `
globalThis.__run = async function run(ctx) {
  const { pipeline, agent } = ctx;
  const out = await pipeline(['x', 'y'],
    (item) => agent({ id: 's1-' + item, agentId: 'scanner', stage: 1, item: item }),
    (prev, item) => agent({ id: 's2-' + item, agentId: 'scanner', stage: 2, item: item, prev: prev }),
  );
  return { out: out };
};
`;

function makeAgentStub() {
  const calls: Array<{ id: unknown; agentId: unknown; axis?: unknown; item?: unknown }> = [];
  const handler = async (arg: unknown) => {
    const a = (arg ?? {}) as { id?: unknown; agentId?: unknown; axis?: unknown; item?: unknown };
    calls.push({ id: a.id, agentId: a.agentId, axis: a.axis, item: a.item });
    return { verdict: 'ok', forId: a.id, forAxis: a.axis ?? null, forItem: a.item ?? null };
  };
  return { calls, handler };
}

describe('DEFECT-1 e2e (fork REAL): parallel/pipeline rodam local no child e disparam agent() no pai', () => {
  it('parallel([()=>agent(a),()=>agent(b),()=>agent(c)]) chega como 3 calls agent() no pai, em ordem', async () => {
    const childFile = writeTmpChild('child-new.cjs', childRuntimeSource(NEW_DESIGN_GLOBALS));
    const factory = createNodeForkFactory(childFile);
    const agentStub = makeAgentStub();

    const result = await runWorkflowSandbox({
      transformedSource: PARALLEL_WORKFLOW,
      wallTimeoutMs: 8_000,
      idleTimeoutMs: 8_000,
      factory,
      handlers: { agent: agentStub.handler },
    });

    expect(result.status).toBe('completed');
    expect(agentStub.calls.length).toBe(3);
    const seenIds = agentStub.calls.map((c) => c.id).sort();
    expect(seenIds).toEqual(['val-a', 'val-b', 'val-c']);

    if (result.status === 'completed') {
      const value = result.value as { results: Array<{ verdict: string; forId: string }> };
      expect(Array.isArray(value.results)).toBe(true);
      expect(value.results.length).toBe(3);
      expect(value.results.map((r) => r.forId)).toEqual(['val-a', 'val-b', 'val-c']);
      expect(value.results.every((r) => r && r.verdict === 'ok')).toBe(true);
    }
  });

  it('pipeline(items, ...stages) roda local: stage 1 dispara agent() por item, no child REAL', async () => {
    const childFile = writeTmpChild('child-new-pipe.cjs', childRuntimeSource(NEW_DESIGN_GLOBALS));
    const factory = createNodeForkFactory(childFile);
    const agentStub = makeAgentStub();

    const result = await runWorkflowSandbox({
      transformedSource: PIPELINE_WORKFLOW,
      wallTimeoutMs: 8_000,
      idleTimeoutMs: 8_000,
      factory,
      handlers: { agent: agentStub.handler },
    });

    expect(result.status).toBe('completed');
    expect(agentStub.calls.length).toBe(2);
    expect(agentStub.calls.map((c) => c.item).sort()).toEqual(['x', 'y']);

    if (result.status === 'completed') {
      const value = result.value as { out: Array<{ scanned: { verdict: string; forItem: string } }> };
      expect(value.out.length).toBe(2);
      expect(value.out.map((r) => r.scanned.forItem)).toEqual(['x', 'y']);
    }
  });
});

function makeFatalAgentStub(fatalId: string) {
  const calls: unknown[] = [];
  const handler = async (arg: unknown) => {
    const a = (arg ?? {}) as { id?: unknown };
    calls.push(a.id);
    if (a.id === fatalId) {
      const err = new Error('node fora do manifest (fatal estrutural)') as Error & {
        isWorkflowHostFatal?: boolean;
      };
      err.name = 'WorkflowHostFatalError';
      err.isWorkflowHostFatal = true;
      throw err;
    }
    return { verdict: 'ok', forId: a.id };
  };
  return { calls, handler };
}

function makeSoftFailAgentStub(softId: string) {
  const calls: unknown[] = [];
  const handler = async (arg: unknown) => {
    const a = (arg ?? {}) as { id?: unknown };
    calls.push(a.id);
    if (a.id === softId) throw new Error('rate limit (recuperavel)');
    return { verdict: 'ok', forId: a.id };
  };
  return { calls, handler };
}

describe('DEFECT-1 Finding 2 e2e (fork REAL): fatal dentro de parallel() cancela o grupo e falha o run', () => {
  it('agent() FATAL dentro de parallel() => run FAILED (nao vira null silencioso)', async () => {
    const childFile = writeTmpChild(
      'child-fatal.cjs',
      childRuntimeSource(NEW_DESIGN_GLOBALS_FATAL, FATAL_PRIMERR_OVERRIDE),
    );
    const factory = createNodeForkFactory(childFile);
    const stub = makeFatalAgentStub('boom');

    const result = await runWorkflowSandbox({
      transformedSource: FATAL_PARALLEL_WORKFLOW,
      wallTimeoutMs: 8_000,
      idleTimeoutMs: 8_000,
      factory,
      handlers: { agent: stub.handler },
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('crash');
      expect(result.message).toContain('fatal estrutural');
    }
  });

  it('contraste: agent() RECUPERAVEL dentro de parallel() => null no array, run COMPLETA', async () => {
    const childFile = writeTmpChild(
      'child-soft.cjs',
      childRuntimeSource(NEW_DESIGN_GLOBALS_FATAL, FATAL_PRIMERR_OVERRIDE),
    );
    const factory = createNodeForkFactory(childFile);
    const stub = makeSoftFailAgentStub('soft-fail');

    const result = await runWorkflowSandbox({
      transformedSource: RECOVERABLE_PARALLEL_WORKFLOW,
      wallTimeoutMs: 8_000,
      idleTimeoutMs: 8_000,
      factory,
      handlers: { agent: stub.handler },
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      const value = result.value as { reached: boolean; results: Array<unknown> };
      expect(value.reached).toBe(true);
      expect(value.results.length).toBe(3);
      expect(value.results[1]).toBeNull();
      expect((value.results[0] as { forId: string }).forId).toBe('val-a');
      expect((value.results[2] as { forId: string }).forId).toBe('val-c');
    }
  });
});

function makeCeilingAgentStub(maxConcurrentAgents: number, holdMs: number) {
  const sem = createAgentSemaphore(maxConcurrentAgents);
  let active = 0;
  let maxActive = 0;
  const calls: unknown[] = [];
  const raw = async (arg: unknown) => {
    const a = (arg ?? {}) as { id?: unknown };
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((r) => setTimeout(r, holdMs));
      calls.push(a.id);
      return { verdict: 'ok', forId: a.id };
    } finally {
      active -= 1;
    }
  };
  const handler = (arg: unknown) => sem.run(() => raw(arg));
  return {
    handler,
    calls,
    get maxActive() {
      return maxActive;
    },
  };
}

describe('DEFECT-1 Finding 1 e2e (fork REAL): semaforo do pai segura o teto no caminho do filho', () => {
  it('parallel() SEM maxConcurrency + maxConcurrentAgents=2 => no maximo 2 agent() vivos (cap vem do semaforo, nao do runParallel)', async () => {
    const childFile = writeTmpChild('child-ceiling.cjs', childRuntimeSource(NEW_DESIGN_GLOBALS));
    const factory = createNodeForkFactory(childFile);
    const stub = makeCeilingAgentStub(2, 25);

    const result = await runWorkflowSandbox({
      transformedSource: CEILING_PARALLEL_WORKFLOW,
      wallTimeoutMs: 8_000,
      idleTimeoutMs: 8_000,
      factory,
      handlers: { agent: stub.handler },
    });

    expect(result.status).toBe('completed');
    expect(stub.calls.length).toBe(6);
    expect(stub.maxActive).toBe(2);
    if (result.status === 'completed') {
      expect((result.value as { count: number }).count).toBe(6);
    }
  });

  it('maxConcurrentAgents=1 serializa por completo no caminho do filho (maxActive=1)', async () => {
    const childFile = writeTmpChild('child-ceiling-1.cjs', childRuntimeSource(NEW_DESIGN_GLOBALS));
    const factory = createNodeForkFactory(childFile);
    const stub = makeCeilingAgentStub(1, 10);

    const result = await runWorkflowSandbox({
      transformedSource: CEILING_PARALLEL_WORKFLOW,
      wallTimeoutMs: 8_000,
      idleTimeoutMs: 8_000,
      factory,
      handlers: { agent: stub.handler },
    });

    expect(result.status).toBe('completed');
    expect(stub.calls.length).toBe(6);
    expect(stub.maxActive).toBe(1);
  });
});

describe('DEFECT-1 Finding 2 caso 1 e2e (fork REAL): failFast nao dispara os thunks pendentes', () => {
  it('parallel({maxConcurrency:1, failFast:true}) com 1o thunk soft-fail => so o 1o chega ao pai; os pendentes NAO viram agent()', async () => {
    const childFile = writeTmpChild(
      'child-failfast.cjs',
      childRuntimeSource(NEW_DESIGN_GLOBALS_FATAL, FATAL_PRIMERR_OVERRIDE),
    );
    const factory = createNodeForkFactory(childFile);
    const stub = makeSoftFailAgentStub('boom-soft');

    const result = await runWorkflowSandbox({
      transformedSource: FAILFAST_PARALLEL_WORKFLOW,
      wallTimeoutMs: 8_000,
      idleTimeoutMs: 8_000,
      factory,
      handlers: { agent: stub.handler },
    });

    expect(result.status).toBe('completed');
    expect(stub.calls).toEqual(['boom-soft']);
    expect(stub.calls).not.toContain('never-1');
    expect(stub.calls).not.toContain('never-2');
    if (result.status === 'completed') {
      const value = result.value as { results: Array<unknown> };
      expect(value.results.length).toBe(3);
      expect(value.results[0]).toBeNull();
      expect(value.results[1] ?? null).toBeNull();
      expect(value.results[2] ?? null).toBeNull();
    }
  });
});

function makePipelineOrderStub(slowMs: number) {
  const enterOrder: string[] = [];
  const handler = async (arg: unknown) => {
    const a = (arg ?? {}) as { id?: unknown; item?: unknown; stage?: unknown };
    const id = String(a.id);
    enterOrder.push(id);
    if (id === 's1-x') {
      await new Promise((r) => setTimeout(r, slowMs));
    }
    return { verdict: 'ok', forId: id, item: a.item, stage: a.stage };
  };
  return { handler, enterOrder };
}

describe('DEFECT-1 Finding 2 caso 2 e2e (fork REAL): pipeline avanca stages sem barrier', () => {
  it('com stage 1 lenta no item 0, o item 1 entra na stage 2 ANTES de o item 0 sair da stage 1', async () => {
    const childFile = writeTmpChild('child-pipe-nobarrier.cjs', childRuntimeSource(NEW_DESIGN_GLOBALS));
    const factory = createNodeForkFactory(childFile);
    const stub = makePipelineOrderStub(120);

    const result = await runWorkflowSandbox({
      transformedSource: PIPELINE_NOBARRIER_WORKFLOW,
      wallTimeoutMs: 8_000,
      idleTimeoutMs: 8_000,
      factory,
      handlers: { agent: stub.handler },
    });

    expect(result.status).toBe('completed');
    expect(stub.enterOrder.length).toBe(4);
    const iS1x = stub.enterOrder.indexOf('s1-x');
    const iS2y = stub.enterOrder.indexOf('s2-y');
    expect(iS1x).toBeGreaterThanOrEqual(0);
    expect(iS2y).toBeGreaterThanOrEqual(0);
    expect(iS1x).toBeLessThan(iS2y);
    const iS2x = stub.enterOrder.indexOf('s2-x');
    expect(iS2x).toBeGreaterThanOrEqual(0);
    expect(iS2y).toBeLessThan(iS2x);
  });
});

describe('DEFECT-1 e2e: o harness PEGA o bug (design antigo = parallel proxied)', () => {
  it('com parallel embrulhado como proxy, o structured clone descarta os thunks: 0 agent() e parallel vira []', async () => {
    const childFile = writeTmpChild('child-old.cjs', childRuntimeSource(OLD_DESIGN_GLOBALS));
    const factory = createNodeForkFactory(childFile);
    const agentStub = makeAgentStub();

    const result = await runWorkflowSandbox({
      transformedSource: PARALLEL_WORKFLOW,
      wallTimeoutMs: 8_000,
      idleTimeoutMs: 8_000,
      factory,
      handlers: {
        agent: agentStub.handler,
        parallel: async () => [],
      },
    });

    expect(agentStub.calls.length).toBe(0);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('protocol-violation');
    }
  });
});

describe('DEFECT-1: guard estrutural do child real (anti-drift)', () => {
  const childSrcPath = path.join(__dirname, '..', 'dynamic-workflows', 'workflow-sandbox-child.ts');
  const childSrc = fs.readFileSync(childSrcPath, 'utf8');

  it('o proxy loop do child real itera PROXIED_PRIMITIVES (nao SANDBOX_PRIMITIVES)', () => {
    expect(childSrc).toMatch(/for\s*\(\s*const\s+primitive\s+of\s+PROXIED_PRIMITIVES\s*\)/);
    expect(childSrc).not.toMatch(/for\s*\(\s*const\s+primitive\s+of\s+SANDBOX_PRIMITIVES\s*\)/);
  });

  it('parallel/pipeline sao globais LOCAIS no child real, nao proxies via callPrimitive', () => {
    expect(childSrc).toMatch(/globals\.parallel\s*=\s*\(/);
    expect(childSrc).toMatch(/globals\.pipeline\s*=\s*\(/);
    expect(childSrc).toContain('runParallelLocal');
    expect(childSrc).toContain('runPipelineLocal');
    expect(childSrc).not.toMatch(/callPrimitive\(\s*['"]parallel['"]/);
    expect(childSrc).not.toMatch(/callPrimitive\(\s*['"]pipeline['"]/);
  });

  it('PROXIED_PRIMITIVES nao inclui parallel/pipeline/budget (control-flow/obj nao proxiam)', () => {
    expect(PROXIED_PRIMITIVES).not.toContain('parallel');
    expect(PROXIED_PRIMITIVES).not.toContain('pipeline');
    expect(PROXIED_PRIMITIVES).not.toContain('budget');
    expect(PROXIED_PRIMITIVES).toEqual(
      expect.arrayContaining(['phase', 'agent', 'gate', 'artifact', 'checkpoint', 'log']),
    );
  });

  it('o child real DISTINGUE fatal de recuperavel em parallel/pipeline (Finding 2 anti-drift)', () => {
    expect(childSrc).toContain('isFatalRejection');
    expect(childSrc).toMatch(/if\s*\(\s*fatalErr\s*\)\s*throw\s+fatalErr/);
    expect(childSrc).toContain('PrimitiveRejection');
    expect(childSrc).toMatch(/msg\.fatal\s*===\s*true/);
  });

  it('o child real honra failFast em parallel (Finding 2 caso 1 anti-drift)', () => {
    expect(childSrc).toMatch(/failFast\s*=\s*options\.failFast\s*===\s*true/);
    expect(childSrc).toMatch(/if\s*\(\s*failFast\s*\)\s*\{[\s\S]*?cancelled\s*=\s*true/);
    expect(childSrc).toMatch(/if\s*\(\s*cancelled\s*\|\|\s*fatalErr\s*\)\s*return/);
  });

  it('o child real roda as stages do pipeline em sequencia POR ITEM, sem barrier (Finding 2 caso 2 anti-drift)', () => {
    expect(childSrc).toContain('runItem');
    expect(childSrc).toMatch(/for\s*\(\s*const\s+stage\s+of\s+stages\s*\)/);
    expect(childSrc).toMatch(/acc\s*=\s*await\s+stage\s*\(\s*acc/);
  });
});

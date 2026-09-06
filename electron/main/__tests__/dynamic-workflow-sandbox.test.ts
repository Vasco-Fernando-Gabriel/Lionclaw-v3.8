
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runWorkflowSandbox,
  createNodeForkFactory,
  type SandboxProcessFactory,
  type SandboxProcessHandle,
  type WorkflowSandboxResult,
} from '../dynamic-workflows/workflow-sandbox';
import type {
  SandboxParentMessage,
  SandboxChildMessage,
} from '../dynamic-workflows/sandbox-protocol';
import { normalizeAgentArgs } from '../dynamic-workflows/workflow-sandbox-child';


interface FakeChild extends SandboxProcessHandle {
  readonly outbox: SandboxParentMessage[];
  emit(raw: unknown): void;
  exit(code: number | null, signal: string | null): void;
  readonly killCount: number;
  readonly wasKilled: boolean;
}

function makeFakeFactory(onChild: (child: FakeChild) => void): SandboxProcessFactory {
  return {
    spawn(): SandboxProcessHandle {
      const outbox: SandboxParentMessage[] = [];
      let messageCb: ((raw: unknown) => void) | null = null;
      let exitCb: ((code: number | null, signal: string | null) => void) | null = null;
      let killCount = 0;
      const child: FakeChild = {
        outbox,
        get killCount() {
          return killCount;
        },
        get wasKilled() {
          return killCount > 0;
        },
        send: (message) => {
          outbox.push(message);
        },
        onMessage: (cb) => {
          messageCb = cb;
        },
        onExit: (cb) => {
          exitCb = cb;
        },
        kill: () => {
          killCount += 1;
        },
        emit: (raw) => {
          messageCb?.(raw);
        },
        exit: (code, signal) => {
          exitCb?.(code, signal);
        },
      };
      onChild(child);
      return child;
    },
  };
}

function childMsg(msg: SandboxChildMessage): SandboxChildMessage {
  return msg;
}


describe('AC-2.1: blast radius - wall timeout (loop infinito)', () => {
  it('estoura o wall timeout e o pai mata o filho, sobrevivendo', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });

    const promise = runWorkflowSandbox({
      transformedSource: 'globalThis.__run = async () => {};',
      wallTimeoutMs: 60,
      idleTimeoutMs: 10_000, // idle alto: garante que o WALL e quem dispara
      factory,
      handlers: {},
    });

    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    const beat = setInterval(() => child.emit(childMsg({ t: 'heartbeat', uptimeMs: 1 })), 5);

    const result: WorkflowSandboxResult = await promise;
    clearInterval(beat);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('wall-timeout');
    expect(child.wasKilled).toBe(true);
    expect(typeof process.pid).toBe('number');
  });
});


describe('AC-2.1: blast radius - idle timeout (sem heartbeat)', () => {
  it('estoura o idle timeout quando o filho para de bater e o pai mata o filho', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });

    const promise = runWorkflowSandbox({
      transformedSource: 'globalThis.__run = async () => {};',
      wallTimeoutMs: 10_000, // wall alto: garante que o IDLE e quem dispara
      idleTimeoutMs: 50,
      factory,
      handlers: {},
    });

    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));

    const result = await promise;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('idle-timeout');
    expect(child.wasKilled).toBe(true);
  });

  it('heartbeats re-armam o idle timer (filho saudavel nao e morto a toa)', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });

    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 80,
      factory,
      handlers: {},
    });

    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    let beats = 0;
    const beat = setInterval(() => {
      child.emit(childMsg({ t: 'heartbeat', uptimeMs: beats * 25 }));
      beats += 1;
    }, 25);

    await new Promise((r) => setTimeout(r, 150));
    clearInterval(beat);
    child.emit(childMsg({ t: 'result', value: { ok: true } }));

    const result = await promise;
    expect(result.status).toBe('completed');
    if (result.status === 'completed') expect(result.value).toEqual({ ok: true });
  });
});


describe('AC-2.1: blast radius - crash do filho', () => {
  it('exit nao-zero antes do resultado vira erro tipado crash', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });

    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {},
    });

    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    child.exit(1, null); // crash

    const result = await promise;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('crash');
      expect(result.message).toContain('code=1');
    }
  });

  it('mensagem fatal do filho vira crash tipado', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });

    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {},
    });

    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    child.emit(childMsg({ t: 'fatal', message: 'ReferenceError: process is not defined' }));

    const result = await promise;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('crash');
      expect(result.message).toContain('process is not defined');
    }
  });
});


describe('protocolo allowlist (SPEC 8.0 P0)', () => {
  it('mensagem fora do protocolo mata o filho', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });

    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {},
    });

    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    child.emit({ t: 'evil', exec: 'rm -rf /' });

    const result = await promise;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('protocol-violation');
    expect(child.wasKilled).toBe(true);
  });

  it('protocolo incompativel no hello mata o filho', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {},
    });
    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 999 }));
    const result = await promise;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('protocol-violation');
  });

  it('call antes do handshake mata o filho', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: { log: () => undefined },
    });
    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'call', callId: 1, primitive: 'log', arg: { message: 'x' } }));
    const result = await promise;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('protocol-violation');
  });

  it('so entrega run() apos o handshake hello', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    const promise = runWorkflowSandbox({
      transformedSource: 'SOURCE-MARKER',
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {},
    });
    const child = captured as unknown as FakeChild;
    expect(child.outbox.find((m) => m.t === 'run')).toBeUndefined();
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    const runMsg = child.outbox.find((m) => m.t === 'run');
    expect(runMsg).toBeDefined();
    if (runMsg && runMsg.t === 'run') {
      expect(runMsg.transformedSource).toBe('SOURCE-MARKER');
      expect('budget' in runMsg).toBe(false);
    }
    child.emit(childMsg({ t: 'result', value: null }));
    await promise;
  });
});


describe('host API e guards de primitiva', () => {
  it('roteia call -> handler -> primitive-result', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    const calls: Array<{ primitive: string; arg: unknown }> = [];
    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {
        phase: (arg) => {
          calls.push({ primitive: 'phase', arg });
          return undefined;
        },
        agent: (arg) => {
          calls.push({ primitive: 'agent', arg });
          return { ok: true, findings: [] };
        },
      },
    });
    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    child.emit(childMsg({ t: 'call', callId: 1, primitive: 'phase', arg: 'Scout' }));
    child.emit(childMsg({ t: 'call', callId: 2, primitive: 'agent', arg: { id: 'x', agentId: 'a' } }));

    await new Promise((r) => setTimeout(r, 20));

    const results = child.outbox.filter((m) => m.t === 'primitive-result');
    expect(results.length).toBe(2);
    const r2 = results.find((m) => m.t === 'primitive-result' && m.callId === 2);
    expect(r2 && r2.t === 'primitive-result' ? r2.value : null).toEqual({ ok: true, findings: [] });
    expect(calls.map((c) => c.primitive)).toEqual(['phase', 'agent']);

    child.emit(childMsg({ t: 'result', value: null }));
    await promise;
  });

  it('artifact com path traversal e REJEITADO no protocolo (primitive-error), sem chamar o handler', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    let handlerCalled = false;
    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {
        artifact: () => {
          handlerCalled = true;
          return { ok: true };
        },
      },
    });
    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    child.emit(childMsg({ t: 'call', callId: 1, primitive: 'artifact', arg: { id: 'a', path: '../../etc/passwd' } }));
    await new Promise((r) => setTimeout(r, 15));

    const errs = child.outbox.filter((m) => m.t === 'primitive-error');
    expect(errs.length).toBe(1);
    expect(handlerCalled).toBe(false);

    child.emit(childMsg({ t: 'result', value: null }));
    await promise;
  });

  it('handler que lanca vira primitive-error (falha recuperavel do node)', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {
        agent: () => {
          throw new Error('policy invalida');
        },
      },
    });
    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    child.emit(childMsg({ t: 'call', callId: 7, primitive: 'agent', arg: {} }));
    await new Promise((r) => setTimeout(r, 15));
    const err = child.outbox.find((m) => m.t === 'primitive-error');
    expect(err && err.t === 'primitive-error' ? err.message : '').toContain('policy invalida');
    child.emit(childMsg({ t: 'result', value: null }));
    await promise;
  });
});


describe('ctx.input no run message (sec 6; autonomy fora do fio)', () => {
  it('forwarda input no run message quando presente, SEM campo autonomy (removido do fio)', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      input: { pauseAfterPlan: true },
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {},
    });
    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    const runMsg = child.outbox.find((m) => m.t === 'run');
    expect(runMsg).toBeDefined();
    if (runMsg && runMsg.t === 'run') {
      expect('autonomy' in runMsg).toBe(false);
      expect(runMsg.input).toEqual({ pauseAfterPlan: true });
    }
    child.emit(childMsg({ t: 'result', value: null }));
    await promise;
  });

  it('OMITE autonomy/input do run message quando ausentes (compat retro)', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {},
    });
    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    const runMsg = child.outbox.find((m) => m.t === 'run');
    expect(runMsg).toBeDefined();
    if (runMsg && runMsg.t === 'run') {
      expect('autonomy' in runMsg).toBe(false);
      expect('input' in runMsg).toBe(false);
      expect('maxPlanRounds' in runMsg).toBe(false);
      expect('maxDevRounds' in runMsg).toBe(false);
      expect('agentCatalog' in runMsg).toBe(false);
    }
    child.emit(childMsg({ t: 'result', value: null }));
    await promise;
  });

  it('forwarda agentCatalog (id/name/description) no run message quando presente', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      agentCatalog: [
        { id: 'typescript-pro', name: 'TypeScript Pro', description: 'TS/Node' },
        { id: 'electron-pro', name: 'Electron Pro' },
      ],
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {},
    });
    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    const runMsg = child.outbox.find((m) => m.t === 'run');
    expect(runMsg).toBeDefined();
    if (runMsg && runMsg.t === 'run') {
      expect(runMsg.agentCatalog).toEqual([
        { id: 'typescript-pro', name: 'TypeScript Pro', description: 'TS/Node' },
        { id: 'electron-pro', name: 'Electron Pro' },
      ]);
    }
    child.emit(childMsg({ t: 'result', value: null }));
    await promise;
  });

  it('FIX-F2a: forwarda maxPlanRounds/maxDevRounds no run message quando presentes', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      maxPlanRounds: 5,
      maxDevRounds: 4,
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {},
    });
    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    const runMsg = child.outbox.find((m) => m.t === 'run');
    expect(runMsg).toBeDefined();
    if (runMsg && runMsg.t === 'run') {
      expect(runMsg.maxPlanRounds).toBe(5);
      expect(runMsg.maxDevRounds).toBe(4);
    }
    child.emit(childMsg({ t: 'result', value: null }));
    await promise;
  });
});


const tmpFiles: string[] = [];
function writeTmpChild(name: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-wf-sandbox-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  tmpFiles.push(file);
  return file;
}

afterEach(() => {
  while (tmpFiles.length) {
    const f = tmpFiles.pop();
    try {
      if (f) fs.rmSync(path.dirname(f), { recursive: true, force: true });
    } catch {
    }
  }
});

describe('processo filho REAL (child_process.fork): AC-2 isolamento e AC-2.1 crash de SO', () => {
  it('contexto vm LIMPO nao expoe process/require/Math.random/Date.now/fs (AC-2)', async () => {
    const childSrc = `
const vm = require('node:vm');
const probe = [
  "typeof process",
  "typeof require",
  "typeof globalThis.process",
  "typeof Buffer",
  "typeof (Math && Math.random)",
  "typeof (Date && Date.now)",
];
// Contexto LIMPO: so primitivas, sem Node globals (igual ao child real).
const sandbox = { phase: () => {}, log: () => {} };
const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
const results = {};
for (const expr of probe) {
  try {
    results[expr] = new vm.Script("(" + expr + ")").runInContext(ctx);
  } catch (e) {
    results[expr] = "threw:" + (e && e.name);
  }
}
// fs so existe se houver require dentro do ctx.
let fsReachable = true;
try {
  fsReachable = new vm.Script("(typeof require === 'function')").runInContext(ctx);
} catch { fsReachable = false; }
process.send({ t: 'hello', protocol: 1 });
process.on('message', (m) => {
  if (m && m.t === 'run') {
    process.send({ t: 'result', value: { results, fsReachable } });
  }
});
`;
    const childFile = writeTmpChild('probe-child.cjs', childSrc);
    const factory = createNodeForkFactory(childFile);

    const result = await runWorkflowSandbox({
      transformedSource: 'ignored-by-probe',
      wallTimeoutMs: 8_000,
      idleTimeoutMs: 8_000,
      factory,
      handlers: {},
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      const value = result.value as { results: Record<string, string>; fsReachable: boolean };
      expect(value.results['typeof process']).toBe('undefined');
      expect(value.results['typeof require']).toBe('undefined');
      expect(value.results['typeof globalThis.process']).toBe('undefined');
      expect(value.results['typeof Buffer']).toBe('undefined');
      expect(value.fsReachable).toBe(false); // sem require, fs e inalcancavel
    }
  });

  it('ctx.autonomy fixo "auto" + ctx.input chegam dentro do vm do filho real (sec 6, FASE 4b-D2)', async () => {
    const childSrc = `
const vm = require('node:vm');
process.send({ t: 'hello', protocol: 1 });
process.on('message', (m) => {
  if (m && m.t === 'run') {
    const sandbox = { phase: () => {}, log: () => {} };
    sandbox.autonomy = 'auto'; // FIXO no child real (nao vem do fio)
    sandbox.input = m.input || {};
    const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    // run(ctx) usa o gate de entrega UNICO (espelho do workflow.js modo unico).
    const src = "globalThis.__out = (function (ctx) {"
      + " var deliveryGate = 'gate-delivery';"
      + " var pauseAfterPlan = !!(ctx.input && ctx.input.pauseAfterPlan);"
      + " return { autonomy: ctx.autonomy, deliveryGate: deliveryGate, pauseAfterPlan: pauseAfterPlan }; })(globalThis);";
    new vm.Script(src).runInContext(ctx);
    process.send({ t: 'result', value: ctx.__out });
  }
});
`;
    const childFile = writeTmpChild('ctx-state-child.cjs', childSrc);
    const factory = createNodeForkFactory(childFile);

    const result = await runWorkflowSandbox({
      transformedSource: 'ignored-by-probe',
      input: { pauseAfterPlan: true },
      wallTimeoutMs: 8_000,
      idleTimeoutMs: 8_000,
      factory,
      handlers: {},
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      const value = result.value as {
        autonomy: string;
        deliveryGate: string;
        pauseAfterPlan: boolean;
      };
      expect(value.autonomy).toBe('auto');
      expect(value.deliveryGate).toBe('gate-delivery');
      expect(value.pauseAfterPlan).toBe(true);
    }
  });

  it('sem input o ctx do filho ve autonomy "auto" fixo e input {} (gate de entrega unico)', async () => {
    const childSrc = `
const vm = require('node:vm');
process.send({ t: 'hello', protocol: 1 });
process.on('message', (m) => {
  if (m && m.t === 'run') {
    const sandbox = { phase: () => {}, log: () => {} };
    sandbox.autonomy = 'auto'; // FIXO no child real (nao vem do fio)
    sandbox.input = m.input || {};
    const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const src = "globalThis.__out = (function (ctx) {"
      + " var deliveryGate = 'gate-delivery';"
      + " var pauseAfterPlan = !!(ctx.input && ctx.input.pauseAfterPlan);"
      + " return { autonomyType: typeof ctx.autonomy, deliveryGate: deliveryGate, pauseAfterPlan: pauseAfterPlan }; })(globalThis);";
    new vm.Script(src).runInContext(ctx);
    process.send({ t: 'result', value: ctx.__out });
  }
});
`;
    const childFile = writeTmpChild('ctx-state-fallback-child.cjs', childSrc);
    const factory = createNodeForkFactory(childFile);

    const result = await runWorkflowSandbox({
      transformedSource: 'ignored-by-probe',
      wallTimeoutMs: 8_000,
      idleTimeoutMs: 8_000,
      factory,
      handlers: {},
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      const value = result.value as {
        autonomyType: string;
        deliveryGate: string;
        pauseAfterPlan: boolean;
      };
      expect(value.autonomyType).toBe('string');
      expect(value.deliveryGate).toBe('gate-delivery');
      expect(value.pauseAfterPlan).toBe(false);
    }
  });

  it('crash de um processo de SO real (exit 1) -> erro tipado, pai sobrevive (AC-2.1 c)', async () => {
    const childSrc = `
process.send({ t: 'hello', protocol: 1 });
process.on('message', (m) => {
  if (m && m.t === 'run') {
    // Simula crash apos receber a ordem de execucao.
    process.exit(1);
  }
});
`;
    const childFile = writeTmpChild('crash-child.cjs', childSrc);
    const factory = createNodeForkFactory(childFile);

    const result = await runWorkflowSandbox({
      transformedSource: 'x',
      wallTimeoutMs: 8_000,
      idleTimeoutMs: 8_000,
      factory,
      handlers: {},
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('crash');
    }
    expect(typeof process.pid).toBe('number');
  });

  it('wall timeout mata um processo de SO real preso em loop infinito (AC-2.1 a)', async () => {
    const childSrc = `
process.send({ t: 'hello', protocol: 1 });
process.on('message', (m) => {
  if (m && m.t === 'run') {
    // Loop infinito bloqueante: nunca retorna result, nunca bate heartbeat.
    while (true) { /* spin */ }
  }
});
`;
    const childFile = writeTmpChild('loop-child.cjs', childSrc);
    const factory = createNodeForkFactory(childFile);

    const result = await runWorkflowSandbox({
      transformedSource: 'x',
      wallTimeoutMs: 300,
      idleTimeoutMs: 5_000,
      factory,
      handlers: {},
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('wall-timeout');
    }
    expect(typeof process.pid).toBe('number');
  });
});


describe('F1b: normalizeAgentArgs (assinatura dupla do agent)', () => {
  it('agent(prompt, opts) -> { prompt, ...opts }', () => {
    const out = normalizeAgentArgs(['faca X', { agentType: 'typescript-pro', label: 'coder', schema: 's' }]);
    expect(out).toEqual({ prompt: 'faca X', agentType: 'typescript-pro', label: 'coder', schema: 's' });
  });

  it('agent(prompt) sem opts -> { prompt }', () => {
    const out = normalizeAgentArgs(['so o prompt']);
    expect(out).toEqual({ prompt: 'so o prompt' });
  });

  it('agent(prompt, optsComIsolation) -> campos da parity claude-code fluem aditivamente', () => {
    const out = normalizeAgentArgs(['build', { agentType: 'a', isolation: 'worktree' }]);
    expect(out).toEqual({ prompt: 'build', agentType: 'a', isolation: 'worktree' });
  });

  it('2o arg nao-objeto e ignorado (so { prompt })', () => {
    expect(normalizeAgentArgs(['p', 'lixo'])).toEqual({ prompt: 'p' });
    expect(normalizeAgentArgs(['p', 42])).toEqual({ prompt: 'p' });
    expect(normalizeAgentArgs(['p', null])).toEqual({ prompt: 'p' });
  });

  it('forma-objeto legada agent({ id, agentId, prompt }) e BYTE-IDENTICA (mesma referencia, intacta)', () => {
    const legacy = { id: 'n1', agentId: 'a1', prompt: 'faca', access: 'read-only' };
    const out = normalizeAgentArgs([legacy]);
    expect(out).toBe(legacy);
    expect(out).toEqual({ id: 'n1', agentId: 'a1', prompt: 'faca', access: 'read-only' });
  });

  it('forma-objeto legada sem 2o arg permanece o proprio objeto', () => {
    const legacy = { id: 'x', agentId: 'y', prompt: 'z' };
    expect(normalizeAgentArgs([legacy])).toBe(legacy);
  });
});

describe('F1b: o arg normalizado de agent cruza o protocolo ate o host (e nao mata o filho)', () => {
  it('call agent com { prompt, agentType, label } chega ao handler intacto; phase/log/gate inalterados', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    const calls: Array<{ primitive: string; arg: unknown }> = [];
    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {
        phase: (arg) => {
          calls.push({ primitive: 'phase', arg });
          return undefined;
        },
        log: (arg) => {
          calls.push({ primitive: 'log', arg });
          return undefined;
        },
        gate: (arg) => {
          calls.push({ primitive: 'gate', arg });
          return { ok: true };
        },
        agent: (arg) => {
          calls.push({ primitive: 'agent', arg });
          return { ok: true, findings: [] };
        },
      },
    });
    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    const normalizedAgentArg = normalizeAgentArgs([
      'faca X',
      { id: 'n1', agentId: 'a1', agentType: 'typescript-pro', label: 'coder' },
    ]);
    child.emit(childMsg({ t: 'call', callId: 1, primitive: 'phase', arg: 'Scout' }));
    child.emit(childMsg({ t: 'call', callId: 2, primitive: 'agent', arg: normalizedAgentArg }));
    child.emit(childMsg({ t: 'call', callId: 3, primitive: 'log', arg: { message: 'oi' } }));
    child.emit(childMsg({ t: 'call', callId: 4, primitive: 'gate', arg: { id: 'g1', mode: 'auto' } }));

    await new Promise((r) => setTimeout(r, 25));

    expect(child.wasKilled).toBe(false);
    const results = child.outbox.filter((m) => m.t === 'primitive-result');
    expect(results.length).toBe(4);

    const agentCall = calls.find((c) => c.primitive === 'agent');
    expect(agentCall?.arg).toEqual({
      prompt: 'faca X',
      id: 'n1',
      agentId: 'a1',
      agentType: 'typescript-pro',
      label: 'coder',
    });
    expect(calls.find((c) => c.primitive === 'phase')?.arg).toBe('Scout');
    expect(calls.find((c) => c.primitive === 'log')?.arg).toEqual({ message: 'oi' });
    expect(calls.find((c) => c.primitive === 'gate')?.arg).toEqual({ id: 'g1', mode: 'auto' });

    child.emit(childMsg({ t: 'result', value: null }));
    await promise;
  });

  it('agent na forma-objeto legada cruza identico (id/agentId/prompt preservados)', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    let receivedAgentArg: unknown = undefined;
    const promise = runWorkflowSandbox({
      transformedSource: 'x',
      wallTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {
        agent: (arg) => {
          receivedAgentArg = arg;
          return { ok: true };
        },
      },
    });
    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    const legacyArg = normalizeAgentArgs([{ id: 'n9', agentId: 'a9', prompt: 'legado' }]);
    child.emit(childMsg({ t: 'call', callId: 1, primitive: 'agent', arg: legacyArg }));
    await new Promise((r) => setTimeout(r, 20));

    expect(child.wasKilled).toBe(false);
    expect(receivedAgentArg).toEqual({ id: 'n9', agentId: 'a9', prompt: 'legado' });

    child.emit(childMsg({ t: 'result', value: null }));
    await promise;
  });
});


describe('D11: wallTimeoutMs opcional em runWorkflowSandbox', () => {
  it('AUSENTE: o filho sobrevive alem de qualquer teto curto e conclui normalmente (idle continua armado)', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    const promise = runWorkflowSandbox({
      transformedSource: 'globalThis.__run = async () => {};',
      idleTimeoutMs: 10_000,
      factory,
      handlers: {},
    });
    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    const beat = setInterval(() => child.emit(childMsg({ t: 'heartbeat', uptimeMs: 1 })), 5);
    await new Promise((r) => setTimeout(r, 150));
    expect(child.wasKilled).toBe(false);
    child.emit(childMsg({ t: 'result', value: { ok: true } }));
    const result: WorkflowSandboxResult = await promise;
    clearInterval(beat);
    expect(result.status).toBe('completed');
  });

  it('PRESENTE: continua matando com reason wall-timeout (contrato preservado para quem passa valor)', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    const promise = runWorkflowSandbox({
      transformedSource: 'globalThis.__run = async () => {};',
      wallTimeoutMs: 40,
      idleTimeoutMs: 10_000,
      factory,
      handlers: {},
    });
    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    const beat = setInterval(() => child.emit(childMsg({ t: 'heartbeat', uptimeMs: 1 })), 5);
    const result: WorkflowSandboxResult = await promise;
    clearInterval(beat);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('wall-timeout');
    expect(child.wasKilled).toBe(true);
  });

  it('AUSENTE: o IDLE continua sendo o freio (sem heartbeat => idle-timeout)', async () => {
    let captured: FakeChild | null = null;
    const factory = makeFakeFactory((c) => {
      captured = c;
    });
    const promise = runWorkflowSandbox({
      transformedSource: 'globalThis.__run = async () => {};',
      idleTimeoutMs: 40,
      factory,
      handlers: {},
    });
    const child = captured as unknown as FakeChild;
    child.emit(childMsg({ t: 'hello', protocol: 1 }));
    const result: WorkflowSandboxResult = await promise;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('idle-timeout');
  });
});

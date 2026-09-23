import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { buildSandboxGlobals, createSandboxVmContext } from '../dynamic-workflows/workflow-sandbox-child';
import { compileWorkflowJs } from '../dynamic-workflows/workflow-js-compiler';
import { parseParentMessage } from '../dynamic-workflows/sandbox-protocol';

function runInSandbox(source: string, input?: Record<string, unknown>): unknown {
  const sandbox = buildSandboxGlobals({ input });
  const context = createSandboxVmContext(sandbox);
  return new vm.Script(source, { filename: 'workflow.js' }).runInContext(context);
}

describe('determinismo em runtime no vm: Date.now', () => {
  it('acesso computado globalThis["Da"+"te"].now() LANCA com a mensagem de determinismo', () => {
    expect(() => runInSandbox('globalThis["Da" + "te"].now()')).toThrow(
      /Determinismo do workflow: Date\.now\(\) e proibido/,
    );
  });

  it('acesso direto Date.now() tambem lanca (defesa alem do regex de compile)', () => {
    expect(() => runInSandbox('Date.now()')).toThrow(/Determinismo do workflow: Date\.now\(\) e proibido/);
  });
});

describe('determinismo em runtime no vm: Math.random', () => {
  it('acesso computado globalThis["Ma"+"th"].random() LANCA com a mensagem de determinismo', () => {
    expect(() => runInSandbox('globalThis["Ma" + "th"].random()')).toThrow(
      /Determinismo do workflow: Math\.random\(\) e proibido/,
    );
  });

  it('o resto de Math continua funcionando (floor/max/abs/PI)', () => {
    expect(runInSandbox('Math.floor(3.7) + Math.max(1, 2) + Math.abs(-4)')).toBe(9);
    expect(runInSandbox('Math.PI')).toBeCloseTo(Math.PI);
  });
});

describe('determinismo em runtime no vm: new Date()', () => {
  it('new Date() SEM argumentos lanca com a mensagem de determinismo', () => {
    expect(() => runInSandbox('new Date()')).toThrow(
      /Determinismo do workflow: new Date\(\) sem argumentos e proibido/,
    );
  });

  it('new Date(1234567890) funciona e preserva getTime/toISOString/instanceof', () => {
    const out = runInSandbox(
      `(() => {
        const d = new Date(1234567890);
        return { time: d.getTime(), iso: d.toISOString(), isDate: d instanceof Date };
      })()`,
    ) as { time: number; iso: string; isDate: boolean };
    expect(out.time).toBe(1234567890);
    expect(out.iso).toBe(new Date(1234567890).toISOString());
    expect(out.isDate).toBe(true);
  });

  it('Date.parse e Date.UTC continuam ok (so o relogio corrente e proibido)', () => {
    expect(runInSandbox("Date.parse('2026-01-02T03:04:05.000Z')")).toBe(Date.parse('2026-01-02T03:04:05.000Z'));
    expect(runInSandbox('Date.UTC(2026, 0, 2)')).toBe(Date.UTC(2026, 0, 2));
  });

  it('o neutering vive SO no contexto vm: Date/Math do processo de teste ficam intactos', () => {
    expect(typeof Date.now()).toBe('number');
    expect(typeof Math.random()).toBe('number');
    expect(new Date()).toBeInstanceOf(Date);
  });
});

describe('global args (paridade claude-code)', () => {
  it('args === input no sandbox (mesma referencia, alias aditivo)', () => {
    const input = { pauseAfterPlan: true, foo: 'bar' };
    const globals = buildSandboxGlobals({ input });
    expect(globals.args).toBe(globals.input);
    expect(globals.args).toBe(input);
  });

  it('sem input, args e o MESMO objeto {} default de input', () => {
    const globals = buildSandboxGlobals({});
    expect(globals.input).toEqual({});
    expect(globals.args).toBe(globals.input);
  });

  it('um .js claude-code que usa `args` compila e roda no contexto vm', async () => {
    const source = [
      "export const meta = { name: 'usa-args', description: 'le o input via args' };",
      "const saudacao = 'oi, ' + args.nome;",
      'return { saudacao, mesmo: args === input };',
    ].join('\n');
    const compiled = compileWorkflowJs(source);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const sandbox = buildSandboxGlobals({ input: { nome: 'breno' } });
    const context = createSandboxVmContext(sandbox);
    new vm.Script(compiled.transformedSource, { filename: 'workflow.js' }).runInContext(context);
    const runFn = (sandbox as { __run?: (c: unknown) => Promise<unknown> }).__run;
    expect(typeof runFn).toBe('function');
    const out = (await runFn!(sandbox)) as { saudacao: string; mesmo: boolean };
    expect(out.saudacao).toBe('oi, breno');
    expect(out.mesmo).toBe(true);
  });
});

describe('budget removido por completo: sem stub no ctx nem no protocolo', () => {
  it('o ctx do vm NAO expoe global budget (nem stub)', () => {
    const globals = buildSandboxGlobals({});
    expect('budget' in globals).toBe(false);
  });

  it('um .js antigo que referencia budget quebra com ReferenceError (aceito por desenho)', () => {
    expect(() => runInSandbox('budget.total')).toThrow(/budget is not defined/);
  });

  it('o payload run do protocolo NAO carrega budget (parse aceita run sem o campo)', () => {
    const parsed = parseParentMessage({ t: 'run', transformedSource: 'globalThis.__run = async () => {};' });
    expect(parsed).not.toBeNull();
    expect(parsed && 'budget' in parsed).toBe(false);
  });
});

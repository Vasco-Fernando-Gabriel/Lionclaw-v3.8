import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import {
  compileWorkflowJs,
  extractWorkflowMeta,
  transformToVmSource,
  stripStringsAndComments,
} from '../dynamic-workflows/workflow-js-compiler';
import { isSafeArtifactRelativePath } from '../dynamic-workflows/sandbox-protocol';

const CC_MINIMAL_VALID = `
export const meta = {
  name: 'cc-mini',
  description: 'workflow no modo claude-code'
};

phase('Scout');
log('oi do claude-code');
const scout = await agent({ id: 'scout', agentId: 'a', access: 'read-only' });
return { ok: true, scout };
`;

describe('workflow-js-compiler: gramatica claude-code (unica)', () => {
  it('compila meta {name, description} (sem phases) + corpo top-level com await/return', () => {
    const r = compileWorkflowJs(CC_MINIMAL_VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta.name).toBe('cc-mini');
    expect(r.meta.description).toBe('workflow no modo claude-code');
    expect(r.meta.phases).toEqual([]);
    expect(r.transformedSource).toContain('globalThis.__run = async (ctx) =>');
    expect(r.transformedSource).not.toMatch(/export\s+const\s+meta/);
    expect(r.transformedSource).not.toMatch(/export\s+default/);
  });

  it('o transform roda no vm, define __run e ele RETORNA o valor top-level', async () => {
    const r = compileWorkflowJs(CC_MINIMAL_VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const calls: string[] = [];
    const sandbox: Record<string, unknown> = {
      phase: (p: string) => calls.push('phase:' + p),
      log: (m: string) => calls.push('log:' + m),
      agent: async (cfg: { id: string }) => ({ id: cfg.id, ran: true }),
    };
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const script = new vm.Script(r.transformedSource, { filename: 'workflow.js' });
    expect(() => script.runInContext(context)).not.toThrow();
    expect(typeof sandbox.__run).toBe('function');
    const value = await (sandbox.__run as (c: unknown) => Promise<unknown>)(sandbox);
    expect(value).toEqual({ ok: true, scout: { id: 'scout', ran: true } });
    expect(calls).toEqual(['phase:Scout', 'log:oi do claude-code']);
  });

  it('extractWorkflowMeta aceita phases presente (array de strings)', () => {
    const src = `export const meta = { name: 'n', description: 'd', phases: ['A', 'B'] };\nawait agent({ id: 'x' });`;
    const r = extractWorkflowMeta(src);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta.phases).toEqual(['A', 'B']);
  });
});

describe('workflow-js-compiler: LEGADO do modo manifest morre no compile normal', () => {
  it('um .js do modo manifest antigo (run + meta sem description) falha com invalid-meta', () => {
    const legacy = `
export const meta = {
  name: 'mini',
  phases: ['Scout', 'Gate']
};

export default async function run({ phase, gate, log }) {
  phase('Scout');
  log('oi');
  const decision = await gate({ id: 'g', mode: 'human', checks: [] });
  return { ok: decision.ok };
}
`;
    const r = compileWorkflowJs(legacy);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === 'invalid-meta')).toBe(true);
    }
  });
});

describe('workflow-js-compiler: extracao estatica de meta (sem executar)', () => {
  it('rejeita meta NAO literal (variavel/call/interpolacao)', () => {
    const dyn = `
export const meta = { name: 'x', description: 'd', phases: buildPhases() };
return {};
`;
    const r = extractWorkflowMeta(dyn);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid-meta');
  });

  it('rejeita ausencia de meta', () => {
    const r = extractWorkflowMeta(`await agent({ id: 'x' });`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('missing-meta');
  });

  it('meta SEM description falha', () => {
    const src = `export const meta = { name: 'so-name' };\nreturn {};`;
    const r = compileWorkflowJs(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'invalid-meta')).toBe(true);
  });

  it('meta com phases NAO array de strings falha', () => {
    const src = `export const meta = { name: 'n', description: 'd', phases: [1, 2] };\nreturn {};`;
    const r = compileWorkflowJs(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'invalid-meta')).toBe(true);
  });
});

describe('workflow-js-compiler: AC-2 rejeicao estatica de API proibida', () => {
  const cases: Array<{ label: string; src: string; code: string }> = [
    {
      label: 'require()',
      src: `export const meta = { name: 'n', description: 'd' };\nconst fs = require('fs');\nreturn {};`,
      code: 'forbidden-import',
    },
    {
      label: 'import estatico',
      src: `import fs from 'fs';\nexport const meta = { name: 'n', description: 'd' };\nreturn {};`,
      code: 'forbidden-import',
    },
    {
      label: 'import dinamico',
      src: `export const meta = { name: 'n', description: 'd' };\nawait import('fs');\nreturn {};`,
      code: 'forbidden-import',
    },
    {
      label: 'process',
      src: `export const meta = { name: 'n', description: 'd' };\nreturn { cwd: process.cwd() };`,
      code: 'forbidden-api',
    },
    {
      label: 'Date.now',
      src: `export const meta = { name: 'n', description: 'd' };\nreturn { t: Date.now() };`,
      code: 'nondeterministic',
    },
    {
      label: 'Math.random',
      src: `export const meta = { name: 'n', description: 'd' };\nreturn { r: Math.random() };`,
      code: 'nondeterministic',
    },
    {
      label: 'new Date() sem arg',
      src: `export const meta = { name: 'n', description: 'd' };\nreturn { d: new Date() };`,
      code: 'nondeterministic',
    },
    {
      label: 'new Function',
      src: `export const meta = { name: 'n', description: 'd' };\nconst f = new Function('return 1');\nreturn {};`,
      code: 'forbidden-api',
    },
    {
      label: 'eval',
      src: `export const meta = { name: 'n', description: 'd' };\nreturn eval('1+1');`,
      code: 'forbidden-api',
    },
    {
      label: 'globalThis',
      src: `export const meta = { name: 'n', description: 'd' };\nreturn globalThis;`,
      code: 'forbidden-api',
    },
  ];

  for (const c of cases) {
    it(`rejeita ${c.label}`, () => {
      const r = compileWorkflowJs(c.src);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors.some((e) => e.code === c.code)).toBe(true);
      }
    });
  }

  it('new Date(ts) COM argumento e permitido (nao quebra determinismo)', () => {
    const src = `export const meta = { name: 'n', description: 'd' };\nconst d = new Date(0);\nreturn { y: d.getFullYear() };`;
    const r = compileWorkflowJs(src);
    expect(r.ok).toBe(true);
  });

  it('menciona API proibida DENTRO de string de prompt nao gera falso-positivo', () => {
    const src = `export const meta = { name: 'n', description: 'd' };\nreturn await agent({ id: 'x', agentId: 'a', prompt: 'use require() e process.env e Math.random no seu raciocinio textual' });`;
    const r = compileWorkflowJs(src);
    expect(r.ok).toBe(true);
  });

  it('rejeita export extra fora do subset (so meta e permitido)', () => {
    const src = `export const meta = { name: 'n', description: 'd' };\nexport const helper = 1;\nreturn {};`;
    const r = compileWorkflowJs(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'forbidden-export')).toBe(true);
  });
});

describe('workflow-js-compiler: stripStringsAndComments preserva offsets', () => {
  it('zera conteudo de strings/comentarios mantendo o comprimento', () => {
    const src = `const a = 'process.exit()'; // require('fs')\nconst b = 1;`;
    const stripped = stripStringsAndComments(src);
    expect(stripped.length).toBe(src.length);
    expect(stripped).not.toContain('process.exit');
    expect(stripped).not.toContain("require('fs')");
    expect(stripped).toContain('const a =');
    expect(stripped).toContain('const b = 1;');
  });
});

describe('sandbox-protocol: guard de path do artifact (SPEC 3.2/7.3)', () => {
  it('aceita path relativo dentro do run dir', () => {
    expect(isSafeArtifactRelativePath('artifacts/delivery.md')).toBe(true);
    expect(isSafeArtifactRelativePath('checkpoints/scout.json')).toBe(true);
  });

  it('rejeita traversal, absoluto, drive do Windows, home e controle', () => {
    expect(isSafeArtifactRelativePath('../escape.md')).toBe(false);
    expect(isSafeArtifactRelativePath('a/../../etc/passwd')).toBe(false);
    expect(isSafeArtifactRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeArtifactRelativePath('~/secret')).toBe(false);
    expect(isSafeArtifactRelativePath('C:\\Windows\\x')).toBe(false);
    expect(isSafeArtifactRelativePath('\\\\server\\share')).toBe(false);
    expect(isSafeArtifactRelativePath('..\\win')).toBe(false);
    expect(isSafeArtifactRelativePath('')).toBe(false);
    expect(isSafeArtifactRelativePath(42)).toBe(false);
    expect(isSafeArtifactRelativePath('a' + String.fromCharCode(0) + 'b')).toBe(false);
  });
});

describe('transformToVmSource: envelopa o corpo top-level', () => {
  it('remove o export do meta e envelopa em __run', () => {
    const out = transformToVmSource(CC_MINIMAL_VALID);
    expect(out).toContain('globalThis.__run = async (ctx) =>');
    expect(out).not.toMatch(/export\s+const\s+meta/);
    expect(out).not.toMatch(/export\s+default/);
  });
});

describe('workflow-js-compiler: claude-code edge/fuzz', () => {
  it('corpo vazio (so meta) compila: __run existe e retorna undefined', async () => {
    const src = `export const meta = { name: 'vazio', description: 'sem corpo' };`;
    const r = compileWorkflowJs(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sandbox: Record<string, unknown> = {};
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    new vm.Script(r.transformedSource, { filename: 'workflow.js' }).runInContext(context);
    expect(typeof sandbox.__run).toBe('function');
    const value = await (sandbox.__run as (c: unknown) => Promise<unknown>)(sandbox);
    expect(value).toBeUndefined();
  });

  it('top-level await fora de agent() funciona no envelope', async () => {
    const src = `export const meta = { name: 'n', description: 'd' };\nconst x = await Promise.resolve(7);\nreturn { x };`;
    const r = compileWorkflowJs(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sandbox: Record<string, unknown> = { Promise };
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    new vm.Script(r.transformedSource, { filename: 'workflow.js' }).runInContext(context);
    const value = await (sandbox.__run as (c: unknown) => Promise<unknown>)(sandbox);
    expect(value).toEqual({ x: 7 });
  });

  it('multiplas phases() on-the-fly no corpo top-level compilam e executam em ordem', async () => {
    const src = `export const meta = { name: 'n', description: 'd' };
phase('Scout');
phase('Build');
phase('Gate');
return { done: true };`;
    const r = compileWorkflowJs(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const seen: string[] = [];
    const sandbox: Record<string, unknown> = { phase: (p: string) => seen.push(p) };
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    new vm.Script(r.transformedSource, { filename: 'workflow.js' }).runInContext(context);
    const value = await (sandbox.__run as (c: unknown) => Promise<unknown>)(sandbox);
    expect(value).toEqual({ done: true });
    expect(seen).toEqual(['Scout', 'Build', 'Gate']);
  });
});

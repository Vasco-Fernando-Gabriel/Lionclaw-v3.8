import { describe, it, expect } from 'vitest';
import {
  resolveGateChecks,
  splitCommand,
  type GateCheckResolutionContext,
} from '../dynamic-workflows/workflow-gate-resolver';
import { runGateChecks, type GateCheckSpec } from '../dynamic-workflows/workflow-gates';

const RC: GateCheckResolutionContext = {
  repoRoot: '/repo',
  protectedPaths: ['electron/main/agent-runtime', 'src/types/pipeline.ts'],
  touchedFiles: ['src/foo.ts', 'src/bar.ts'],
  nodeOutputs: {
    'validator-correctness-r0': { verdict: 'pass', findings: [] },
    'validator-skeptic-r0': { verdict: 'pass', findings: [] },
  },
  defaultSchemaRequiredKeys: ['verdict', 'findings'],
  baselineMaxErrorsByCommand: { 'npm run test': 63 },
};

function fakeRunner(byBin: Record<string, { status: number; stdout: string; stderr: string }>) {
  return (command: string, _args: string[]) => {
    const r = byBin[command] ?? { status: 127, stdout: '', stderr: '' };
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, timedOut: false };
  };
}

describe('splitCommand', () => {
  it('quebra "npm run typecheck" em bin+args', () => {
    expect(splitCommand('npm run typecheck')).toEqual({ bin: 'npm', args: ['run', 'typecheck'] });
  });
  it('tolera espacos multiplos e trim', () => {
    expect(splitCommand('  npm   run   test  ')).toEqual({ bin: 'npm', args: ['run', 'test'] });
  });
});

describe('resolveGateChecks: command (a)', () => {
  it('resolve "npm run typecheck" + maxErrors em {command, args, cwd, maxErrors}', () => {
    const resolved = resolveGateChecks(
      [{ kind: 'command', command: 'npm run typecheck', maxErrors: 123 } as unknown as GateCheckSpec],
      RC,
    );
    const c = resolved[0] as unknown as Record<string, unknown>;
    expect(c.command).toBe('npm');
    expect(c.args).toEqual(['run', 'typecheck']);
    expect(c.cwd).toBe('/repo');
    expect(c.maxErrors).toBe(123);
  });

  it('resolve baselineRef simbolico em maxErrors concreto (context-bundle.baselineResults)', () => {
    const resolved = resolveGateChecks(
      [
        {
          kind: 'command',
          command: 'npm run test',
          baselineRef: 'context-bundle.baselineResults',
        } as unknown as GateCheckSpec,
      ],
      RC,
    );
    const c = resolved[0] as unknown as Record<string, unknown>;
    expect(c.command).toBe('npm');
    expect(c.args).toEqual(['run', 'test']);
    expect(c.maxErrors).toBe(63);
  });

  it('NAO da falso-positivo: comando resolvido roda o bin certo e o veredito reflete erros reais', () => {
    const resolved = resolveGateChecks(
      [{ kind: 'command', command: 'npm run typecheck', maxErrors: 0 } as unknown as GateCheckSpec],
      RC,
    );
    const red = runGateChecks(resolved, 'auto', {
      runCommand: fakeRunner({ npm: { status: 1, stdout: 'error one\nerror two', stderr: '' } }),
    });
    expect(red.ok).toBe(false);
    const green = runGateChecks(resolved, 'auto', {
      runCommand: fakeRunner({ npm: { status: 0, stdout: 'ok', stderr: '' } }),
    });
    expect(green.ok).toBe(true);
  });

  it('command ja concreto (com args) passa intacto (idempotente)', () => {
    const concrete = { kind: 'command', id: 'x', command: 'npm', args: ['run', 'build'] };
    const resolved = resolveGateChecks([concrete as unknown as GateCheckSpec], RC);
    expect(resolved[0]).toBe(concrete as unknown as GateCheckSpec);
  });
});

describe('resolveGateChecks: containment (b)', () => {
  it('resolve protectedPaths STRING para [] real + touchedFiles do run; runGateChecks NAO lanca', () => {
    const resolved = resolveGateChecks(
      [
        {
          kind: 'containment',
          protectedPaths: 'context-bundle.protectedPaths',
        } as unknown as GateCheckSpec,
      ],
      RC,
    );
    const c = resolved[0] as unknown as Record<string, unknown>;
    expect(Array.isArray(c.protectedPaths)).toBe(true);
    expect(c.protectedPaths).toEqual(RC.protectedPaths);
    expect(c.touchedFiles).toEqual(RC.touchedFiles);
    expect(c.baseDir).toBe('/repo');
    const run = runGateChecks(resolved, 'auto');
    expect(run.ok).toBe(true);
  });

  it('detecta violacao quando um touched cai sob protected', () => {
    const rc: GateCheckResolutionContext = {
      ...RC,
      touchedFiles: ['electron/main/agent-runtime/execute.ts'], // sob protected
    };
    const resolved = resolveGateChecks(
      [{ kind: 'containment', protectedPaths: 'context-bundle.protectedPaths' } as unknown as GateCheckSpec],
      rc,
    );
    const run = runGateChecks(resolved, 'auto');
    expect(run.ok).toBe(false);
  });
});

describe('resolveGateChecks: schema (c)', () => {
  it('resolve nodeIds em UM check por node com value=output + requiredKeys', () => {
    const resolved = resolveGateChecks(
      [
        {
          kind: 'schema',
          nodeIds: ['validator-correctness-r0', 'validator-skeptic-r0'],
        } as unknown as GateCheckSpec,
      ],
      RC,
    );
    expect(resolved).toHaveLength(2);
    const run = runGateChecks(resolved, 'auto');
    expect(run.ok).toBe(true);
  });

  it('node sem output -> value undefined -> reprova (veredito CORRETO, nao falso-positivo)', () => {
    const resolved = resolveGateChecks([{ kind: 'schema', nodeIds: ['nao-existe'] } as unknown as GateCheckSpec], RC);
    const run = runGateChecks(resolved, 'auto');
    expect(run.ok).toBe(false);
  });

  it('schema ja concreto (value presente) passa intacto', () => {
    const resolved = resolveGateChecks(
      [{ kind: 'schema', id: 'c1', value: { verdict: 'ok' }, requiredKeys: ['verdict'] } as unknown as GateCheckSpec],
      RC,
    );
    const run = runGateChecks(resolved, 'auto');
    expect(run.ok).toBe(true);
  });
});

describe('resolveGateChecks: o pacote simbolico do template inteiro', () => {
  it('resolve os 4 checks do gate-global e o runGateChecks REAL produz ok com fakes verdes', () => {
    const symbolic = [
      { kind: 'schema', nodeIds: ['validator-correctness-r0', 'validator-skeptic-r0'] },
      { kind: 'command', command: 'npm run typecheck', maxErrors: 123 },
      { kind: 'command', command: 'npm run test', baselineRef: 'context-bundle.baselineResults' },
      { kind: 'containment', protectedPaths: 'context-bundle.protectedPaths' },
    ] as unknown as GateCheckSpec[];
    const resolved = resolveGateChecks(symbolic, RC);
    const run = runGateChecks(resolved, 'auto', {
      runCommand: fakeRunner({ npm: { status: 0, stdout: '', stderr: '' } }),
    });
    expect(run.ok).toBe(true);
    expect(run.checks).toHaveLength(5);
    expect(run.checks.every((c) => c.ok)).toBe(true);
  });
});

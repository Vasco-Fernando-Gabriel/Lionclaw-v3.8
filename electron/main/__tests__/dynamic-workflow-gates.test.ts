
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runGateChecks,
  resolveSpawnTarget,
  type GateCheckSpec,
  type CommandRunner,
} from '../dynamic-workflows/workflow-gates';

describe('workflow-gates: command check (typecheck/tests/build com baseline)', () => {
  it('passa quando errorCount <= maxErrors (baseline do bundle)', () => {
    const runner: CommandRunner = () => ({
      status: 1,
      stdout: Array.from({ length: 123 }, (_, i) => `src/a.ts(${i}): error TS1: x`).join('\n'),
      stderr: '',
      timedOut: false,
    });
    const checks: GateCheckSpec[] = [
      { kind: 'command', id: 'typecheck', command: 'npm', args: ['run', 'typecheck'], maxErrors: 123 },
    ];
    const res = runGateChecks(checks, 'auto', { runCommand: runner });
    expect(res.ok).toBe(true);
    expect(res.checks[0]!.detail!['errorCount']).toBe(123);
  });

  it('reprova quando errorCount ultrapassa o baseline', () => {
    const runner: CommandRunner = () => ({
      status: 1,
      stdout: Array.from({ length: 124 }, () => 'error TS1: novo').join('\n'),
      stderr: '',
      timedOut: false,
    });
    const checks: GateCheckSpec[] = [
      { kind: 'command', id: 'typecheck', command: 'tsc', maxErrors: 123 },
    ];
    const res = runGateChecks(checks, 'auto', { runCommand: runner });
    expect(res.ok).toBe(false);
    expect(res.checks[0]!.detail!['errorCount']).toBe(124);
  });

  it('sem maxErrors exige exit 0', () => {
    const okRunner: CommandRunner = () => ({ status: 0, stdout: '', stderr: '', timedOut: false });
    const failRunner: CommandRunner = () => ({ status: 2, stdout: '', stderr: 'boom', timedOut: false });
    expect(runGateChecks([{ kind: 'command', id: 'build', command: 'x' }], 'auto', { runCommand: okRunner }).ok).toBe(true);
    expect(runGateChecks([{ kind: 'command', id: 'build', command: 'x' }], 'auto', { runCommand: failRunner }).ok).toBe(false);
  });

  it('timeout do comando reprova o check', () => {
    const runner: CommandRunner = () => ({ status: null, stdout: '', stderr: '', timedOut: true });
    const res = runGateChecks(
      [{ kind: 'command', id: 'tests', command: 'x', timeoutMs: 10 }],
      'auto',
      { runCommand: runner },
    );
    expect(res.ok).toBe(false);
    expect(res.checks[0]!.reason).toContain('timeout');
  });

  it('spawn-fail (status null) com maxErrors NAO e verde', () => {
    const runner: CommandRunner = () => ({
      status: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: 'spawn tsc ENOENT',
    });
    const res = runGateChecks(
      [{ kind: 'command', id: 'typecheck', command: 'tsc', maxErrors: 123 }],
      'auto',
      { runCommand: runner },
    );
    expect(res.ok).toBe(false);
    expect(res.checks[0]!.ok).toBe(false);
    expect(res.checks[0]!.reason).toContain('ENOENT');
    expect(res.checks[0]!.detail!['error']).toBe('spawn tsc ENOENT');
  });

  it('status null sem error (sem exit code) com maxErrors NAO e verde', () => {
    const runner: CommandRunner = () => ({
      status: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    const res = runGateChecks(
      [{ kind: 'command', id: 'typecheck', command: 'tsc', maxErrors: 123 }],
      'auto',
      { runCommand: runner },
    );
    expect(res.ok).toBe(false);
    expect(res.checks[0]!.reason).toContain('sem exit code');
  });

  it('processo morto por sinal (SIGKILL) com maxErrors NAO e verde', () => {
    const runner: CommandRunner = () => ({
      status: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      signal: 'SIGKILL',
    });
    const res = runGateChecks(
      [{ kind: 'command', id: 'tests', command: 'vitest', maxErrors: 0 }],
      'auto',
      { runCommand: runner },
    );
    expect(res.ok).toBe(false);
    expect(res.checks[0]!.reason).toContain('SIGKILL');
    expect(res.checks[0]!.detail!['signal']).toBe('SIGKILL');
  });

  it('spawn-fail SEM maxErrors (exit-0 branch) tambem NAO e verde', () => {
    const runner: CommandRunner = () => ({
      status: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: 'spawn npm ENOENT',
    });
    const res = runGateChecks(
      [{ kind: 'command', id: 'build', command: 'npm', args: ['run', 'build'] }],
      'auto',
      { runCommand: runner },
    );
    expect(res.ok).toBe(false);
    expect(res.checks[0]!.reason).toContain('ENOENT');
  });

  it('exit code real com maxErrors continua VERDE (baseline conhecido)', () => {
    const runner: CommandRunner = () => ({
      status: 1,
      stdout: Array.from({ length: 100 }, () => 'error TS1: x').join('\n'),
      stderr: '',
      timedOut: false,
    });
    const res = runGateChecks(
      [{ kind: 'command', id: 'typecheck', command: 'tsc', maxErrors: 123 }],
      'auto',
      { runCommand: runner },
    );
    expect(res.ok).toBe(true);
    expect(res.checks[0]!.detail!['errorCount']).toBe(100);
  });
});

describe('workflow-gates: containment check (protected paths via diff)', () => {
  it('passa quando nenhum protected path foi tocado', () => {
    const res = runGateChecks(
      [
        {
          kind: 'containment',
          id: 'containment',
          touchedFiles: ['src/feature.ts', 'src/feature.test.ts'],
          protectedPaths: ['electron/main/pipeline-engine', 'electron/main/agent-runtime'],
        },
      ],
      'auto',
    );
    expect(res.ok).toBe(true);
  });

  it('reprova quando um protected DIR foi tocado (match por prefixo de segmento)', () => {
    const res = runGateChecks(
      [
        {
          kind: 'containment',
          id: 'containment',
          touchedFiles: ['electron/main/pipeline-engine/index.ts', 'src/ok.ts'],
          protectedPaths: ['electron/main/pipeline-engine'],
        },
      ],
      'auto',
    );
    expect(res.ok).toBe(false);
    expect(res.checks[0]!.detail!['violations']).toEqual([
      'electron/main/pipeline-engine/index.ts',
    ]);
  });

  it('nao confunde prefixo de nome (pipeline-engine-foo nao casa pipeline-engine)', () => {
    const res = runGateChecks(
      [
        {
          kind: 'containment',
          id: 'containment',
          touchedFiles: ['electron/main/pipeline-engine-foo/x.ts'],
          protectedPaths: ['electron/main/pipeline-engine'],
        },
      ],
      'auto',
    );
    expect(res.ok).toBe(true);
  });
});

describe('workflow-gates: schema check (resultado de node tem o shape minimo)', () => {
  it('passa quando todas as chaves obrigatorias estao presentes', () => {
    const res = runGateChecks(
      [
        {
          kind: 'schema',
          id: 'findings',
          value: { verdict: 'pass', findings: [] },
          requiredKeys: ['verdict', 'findings'],
        },
      ],
      'auto',
    );
    expect(res.ok).toBe(true);
  });

  it('reprova quando faltam chaves', () => {
    const res = runGateChecks(
      [
        {
          kind: 'schema',
          id: 'findings',
          value: { verdict: 'pass' },
          requiredKeys: ['verdict', 'findings'],
        },
      ],
      'auto',
    );
    expect(res.ok).toBe(false);
    expect(res.checks[0]!.detail!['missing']).toEqual(['findings']);
  });

  it('reprova quando o resultado nem e objeto', () => {
    const res = runGateChecks(
      [{ kind: 'schema', id: 'x', value: null, requiredKeys: ['a'] }],
      'auto',
    );
    expect(res.ok).toBe(false);
  });
});

describe('workflow-gates: expected-files check', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'dwf-gates-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('passa quando os arquivos existem e o hash bate', () => {
    mkdirSync(join(base, 'artifacts'), { recursive: true });
    const content = 'entrega final';
    writeFileSync(join(base, 'artifacts', 'delivery.md'), content);
    const sha = createHash('sha256').update(Buffer.from(content)).digest('hex');
    const res = runGateChecks(
      [
        {
          kind: 'expected-files',
          id: 'delivery',
          baseDir: base,
          files: [{ path: 'artifacts/delivery.md', sha256: sha }],
        },
      ],
      'auto',
    );
    expect(res.ok).toBe(true);
  });

  it('reprova quando o arquivo falta', () => {
    const res = runGateChecks(
      [
        {
          kind: 'expected-files',
          id: 'delivery',
          baseDir: base,
          files: [{ path: 'artifacts/delivery.md' }],
        },
      ],
      'auto',
    );
    expect(res.ok).toBe(false);
    expect(res.checks[0]!.detail!['missing']).toEqual(['artifacts/delivery.md']);
  });

  it('reprova quando o hash diverge', () => {
    mkdirSync(join(base, 'artifacts'), { recursive: true });
    writeFileSync(join(base, 'artifacts', 'delivery.md'), 'conteudo real');
    const res = runGateChecks(
      [
        {
          kind: 'expected-files',
          id: 'delivery',
          baseDir: base,
          files: [{ path: 'artifacts/delivery.md', sha256: 'deadbeef' }],
        },
      ],
      'auto',
    );
    expect(res.ok).toBe(false);
    expect(res.checks[0]!.detail!['hashMismatch']).toEqual(['artifacts/delivery.md']);
  });
});

describe('workflow-gates: regra 15 (gate auto exige check deterministico)', () => {
  it('gate AUTO com check sem impl deterministica e RECUSADO', () => {
    const res = runGateChecks(
      [{ kind: 'semantic-review', id: 'risco', note: 'avaliar risco de regressao' }],
      'auto',
    );
    expect(res.ok).toBe(false);
    expect(res.checks[0]!.ok).toBe(false);
    expect(res.checks[0]!.reason).toBe('no-deterministic-impl');
  });

  it('mesmo check em gate HUMAN nao reprova sozinho (decisao semantica do humano)', () => {
    const res = runGateChecks(
      [{ kind: 'semantic-review', id: 'risco' }],
      'human',
    );
    expect(res.checks[0]!.ok).toBe(true);
    expect(res.checks[0]!.reason).toContain('nao-deterministico');
  });

  it('gate auto reprova se UM check qualquer reprovar (AND), preservando ordem', () => {
    const checks: GateCheckSpec[] = [
      { kind: 'schema', id: 's', value: { a: 1 }, requiredKeys: ['a'] },
      { kind: 'containment', id: 'c', touchedFiles: ['x.ts'], protectedPaths: [] },
      { kind: 'unknown-thing', id: 'u' },
    ];
    const res = runGateChecks(checks, 'auto');
    expect(res.ok).toBe(false);
    expect(res.checks.map((c) => c.id)).toEqual(['s', 'c', 'u']);
    expect(res.checks[0]!.ok).toBe(true);
    expect(res.checks[1]!.ok).toBe(true);
    expect(res.checks[2]!.ok).toBe(false);
  });
});

describe('workflow-gates: estado INCONCLUSIVO (doutrina do gate determinista)', () => {
  it('spawn-fail (ENOENT) -> ok:false + inconclusive:true no check e no agregado', () => {
    const runner: CommandRunner = () => ({
      status: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: 'spawn npm ENOENT',
    });
    const checks: GateCheckSpec[] = [
      { kind: 'command', id: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
    ];
    const res = runGateChecks(checks, 'auto', { runCommand: runner });
    expect(res.ok).toBe(false);
    expect(res.inconclusive).toBe(true);
    expect(res.checks[0]!.ok).toBe(false);
    expect(res.checks[0]!.inconclusive).toBe(true);
  });

  it('timeout -> inconclusive:true (pode ser infra lenta, nao veredito de codigo)', () => {
    const runner: CommandRunner = () => ({
      status: null,
      stdout: '',
      stderr: '',
      timedOut: true,
    });
    const checks: GateCheckSpec[] = [
      { kind: 'command', id: 'test', command: 'npm', args: ['run', 'test'], timeoutMs: 100 },
    ];
    const res = runGateChecks(checks, 'auto', { runCommand: runner });
    expect(res.ok).toBe(false);
    expect(res.inconclusive).toBe(true);
    expect(res.checks[0]!.inconclusive).toBe(true);
  });

  it('exit 1 EXECUTADO segue vermelho comum (inconclusive ausente/false)', () => {
    const runner: CommandRunner = () => ({
      status: 1,
      stdout: 'error TS2304',
      stderr: '',
      timedOut: false,
    });
    const checks: GateCheckSpec[] = [
      { kind: 'command', id: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
    ];
    const res = runGateChecks(checks, 'auto', { runCommand: runner });
    expect(res.ok).toBe(false);
    expect(res.inconclusive).toBe(false);
    expect(res.checks[0]!.inconclusive).not.toBe(true);
  });
});

describe('workflow-gates: resolveSpawnTarget (spawn win32 / CVE-2024-27980)', () => {
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const winEnv = {
    PATH: ['C:\\Program Files\\nodejs', 'C:\\Windows\\system32'].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    comspec: 'C:\\Windows\\system32\\cmd.exe',
  } as NodeJS.ProcessEnv;

  it('fora do win32: alvo intacto (shell:false de sempre)', () => {
    const target = resolveSpawnTarget('npm', ['run', 'typecheck'], { platform: 'linux' });
    expect(target).toEqual({ command: 'npm', args: ['run', 'typecheck'] });
  });

  it('win32: npm resolve para npm.cmd no PATH e roteia via cmd.exe verbatim', () => {
    const target = resolveSpawnTarget('npm', ['run', 'typecheck'], {
      platform: 'win32',
      env: winEnv,
      existsFn: (p) => norm(p) === 'C:/Program Files/nodejs/npm.cmd',
    });
    expect(norm(target.command)).toBe('C:/Windows/system32/cmd.exe');
    expect(target.windowsVerbatimArguments).toBe(true);
    expect(target.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    const line = norm(target.args[3] ?? '');
    expect(line.startsWith('""C:/Program Files/nodejs/npm.cmd"')).toBe(true);
    expect(line.endsWith(' run typecheck"')).toBe(true);
  });

  it('win32: binario .exe resolvido spawna direto, sem cmd.exe', () => {
    const target = resolveSpawnTarget('git', ['status'], {
      platform: 'win32',
      env: winEnv,
      existsFn: (p) => norm(p) === 'C:/Windows/system32/git.exe',
    });
    expect(norm(target.command)).toBe('C:/Windows/system32/git.exe');
    expect(target.args).toEqual(['status']);
    expect(target.windowsVerbatimArguments).toBeUndefined();
  });

  it('win32: binario inexistente passa intacto (ENOENT honesto vira inconclusivo)', () => {
    const target = resolveSpawnTarget('naoexiste', ['x'], {
      platform: 'win32',
      env: winEnv,
      existsFn: () => false,
    });
    expect(target).toEqual({ command: 'naoexiste', args: ['x'] });
  });

  it('win32: comando com path explicito .cmd tambem roteia via cmd.exe', () => {
    const target = resolveSpawnTarget('C:\\tools\\build.cmd', ['--fast'], {
      platform: 'win32',
      env: winEnv,
      existsFn: () => false,
    });
    expect(norm(target.command)).toBe('C:/Windows/system32/cmd.exe');
    expect(norm(target.args[3] ?? '')).toBe('""C:/tools/build.cmd" --fast"');
  });
});

describe('workflow-gates: endurecimento adversarial do spawn/veredito', () => {
  const winEnv2 = {
    PATH: 'C:\\nodejs',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    comspec: 'C:\\Windows\\system32\\cmd.exe',
  } as NodeJS.ProcessEnv;

  it('win32: arg com metacaractere de cmd NAO roteia via cmd.exe (fail-closed)', () => {
    const target = resolveSpawnTarget('npm', ['run', 'test', '>', 'out.json'], {
      platform: 'win32',
      env: winEnv2,
      existsFn: (p) => p.replace(/\\/g, '/') === 'C:/nodejs/npm.cmd',
    });
    expect(target.command.toLowerCase().endsWith('npm.cmd')).toBe(true);
    expect(target.windowsVerbatimArguments).toBeUndefined();
  });

  it('exit 9009 (cmd nao reconheceu) e INCONCLUSIVO, nunca vermelho/verde por contagem', () => {
    const runner: CommandRunner = () => ({
      status: 9009,
      stdout: '',
      stderr: "'tsc' is not recognized as an internal or external command",
      timedOut: false,
    });
    const checks: GateCheckSpec[] = [
      { kind: 'command', id: 'typecheck', command: 'npm', args: ['run', 'typecheck'], maxErrors: 125 },
    ];
    const res = runGateChecks(checks, 'auto', { runCommand: runner });
    expect(res.ok).toBe(false);
    expect(res.inconclusive).toBe(true);
    expect(res.checks[0]!.inconclusive).toBe(true);
  });

  it('exit 127 (command not found no sh) tambem e INCONCLUSIVO', () => {
    const runner: CommandRunner = () => ({
      status: 127,
      stdout: '',
      stderr: 'sh: npm: command not found',
      timedOut: false,
    });
    const checks: GateCheckSpec[] = [
      { kind: 'command', id: 'test', command: 'npm', args: ['run', 'test'] },
    ];
    const res = runGateChecks(checks, 'auto', { runCommand: runner });
    expect(res.ok).toBe(false);
    expect(res.inconclusive).toBe(true);
  });
});

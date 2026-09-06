
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '../logger';
import { nonInteractiveGitEnv } from './workflow-git-env';
import { sanitizeSubprocessEnv } from '../agent-runtime/subprocess-env';
import type { DynamicWorkflowGateMode } from './types';

const logger = createLogger('dynamic-workflow-gates');


export interface CommandCheckSpec {
  kind: 'command';
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  maxErrors?: number;
  errorPattern?: string;
  timeoutMs?: number;
}

export interface ContainmentCheckSpec {
  kind: 'containment';
  id: string;
  touchedFiles: string[];
  protectedPaths: string[];
  baseDir?: string;
}

export interface SchemaCheckSpec {
  kind: 'schema';
  id: string;
  value: unknown;
  requiredKeys: string[];
}

export interface ExpectedFilesCheckSpec {
  kind: 'expected-files';
  id: string;
  files: Array<{ path: string; sha256?: string }>;
  baseDir?: string;
}

export type GateCheckSpec =
  | CommandCheckSpec
  | ContainmentCheckSpec
  | SchemaCheckSpec
  | ExpectedFilesCheckSpec
  | { kind: string; id: string; [extra: string]: unknown };


export interface GateCheckResult {
  id: string;
  kind: string;
  ok: boolean;
  inconclusive?: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
  output?: string;
}

function truncateOutput(combined: string, maxLines = 40, maxChars = 2000): string {
  const lines = combined.split('\n');
  let out = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') + '\n... (truncado)' : combined;
  if (out.length > maxChars) out = out.slice(0, maxChars) + '... (truncado)';
  return out.trim();
}

export interface GateRunResult {
  ok: boolean;
  inconclusive: boolean;
  checks: GateCheckResult[];
}

export interface CommandRunner {
  (
    command: string,
    args: string[],
    opts: { cwd?: string; timeoutMs?: number },
  ): {
    status: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    error?: string;
    signal?: string;
  };
}

export interface ResolvedSpawnTarget {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

const WIN32_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function findOnWin32Path(
  bin: string,
  env: NodeJS.ProcessEnv,
  existsFn: (p: string) => boolean,
): string | null {
  const pathEnv = env.PATH ?? env.Path ?? '';
  const exts = (env.PATHEXT ?? WIN32_DEFAULT_PATHEXT).split(';').filter(Boolean);
  const hasExt = win32.extname(bin) !== '';
  for (const dir of pathEnv.split(win32.delimiter).filter(Boolean)) {
    const base = win32.join(dir, bin);
    if (hasExt) {
      if (existsFn(base)) return base;
      continue;
    }
    for (const ext of exts) {
      const candidate = base + ext.toLowerCase();
      if (existsFn(candidate)) return candidate;
    }
  }
  return null;
}

const CMD_UNSAFE_ARG = /[\s&|<>^%!"'`;,()\[\]*?]/;

export function resolveSpawnTarget(
  command: string,
  args: string[],
  opts?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    existsFn?: (p: string) => boolean;
  },
): ResolvedSpawnTarget {
  const platform = opts?.platform ?? process.platform;
  if (platform !== 'win32') return { command, args };

  const env = opts?.env ?? process.env;
  const existsFn = opts?.existsFn ?? existsSync;
  const looksPathy = command.includes('/') || command.includes('\\') || win32.isAbsolute(command);
  const resolved = looksPathy ? command : (findOnWin32Path(command, env, existsFn) ?? command);

  const lower = resolved.toLowerCase();
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) {
    return { command: resolved, args };
  }

  if (args.some((a) => CMD_UNSAFE_ARG.test(a))) {
    return { command: resolved, args };
  }

  const comspec = env.comspec ?? 'cmd.exe';
  const line = [`"${resolved}"`, ...args].join(' ');
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

export function gateCommandEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return sanitizeSubprocessEnv(nonInteractiveGitEnv(base));
}

const defaultCommandRunner: CommandRunner = (command, args, opts) => {
  const target = resolveSpawnTarget(command, args);
  const res = spawnSync(target.command, target.args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    encoding: 'utf8',
    shell: false,
    ...(target.windowsVerbatimArguments !== undefined
      ? { windowsVerbatimArguments: target.windowsVerbatimArguments }
      : {}),
    env: gateCommandEnv(),
  });
  const errno = res.error as NodeJS.ErrnoException | undefined;
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut: res.signal === 'SIGTERM' || errno?.code === 'ETIMEDOUT',
    error: errno?.message,
    signal: res.signal ?? undefined,
  };
};

export interface RunGateChecksDeps {
  runCommand?: CommandRunner;
}


function countMatches(text: string, pattern: string): number {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'gim');
  } catch {
    return 0;
  }
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

function evalCommand(spec: CommandCheckSpec, runner: CommandRunner): GateCheckResult {
  const result = runner(spec.command, spec.args ?? [], {
    cwd: spec.cwd,
    timeoutMs: spec.timeoutMs,
  });
  if (result.timedOut) {
    return {
      id: spec.id,
      kind: 'command',
      ok: false,
      inconclusive: true,
      reason: 'comando excedeu o timeout',
      detail: { command: spec.command, timeoutMs: spec.timeoutMs ?? null },
    };
  }

  const ranForReal =
    result.status !== null &&
    !result.error &&
    !result.signal &&
    !result.timedOut;

  if (!ranForReal) {
    const reason = result.error
      ? `comando nao executou (${result.error})`
      : result.signal
        ? `comando morto por sinal ${result.signal}`
        : 'comando nao executou (sem exit code)';
    return {
      id: spec.id,
      kind: 'command',
      ok: false,
      inconclusive: true,
      reason,
      detail: {
        command: spec.command,
        exitCode: result.status,
        error: result.error ?? null,
        signal: result.signal ?? null,
      },
    };
  }

  const combined = `${result.stdout}\n${result.stderr}`;

  const notRecognized =
    result.status === 9009 ||
    result.status === 127 ||
    /is not recognized as an internal or external command|nao e reconhecido como um comando interno|não é reconhecido como um comando interno|command not found/i.test(
      combined,
    );
  if (notRecognized) {
    return {
      id: spec.id,
      kind: 'command',
      ok: false,
      inconclusive: true,
      reason: `toolchain nao reconheceu o comando (exit ${result.status})`,
      detail: { command: spec.command, exitCode: result.status },
      output: truncateOutput(combined),
    };
  }

  if (spec.maxErrors !== undefined) {
    const pattern = spec.errorPattern ?? 'error';
    const errorCount = countMatches(combined, pattern);
    const ok = errorCount <= spec.maxErrors;
    return {
      id: spec.id,
      kind: 'command',
      ok,
      reason: ok
        ? `erros ${errorCount} <= baseline ${spec.maxErrors}`
        : `erros ${errorCount} acima do baseline ${spec.maxErrors}`,
      detail: { errorCount, maxErrors: spec.maxErrors, exitCode: result.status },
      ...(ok ? {} : { output: truncateOutput(combined) }),
    };
  }

  const ok = result.status === 0;
  return {
    id: spec.id,
    kind: 'command',
    ok,
    reason: ok ? 'exit 0' : `exit ${result.status}`,
    detail: { exitCode: result.status },
    ...(ok ? {} : { output: truncateOutput(combined) }),
  };
}

function normalizeForMatch(p: string, baseDir?: string): string {
  if (isAbsolute(p)) return resolve(p);
  return baseDir ? resolve(baseDir, p) : resolve(p);
}

function pathCoveredBy(file: string, protectedPath: string, baseDir?: string): boolean {
  const f = normalizeForMatch(file, baseDir);
  const p = normalizeForMatch(protectedPath, baseDir);
  if (f === p) return true;
  const rel = relative(p, f);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function evalContainment(spec: ContainmentCheckSpec): GateCheckResult {
  const violations: string[] = [];
  for (const touched of spec.touchedFiles) {
    for (const prot of spec.protectedPaths) {
      if (pathCoveredBy(touched, prot, spec.baseDir)) {
        violations.push(touched);
        break;
      }
    }
  }
  const ok = violations.length === 0;
  return {
    id: spec.id,
    kind: 'containment',
    ok,
    reason: ok
      ? 'nenhum protected path tocado'
      : `${violations.length} protected path(s) tocado(s)`,
    detail: { violations },
  };
}

function evalSchema(spec: SchemaCheckSpec): GateCheckResult {
  if (!spec.value || typeof spec.value !== 'object') {
    return {
      id: spec.id,
      kind: 'schema',
      ok: false,
      reason: 'resultado ausente ou nao e objeto',
      detail: { requiredKeys: spec.requiredKeys },
    };
  }
  const obj = spec.value as Record<string, unknown>;
  const missing = spec.requiredKeys.filter((k) => !(k in obj));
  const ok = missing.length === 0;
  return {
    id: spec.id,
    kind: 'schema',
    ok,
    reason: ok ? 'chaves obrigatorias presentes' : `faltam chaves: ${missing.join(', ')}`,
    detail: { missing },
  };
}

function evalExpectedFiles(spec: ExpectedFilesCheckSpec): GateCheckResult {
  const missing: string[] = [];
  const hashMismatch: string[] = [];
  for (const f of spec.files) {
    const abs = normalizeForMatch(f.path, spec.baseDir);
    if (!existsSync(abs)) {
      missing.push(f.path);
      continue;
    }
    if (f.sha256) {
      try {
        const actual = createHash('sha256')
          .update(readFileSync(abs))
          .digest('hex');
        if (actual !== f.sha256) hashMismatch.push(f.path);
      } catch {
        hashMismatch.push(f.path);
      }
    }
  }
  const ok = missing.length === 0 && hashMismatch.length === 0;
  return {
    id: spec.id,
    kind: 'expected-files',
    ok,
    reason: ok
      ? 'todos os arquivos esperados presentes'
      : `faltando: ${missing.length}, hash divergente: ${hashMismatch.length}`,
    detail: { missing, hashMismatch },
  };
}


const DETERMINISTIC_KINDS = new Set([
  'command',
  'containment',
  'schema',
  'expected-files',
]);

export function runGateChecks(
  checks: GateCheckSpec[],
  mode: DynamicWorkflowGateMode,
  deps: RunGateChecksDeps = {},
): GateRunResult {
  const runCommand = deps.runCommand ?? defaultCommandRunner;
  const results: GateCheckResult[] = [];

  for (const check of checks) {
    if (!DETERMINISTIC_KINDS.has(check.kind)) {
      const refusedInAuto = mode === 'auto';
      results.push({
        id: check.id,
        kind: check.kind,
        ok: !refusedInAuto,
        reason: refusedInAuto
          ? 'no-deterministic-impl'
          : 'check nao-deterministico (decisao semantica do gate ' + mode + ')',
        detail: { mode },
      });
      if (refusedInAuto) {
        logger.warn(
          { checkId: check.id, kind: check.kind },
          'gate auto com check sem implementacao deterministica (reprovado, regra 15)',
        );
      }
      continue;
    }

    switch (check.kind) {
      case 'command':
        results.push(evalCommand(check as CommandCheckSpec, runCommand));
        break;
      case 'containment':
        results.push(evalContainment(check as ContainmentCheckSpec));
        break;
      case 'schema':
        results.push(evalSchema(check as SchemaCheckSpec));
        break;
      case 'expected-files':
        results.push(evalExpectedFiles(check as ExpectedFilesCheckSpec));
        break;
      default:
        results.push({ id: check.id, kind: check.kind, ok: false, reason: 'unreachable' });
    }
  }

  const ok = results.every((r) => r.ok);
  const inconclusive = results.some((r) => r.inconclusive === true);
  const failed = results.filter((r) => !r.ok);
  logger.info(
    {
      phase: 'gate-checks',
      mode,
      ok,
      inconclusive,
      checkCount: results.length,
      failedCount: failed.length,
      inconclusiveCount: results.filter((r) => r.inconclusive === true).length,
      checks: results.map((r) => ({
        id: r.id,
        kind: r.kind,
        ok: r.ok,
        ...(r.inconclusive ? { inconclusive: true } : {}),
        reason: r.reason,
      })),
    },
    ok
      ? 'gate aprovado (todos os checks ok)'
      : inconclusive
        ? 'gate INCONCLUSIVO (ha checks que nao produziram veredito - toolchain/infra)'
        : 'gate reprovado (ha checks falhando)',
  );

  return { ok, inconclusive, checks: results };
}

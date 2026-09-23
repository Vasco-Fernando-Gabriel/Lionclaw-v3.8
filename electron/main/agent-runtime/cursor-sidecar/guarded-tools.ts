import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import glob from 'glob';
import { minimatch } from 'minimatch';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '../../logger';
import type { CursorCustomToolDeclaration } from './protocol';
import type { CursorToolHandler } from './tool-dispatch';

const logger = createLogger('cursor-guarded-tools');

export const CURSOR_GUARDED_NATIVE_ALLOWLIST: readonly string[] = ['mcp'];

const READ_MAX_BYTES = 512 * 1024;
const READ_DEFAULT_LIMIT_LINES = 2_000;
const GLOB_MAX_RESULTS = 200;
const GREP_MAX_MATCHES = 100;
const GREP_MAX_FILE_BYTES = 1024 * 1024;
const GREP_MAX_FILES = 5_000;
const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
const SHELL_MAX_TIMEOUT_MS = 600_000;
const SHELL_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

export interface CursorGuardedToolsetOptions {
  cwd: string;
  canUseTool: CanUseTool;
  deniedRoots?: readonly string[];
  extraRoots?: readonly string[];
  includeShell?: boolean;
}

export interface CursorGuardedToolset {
  declarations: CursorCustomToolDeclaration[];
  handlers: Record<string, CursorToolHandler>;
}

interface GuardedRunEnv {
  root: string;
  guard: CanUseTool;
  deniedRoots: readonly string[];
  extraRoots: readonly string[];
}

function isUnderDeniedRoot(env: GuardedRunEnv, absolute: string): boolean {
  return env.deniedRoots.some((denied) => absolute === denied || absolute.startsWith(denied + path.sep));
}

function resolveConfined(env: GuardedRunEnv, target: string, toolLabel: string): string {
  const rootResolved = path.resolve(env.root);
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(rootResolved, target);
  const allowedRoots = [rootResolved, ...env.extraRoots];
  const inside = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!inside) {
    throw new Error(
      `${toolLabel}: path "${target}" esta fora das raizes permitidas ` +
        `(${allowedRoots.join(', ')}). ` +
        'Neste runtime toda operacao por arquivo e confinada a essas raizes.',
    );
  }
  if (isUnderDeniedRoot(env, resolved)) {
    throw new Error(
      `${toolLabel}: path "${target}" esta sob uma raiz PROTEGIDA do runtime ` +
        '(fonte de instrucao das sessoes Cursor); nenhuma tool opera ali.',
    );
  }
  return resolved;
}

async function consultGuard(
  guard: CanUseTool,
  toolName: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const toolUseID = `cursor-guarded-${randomUUID()}`;
  const decision = await guard(toolName, input, {
    signal,
    toolUseID,
    requestId: randomUUID(),
  });
  if (decision === null) {
    logger.warn({ toolName, toolUseID }, 'Policy composta nao decidiu (null); tool guardada negada fail-closed');
    throw new Error(`Permissao negada (${toolName}): policy sem decisao (fail-closed)`);
  }
  if (decision.behavior === 'deny') {
    logger.warn({ toolName, message: decision.message }, 'Policy composta negou tool guardada');
    throw new Error(`Permissao negada (${toolName}): ${decision.message}`);
  }
  return decision.updatedInput ?? input;
}

function requireString(args: Record<string, unknown>, key: string, tool: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${tool}: argumento "${key}" (string) e obrigatorio`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('session-aborted');
}

async function guardedRead(env: GuardedRunEnv, rawArgs: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const filePath = requireString(rawArgs, 'file_path', 'lion_read');
  const effective = await consultGuard(env.guard, 'Read', { ...rawArgs, file_path: filePath }, signal);
  const effectivePath = typeof effective['file_path'] === 'string' ? (effective['file_path'] as string) : filePath;
  const resolved = resolveConfined(env, effectivePath, 'lion_read');
  const stat = await fs.promises.stat(resolved);
  if (stat.size > READ_MAX_BYTES) {
    throw new Error(
      `lion_read: arquivo com ${stat.size} bytes excede o limite de ${READ_MAX_BYTES}. ` +
        'Use offset/limit ou lion_grep para extrair o trecho relevante.',
    );
  }
  const raw = await fs.promises.readFile(resolved, 'utf8');
  const lines = raw.split('\n');
  const offset =
    typeof rawArgs['offset'] === 'number' && rawArgs['offset'] >= 0 ? Math.floor(rawArgs['offset'] as number) : 0;
  const limit =
    typeof rawArgs['limit'] === 'number' && rawArgs['limit'] > 0
      ? Math.floor(rawArgs['limit'] as number)
      : READ_DEFAULT_LIMIT_LINES;
  const sliced = lines.slice(offset, offset + limit);
  const suffix =
    offset + limit < lines.length
      ? `\n... (${lines.length - offset - sliced.length} linhas restantes; use offset/limit)`
      : '';
  return sliced.join('\n') + suffix;
}

async function guardedList(env: GuardedRunEnv, rawArgs: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const target =
    typeof rawArgs['path'] === 'string' && rawArgs['path'].length > 0 ? (rawArgs['path'] as string) : env.root;
  await consultGuard(env.guard, 'Read', { file_path: target }, signal);
  const resolved = resolveConfined(env, target, 'lion_list');
  const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
  if (entries.length === 0) return '(diretorio vazio)';
  return entries
    .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'}  ${entry.name}`)
    .sort()
    .join('\n');
}

function assertConfinedGlobPattern(pattern: string): void {
  if (path.isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern) || /^[\\/]/.test(pattern)) {
    throw new Error(
      'lion_glob: pattern absoluto nao e permitido. Use "path" (dentro do workspace) ' + 'mais um pattern relativo.',
    );
  }
  if (pattern.split(/[\\/]+/).includes('..')) {
    throw new Error(
      'lion_glob: pattern com segmento ".." nao e permitido. ' + 'Toda busca e confinada a raiz do workspace do run.',
    );
  }
}

async function guardedGlob(env: GuardedRunEnv, rawArgs: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const pattern = requireString(rawArgs, 'pattern', 'lion_glob');
  assertConfinedGlobPattern(pattern);
  const basePath =
    typeof rawArgs['path'] === 'string' && rawArgs['path'].length > 0 ? (rawArgs['path'] as string) : env.root;
  await consultGuard(env.guard, 'Glob', { pattern, path: basePath }, signal);
  const resolvedBase = resolveConfined(env, basePath, 'lion_glob');
  const allowedRoots = [path.resolve(env.root), ...env.extraRoots];
  const matches = glob
    .sync(pattern, {
      cwd: resolvedBase,
      nodir: true,
      dot: false,
      absolute: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    })
    .filter((match) => {
      const resolved = path.resolve(match);
      const inside = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
      return inside && !isUnderDeniedRoot(env, resolved);
    });
  if (matches.length === 0) return 'Nenhum arquivo encontrado.';
  const trimmed = matches.slice(0, GLOB_MAX_RESULTS).join('\n');
  const suffix =
    matches.length > GLOB_MAX_RESULTS ? `\n... (+${matches.length - GLOB_MAX_RESULTS} arquivos truncados)` : '';
  return trimmed + suffix;
}

async function guardedGrep(env: GuardedRunEnv, rawArgs: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const pattern = requireString(rawArgs, 'pattern', 'lion_grep');
  const basePath =
    typeof rawArgs['path'] === 'string' && rawArgs['path'].length > 0 ? (rawArgs['path'] as string) : env.root;
  await consultGuard(env.guard, 'Grep', { pattern, path: basePath }, signal);
  const resolvedBase = resolveConfined(env, basePath, 'lion_grep');
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    throw new Error(`lion_grep: pattern regex invalido: ${err instanceof Error ? err.message : String(err)}`);
  }
  const includeGlob =
    typeof rawArgs['glob'] === 'string' && rawArgs['glob'].length > 0 ? (rawArgs['glob'] as string) : null;

  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (files.length >= GREP_MAX_FILES) return;
    if (isUnderDeniedRoot(env, path.resolve(dir))) return;
    throwIfAborted(signal);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= GREP_MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile()) {
        if (!isUnderDeniedRoot(env, path.resolve(full))) files.push(full);
      }
    }
  };
  const baseStat = await fs.promises.stat(resolvedBase);
  if (baseStat.isFile()) files.push(resolvedBase);
  else await walk(resolvedBase);

  const matchesInclude = (file: string): boolean =>
    includeGlob === null ||
    minimatch(path.basename(file), includeGlob, {
      matchBase: true,
      nocase: process.platform === 'win32',
    });
  const matches: string[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    if (matches.length >= GREP_MAX_MATCHES) break;
    if (!matchesInclude(file)) continue;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      continue;
    }
    if (stat.size > GREP_MAX_FILE_BYTES) continue;
    let content: string;
    try {
      content = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\0')) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && matches.length < GREP_MAX_MATCHES; i += 1) {
      if (regex.test(lines[i]!)) {
        matches.push(`${file}:${i + 1}:${lines[i]!.slice(0, 300)}`);
      }
    }
  }
  if (matches.length === 0) return 'Nenhum resultado encontrado.';
  const suffix = matches.length >= GREP_MAX_MATCHES ? '\n... (resultados truncados)' : '';
  return matches.join('\n') + suffix;
}

async function guardedWrite(
  env: GuardedRunEnv,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const filePath = requireString(rawArgs, 'file_path', 'lion_write');
  const content = rawArgs['content'];
  if (typeof content !== 'string') {
    throw new Error('lion_write: argumento "content" (string) e obrigatorio');
  }
  const effective = await consultGuard(env.guard, 'Write', { file_path: filePath, content }, signal);
  const effectivePath = typeof effective['file_path'] === 'string' ? (effective['file_path'] as string) : filePath;
  const effectiveContent = typeof effective['content'] === 'string' ? (effective['content'] as string) : content;
  const resolved = resolveConfined(env, effectivePath, 'lion_write');
  throwIfAborted(signal);
  await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
  await fs.promises.writeFile(resolved, effectiveContent, 'utf8');
  return `Arquivo escrito com sucesso: ${resolved}`;
}

async function guardedEdit(env: GuardedRunEnv, rawArgs: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const filePath = requireString(rawArgs, 'file_path', 'lion_edit');
  const oldString = requireString(rawArgs, 'old_string', 'lion_edit');
  const newString = typeof rawArgs['new_string'] === 'string' ? (rawArgs['new_string'] as string) : '';
  const effective = await consultGuard(
    env.guard,
    'Edit',
    { file_path: filePath, old_string: oldString, new_string: newString },
    signal,
  );
  const effectivePath = typeof effective['file_path'] === 'string' ? (effective['file_path'] as string) : filePath;
  const resolved = resolveConfined(env, effectivePath, 'lion_edit');
  throwIfAborted(signal);
  const current = await fs.promises.readFile(resolved, 'utf8');
  if (!current.includes(oldString)) {
    throw new Error('lion_edit: old_string nao encontrado no arquivo');
  }
  const replaceAll = rawArgs['replace_all'] === true;
  const next = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString);
  await fs.promises.writeFile(resolved, next, 'utf8');
  return `Arquivo editado com sucesso: ${resolved}`;
}

async function guardedShell(
  env: GuardedRunEnv,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const command = requireString(rawArgs, 'command', 'lion_shell');
  const effective = await consultGuard(env.guard, 'Bash', { command }, signal);
  const effectiveCommand = typeof effective['command'] === 'string' ? (effective['command'] as string) : command;
  const timeoutMs =
    typeof rawArgs['timeout_ms'] === 'number' && rawArgs['timeout_ms'] > 0
      ? Math.min(Math.floor(rawArgs['timeout_ms'] as number), SHELL_MAX_TIMEOUT_MS)
      : SHELL_DEFAULT_TIMEOUT_MS;
  throwIfAborted(signal);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(effectiveCommand, {
      cwd: env.root,
      shell: true,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;

    const append = (target: 'out' | 'err', chunk: Buffer): void => {
      if (outputBytes >= SHELL_MAX_OUTPUT_BYTES) return;
      const text = chunk.toString('utf8');
      outputBytes += Buffer.byteLength(text);
      if (target === 'out') stdout += text;
      else stderr += text;
    };
    child.stdout?.on('data', (c: Buffer) => append('out', c));
    child.stderr?.on('data', (c: Buffer) => append('err', c));

    const killChild = (): void => {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill();
        } catch {}
      }
    };
    const onAbort = (): void => {
      killChild();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    timeoutTimer.unref?.();

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };

    child.on('error', (err) => {
      finish(() => reject(new Error(`lion_shell: falha ao spawnar o comando: ${err.message}`)));
    });
    child.on('close', (code, exitSignal) => {
      finish(() => {
        if (signal.aborted) {
          reject(new Error('session-aborted'));
          return;
        }
        if (timedOut) {
          reject(new Error(`lion_shell: comando excedeu o timeout de ${timeoutMs}ms e foi morto`));
          return;
        }
        const combined = [stdout.trim(), stderr.trim()].filter((s) => s.length > 0).join('\n');
        const truncated = outputBytes >= SHELL_MAX_OUTPUT_BYTES ? '\n... (output truncado)' : '';
        if (code === 0) {
          resolve((combined || '(sem output)') + truncated);
        } else {
          resolve(`Error (exit ${code ?? exitSignal ?? '?'}): ${combined || 'comando falhou sem output'}${truncated}`);
        }
      });
    });
  });
}

const STRING_PROP = { type: 'string' } as const;
const NUMBER_PROP = { type: 'number' } as const;

interface GuardedToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (env: GuardedRunEnv, args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
}

const GUARDED_TOOL_SPECS: GuardedToolSpec[] = [
  {
    name: 'lion_read',
    description:
      'Le um arquivo de texto do workspace do run (confinado a raiz). Args: file_path (obrigatorio), offset e limit opcionais em linhas.',
    inputSchema: {
      type: 'object',
      properties: { file_path: STRING_PROP, offset: NUMBER_PROP, limit: NUMBER_PROP },
      required: ['file_path'],
    },
    run: guardedRead,
  },
  {
    name: 'lion_list',
    description:
      'Lista as entradas de um diretorio do workspace do run. Args: path opcional (default: raiz do workspace).',
    inputSchema: { type: 'object', properties: { path: STRING_PROP } },
    run: guardedList,
  },
  {
    name: 'lion_glob',
    description:
      'Busca arquivos por glob pattern dentro do workspace do run. Args: pattern (obrigatorio), path opcional.',
    inputSchema: {
      type: 'object',
      properties: { pattern: STRING_PROP, path: STRING_PROP },
      required: ['pattern'],
    },
    run: guardedGlob,
  },
  {
    name: 'lion_grep',
    description:
      'Busca conteudo por regex nos arquivos do workspace do run. Args: pattern (regex, obrigatorio), path opcional, glob opcional para filtrar por nome de arquivo.',
    inputSchema: {
      type: 'object',
      properties: { pattern: STRING_PROP, path: STRING_PROP, glob: STRING_PROP },
      required: ['pattern'],
    },
    run: guardedGrep,
  },
  {
    name: 'lion_write',
    description:
      'Escreve/cria um arquivo no workspace do run. A policy da execucao valida o path ANTES da escrita. Args: file_path e content (obrigatorios).',
    inputSchema: {
      type: 'object',
      properties: { file_path: STRING_PROP, content: STRING_PROP },
      required: ['file_path', 'content'],
    },
    run: guardedWrite,
  },
  {
    name: 'lion_edit',
    description:
      'Edita um arquivo por substituicao de string. A policy da execucao valida o path ANTES da edicao. Args: file_path e old_string (obrigatorios), new_string opcional, replace_all opcional.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: STRING_PROP,
        old_string: STRING_PROP,
        new_string: STRING_PROP,
        replace_all: { type: 'boolean' },
      },
      required: ['file_path', 'old_string'],
    },
    run: guardedEdit,
  },
  {
    name: 'lion_shell',
    description:
      'Executa um comando shell no workspace do run. A policy da execucao valida o comando ANTES do spawn. Args: command (obrigatorio), timeout_ms opcional.',
    inputSchema: {
      type: 'object',
      properties: { command: STRING_PROP, timeout_ms: NUMBER_PROP },
      required: ['command'],
    },
    run: guardedShell,
  },
];

export function buildCursorGuardedToolset(opts: CursorGuardedToolsetOptions): CursorGuardedToolset {
  const env: GuardedRunEnv = {
    root: opts.cwd,
    guard: opts.canUseTool,
    deniedRoots: (opts.deniedRoots ?? []).map((root) => path.resolve(root)),
    extraRoots: (opts.extraRoots ?? []).map((root) => path.resolve(root)),
  };
  const specs =
    opts.includeShell === false ? GUARDED_TOOL_SPECS.filter((spec) => spec.name !== 'lion_shell') : GUARDED_TOOL_SPECS;
  const declarations: CursorCustomToolDeclaration[] = specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
  }));
  const handlers: Record<string, CursorToolHandler> = {};
  for (const spec of specs) {
    handlers[spec.name] = (invocation, ctx) => spec.run(env, invocation.args, ctx.signal);
  }
  return { declarations, handlers };
}

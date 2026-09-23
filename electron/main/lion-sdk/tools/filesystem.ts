import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { minimatch } from 'minimatch';
import { createLogger } from '../../logger';
import { getAgentCwd } from '../../paths';
import { estimateTokens } from '../compaction/token-estimate';

const logger = createLogger('lion-sdk-fs');

export interface SessionFsState {
  readFiles: Set<string>;
}

export function createSessionFsState(): SessionFsState {
  return { readFiles: new Set() };
}

export interface FsToolError {
  isError: true;
  message: string;
}

export interface FsToolOk<T> {
  isError: false;
  value: T;
}

export type FsToolResult<T> = FsToolOk<T> | FsToolError;

function ok<T>(value: T): FsToolOk<T> {
  return { isError: false, value };
}

function err(message: string): FsToolError {
  return { isError: true, message };
}

export const READ_MAX_INTEGRAL_BYTES = 262_144;
export const READ_TOKEN_CAP = 25_000;

export interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

export async function lionRead(state: SessionFsState, input: ReadInput): Promise<FsToolResult<string>> {
  if (!input || typeof input.file_path !== 'string' || input.file_path.length === 0) {
    return err('Read: file_path obrigatorio.');
  }
  if (!path.isAbsolute(input.file_path)) {
    return err(`Read: caminho deve ser absoluto. Recebido: ${input.file_path}`);
  }

  let raw: string;
  try {
    const stat = await fs.stat(input.file_path);
    if (input.offset === undefined && !(input.limit && input.limit > 0) && stat.size > READ_MAX_INTEGRAL_BYTES) {
      return err(
        `File content (${(stat.size / 1024).toFixed(1)}KB) exceeds maximum allowed size (256KB). Use offset and limit parameters to read specific portions of the file`,
      );
    }
    raw = await fs.readFile(input.file_path, 'utf-8');
  } catch (e) {
    return err(`Read falhou em ${input.file_path}: ${(e as Error).message}`);
  }

  state.readFiles.add(input.file_path);
  if (raw === '') return ok('');

  const lines = raw.split('\n');
  const offset = Math.max(0, input.offset ?? 0);
  if (offset >= lines.length) return ok(`[offset ${offset} alem do fim: arquivo tem ${lines.length} linhas]`);
  const limit = input.limit && input.limit > 0 ? input.limit : lines.length;
  const slice = lines.slice(offset, offset + limit);

  const numbered = slice.map((line, idx) => {
    const lineNo = offset + idx + 1;
    return `${String(lineNo).padStart(6, ' ')}\t${line}`;
  });

  const output = numbered.join('\n');
  if (estimateTokens(output) <= READ_TOKEN_CAP) return ok(output);

  let length = 0;
  let count = 0;
  for (const line of numbered) {
    const nextLength = length + (count > 0 ? 1 : 0) + line.length;
    if (nextLength > READ_TOKEN_CAP * 4) break;
    length = nextLength;
    count++;
  }
  let prefix: string;
  if (count === 0) {
    count = 1;
    const first = numbered[0];
    const cap = READ_TOKEN_CAP * 4;
    prefix = `${first.slice(0, cap)}[... linha cortada; ${first.length - cap} chars restantes ...]`;
  } else {
    prefix = numbered.slice(0, count).join('\n');
  }
  const start = offset + 1;
  const end = offset + count;
  return ok(
    `${prefix}\n[Truncated: PARTIAL view — showing lines ${start}-${end} of ${lines.length} total (${estimateTokens(prefix)} tokens, cap 25000). Call Read with offset=${end} limit=${count} for the next page]`,
  );
}

export interface WriteInput {
  file_path: string;
  content: string;
}

export async function lionWrite(state: SessionFsState, input: WriteInput): Promise<FsToolResult<string>> {
  if (!input || typeof input.file_path !== 'string' || input.file_path.length === 0) {
    return err('Write: file_path obrigatorio.');
  }
  if (typeof input.content !== 'string') {
    return err('Write: content obrigatorio (string).');
  }
  if (!path.isAbsolute(input.file_path)) {
    return err(`Write: caminho deve ser absoluto. Recebido: ${input.file_path}`);
  }

  let existed = false;
  try {
    await fs.access(input.file_path, fsSync.constants.F_OK);
    existed = true;
  } catch {
    existed = false;
  }

  if (existed && !state.readFiles.has(input.file_path)) {
    return err(`Write em arquivo existente requer Read previa nesta sessao: ${input.file_path}`);
  }

  try {
    await fs.writeFile(input.file_path, input.content, 'utf-8');
  } catch (e) {
    return err(`Write falhou em ${input.file_path}: ${(e as Error).message}`);
  }

  state.readFiles.add(input.file_path);
  return ok(existed ? `Arquivo sobrescrito: ${input.file_path}` : `Arquivo criado: ${input.file_path}`);
}

export interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export async function lionEdit(state: SessionFsState, input: EditInput): Promise<FsToolResult<string>> {
  if (!input || typeof input.file_path !== 'string' || input.file_path.length === 0) {
    return err('Edit: file_path obrigatorio.');
  }
  if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') {
    return err('Edit: old_string e new_string sao obrigatorios.');
  }
  if (!path.isAbsolute(input.file_path)) {
    return err(`Edit: caminho deve ser absoluto. Recebido: ${input.file_path}`);
  }
  if (!state.readFiles.has(input.file_path)) {
    return err(`Edit requer Read previa nesta sessao: ${input.file_path}`);
  }

  let content: string;
  try {
    content = await fs.readFile(input.file_path, 'utf-8');
  } catch (e) {
    return err(`Edit nao conseguiu reler ${input.file_path}: ${(e as Error).message}`);
  }

  if (!content.includes(input.old_string)) {
    return err(`Edit: old_string nao encontrado em ${input.file_path}.`);
  }

  if (!input.replace_all) {
    const first = content.indexOf(input.old_string);
    const second = content.indexOf(input.old_string, first + input.old_string.length);
    if (second !== -1) {
      return err(`Edit: old_string nao e unico em ${input.file_path}. Use replace_all=true ou amplie o old_string.`);
    }
    const updated = content.replace(input.old_string, input.new_string);
    await fs.writeFile(input.file_path, updated, 'utf-8');
    return ok(`Arquivo editado (1 substituicao): ${input.file_path}`);
  }

  const re = new RegExp(escapeRegExp(input.old_string), 'g');
  const matches = content.match(re);
  const count = matches ? matches.length : 0;
  const updated = content.replace(re, input.new_string);
  await fs.writeFile(input.file_path, updated, 'utf-8');
  return ok(`Arquivo editado (${count} substituicoes): ${input.file_path}`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface GlobInput {
  pattern: string;
  path?: string;
}

const GLOB_MAX_RESULTS = 500;
const GLOB_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.vite',
]);

export async function lionGlob(input: GlobInput): Promise<FsToolResult<string[]>> {
  if (!input || typeof input.pattern !== 'string' || input.pattern.length === 0) {
    return err('Glob: pattern obrigatorio.');
  }
  const defaultRoot = getAgentCwd(false);
  const root =
    input.path && path.isAbsolute(input.path)
      ? input.path
      : input.path
        ? path.resolve(defaultRoot, input.path)
        : defaultRoot;

  try {
    const mod = await tryRequireFastGlob();
    if (mod) {
      const entries = (await mod(input.pattern, {
        cwd: root,
        absolute: true,
        onlyFiles: true,
        stats: true,
        ignore: Array.from(GLOB_SKIP_DIRS).map((d) => `**/${d}/**`),
      })) as Array<{ path: string; stats?: { mtimeMs: number } }>;
      const sorted = entries
        .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
        .slice(0, GLOB_MAX_RESULTS)
        .map((e) => e.path);
      return ok(sorted);
    }
  } catch (e) {
    logger.warn({ err: e }, 'fast-glob indisponivel, usando fallback');
  }

  const results: Array<{ p: string; mtimeMs: number }> = [];
  await walkDir(root, root, input.pattern, results);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return ok(results.slice(0, GLOB_MAX_RESULTS).map((r) => r.p));
}

type FastGlobLike = (pattern: string, opts: Record<string, unknown>) => Promise<unknown[]>;

async function tryRequireFastGlob(): Promise<FastGlobLike | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod: unknown = require('fast-glob');
    if (typeof mod === 'function') return mod as FastGlobLike;
    const def = (mod as { default?: unknown }).default;
    if (typeof def === 'function') return def as FastGlobLike;
    return null;
  } catch {
    return null;
  }
}

async function walkDir(
  root: string,
  current: string,
  pattern: string,
  results: Array<{ p: string; mtimeMs: number }>,
): Promise<void> {
  if (results.length >= GLOB_MAX_RESULTS * 4) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(current, e.name);
    if (e.isDirectory()) {
      if (GLOB_SKIP_DIRS.has(e.name)) continue;
      await walkDir(root, full, pattern, results);
      continue;
    }
    if (!e.isFile()) continue;
    const rel = path.relative(root, full);
    if (minimatch(rel, pattern, { dot: true, matchBase: pattern.includes('/') ? false : true })) {
      try {
        const st = await fs.stat(full);
        results.push({ p: full, mtimeMs: st.mtimeMs });
      } catch {}
    }
  }
}

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  multiline?: boolean;
  head_limit?: number | null;
}

const GREP_MAX_BYTES = 200_000;
export const GREP_DEFAULT_HEAD_LIMIT = 250;

export function normalizeHeadLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : GREP_DEFAULT_HEAD_LIMIT;
}

function paginateGrep(output: string, limit: number): string {
  const entries = output.split('\n').filter((line) => line.length > 0);
  if (entries.length <= limit) return output;
  return `${entries.slice(0, limit).join('\n')}\n[Showing results with pagination = limit: ${limit}]`;
}

export async function lionGrep(input: GrepInput): Promise<FsToolResult<string>> {
  if (!input || typeof input.pattern !== 'string' || input.pattern.length === 0) {
    return err('Grep: pattern obrigatorio.');
  }
  const defaultRoot = getAgentCwd(false);
  const root =
    input.path && input.path.length > 0
      ? path.isAbsolute(input.path)
        ? input.path
        : path.resolve(defaultRoot, input.path)
      : defaultRoot;
  const mode = input.output_mode ?? 'files_with_matches';

  try {
    const out = await runRipgrep(root, input);
    if (out !== null) return ok(paginateGrep(out, normalizeHeadLimit(input.head_limit)));
  } catch (e) {
    logger.warn({ err: e }, 'ripgrep falhou, usando fallback');
  }

  const files: string[] = [];
  const globPattern = input.glob ?? '**/*';
  const collected: Array<{ p: string; mtimeMs: number }> = [];
  await walkDir(root, root, globPattern, collected);
  collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of collected.slice(0, 2000)) files.push(c.p);

  const re = buildGrepRegex(input.pattern, !!input.multiline);
  let totalBytes = 0;
  const matchedFiles = new Set<string>();
  const contentLines: string[] = [];
  const counts: string[] = [];

  for (const file of files) {
    let fileCount = 0;
    if (totalBytes >= GREP_MAX_BYTES) break;
    let buf: string;
    try {
      buf = await fs.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    if (input.multiline) {
      const m = buf.match(re);
      if (m) {
        matchedFiles.add(file);
        fileCount += m.length;
        if (mode === 'content') {
          const snippet = `${file}: ${m[0].slice(0, 400)}`;
          contentLines.push(snippet);
          totalBytes += snippet.length;
        }
      }
    } else {
      const lines = buf.split('\n');
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i] ?? '')) {
          matchedFiles.add(file);
          fileCount++;
          if (mode === 'content') {
            const line = `${file}:${i + 1}:${lines[i]?.slice(0, 400) ?? ''}`;
            contentLines.push(line);
            totalBytes += line.length;
            if (totalBytes >= GREP_MAX_BYTES) break;
          }
        }
      }
    }
    if (fileCount > 0) counts.push(`${file}:${fileCount}`);
  }

  const output =
    mode === 'files_with_matches'
      ? [...matchedFiles].join('\n')
      : mode === 'count'
        ? counts.join('\n')
        : contentLines.join('\n');
  return ok(paginateGrep(output, normalizeHeadLimit(input.head_limit)));
}

function buildGrepRegex(pattern: string, multiline: boolean): RegExp {
  const flags = multiline ? 'gms' : 'g';
  try {
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
}

function runRipgrep(root: string, input: GrepInput): Promise<string | null> {
  return new Promise((resolve) => {
    const args: string[] = [];
    if (input.multiline) args.push('-U', '--multiline-dotall');
    const mode = input.output_mode ?? 'files_with_matches';
    if (mode === 'files_with_matches') args.push('-l');
    else if (mode === 'count') args.push('-c');
    else args.push('-n');
    if (input.glob) args.push('-g', input.glob);
    args.push(input.pattern, root);

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let proc;
    try {
      proc = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > GREP_MAX_BYTES) {
        stdout = stdout.slice(0, GREP_MAX_BYTES);
        try {
          proc.kill();
        } catch {
          /* noop */
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', () => {
      if (resolved) return;
      resolved = true;
      resolve(null);
    });
    proc.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      if (code === 0 || code === 1) return resolve(stdout);
      logger.debug({ code, stderr: stderr.slice(0, 200) }, 'rg exited non-zero');
      resolve(null);
    });
  });
}

export const __filesystemInternal = {
  HOME: os.homedir(),
  GLOB_MAX_RESULTS,
  GREP_MAX_BYTES,
};

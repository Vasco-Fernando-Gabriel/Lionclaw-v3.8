import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { createLogger } from '../logger';
import { minimalInternalRuntimeEnv, resolveCodegraphPhysicalRuntime } from '../distribution-runtime';
import { composeMinimalContext } from './minimal-context';
import type {
  RepoGraphProviderStats,
  RepoGraphProviderStatus,
  RepoGraphReader,
  RepoGraphWriter,
  RepoGraphSearchInput,
  RepoGraphSearchResult,
  RepoGraphSymbol,
  RepoGraphNodeInput,
  RepoGraphNodeResult,
  RepoGraphCallInput,
  RepoGraphCallResult,
  RepoGraphImpactInput,
  RepoGraphImpactResult,
  RepoGraphFilesInput,
  RepoGraphFilesResult,
  RepoGraphFileEntry,
  RepoGraphContextInput,
  RepoGraphContext,
  RepoGraphBuildInput,
  RepoGraphRunResult,
} from './types';

const logger = createLogger('repo-graph-provider');

export const BUILD_TIMEOUT_MS = 10 * 60_000;
export const BUILD_IDLE_TIMEOUT_MS = 90_000;
export const QUERY_TIMEOUT_MS = 30_000;

export {
  MINIMAL_CONTEXT_MAX_FILES,
  MINIMAL_CONTEXT_MAX_SYMBOLS,
  MINIMAL_CONTEXT_MAX_MARKDOWN_BYTES,
  renderContextMarkdown,
} from './minimal-context';

export function resolveCodegraphBinary(): string | null {
  return resolveCodegraphPhysicalRuntime()?.entryPath ?? null;
}

export function resolveCodegraphSpawn(
  binaryPath: string,
  cliArgs: string[],
  platform: NodeJS.Platform = process.platform,
  _execPath: string = process.execPath,
  _arch: string = process.arch,
  fileExists: (p: string) => boolean = fs.existsSync,
): { file: string; args: string[]; runAsNode: boolean; windowsHide: boolean } {
  const isPhysicalEntry = /[\\/]lib[\\/]dist[\\/]bin[\\/]codegraph\.js$/.test(binaryPath);
  if (!isPhysicalEntry) {
    if (platform !== 'win32') {
      return { file: binaryPath, args: cliArgs, runAsNode: false, windowsHide: false };
    }
    const scopeDir = path.join(path.dirname(binaryPath), '..', '@colbymchenry');
    const bundleDir = path.join(scopeDir, `codegraph-${platform}-${_arch}`);
    const bundledNode = path.join(bundleDir, 'node.exe');
    const entry = path.join(bundleDir, 'lib', 'dist', 'bin', 'codegraph.js');
    if (fileExists(bundledNode) && fileExists(entry)) {
      return {
        file: bundledNode,
        args: ['--liftoff-only', entry, ...cliArgs],
        runAsNode: false,
        windowsHide: true,
      };
    }
    const shimJs = path.join(scopeDir, 'codegraph', 'npm-shim.js');
    return { file: _execPath, args: [shimJs, ...cliArgs], runAsNode: true, windowsHide: false };
  }

  const bundleRoot = path.resolve(path.dirname(binaryPath), '..', '..', '..');
  const privateNode = path.join(bundleRoot, platform === 'win32' ? 'node.exe' : 'node');
  if (!fileExists(binaryPath) || !fileExists(privateNode)) {
    throw new Error(`closure física CodeGraph incompleta: node=${privateNode}, entry=${binaryPath}`);
  }
  return {
    file: privateNode,
    args: ['--liftoff-only', binaryPath, ...cliArgs],
    runAsNode: false,
    windowsHide: platform === 'win32',
  };
}

export const CODEGRAPH_BINARY_MISSING_ERROR =
  'closure física do CodeGraph não encontrada para o target atual. ' +
  'Execute a preparação de runtimes antes de iniciar o app.';

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}

export function parseCodegraphJson(stdout: string): unknown {
  const cleaned = stripAnsi(stdout).trim();
  const firstBrace = cleaned.search(/[[{]/);
  if (firstBrace === -1) {
    throw new Error(`saida da CLI codegraph nao e JSON: "${cleaned.slice(0, 120)}"`);
  }
  const candidate = cleaned.slice(firstBrace);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error(`saida da CLI codegraph nao parseou como JSON: "${candidate.slice(0, 120)}"`);
  }
}

export function parseStatusText(stdout: string): RepoGraphProviderStats {
  const cleaned = stripAnsi(stdout);
  const stats: RepoGraphProviderStats = {};
  const grab = (label: string): number | undefined => {
    const m = cleaned.match(new RegExp(`${label}:\\s*([0-9][0-9,_. \\u00a0]*)`, 'i'));
    if (!m) return undefined;
    const n = parseInt(m[1].replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const files = grab('Files');
  const nodes = grab('Nodes');
  const edges = grab('Edges');
  if (files !== undefined) stats.files = files;
  if (nodes !== undefined) stats.nodes = nodes;
  if (edges !== undefined) stats.edges = edges;
  return stats;
}

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
  idleTimedOut: boolean;
}

interface CliRunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdout?: (chunkText: string) => void;
  idleTimeoutMs?: number;
}

export class CodegraphCliProvider implements RepoGraphReader, RepoGraphWriter {
  readonly providerName = 'codegraph';
  private readonly binaryPath: string | null;
  private readonly platform: NodeJS.Platform;
  private readonly execPath: string;

  constructor(binaryPath?: string, opts?: { platform?: NodeJS.Platform; execPath?: string }) {
    this.binaryPath = binaryPath ?? resolveCodegraphBinary();
    this.platform = opts?.platform ?? process.platform;
    this.execPath = opts?.execPath ?? process.execPath;
  }

  private requireBinary(): string {
    if (!this.binaryPath || !fs.existsSync(this.binaryPath)) {
      throw new Error(CODEGRAPH_BINARY_MISSING_ERROR);
    }
    return this.binaryPath;
  }

  private runCli(args: string[], opts: CliRunOptions): Promise<CliRunResult> {
    const binary = this.requireBinary();
    const {
      file,
      args: spawnArgs,
      runAsNode,
      windowsHide,
    } = resolveCodegraphSpawn(binary, args, this.platform, this.execPath);
    return new Promise<CliRunResult>((resolve, reject) => {
      const child = spawn(file, spawnArgs, {
        cwd: opts.cwd,
        env: {
          ...minimalInternalRuntimeEnv(file, process.env, this.platform),
          ...(runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let cancelled = false;
      let timedOut = false;
      let idleTimedOut = false;
      let idleTimer: NodeJS.Timeout | null = null;

      const killChild = (): void => {
        try {
          child.kill('SIGTERM');
          setTimeout(() => {
            try {
              if (child.exitCode === null) child.kill('SIGKILL');
            } catch {}
          }, 2_000).unref();
        } catch {}
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killChild();
      }, opts.timeoutMs);
      timer.unref();

      const armIdleTimer = (): void => {
        if (!opts.idleTimeoutMs) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimedOut = true;
          killChild();
        }, opts.idleTimeoutMs);
        idleTimer.unref();
      };
      armIdleTimer();

      const onAbort = (): void => {
        cancelled = true;
        killChild();
      };
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.on('data', (buf: Buffer) => {
        armIdleTimer();
        const text = buf.toString('utf8');
        stdout += text;
        if (opts.onStdout) opts.onStdout(text);
      });
      child.stderr.on('data', (buf: Buffer) => {
        armIdleTimer();
        stderr += buf.toString('utf8');
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (idleTimer) clearTimeout(idleTimer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        reject(err);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (idleTimer) clearTimeout(idleTimer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        resolve({ exitCode: code ?? -1, stdout, stderr, cancelled, timedOut, idleTimedOut });
      });
    });
  }

  private async runJson(args: string[], rootPath: string): Promise<unknown> {
    const result = await this.runCli(args, { cwd: rootPath, timeoutMs: QUERY_TIMEOUT_MS });
    if (result.timedOut) {
      throw new Error(`codegraph ${args[0]}: timeout apos ${QUERY_TIMEOUT_MS}ms`);
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `codegraph ${args[0]} falhou (exit ${result.exitCode}): ${stripAnsi(result.stderr || result.stdout)
          .trim()
          .slice(0, 300)}`,
      );
    }
    return parseCodegraphJson(result.stdout);
  }

  private graphDbPath(rootPath: string): string {
    return path.join(rootPath, '.codegraph', 'codegraph.db');
  }

  async detect(rootPath: string): Promise<RepoGraphProviderStatus> {
    if (!this.binaryPath || !fs.existsSync(this.binaryPath)) {
      return { exists: false, error: CODEGRAPH_BINARY_MISSING_ERROR };
    }
    const exists = fs.existsSync(this.graphDbPath(rootPath));
    if (!exists) return { exists: false };
    try {
      const result = await this.runCli(['status'], {
        cwd: rootPath,
        timeoutMs: QUERY_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        return {
          exists: true,
          error: stripAnsi(result.stderr || result.stdout)
            .trim()
            .slice(0, 300),
        };
      }
      const statusText = stripAnsi(result.stdout).trim();
      return { exists: true, stats: parseStatusText(result.stdout), statusText };
    } catch (err) {
      logger.warn({ err, rootPath }, 'codegraph status falhou no detect (best-effort)');
      return { exists: true, error: (err as Error).message };
    }
  }

  async search(input: RepoGraphSearchInput): Promise<RepoGraphSearchResult> {
    const args = ['query', input.term];
    if (input.kind) args.push('--kind', input.kind);
    if (input.limit !== undefined) args.push('--limit', String(input.limit));
    args.push('--json');
    const raw = await this.runJson(args, input.rootPath);
    return { symbols: mapQueryResults(raw) };
  }

  async node(input: RepoGraphNodeInput): Promise<RepoGraphNodeResult> {
    const raw = await this.runJson(['query', input.name, '--json'], input.rootPath);
    const symbols = mapQueryResults(raw);
    const exact = symbols.find((s) => s.name === input.name) ?? null;
    return { node: exact };
  }

  async callers(input: RepoGraphCallInput): Promise<RepoGraphCallResult> {
    return this.callEdge('callers', input);
  }

  async callees(input: RepoGraphCallInput): Promise<RepoGraphCallResult> {
    return this.callEdge('callees', input);
  }

  private async callEdge(command: 'callers' | 'callees', input: RepoGraphCallInput): Promise<RepoGraphCallResult> {
    const args = [command, input.symbol];
    if (input.limit !== undefined) args.push('--limit', String(input.limit));
    args.push('--json');
    const raw = await this.runJson(args, input.rootPath);
    const obj = (raw ?? {}) as Record<string, unknown>;
    const list = (obj[command] as unknown[] | undefined) ?? [];
    return {
      symbol: (obj['symbol'] as string) ?? input.symbol,
      related: list.map((entry) => mapSymbol(entry as Record<string, unknown>)),
    };
  }

  async impact(input: RepoGraphImpactInput): Promise<RepoGraphImpactResult> {
    const args = ['impact', input.symbol];
    if (input.depth !== undefined) args.push('--depth', String(input.depth));
    args.push('--json');
    const raw = await this.runJson(args, input.rootPath);
    const obj = (raw ?? {}) as Record<string, unknown>;
    const affected = ((obj['affected'] as unknown[] | undefined) ?? []).map((entry) =>
      mapSymbol(entry as Record<string, unknown>),
    );
    return {
      symbol: (obj['symbol'] as string) ?? input.symbol,
      depth: (obj['depth'] as number) ?? input.depth ?? 2,
      nodeCount: (obj['nodeCount'] as number) ?? affected.length,
      edgeCount: (obj['edgeCount'] as number) ?? 0,
      affected,
    };
  }

  async files(input: RepoGraphFilesInput): Promise<RepoGraphFilesResult> {
    const args = ['files'];
    if (input.filter) args.push('--filter', input.filter);
    args.push('--json');
    const raw = await this.runJson(args, input.rootPath);
    const list = Array.isArray(raw) ? raw : [];
    const files: RepoGraphFileEntry[] = list.map((entry) => {
      const obj = entry as Record<string, unknown>;
      return {
        path: (obj['path'] as string) ?? '',
        language: obj['language'] as string | undefined,
        nodeCount: obj['nodeCount'] as number | undefined,
        size: obj['size'] as number | undefined,
      };
    });
    return { files };
  }

  async minimalContext(input: RepoGraphContextInput): Promise<RepoGraphContext> {
    return composeMinimalContext(this, input);
  }

  async build(input: RepoGraphBuildInput): Promise<RepoGraphRunResult> {
    const hasGraph = fs.existsSync(this.graphDbPath(input.rootPath));
    const args = hasGraph ? ['index', '--force'] : ['init', '--index'];
    return this.runWrite(args, input);
  }

  async update(input: RepoGraphBuildInput): Promise<RepoGraphRunResult> {
    return this.runWrite(['sync'], input);
  }

  private async runWrite(args: string[], input: RepoGraphBuildInput): Promise<RepoGraphRunResult> {
    const startedAt = Date.now();
    const dataless = this.findDatalessSource(input.rootPath);
    if (dataless) {
      return {
        status: 'error',
        output: '',
        error: `Arquivo do projeto ainda não foi baixado do iCloud: ${dataless}. No Finder, use “Baixar Agora” na pasta do repositório e tente novamente.`,
        durationMs: Date.now() - startedAt,
      };
    }
    let result: CliRunResult;
    try {
      result = await this.runCli(args, {
        cwd: input.rootPath,
        timeoutMs: BUILD_TIMEOUT_MS,
        idleTimeoutMs: BUILD_IDLE_TIMEOUT_MS,
        signal: input.signal,
        onStdout: input.onProgress,
      });
    } catch (err) {
      return {
        status: 'error',
        output: '',
        error: (err as Error).message,
        durationMs: Date.now() - startedAt,
      };
    }
    const durationMs = Date.now() - startedAt;
    const output = stripAnsi(result.stdout);
    if (result.cancelled) {
      return { status: 'cancelled', output, durationMs };
    }
    if (result.timedOut) {
      return {
        status: 'error',
        output,
        error: `codegraph ${args.join(' ')}: timeout apos ${BUILD_TIMEOUT_MS}ms`,
        durationMs,
      };
    }
    if (result.idleTimedOut) {
      return {
        status: 'error',
        output,
        error: `codegraph ${args.join(' ')}: sem progresso por ${BUILD_IDLE_TIMEOUT_MS}ms; verifique arquivos iCloud não baixados ou filesystem indisponível`,
        durationMs,
      };
    }
    if (result.exitCode !== 0) {
      return {
        status: 'error',
        output,
        error: `codegraph ${args.join(' ')} falhou (exit ${result.exitCode}): ${stripAnsi(result.stderr).trim().slice(0, 300)}`,
        durationMs,
      };
    }
    return { status: 'done', output, durationMs };
  }

  private findDatalessSource(rootPath: string): string | null {
    if (this.platform !== 'darwin') return null;
    const sourcePatterns = [
      '*.ts',
      '*.tsx',
      '*.js',
      '*.jsx',
      '*.mjs',
      '*.cjs',
      '*.json',
      '*.py',
      '*.go',
      '*.rs',
      '*.java',
      '*.kt',
      '*.swift',
      '*.c',
      '*.cc',
      '*.cpp',
      '*.h',
      '*.hpp',
      '*.cs',
      '*.rb',
      '*.php',
      '*.vue',
      '*.svelte',
      '*.md',
      '*.yaml',
      '*.yml',
      '*.toml',
      '*.sql',
      '*.sh',
      '*.css',
      '*.scss',
      '*.html',
    ];
    const patternArgs = sourcePatterns.flatMap((pattern, index) =>
      index === 0 ? ['-name', pattern] : ['-o', '-name', pattern],
    );
    const result = spawnSync(
      '/usr/bin/find',
      [
        '.',
        '(',
        '-name',
        '.git',
        '-o',
        '-name',
        'node_modules',
        '-o',
        '-name',
        'out',
        '-o',
        '-name',
        'release',
        '-o',
        '-name',
        '.codegraph',
        ')',
        '-prune',
        '-o',
        '-type',
        'f',
        '(',
        ...patternArgs,
        ')',
        '-flags',
        '+dataless',
        '-print',
        '-quit',
      ],
      {
        cwd: rootPath,
        encoding: 'utf8',
        timeout: 10_000,
        shell: false,
      },
    );
    if (result.error || result.status !== 0) {
      logger.warn({ rootPath, err: result.error, stderr: result.stderr }, 'preflight dataless falhou; sync seguirá');
      return null;
    }
    const relative = result.stdout.trim();
    return relative ? path.join(rootPath, relative.replace(/^\.\//, '')) : null;
  }
}

export function mapQueryResults(raw: unknown): RepoGraphSymbol[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const obj = entry as Record<string, unknown>;
    const node = (obj['node'] as Record<string, unknown> | undefined) ?? obj;
    const sym = mapSymbol(node);
    if (typeof obj['score'] === 'number') sym.score = obj['score'] as number;
    return sym;
  });
}

export function mapSymbol(node: Record<string, unknown>): RepoGraphSymbol {
  return {
    name: (node['name'] as string) ?? '',
    kind: (node['kind'] as string) ?? 'unknown',
    filePath: (node['filePath'] as string) ?? (node['file'] as string) ?? '',
    startLine: node['startLine'] as number | undefined,
    endLine: node['endLine'] as number | undefined,
    signature: node['signature'] as string | undefined,
    isExported: node['isExported'] as boolean | undefined,
  };
}

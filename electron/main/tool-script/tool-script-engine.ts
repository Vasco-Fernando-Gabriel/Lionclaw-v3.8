
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { createLogger } from '../logger';
import { getChatCapabilityTurn } from '../chat-capability-context';
import type { ChatCapabilityTurnContext } from '../chat-capability-context';
import {
  generateLionclawToolsStub,
  type ToolScriptTransport,
} from './tool-script-python-stub';
import {
  ToolScriptError,
  TOOL_SCRIPT_DEFAULT_TOOLS,
  TOOL_SCRIPT_DEFAULT_TIMEOUT_MS,
  TOOL_SCRIPT_DEFAULT_RPC_TIMEOUT_MS,
  TOOL_SCRIPT_DEFAULT_MAX_STDOUT_BYTES,
  TOOL_SCRIPT_DEFAULT_MAX_STDERR_BYTES,
  TOOL_SCRIPT_DEFAULT_MAX_TOOL_CALLS,
  TOOL_SCRIPT_HARD_BUFFER_CAP_BYTES,
  type ToolScriptEngineDeps,
  type ToolScriptResult,
  type ToolScriptDispatchContext,
  type ToolScriptRpcResponseFrame,
  type ToolScriptHeartbeatFrame,
} from './tool-script-types';

const logger = createLogger('tool-script-engine');

const CODE_LOG_PREVIEW_CHARS = 200;

const PYTHON_PROBE_TIMEOUT_MS = 3_000;


interface PythonDetection {
  available: boolean;
  pythonPath?: string;
  reason?: string;
}

let cachedPythonDetection: PythonDetection | undefined;

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function probePythonVersion(binPath: string): boolean {
  try {
    execFileSync(binPath, ['--version'], {
      timeout: PYTHON_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch (err) {
    logger.debug({ binPath, err }, 'probe de python3 falhou');
    return false;
  }
}

function macCommandLineToolsPresent(): boolean {
  try {
    execFileSync('/usr/bin/xcode-select', ['-p'], {
      timeout: PYTHON_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function findExecutableInPath(
  name: string,
  excludedDirs: readonly string[],
): string | undefined {
  const pathEnv = process.env.PATH ?? '';
  for (const rawDir of pathEnv.split(path.delimiter)) {
    const dir = rawDir.trim();
    if (dir.length === 0) continue;
    const normalizedDir = path.resolve(dir);
    if (excludedDirs.some((ex) => path.resolve(ex) === normalizedDir)) continue;
    const candidate = path.join(normalizedDir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function detectPython(): PythonDetection {
  if (process.platform === 'win32') {
    for (const name of ['python3.exe', 'python.exe']) {
      const found = findExecutableInPath(name, []);
      if (found !== undefined && probePythonVersion(found)) {
        return { available: true, pythonPath: found };
      }
    }
    return { available: false, reason: 'python nao encontrado no PATH' };
  }

  for (const candidate of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3']) {
    if (isExecutableFile(candidate) && probePythonVersion(candidate)) {
      return { available: true, pythonPath: candidate };
    }
  }

  const excluded = process.platform === 'darwin' ? ['/usr/bin'] : [];
  const fromPath = findExecutableInPath('python3', excluded);
  if (fromPath !== undefined && probePythonVersion(fromPath)) {
    return { available: true, pythonPath: fromPath };
  }

  if (process.platform === 'darwin' && isExecutableFile('/usr/bin/python3')) {
    if (macCommandLineToolsPresent() && probePythonVersion('/usr/bin/python3')) {
      return { available: true, pythonPath: '/usr/bin/python3' };
    }
    return {
      available: false,
      reason:
        '/usr/bin/python3 e stub do CLT (xcode-select -p falhou) e nenhum outro python3 foi encontrado',
    };
  }

  return { available: false, reason: 'python3 nao encontrado' };
}

function resolvePythonDetection(): PythonDetection {
  if (cachedPythonDetection === undefined) {
    cachedPythonDetection = detectPython();
    if (cachedPythonDetection.available) {
      logger.info(
        { pythonPath: cachedPythonDetection.pythonPath },
        'python3 detectado para o Tool Script',
      );
    } else {
      logger.warn(
        { reason: cachedPythonDetection.reason },
        'Tool Script indisponivel: python3 nao detectado',
      );
    }
  }
  return cachedPythonDetection;
}

export function isToolScriptAvailable(): boolean {
  return resolvePythonDetection().available;
}

export function getToolScriptAvailabilityReason(): string | undefined {
  const detection = resolvePythonDetection();
  return detection.available
    ? undefined
    : (detection.reason ?? 'python3 nao encontrado');
}

export function getToolScriptPythonPath(): string | undefined {
  return resolvePythonDetection().pythonPath;
}

export function __resetToolScriptPythonDetectionForTests(): void {
  cachedPythonDetection = undefined;
}


export function createToolScriptSocketPath(): string {
  return path.join(
    os.tmpdir(),
    `lcts-${crypto.randomBytes(4).toString('hex')}.sock`,
  );
}


const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'HOME',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TERM',
  'USER',
  'LOGNAME',
  'SHELL',
  'TZ',
];

export function buildDefaultToolScriptEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of DEFAULT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}


class PausableTimer {
  private timer: NodeJS.Timeout | null = null;
  private remainingMs: number;
  private armedAt = 0;
  private pauseDepth = 0;
  private done = false;

  constructor(
    totalMs: number,
    private readonly onFire: () => void,
  ) {
    this.remainingMs = totalMs;
  }

  start(): void {
    if (!this.done && this.pauseDepth === 0 && this.timer === null) this.arm();
  }

  private arm(): void {
    this.armedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.done = true;
      this.onFire();
    }, this.remainingMs);
  }

  pause(): void {
    this.pauseDepth++;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.armedAt));
    }
  }

  resume(): void {
    if (this.pauseDepth === 0) return;
    this.pauseDepth--;
    if (this.pauseDepth === 0 && !this.done) this.arm();
  }

  cancel(): void {
    this.done = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}


class CappedCollector {
  private chunks: Buffer[] = [];
  private storedBytes = 0;
  totalBytes = 0;

  constructor(private readonly hardCapBytes: number) {}

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    if (this.storedBytes >= this.hardCapBytes) return;
    const room = this.hardCapBytes - this.storedBytes;
    const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
    this.chunks.push(slice);
    this.storedBytes += slice.length;
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

interface CappedOutput {
  text: string;
  truncated: boolean;
  persistedPath?: string;
}

export const TOOL_SCRIPT_OVERFLOW_DIRNAME = path.join('.lionclaw', 'tool-script');

const OVERFLOW_HEAD_FRACTION = 0.4;

function ensureOverflowGitignore(dir: string): void {
  const gitignorePath = path.join(dir, '.gitignore');
  try {
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, '*\n');
      return;
    }
    const content = fs.readFileSync(gitignorePath, 'utf8');
    const hasWildcard = content
      .split('\n')
      .some((line) => line.trim() === '*');
    if (!hasWildcard) {
      fs.appendFileSync(gitignorePath, `${content.endsWith('\n') ? '' : '\n'}*\n`);
    }
  } catch (err) {
    logger.warn(
      { err, gitignorePath },
      'falha ao garantir .gitignore do dir de overflow do tool-script (best-effort)',
    );
  }
}

interface StdoutOverflowOutcome {
  text: string;
  persistedPath?: string;
}

export function applyStdoutOverflowPolicy(
  stored: Buffer,
  totalBytes: number,
  capBytes: number,
  cwd: string,
): StdoutOverflowOutcome {
  const headBytes = Math.floor(capBytes * OVERFLOW_HEAD_FRACTION);
  const tailBytes = Math.max(0, capBytes - headBytes);
  const head = stored.subarray(0, headBytes).toString('utf8');
  const tailStart = Math.max(headBytes, stored.length - tailBytes);
  const tail = stored.subarray(tailStart).toString('utf8');
  const omittedBytes = Math.max(0, totalBytes - headBytes - (stored.length - tailStart));

  let persistedPath: string | undefined;
  try {
    const dir = path.join(cwd, TOOL_SCRIPT_OVERFLOW_DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    ensureOverflowGitignore(dir);
    const fileName = `stdout-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.txt`;
    const target = path.join(dir, fileName);
    fs.writeFileSync(target, stored, { mode: 0o600 });
    persistedPath = target;
  } catch (err) {
    logger.warn(
      { err, cwd },
      'falha ao persistir stdout completo do tool-script; overflow segue so com head+tail',
    );
  }

  const note =
    persistedPath !== undefined
      ? `\n...[${omittedBytes} bytes omitidos, resto em ${persistedPath}]...\n`
      : `\n...[${omittedBytes} bytes omitidos; persistencia do stdout completo falhou]...\n`;
  return { text: `${head}${note}${tail}`, persistedPath };
}

function capOutput(
  collector: CappedCollector,
  capBytes: number,
  overflow?: { cwd: string },
): CappedOutput {
  const full = collector.buffer();
  const truncated = collector.totalBytes > capBytes;
  if (!truncated) {
    return { text: full.toString('utf8'), truncated: false };
  }
  if (overflow === undefined) {
    return { text: full.subarray(0, capBytes).toString('utf8'), truncated: true };
  }
  const outcome = applyStdoutOverflowPolicy(
    full,
    collector.totalBytes,
    capBytes,
    overflow.cwd,
  );
  return { text: outcome.text, truncated: true, persistedPath: outcome.persistedPath };
}


interface ParsedRequestFrame {
  id: number;
  tool: string;
  args: Record<string, unknown>;
  token: string;
}

function tokenMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(received).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseRequestFrame(line: string): ParsedRequestFrame | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const frame = raw as Record<string, unknown>;
  const { id, tool, token } = frame;
  if (typeof id !== 'number' || !Number.isFinite(id)) return undefined;
  if (typeof tool !== 'string' || tool.length === 0) return undefined;
  if (typeof token !== 'string') return undefined;
  const args = frame.args;
  const parsedArgs =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  return { id, tool, args: parsedArgs, token };
}

function writeFrame(
  conn: net.Socket,
  frame: ToolScriptRpcResponseFrame | ToolScriptHeartbeatFrame,
): void {
  if (conn.destroyed || conn.writableEnded) return;
  try {
    conn.write(`${JSON.stringify(frame)}\n`);
  } catch (err) {
    logger.warn({ err }, 'falha ao escrever frame de resposta no socket');
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}


interface ResolvedDeps {
  dispatchRpc: ToolScriptEngineDeps['dispatchRpc'];
  buildEnv: () => NodeJS.ProcessEnv;
  enabledTools: readonly string[];
  timeoutMs: number;
  rpcTimeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxToolCalls: number;
  pythonPath: string;
}

export interface RunToolScriptInput {
  code: string;
  sessionId: string;
  turnId: string;
  abortSignal: AbortSignal;
}

function clientTimeoutSeconds(rpcTimeoutMs: number): number {
  return (rpcTimeoutMs * 1.5 + 1_000) / 1_000;
}

function heartbeatIntervalMs(rpcTimeoutMs: number): number {
  return Math.max(250, Math.floor((clientTimeoutSeconds(rpcTimeoutMs) * 1_000) / 3));
}

class ToolScriptExecution {
  private child: ChildProcess | undefined;
  private server: net.Server | undefined;
  private readonly connections = new Set<net.Socket>();
  private readonly token = crypto.randomBytes(32).toString('hex');
  private tmpDir: string | undefined;
  private transport: ToolScriptTransport | undefined;

  private readonly stdout: CappedCollector;
  private readonly stderr: CappedCollector;
  private globalTimer: PausableTimer | undefined;

  private toolCallCount = 0;
  private timedOut = false;
  private aborted = false;
  private toolCallLimitExceeded = false;
  private killed = false;

  private readonly onAbort = (): void => {
    this.aborted = true;
    this.killProcessGroup('abort');
  };

  constructor(
    private readonly input: RunToolScriptInput,
    private readonly deps: ResolvedDeps,
    private readonly turnCtx: ChatCapabilityTurnContext & {
      cwd: string;
      permissionProfile: NonNullable<ChatCapabilityTurnContext['permissionProfile']>;
      allowedServerIds: string[];
    },
  ) {
    this.stdout = new CappedCollector(TOOL_SCRIPT_HARD_BUFFER_CAP_BYTES);
    this.stderr = new CappedCollector(TOOL_SCRIPT_HARD_BUFFER_CAP_BYTES);
  }

  async run(): Promise<ToolScriptResult> {
    try {
      await this.startServer();
      this.writeScripts();
      const exit = await this.spawnAndWait();
      return this.buildResult(exit);
    } finally {
      this.cleanup();
    }
  }


  private async startServer(): Promise<void> {
    const server = net.createServer((conn) => {
      this.connections.add(conn);
      conn.on('close', () => this.connections.delete(conn));
      conn.on('error', (err) => {
        logger.debug({ err }, 'erro em conexao do tool-script (ignorado)');
      });
      let buffer = '';
      conn.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx >= 0) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          if (line.trim().length > 0) {
            this.handleFrame(line, conn).catch((err: unknown) => {
              logger.error({ err }, 'erro inesperado no handler de frame do tool-script');
            });
          }
          newlineIdx = buffer.indexOf('\n');
        }
      });
    });
    this.server = server;

    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('servidor TCP do tool-script sem porta atribuida');
      }
      this.transport = { kind: 'tcp', host: '127.0.0.1', port: address.port };
      return;
    }

    const socketPath = createToolScriptSocketPath();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
    this.transport = { kind: 'unix', socketPath };
  }


  private writeScripts(): void {
    if (this.transport === undefined) {
      throw new Error('transporte do tool-script nao inicializado');
    }
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-toolscript-'));
    const stub = generateLionclawToolsStub({
      transport: this.transport,
      token: this.token,
      enabledTools: this.deps.enabledTools,
      clientTimeoutSeconds: clientTimeoutSeconds(this.deps.rpcTimeoutMs),
    });
    fs.writeFileSync(path.join(this.tmpDir, 'lionclaw_tools.py'), stub, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(this.tmpDir, 'script.py'), this.input.code, {
      mode: 0o600,
    });
  }


  private async spawnAndWait(): Promise<{ code: number | null; signal: string | null }> {
    if (this.tmpDir === undefined) throw new Error('temp dir nao criado');
    const scriptPath = path.join(this.tmpDir, 'script.py');
    const env: NodeJS.ProcessEnv = {
      ...this.deps.buildEnv(),
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    };

    const child = spawn(this.deps.pythonPath, [scriptPath], {
      cwd: this.turnCtx.cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.stderr.append(chunk));

    this.globalTimer = new PausableTimer(this.deps.timeoutMs, () => {
      this.timedOut = true;
      this.killProcessGroup('timeout-global');
    });
    this.globalTimer.start();

    this.input.abortSignal.addEventListener('abort', this.onAbort, { once: true });

    return new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        let settled = false;
        child.once('error', (err) => {
          if (settled) return;
          settled = true;
          logger.error({ err }, 'falha ao spawnar python3 do tool-script');
          reject(err);
        });
        child.once('close', (code, signal) => {
          if (settled) return;
          settled = true;
          resolve({ code, signal });
        });
      },
    );
  }

  private killProcessGroup(reason: string): void {
    const pid = this.child?.pid;
    if (pid === undefined || this.killed) return;
    this.killed = true;
    logger.debug(
      { sessionId: this.input.sessionId, turnId: this.input.turnId, reason },
      'matando process group do tool-script',
    );
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (err) {
      logger.debug({ err, reason }, 'kill(-pid) falhou; fallback kill direto');
      try {
        this.child?.kill('SIGKILL');
      } catch {
      }
    }
  }


  private async handleFrame(line: string, conn: net.Socket): Promise<void> {
    const frame = parseRequestFrame(line);
    if (frame === undefined) {
      logger.debug('frame NDJSON invalido descartado');
      return;
    }
    if (!tokenMatches(this.token, frame.token)) {
      logger.warn(
        { sessionId: this.input.sessionId, turnId: this.input.turnId, tool: frame.tool },
        'frame com token invalido descartado',
      );
      return;
    }

    if (this.toolCallCount >= this.deps.maxToolCalls) {
      this.toolCallLimitExceeded = true;
      writeFrame(conn, {
        id: frame.id,
        ok: false,
        error: `limite de tool calls excedido (max ${this.deps.maxToolCalls}); execucao encerrada`,
      });
      setImmediate(() => this.killProcessGroup('tool-call-limit'));
      return;
    }
    this.toolCallCount++;

    let onRpcTimeout: () => void = () => {};
    const rpcTimer = new PausableTimer(this.deps.rpcTimeoutMs, () => onRpcTimeout());

    let pauseDepth = 0;
    let heartbeat: NodeJS.Timeout | null = null;
    const pauseTimeout = (): void => {
      pauseDepth++;
      this.globalTimer?.pause();
      rpcTimer.pause();
      if (heartbeat === null) {
        heartbeat = setInterval(() => {
          writeFrame(conn, { id: frame.id, heartbeat: true });
        }, heartbeatIntervalMs(this.deps.rpcTimeoutMs));
      }
    };
    const resumeTimeout = (): void => {
      if (pauseDepth === 0) {
        logger.warn(
          { tool: frame.tool },
          'resumeTimeout sem pauseTimeout correspondente (ignorado)',
        );
        return;
      }
      pauseDepth--;
      this.globalTimer?.resume();
      rpcTimer.resume();
      if (pauseDepth === 0 && heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    const ctx: ToolScriptDispatchContext = {
      sessionId: this.input.sessionId,
      turnId: this.input.turnId,
      cwd: this.turnCtx.cwd,
      permissionProfile: this.turnCtx.permissionProfile,
      allowedServerIds: this.turnCtx.allowedServerIds,
      capabilities: { ...this.turnCtx.capabilities },
      pauseTimeout,
      resumeTimeout,
    };

    try {
      const result = await this.dispatchWithRpcTimeout(frame, ctx, rpcTimer, (fire) => {
        onRpcTimeout = fire;
      });
      writeFrame(conn, { id: frame.id, ok: true, result });
    } catch (err) {
      writeFrame(conn, { id: frame.id, ok: false, error: errorMessage(err) });
    } finally {
      rpcTimer.cancel();
      if (heartbeat !== null) clearInterval(heartbeat);
      while (pauseDepth > 0) {
        pauseDepth--;
        this.globalTimer?.resume();
      }
    }
  }

  private dispatchWithRpcTimeout(
    frame: ParsedRequestFrame,
    ctx: ToolScriptDispatchContext,
    rpcTimer: PausableTimer,
    bindTimeoutFire: (fire: () => void) => void,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      bindTimeoutFire(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `timeout da RPC ${frame.tool} (${this.deps.rpcTimeoutMs}ms); a tool pode continuar rodando no main`,
          ),
        );
      });
      rpcTimer.start();

      this.deps
        .dispatchRpc({ id: frame.id, tool: frame.tool, args: frame.args }, ctx)
        .then((result) => {
          if (settled) return;
          settled = true;
          rpcTimer.cancel();
          resolve(result);
        })
        .catch((err: unknown) => {
          if (settled) return;
          settled = true;
          rpcTimer.cancel();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }


  private buildResult(exit: { code: number | null; signal: string | null }): ToolScriptResult {
    const stdout = capOutput(this.stdout, this.deps.maxStdoutBytes, {
      cwd: this.turnCtx.cwd,
    });
    const stderr = capOutput(this.stderr, this.deps.maxStderrBytes);
    const result: ToolScriptResult = {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: exit.code ?? -1,
      toolCallCount: this.toolCallCount,
      timedOut: this.timedOut,
      aborted: this.aborted,
      ...(stdout.persistedPath !== undefined
        ? { persistedPath: stdout.persistedPath }
        : {}),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      toolCallLimitExceeded: this.toolCallLimitExceeded,
    };
    logger.info(
      {
        sessionId: this.input.sessionId,
        turnId: this.input.turnId,
        exitCode: result.exitCode,
        toolCallCount: result.toolCallCount,
        timedOut: result.timedOut,
        aborted: result.aborted,
        stdoutBytes: this.stdout.totalBytes,
        stderrBytes: this.stderr.totalBytes,
        ...(result.persistedPath !== undefined
          ? { persistedPath: result.persistedPath }
          : {}),
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        toolCallLimitExceeded: result.toolCallLimitExceeded,
      },
      'tool-script finalizado',
    );
    return result;
  }

  private cleanup(): void {
    this.input.abortSignal.removeEventListener('abort', this.onAbort);
    this.globalTimer?.cancel();
    if (this.child !== undefined && this.child.exitCode === null && !this.killed) {
      this.killProcessGroup('cleanup');
    }
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();
    if (this.server !== undefined) {
      try {
        this.server.close();
      } catch (err) {
        logger.warn({ err }, 'falha ao fechar servidor do tool-script');
      }
    }
    if (this.transport?.kind === 'unix') {
      try {
        fs.rmSync(this.transport.socketPath, { force: true });
      } catch (err) {
        logger.warn({ err }, 'falha ao remover socket do tool-script');
      }
    }
    if (this.tmpDir !== undefined) {
      try {
        fs.rmSync(this.tmpDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn({ err, tmpDir: this.tmpDir }, 'falha ao apagar temp dir do tool-script');
      }
    }
  }
}


function resolveDeps(deps: ToolScriptEngineDeps): ResolvedDeps {
  const pythonPath = deps.pythonPath ?? getToolScriptPythonPath();
  if (pythonPath === undefined) {
    throw new ToolScriptError(
      'python-unavailable',
      `Tool Script indisponivel: ${resolvePythonDetection().reason ?? 'python3 nao encontrado'}`,
    );
  }
  return {
    dispatchRpc: deps.dispatchRpc,
    buildEnv: deps.buildEnv ?? buildDefaultToolScriptEnv,
    enabledTools: deps.enabledTools ?? TOOL_SCRIPT_DEFAULT_TOOLS,
    timeoutMs: deps.timeoutMs ?? TOOL_SCRIPT_DEFAULT_TIMEOUT_MS,
    rpcTimeoutMs: deps.rpcTimeoutMs ?? TOOL_SCRIPT_DEFAULT_RPC_TIMEOUT_MS,
    maxStdoutBytes: deps.maxStdoutBytes ?? TOOL_SCRIPT_DEFAULT_MAX_STDOUT_BYTES,
    maxStderrBytes: deps.maxStderrBytes ?? TOOL_SCRIPT_DEFAULT_MAX_STDERR_BYTES,
    maxToolCalls: deps.maxToolCalls ?? TOOL_SCRIPT_DEFAULT_MAX_TOOL_CALLS,
    pythonPath,
  };
}

export async function runToolScript(
  input: RunToolScriptInput,
  deps: ToolScriptEngineDeps,
): Promise<ToolScriptResult> {
  const turnCtx = getChatCapabilityTurn({
    sessionId: input.sessionId,
    turnId: input.turnId,
  });
  if (turnCtx === undefined) {
    throw new ToolScriptError(
      'turn-context-missing',
      'run_tool_script sem turn-context registrado para o turno (fail-closed); o host precisa registrar o turno antes',
    );
  }
  const missing: string[] = [];
  if (turnCtx.cwd === undefined || turnCtx.cwd.length === 0) missing.push('cwd');
  if (turnCtx.permissionProfile === undefined) missing.push('permissionProfile');
  if (turnCtx.allowedServerIds === undefined) missing.push('allowedServerIds');
  if (missing.length > 0) {
    throw new ToolScriptError(
      'turn-context-incomplete',
      `run_tool_script com turn-context sem os campos da Fase B: ${missing.join(', ')} (fail-closed); o hook do host (S3) precisa preenche-los`,
    );
  }

  const resolved = resolveDeps(deps);

  logger.debug(
    {
      sessionId: input.sessionId,
      turnId: input.turnId,
      codeLength: input.code.length,
      codePreview: input.code.slice(0, CODE_LOG_PREVIEW_CHARS),
      enabledTools: resolved.enabledTools,
    },
    'run_tool_script iniciado',
  );

  if (input.abortSignal.aborted) {
    return {
      stdout: '',
      stderr: '',
      exitCode: -1,
      toolCallCount: 0,
      timedOut: false,
      aborted: true,
      stdoutTruncated: false,
      stderrTruncated: false,
      toolCallLimitExceeded: false,
    };
  }

  const execution = new ToolScriptExecution(input, resolved, {
    ...turnCtx,
    cwd: turnCtx.cwd as string,
    permissionProfile: turnCtx.permissionProfile as NonNullable<
      ChatCapabilityTurnContext['permissionProfile']
    >,
    allowedServerIds: turnCtx.allowedServerIds as string[],
  });
  return execution.run();
}

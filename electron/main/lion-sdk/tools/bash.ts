import { spawn } from 'child_process';
import type { BrowserWindow } from 'electron';
import { createLogger } from '../../logger';
import { getAgentCwd, getLionClawHome } from '../../paths';
import { createPermissionGuard } from '../../permission-guard';

const logger = createLogger('lion-sdk-bash');

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 200_000;

export interface BashInput {
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  blocked?: { reason: string };
}

export interface BashRuntimeOptions {
  getWindow: () => BrowserWindow | null;
  sessionId: string;
  isOnboarding?: boolean;
  permissionGuard?: (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown> }>;
  resolveDefaultCwd?: () => string;
}

export async function lionBash(input: BashInput, opts: BashRuntimeOptions): Promise<BashResult> {
  if (!input || typeof input.command !== 'string' || input.command.length === 0) {
    return {
      stdout: '',
      stderr: 'Bash: command obrigatorio.',
      exitCode: 1,
      durationMs: 0,
      blocked: { reason: 'invalid-input' },
    };
  }

  const guard =
    opts.permissionGuard ??
    createPermissionGuard(opts.getWindow, { isOnboarding: opts.isOnboarding, sessionId: opts.sessionId });

  const decision = await guard('Bash', {
    command: input.command,
    cwd: input.cwd,
    timeout_ms: input.timeout_ms,
  } as Record<string, unknown>);

  if (decision.behavior === 'deny') {
    return {
      stdout: '',
      stderr: `Bash bloqueado pela permission-guard: ${decision.message ?? 'sem detalhes'}`,
      exitCode: 1,
      durationMs: 0,
      blocked: { reason: decision.message ?? 'denied' },
    };
  }

  const cwd =
    input.cwd && input.cwd.length > 0
      ? input.cwd
      : opts.resolveDefaultCwd
        ? opts.resolveDefaultCwd()
        : getAgentCwd(opts.isOnboarding ?? false);

  const timeoutMs = input.timeout_ms && input.timeout_ms > 0 ? input.timeout_ms : DEFAULT_TIMEOUT_MS;
  const started = Date.now();

  return await new Promise<BashResult>((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let resolved = false;

    let proc;
    try {
      proc = spawn(input.command, {
        cwd,
        env: {
          ...process.env,
          LIONCLAW_HOME: getLionClawHome(),
        },
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({
        stdout: '',
        stderr: `Bash: spawn falhou - ${(e as Error).message}`,
        exitCode: 1,
        durationMs: Date.now() - started,
        blocked: { reason: 'spawn-failed' },
      });
      return;
    }

    const timer = setTimeout(() => {
      if (resolved) return;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* noop */
      }
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* noop */
        }
      }, 2_000).unref();
      logger.warn({ command: input.command.slice(0, 80), timeoutMs }, 'Bash timeout');
    }, timeoutMs);
    timer.unref?.();

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
        stdoutBuf += chunk.toString();
        if (stdoutBuf.length > MAX_OUTPUT_BYTES) stdoutBuf = stdoutBuf.slice(0, MAX_OUTPUT_BYTES);
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBuf.length < MAX_OUTPUT_BYTES) {
        stderrBuf += chunk.toString();
        if (stderrBuf.length > MAX_OUTPUT_BYTES) stderrBuf = stderrBuf.slice(0, MAX_OUTPUT_BYTES);
      }
    });

    proc.on('error', (e) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        stdout: stdoutBuf,
        stderr: `${stderrBuf}\nBash error: ${e.message}`,
        exitCode: 1,
        durationMs: Date.now() - started,
      });
    });
    proc.on('exit', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const exitCode = typeof code === 'number' ? code : signal ? 130 : 1;
      resolve({
        stdout: stdoutBuf,
        stderr: stderrBuf,
        exitCode,
        durationMs: Date.now() - started,
      });
    });
  });
}

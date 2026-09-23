import { spawn } from 'child_process';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { createLogger } from '../logger';
import { getPermissionBypass } from '../db';
import { executeLocalTool } from '../local-tool-executor';
import { invokeMcpTool, type McpInvokeRequest, type McpInvokeResult } from '../mcp-invoke';
import { requestActionConfirmation } from '../permission-guard';
import { assessMcpToolRisk } from '../mcp-risk-patterns';
import type { ConfirmAction } from '../../../src/types';
import { buildToolScriptEnv } from './tool-script-env';
import {
  TOOL_SCRIPT_DEFAULT_TOOLS,
  TOOL_SCRIPT_DEFAULT_RPC_TIMEOUT_MS,
  type ToolScriptDispatchContext,
  type ToolScriptRpcCall,
  type ToolScriptRpcDispatcher,
} from './tool-script-types';

const logger = createLogger('tool-script-dispatch');

export const TOOL_SCRIPT_READONLY_TOOLS: ReadonlySet<string> = new Set(['read_file', 'search_files', 'grep']);

export const TOOL_SCRIPT_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit',
  'run_command',
  'mcp_invoke',
]);

const TOOL_SCRIPT_SERVER_ID = 'lionclaw-toolscript';
const TOOL_SCRIPT_MATERIALIZED_PREFIX = 'mcp__lionclaw-toolscript__';
const TOOL_SCRIPT_MATERIALIZED_TOOL = 'mcp__lionclaw-toolscript__run_tool_script';

const RUN_COMMAND_MAX_STDOUT_BYTES = 512_000;
const RUN_COMMAND_MAX_STDERR_BYTES = 65_536;

const CODE_PREVIEW_MAX_CHARS = 4_000;

const AUDIT_COMMAND_PREVIEW_CHARS = 80;

export interface ToolScriptCodeClassification {
  mutating: boolean;
  matchedTools: string[];
}

export function classifyToolScriptCode(code: string, enabledTools: readonly string[]): ToolScriptCodeClassification {
  const matchedTools: string[] = [];
  for (const tool of enabledTools) {
    if (!TOOL_SCRIPT_MUTATING_TOOLS.has(tool)) continue;
    if (new RegExp(`\\b${tool}\\b`).test(code)) matchedTools.push(tool);
  }
  return { mutating: matchedTools.length > 0, matchedTools };
}

export interface ToolScriptToolCallAudit {
  sessionId: string;
  turnId: string;
  tool: string;
  displayName: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface ToolScriptDispatcherOverrides {
  invokeMcp?: (req: McpInvokeRequest) => Promise<McpInvokeResult>;
  executeLocal?: typeof executeLocalTool;
  confirmAction?: typeof requestActionConfirmation;
  isBypassEnabled?: () => boolean;
  buildEnv?: () => NodeJS.ProcessEnv;
  runCommandTimeoutMs?: number;
}

export interface CreateToolScriptDispatcherInput {
  code: string;
  getWindow: () => BrowserWindow | null;
  abortSignal: AbortSignal;
  enabledTools?: readonly string[];
  onToolCall?: (entry: ToolScriptToolCallAudit) => void;
  overrides?: ToolScriptDispatcherOverrides;
}

type ToolHandler = (args: Record<string, unknown>, ctx: ToolScriptDispatchContext) => Promise<string>;

export function createToolScriptDispatcher(input: CreateToolScriptDispatcherInput): ToolScriptRpcDispatcher {
  const enabledTools = input.enabledTools ?? TOOL_SCRIPT_DEFAULT_TOOLS;
  const enabledSet = new Set(enabledTools);
  const invokeMcp = input.overrides?.invokeMcp ?? invokeMcpTool;
  const executeLocal = input.overrides?.executeLocal ?? executeLocalTool;
  const confirmAction = input.overrides?.confirmAction ?? requestActionConfirmation;
  const isBypassEnabled = input.overrides?.isBypassEnabled ?? defaultIsBypassEnabled;
  const buildEnv = input.overrides?.buildEnv ?? buildToolScriptEnv;
  const runCommandTimeoutMs = input.overrides?.runCommandTimeoutMs ?? TOOL_SCRIPT_DEFAULT_RPC_TIMEOUT_MS;
  const abortSignal = input.abortSignal;

  const classification = classifyToolScriptCode(input.code, enabledTools);

  let entryApproval: Promise<void> | undefined;

  function bypassActive(ctx: ToolScriptDispatchContext): boolean {
    if (
      ctx.permissionProfile.dangerouslySkipPermissions === true ||
      ctx.permissionProfile.mode === 'bypassPermissions'
    ) {
      return true;
    }
    return isBypassEnabled();
  }

  async function runEntryGuard(ctx: ToolScriptDispatchContext, trigger: string): Promise<void> {
    if (bypassActive(ctx)) {
      logger.debug(
        { sessionId: ctx.sessionId, turnId: ctx.turnId, trigger },
        'guard de entrada auto-aprovado (bypass ativo)',
      );
      return;
    }
    const action: Omit<ConfirmAction, 'id'> = {
      tool: 'run_tool_script',
      description: `Executar script com acoes potencialmente mutantes (${
        classification.matchedTools.length > 0 ? classification.matchedTools.join(', ') : trigger
      })`,
      input: {
        script:
          input.code.length > CODE_PREVIEW_MAX_CHARS
            ? `${input.code.slice(0, CODE_PREVIEW_MAX_CHARS)}\n... [script truncado no preview]`
            : input.code,
        tools: classification.matchedTools,
      },
      risk: 'high',
    };
    ctx.pauseTimeout();
    try {
      const { approved, message } = await raceAbort(
        confirmAction(input.getWindow, action),
        abortSignal,
        'confirmacao do guard de entrada',
      );
      if (!approved) {
        throw new Error(`script negado pelo guard de entrada${message ? ` (${message})` : ''}; nenhuma tool executa`);
      }
      logger.info(
        { sessionId: ctx.sessionId, turnId: ctx.turnId, tools: classification.matchedTools },
        'guard de entrada aprovado pelo usuario',
      );
    } finally {
      ctx.resumeTimeout();
    }
  }

  function ensureEntryApproval(ctx: ToolScriptDispatchContext, trigger: string): Promise<void> {
    if (entryApproval === undefined) {
      entryApproval = runEntryGuard(ctx, trigger);
    }
    return entryApproval;
  }

  async function fileOpHandler(
    sdkTool: 'Read' | 'Write' | 'Edit' | 'Glob' | 'Grep',
    executorArgs: Record<string, unknown>,
    ctx: ToolScriptDispatchContext,
  ): Promise<string> {
    const outcome = await executeLocal(sdkTool, executorArgs, ctx.cwd);
    if (outcome.isError) throw new Error(outcome.result);
    return outcome.result;
  }

  const handlers: Record<string, ToolHandler> = {
    read_file: async (args, ctx) => {
      const filePath = resolvePathArg(ctx.cwd, requireString(args, ['path', 'file_path'], 'read_file'));
      const executorArgs: Record<string, unknown> = { file_path: filePath };
      if (typeof args.offset === 'number') executorArgs.offset = args.offset;
      if (typeof args.limit === 'number') executorArgs.limit = args.limit;
      const content = await fileOpHandler('Read', executorArgs, ctx);
      if (content.includes('\u0000')) {
        throw new Error(
          `read_file: conteudo binario nao suportado no Tool Script (${filePath}). ` +
            'Use um caminho de texto, ou leia o binario via run_command (ex.: base64).',
        );
      }
      return content;
    },
    write_file: (args, ctx) => {
      const filePath = resolvePathArg(ctx.cwd, requireString(args, ['path', 'file_path'], 'write_file'));
      const content = requireString(args, ['content'], 'write_file');
      return fileOpHandler('Write', { file_path: filePath, content }, ctx);
    },
    edit: (args, ctx) => {
      const filePath = resolvePathArg(ctx.cwd, requireString(args, ['path', 'file_path'], 'edit'));
      const oldString = requireString(args, ['old_string'], 'edit');
      const newString = optionalString(args, ['new_string']) ?? '';
      return fileOpHandler('Edit', { file_path: filePath, old_string: oldString, new_string: newString }, ctx);
    },
    search_files: (args, ctx) => {
      const pattern = requireString(args, ['pattern'], 'search_files');
      const executorArgs: Record<string, unknown> = { pattern };
      const basePath = optionalString(args, ['path']);
      if (basePath !== undefined) executorArgs.path = resolvePathArg(ctx.cwd, basePath);
      return fileOpHandler('Glob', executorArgs, ctx);
    },
    grep: (args, ctx) => {
      const pattern = requireString(args, ['pattern'], 'grep');
      const executorArgs: Record<string, unknown> = { pattern };
      const basePath = optionalString(args, ['path']);
      if (basePath !== undefined) executorArgs.path = resolvePathArg(ctx.cwd, basePath);
      const globFilter = optionalString(args, ['glob']);
      if (globFilter !== undefined) executorArgs.glob = globFilter;
      return fileOpHandler('Grep', executorArgs, ctx);
    },
    run_command: (args, ctx) => {
      const command = requireString(args, ['command'], 'run_command');
      const requested = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined;
      const timeoutMs =
        requested !== undefined && Number.isFinite(requested) && requested > 0
          ? Math.min(requested, runCommandTimeoutMs)
          : runCommandTimeoutMs;
      return runCommandAsync(command, {
        cwd: ctx.cwd,
        env: buildEnv(),
        timeoutMs,
        abortSignal,
      });
    },
    mcp_invoke: async (args, ctx) => {
      const serverId = requireString(args, ['server_id', 'serverId'], 'mcp_invoke');
      const toolName = requireString(args, ['tool_name', 'toolName'], 'mcp_invoke');
      assertNotRecursive(serverId, toolName);
      const innerArgs = args.args ?? {};

      const req: McpInvokeRequest = {
        serverId,
        toolName,
        args: innerArgs,
        surface: 'chat',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        allowedServerIds: [...ctx.allowedServerIds],
        context: { surface: 'chat', sessionId: ctx.sessionId, turnId: ctx.turnId },
      };

      const mayPrompt = assessMcpToolRisk(toolName) !== 'safe' && !bypassActive(ctx);
      if (mayPrompt) ctx.pauseTimeout();
      try {
        const result = await raceAbort(invokeMcp(req), abortSignal, `mcp_invoke ${toolName}`);
        if (result.isError) throw new Error(result.content);
        return result.content;
      } finally {
        if (mayPrompt) ctx.resumeTimeout();
      }
    },
  };

  function assertNotRecursive(serverId: string, toolName: string): void {
    const normalizedServer = serverId.trim().toLowerCase();
    const normalizedTool = toolName.trim().toLowerCase();
    const recursive =
      normalizedServer === TOOL_SCRIPT_SERVER_ID ||
      normalizedServer === TOOL_SCRIPT_MATERIALIZED_TOOL ||
      normalizedTool === TOOL_SCRIPT_MATERIALIZED_TOOL ||
      normalizedTool.startsWith(TOOL_SCRIPT_MATERIALIZED_PREFIX);
    if (recursive) {
      throw new Error('mcp_invoke recursivo bloqueado (B.3.3): um Tool Script nao pode chamar run_tool_script');
    }
  }

  function emitAudit(entry: ToolScriptToolCallAudit): void {
    if (input.onToolCall === undefined) return;
    try {
      input.onToolCall(entry);
    } catch (err) {
      logger.warn({ err, tool: entry.tool }, 'hook de auditoria do tool-script falhou');
    }
  }

  return async function dispatchRpc(call: ToolScriptRpcCall, ctx: ToolScriptDispatchContext): Promise<string> {
    const startedAt = Date.now();
    const displayName = formatDisplayName(call, ctx.cwd);
    try {
      const handler = handlers[call.tool];
      if (handler === undefined || !enabledSet.has(call.tool)) {
        throw new Error(
          `tool "${call.tool}" desconhecida ou desabilitada no Tool Script. Habilitadas: ${enabledTools.join(', ')}`,
        );
      }

      if (classification.mutating) {
        await ensureEntryApproval(ctx, 'classificacao-estatica');
      } else if (TOOL_SCRIPT_MUTATING_TOOLS.has(call.tool)) {
        await ensureEntryApproval(ctx, call.tool);
      }

      const result = await handler(call.args, ctx);
      emitAudit({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        tool: call.tool,
        displayName,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ sessionId: ctx.sessionId, turnId: ctx.turnId, tool: call.tool, err }, 'RPC do tool-script falhou');
      emitAudit({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        tool: call.tool,
        displayName,
        ok: false,
        error: message,
        durationMs: Date.now() - startedAt,
      });
      throw err instanceof Error ? err : new Error(message);
    }
  };
}

interface RunCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  abortSignal: AbortSignal;
}

class CappedChunks {
  private chunks: Buffer[] = [];
  private storedBytes = 0;
  truncated = false;

  constructor(private readonly capBytes: number) {}

  append(chunk: Buffer): void {
    if (this.storedBytes >= this.capBytes) {
      this.truncated = true;
      return;
    }
    const room = this.capBytes - this.storedBytes;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.storedBytes = this.capBytes;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.storedBytes += chunk.length;
  }

  text(): string {
    const raw = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? `${raw}\n[saida truncada no cap]` : raw;
  }
}

function runCommandAsync(command: string, opts: RunCommandOptions): Promise<string> {
  if (opts.abortSignal.aborted) {
    return Promise.reject(new Error('run_command abortado (stop do turno)'));
  }

  return new Promise<string>((resolve, reject) => {
    const posix = process.platform !== 'win32';
    const child = posix
      ? spawn('/bin/sh', ['-c', command], {
          cwd: opts.cwd,
          env: opts.env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(command, {
          cwd: opts.cwd,
          env: opts.env,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

    const stdout = new CappedChunks(RUN_COMMAND_MAX_STDOUT_BYTES);
    const stderr = new CappedChunks(RUN_COMMAND_MAX_STDERR_BYTES);
    child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));

    let timedOut = false;
    let abortedByTurn = false;
    let settled = false;

    const killGroup = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (posix) {
          process.kill(-pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);

    const onAbort = (): void => {
      abortedByTurn = true;
      killGroup();
    };
    opts.abortSignal.addEventListener('abort', onAbort, { once: true });

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.abortSignal.removeEventListener('abort', onAbort);
      fn();
    };

    child.once('error', (err) => {
      settle(() => {
        logger.error({ err, command: command.slice(0, 120) }, 'falha ao spawnar run_command');
        reject(new Error(`run_command falhou ao iniciar: ${err.message}`));
      });
    });

    child.once('close', (code, signal) => {
      settle(() => {
        if (abortedByTurn) {
          reject(new Error('run_command abortado (stop do turno)'));
          return;
        }
        if (timedOut) {
          reject(
            new Error(`run_command excedeu o timeout de ${opts.timeoutMs}ms e foi morto (SIGKILL no process group)`),
          );
          return;
        }
        const parts: string[] = [stdout.text()];
        const errText = stderr.text();
        if (errText.length > 0) parts.push(`[stderr]\n${errText}`);
        const exitCode = code ?? -1;
        if (exitCode !== 0 || signal !== null) {
          parts.push(`[exit code: ${exitCode}${signal !== null ? `, signal: ${signal}` : ''}]`);
        }
        resolve(parts.filter((p) => p.length > 0).join('\n') || '(sem output)');
      });
    });
  });
}

function defaultIsBypassEnabled(): boolean {
  try {
    return getPermissionBypass();
  } catch (err) {
    logger.warn({ err }, 'falha ao ler permission:bypass; assumindo bypass OFF');
    return false;
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, what: string): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error(`${what} abortada (stop do turno)`));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error(`${what} abortada (stop do turno)`));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function requireString(args: Record<string, unknown>, keys: readonly string[], tool: string): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  throw new Error(`${tool}: argumento obrigatorio "${keys[0]}" ausente ou vazio`);
}

function resolvePathArg(cwd: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(cwd, target);
}

function optionalString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function formatDisplayName(call: ToolScriptRpcCall, cwd: string): string {
  const args = call.args;
  switch (call.tool) {
    case 'read_file':
    case 'write_file':
    case 'edit': {
      const target = optionalString(args, ['path', 'file_path']);
      return target !== undefined ? `${call.tool} ${resolvePathArg(cwd, target)}` : call.tool;
    }
    case 'search_files':
    case 'grep': {
      const pattern = optionalString(args, ['pattern']);
      return pattern !== undefined ? `${call.tool} ${pattern}` : call.tool;
    }
    case 'run_command': {
      const command = optionalString(args, ['command']);
      if (command === undefined) return call.tool;
      const preview =
        command.length > AUDIT_COMMAND_PREVIEW_CHARS ? `${command.slice(0, AUDIT_COMMAND_PREVIEW_CHARS)}...` : command;
      return `run_command ${preview}`;
    }
    case 'mcp_invoke': {
      const serverId = optionalString(args, ['server_id', 'serverId']);
      const toolName = optionalString(args, ['tool_name', 'toolName']);
      if (serverId !== undefined && toolName !== undefined) {
        return `mcp__${serverId}__${toolName}`;
      }
      return call.tool;
    }
    default:
      return call.tool;
  }
}

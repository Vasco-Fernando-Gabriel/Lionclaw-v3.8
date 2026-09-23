import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import glob from 'glob';
import { createLogger } from './logger';
import type { McpSessionClient } from './mcp-tool-bridge';

const logger = createLogger('local-tool-executor');

const BASH_TIMEOUT_MS = 30_000;

const BASH_BLOCKED_TERMS = ['rm -rf', 'rm -r', 'sudo', 'mkfs', 'dd if=', ':(){', 'chmod -R 777', '> /dev/sd'] as const;

export interface LocalToolResult {
  result: string;
  isError: boolean;
}

type ToolImpl = (args: Record<string, unknown>, cwd: string) => Promise<LocalToolResult>;

function validatePathInCwd(targetPath: string, cwd: string): LocalToolResult | null {
  const cwdResolved = path.resolve(cwd);
  const targetResolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(cwdResolved, targetPath);

  const inside = targetResolved === cwdResolved || targetResolved.startsWith(cwdResolved + path.sep);

  if (!inside) {
    logger.warn({ targetPath, targetResolved, cwd: cwdResolved }, 'Tool blocked: path outside project root');
    return {
      result:
        `Error: path "${targetPath}" esta fora da raiz do projeto.\n` +
        `PROJECT ROOT: ${cwdResolved}\n` +
        `Use SEMPRE paths absolutos comecando com PROJECT ROOT, ou paths relativos que resolvam dentro dele.`,
      isError: true,
    };
  }

  return null;
}

async function execRead(args: Record<string, unknown>, cwd: string): Promise<LocalToolResult> {
  const filePath = args.file_path as string | undefined;
  if (!filePath) {
    return { result: 'Error: file_path e obrigatorio', isError: true };
  }

  const sandboxError = validatePathInCwd(filePath, cwd);
  if (sandboxError) return sandboxError;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n');
    const offset = typeof args.offset === 'number' ? args.offset : 0;
    const limit = typeof args.limit === 'number' ? args.limit : lines.length;
    const sliced = lines.slice(offset, offset + limit).join('\n');
    return { result: sliced, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ filePath, err }, 'Read tool failed');
    return { result: `Error ao ler arquivo: ${msg}`, isError: true };
  }
}

async function execWrite(args: Record<string, unknown>, cwd: string): Promise<LocalToolResult> {
  const filePath = args.file_path as string | undefined;
  const content = args.content as string | undefined;

  if (!filePath || content === undefined) {
    return { result: 'Error: file_path e content sao obrigatorios', isError: true };
  }

  const sandboxError = validatePathInCwd(filePath, cwd);
  if (sandboxError) return sandboxError;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { result: `Arquivo escrito com sucesso: ${filePath}`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ filePath, err }, 'Write tool failed');
    return { result: `Error ao escrever arquivo: ${msg}`, isError: true };
  }
}

async function execEdit(args: Record<string, unknown>, cwd: string): Promise<LocalToolResult> {
  const filePath = args.file_path as string | undefined;
  const oldString = args.old_string as string | undefined;
  const newString = args.new_string as string | undefined;

  if (!filePath || !oldString) {
    return { result: 'Error: file_path e old_string sao obrigatorios', isError: true };
  }

  const sandboxError = validatePathInCwd(filePath, cwd);
  if (sandboxError) return sandboxError;

  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    if (!content.includes(oldString)) {
      return { result: 'Error: old_string nao encontrado no arquivo', isError: true };
    }
    content = content.replace(oldString, newString ?? '');
    fs.writeFileSync(filePath, content, 'utf-8');
    return { result: `Arquivo editado com sucesso: ${filePath}`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ filePath, err }, 'Edit tool failed');
    return { result: `Error ao editar arquivo: ${msg}`, isError: true };
  }
}

async function execGlob(args: Record<string, unknown>, cwd: string): Promise<LocalToolResult> {
  const pattern = args.pattern as string | undefined;
  if (!pattern) {
    return { result: 'Error: pattern e obrigatorio', isError: true };
  }

  const basePath = (args.path as string | undefined) || cwd;
  const sandboxError = validatePathInCwd(basePath, cwd);
  if (sandboxError) return sandboxError;

  try {
    const matches = glob.sync(pattern, {
      cwd: basePath,
      nodir: true,
      dot: false,
      absolute: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    });

    if (matches.length === 0) {
      return { result: 'Nenhum arquivo encontrado.', isError: false };
    }

    const trimmed = matches.slice(0, 200).join('\n');
    const suffix = matches.length > 200 ? `\n... (+${matches.length - 200} arquivos truncados)` : '';
    return { result: trimmed + suffix, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ pattern, basePath, err }, 'Glob tool failed');
    return { result: `Error ao buscar arquivos: ${msg}`, isError: true };
  }
}

async function execGrep(args: Record<string, unknown>, cwd: string): Promise<LocalToolResult> {
  const pattern = args.pattern as string | undefined;
  if (!pattern) {
    return { result: 'Error: pattern e obrigatorio', isError: true };
  }

  const searchPath = (args.path as string | undefined) || cwd;
  const sandboxError = validatePathInCwd(searchPath, cwd);
  if (sandboxError) return sandboxError;
  const glob = args.glob as string | undefined;

  try {
    const safePattern = pattern.replace(/"/g, '\\"');
    let cmd = `grep -rn "${safePattern}" "${searchPath}"`;
    if (glob) cmd += ` --include="${glob}"`;
    cmd += ' 2>/dev/null | head -50';

    const output = execSync(cmd, { encoding: 'utf-8', timeout: 10_000 });
    const trimmed = output.trim();
    return { result: trimmed || 'Nenhum resultado encontrado.', isError: false };
  } catch (err) {
    const exitCode = (err as { status?: number }).status;
    if (exitCode === 1) {
      return { result: 'Nenhum resultado encontrado.', isError: false };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ pattern, searchPath, err }, 'Grep tool failed');
    return { result: `Error ao buscar conteudo: ${msg}`, isError: true };
  }
}

async function execBash(args: Record<string, unknown>, cwd: string): Promise<LocalToolResult> {
  const command = args.command as string | undefined;
  if (!command) {
    return { result: 'Error: command e obrigatorio', isError: true };
  }

  const timeout = typeof args.timeout === 'number' ? args.timeout : BASH_TIMEOUT_MS;

  const blockedTerm = BASH_BLOCKED_TERMS.find((term) => command.includes(term));
  if (blockedTerm) {
    logger.warn({ command, blockedTerm }, 'Bash command blocked by safety filter');
    return {
      result: `BLOCKED: comando contem termo proibido '${blockedTerm}'. Use alternativas seguras.`,
      isError: true,
    };
  }

  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      timeout,
      cwd,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { result: output || '(sem output)', isError: false };
  } catch (err) {
    const error = err as { stderr?: string; stdout?: string; message?: string; status?: number };
    const output = error.stderr || error.stdout || error.message || 'comando falhou';
    logger.warn({ command, cwd }, 'Bash command exited with error');
    return { result: `Error (exit ${error.status ?? '?'}): ${output}`, isError: true };
  }
}

const TOOL_MAP: Record<string, ToolImpl> = {
  Read: (args, cwd) => execRead(args, cwd),
  Write: (args, cwd) => execWrite(args, cwd),
  Edit: (args, cwd) => execEdit(args, cwd),
  Glob: (args, cwd) => execGlob(args, cwd),
  Grep: (args, cwd) => execGrep(args, cwd),
  Bash: (args, cwd) => execBash(args, cwd),
};

export async function executeLocalTool(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<LocalToolResult> {
  const impl = TOOL_MAP[toolName];

  if (!impl) {
    logger.warn({ toolName }, 'Tool nao suportada pelo local-tool-executor');
    return {
      result: `Error: Tool "${toolName}" nao suportada. Tools disponiveis: ${Object.keys(TOOL_MAP).join(', ')}.`,
      isError: true,
    };
  }

  logger.debug({ toolName, args }, 'Executando local tool');

  try {
    return await impl(args, cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ toolName, args, err }, 'Local tool execution threw unexpectedly');
    return { result: `Error inesperado em ${toolName}: ${msg}`, isError: true };
  }
}

export const SUPPORTED_LOCAL_TOOLS = Object.keys(TOOL_MAP) as ReadonlyArray<string>;

export function isBuiltinTool(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_MAP, toolName);
}

export async function executeToolDispatch(
  toolName: string,
  args: unknown,
  cwd: string,
  mcpClient?: McpSessionClient,
): Promise<unknown> {
  if (isBuiltinTool(toolName)) {
    return executeLocalTool(toolName, args as Record<string, unknown>, cwd);
  }

  if (toolName.startsWith('mcp__')) {
    if (!mcpClient) {
      throw new Error(`executeToolDispatch: tool MCP "${toolName}" solicitada mas nenhum mcpClient disponivel`);
    }
    const { callMCPTool } = await import('./mcp-tool-bridge');
    return callMCPTool(mcpClient, toolName, args);
  }

  throw new Error(
    `executeToolDispatch: tool desconhecida "${toolName}". Builtin disponiveis: ${SUPPORTED_LOCAL_TOOLS.join(', ')}`,
  );
}

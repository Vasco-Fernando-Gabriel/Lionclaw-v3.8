import { executeLocalTool } from '../local-tool-executor';
import { WorkflowPathGuard } from './workflow-path-guard';
import type { WorkflowNodeExecutionPolicy } from '../../../src/types/dynamic-workflow';
import type { OllamaToolSchema } from '../ollama-client';

const LOCAL_BUILTIN_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const;

export type LocalBuiltinTool = (typeof LOCAL_BUILTIN_TOOLS)[number];

const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit']);
const BASH_TOOL = 'Bash';

export function deriveOfferedTools(policy: WorkflowNodeExecutionPolicy): LocalBuiltinTool[] {
  const wanted = new Set(policy.effectiveTools);
  const readOnly = policy.access === 'read-only';
  return LOCAL_BUILTIN_TOOLS.filter((tool) => {
    if (!wanted.has(tool)) return false;
    if (readOnly && (WRITE_TOOLS.has(tool) || tool === BASH_TOOL)) return false;
    return true;
  });
}

export function offeredToolSchemas(offered: LocalBuiltinTool[]): OllamaToolSchema[] {
  return offered.map((name) => LOCAL_BUILTIN_SCHEMAS[name]);
}

export interface LocalToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LocalModelRoundResult {
  text: string;
  toolCalls: LocalToolCall[];
}

export type LocalModelRound = (params: {
  round: number;
  offeredSchemas: OllamaToolSchema[];
  messages: LocalDispatcherMessage[];
}) => Promise<LocalModelRoundResult>;

export type LocalToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
) => Promise<{ result: string; isError: boolean }>;

export interface LocalDispatcherMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface LocalDispatcherOptions {
  policy: WorkflowNodeExecutionPolicy;
  prompt: string;
  systemPrompt?: string;
  modelRound: LocalModelRound;
  abortSignal?: AbortSignal;
  maxRounds?: number;
  pathGuard?: WorkflowPathGuard;
  toolExecutor?: LocalToolExecutor;
}

export interface LocalToolExecutionRecord {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
  refused: boolean;
  guardDenied: boolean;
}

export interface LocalDispatcherResult {
  output: string;
  toolCalls: LocalToolExecutionRecord[];
  rounds: number;
  aborted: boolean;
  maxRoundsReached: boolean;
}

const DEFAULT_MAX_ROUNDS = 10;

const defaultToolExecutor: LocalToolExecutor = (toolName, args, cwd) => executeLocalTool(toolName, args, cwd);

function refusalMessage(toolName: string, offered: string[]): string {
  return (
    `Error: a tool "${toolName}" nao esta disponivel para este node. ` +
    `Tools permitidas: ${offered.length > 0 ? offered.join(', ') : '(nenhuma)'}. ` +
    `Use SOMENTE as tools permitidas; nao invente nomes de tool.`
  );
}

function writeTargetOf(toolName: string, args: Record<string, unknown>): string | null {
  if (WRITE_TOOLS.has(toolName)) {
    const fp = args.file_path;
    return typeof fp === 'string' ? fp : null;
  }
  return null;
}

export async function runLocalDispatcher(options: LocalDispatcherOptions): Promise<LocalDispatcherResult> {
  const maxRounds = Math.max(1, options.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const offered = deriveOfferedTools(options.policy);
  const offeredSet = new Set<string>(offered);
  const offeredSchemas = offeredToolSchemas(offered);
  const guard =
    options.pathGuard ??
    new WorkflowPathGuard({
      workspaceRoot: options.policy.workspaceRoot,
      writeSet: undefined,
    });
  const exec = options.toolExecutor ?? defaultToolExecutor;
  const cwd = options.policy.cwd;

  const messages: LocalDispatcherMessage[] = [];
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  messages.push({ role: 'user', content: options.prompt });

  const toolRecords: LocalToolExecutionRecord[] = [];
  let lastText = '';
  let rounds = 0;

  for (let round = 0; round < maxRounds; round++) {
    if (options.abortSignal?.aborted) {
      return {
        output: lastText,
        toolCalls: toolRecords,
        rounds,
        aborted: true,
        maxRoundsReached: false,
      };
    }

    rounds = round + 1;

    const result = await options.modelRound({
      round,
      offeredSchemas,
      messages: [...messages],
    });
    lastText = result.text;
    messages.push({ role: 'assistant', content: result.text });

    if (!result.toolCalls || result.toolCalls.length === 0) {
      return {
        output: lastText,
        toolCalls: toolRecords,
        rounds,
        aborted: false,
        maxRoundsReached: false,
      };
    }

    for (const call of result.toolCalls) {
      if (!offeredSet.has(call.name)) {
        const msg = refusalMessage(call.name, offered);
        toolRecords.push({
          tool: call.name,
          input: call.args,
          output: msg,
          isError: true,
          refused: true,
          guardDenied: false,
        });
        messages.push({
          role: 'tool',
          content: msg,
          toolCallId: call.id,
          toolName: call.name,
        });
        continue;
      }

      const writeTarget = writeTargetOf(call.name, call.args);
      if (writeTarget !== null) {
        const verdict = guard.checkWrite(writeTarget);
        if (!verdict.ok) {
          const msg = `Error: ${verdict.message}`;
          toolRecords.push({
            tool: call.name,
            input: call.args,
            output: msg,
            isError: true,
            refused: false,
            guardDenied: true,
          });
          messages.push({
            role: 'tool',
            content: msg,
            toolCallId: call.id,
            toolName: call.name,
          });
          continue;
        }
      }

      const out = await exec(call.name, call.args, cwd);
      toolRecords.push({
        tool: call.name,
        input: call.args,
        output: out.result,
        isError: out.isError,
        refused: false,
        guardDenied: false,
      });
      messages.push({
        role: 'tool',
        content: out.result,
        toolCallId: call.id,
        toolName: call.name,
      });
    }
  }

  return {
    output: lastText,
    toolCalls: toolRecords,
    rounds,
    aborted: false,
    maxRoundsReached: true,
  };
}

const LOCAL_BUILTIN_SCHEMAS: Record<LocalBuiltinTool, OllamaToolSchema> = {
  Read: {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read the contents of a file from the filesystem.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file.' },
          offset: { type: 'number', description: 'Line offset (0-based).' },
          limit: { type: 'number', description: 'Max lines to read.' },
        },
        required: ['file_path'],
      },
    },
  },
  Write: {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write content to a file, creating it if necessary.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file.' },
          content: { type: 'string', description: 'Content to write.' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  Edit: {
    type: 'function',
    function: {
      name: 'Edit',
      description: 'Replace a substring in a file with new content.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file.' },
          old_string: { type: 'string', description: 'Exact string to replace.' },
          new_string: { type: 'string', description: 'Replacement string.' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  Glob: {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Find files matching a glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match.' },
          path: { type: 'string', description: 'Base directory path.' },
        },
        required: ['pattern'],
      },
    },
  },
  Grep: {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search for a regex pattern in files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search.' },
          path: { type: 'string', description: 'Directory or file to search.' },
          glob: { type: 'string', description: 'File glob filter.' },
        },
        required: ['pattern'],
      },
    },
  },
  Bash: {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Execute a shell command.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          timeout: { type: 'number', description: 'Timeout in milliseconds.' },
        },
        required: ['command'],
      },
    },
  },
};

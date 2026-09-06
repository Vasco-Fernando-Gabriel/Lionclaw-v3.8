
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeCompatExecutorRuntime = 'cloud' | 'zai' | 'minimax-tp';

export interface ClaudeCompatExecResult {
  output: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  apiRequests: number;
  toolUses: number;
}

export interface ClaudeCompatExecInput {
  runtime: ClaudeCompatExecutorRuntime;
  config: AgentQueryConfig;
  prompt: string;
  cwd: string;
  allowedTools: string[];
  mcpServers: AgentQueryConfig['mcpServers'];
  canUseTool: CanUseTool;
  abortSignal: AbortSignal;
  onStreamChunk?: (partial: {
    type: 'text' | 'tool_call' | 'tool_call_start';
    content?: string;
    toolName?: string;
  }) => void;
}

export interface ClaudeCompatExecDeps {
  query?: (opts: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>;
  buildCloudOptions?: BuildOptionsFn;
  buildZaiOptions?: BuildOptionsWithKeyFn;
  buildMinimaxOptions?: BuildOptionsWithKeyFn;
  processStream?: ProcessStreamFn;
  calculateCost?: (
    model: string,
    inT: number,
    outT: number,
    cacheR: number,
    cacheC: number,
  ) => number;
  resolveCliPath?: () => string | Promise<string>;
  resolveProviderApiKey?: (runtime: 'zai' | 'minimax-tp') => Promise<string>;
}

type BuildOptionsFn = (
  req: { agentId: string; prompt: string; cwd: string; permission: { mode: 'default'; dangerouslySkipPermissions: false; canUseTool: CanUseTool } },
  config: AgentQueryConfig,
  cliPath: string,
  childAbort: AbortController,
) => Record<string, unknown>;

type BuildOptionsWithKeyFn = (
  req: { agentId: string; prompt: string; cwd: string; permission: { mode: 'default'; dangerouslySkipPermissions: false; canUseTool: CanUseTool } },
  config: AgentQueryConfig,
  cliPath: string,
  childAbort: AbortController,
  apiKey: string,
) => Record<string, unknown>;

type ProcessStreamFn = (
  q: AsyncIterable<Record<string, unknown>>,
  opts: {
    shouldAbort: () => boolean;
    onText?: (text: string) => void;
    onToolUse?: (toolName: string) => void;
    onToolUseComplete?: (toolName: string, input: unknown) => void;
  },
) => Promise<{
  output: string;
  metrics: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    toolUses: number;
    apiRequests: number;
  };
}>;

export interface SdkStreamUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  apiRequests: number;
}

export function createSdkUsageTap(): {
  wrap: (stream: AsyncIterable<Record<string, unknown>>) => AsyncIterable<Record<string, unknown>>;
  snapshot: () => SdkStreamUsageSnapshot | null;
} {
  const byMessage = new Map<string, { input: number; output: number; cacheRead: number; cacheCreation: number }>();
  let resultFloor: { input: number; output: number; cacheRead: number; cacheCreation: number } | null = null;
  let seen = false;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const observe = (msg: Record<string, unknown>): void => {
    if (msg.type === 'assistant') {
      const message = msg.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (!usage) return;
      seen = true;
      const key = typeof message?.id === 'string' ? message.id : `#${byMessage.size}`;
      const cur = byMessage.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      cur.input = Math.max(cur.input, num(usage.input_tokens));
      cur.output = Math.max(cur.output, num(usage.output_tokens));
      cur.cacheRead = Math.max(cur.cacheRead, num(usage.cache_read_input_tokens));
      cur.cacheCreation = Math.max(cur.cacheCreation, num(usage.cache_creation_input_tokens));
      byMessage.set(key, cur);
      return;
    }
    if (msg.type === 'result') {
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (!usage) return;
      seen = true;
      const cacheRead = num(usage.cache_read_input_tokens);
      const cacheCreation = num(usage.cache_creation_input_tokens);
      resultFloor = {
        input: num(usage.input_tokens) + cacheRead + cacheCreation,
        output: num(usage.output_tokens),
        cacheRead,
        cacheCreation,
      };
    }
  };
  return {
    wrap: (stream) => ({
      async *[Symbol.asyncIterator]() {
        for await (const msg of stream) {
          try {
            observe(msg);
          } catch {
          }
          yield msg;
        }
      },
    }),
    snapshot: () => {
      if (!seen) return null;
      let input = 0;
      let output = 0;
      let cacheRead = 0;
      let cacheCreation = 0;
      for (const u of byMessage.values()) {
        input += u.input + u.cacheRead + u.cacheCreation;
        output += u.output;
        cacheRead += u.cacheRead;
        cacheCreation += u.cacheCreation;
      }
      if (resultFloor) {
        input = Math.max(input, resultFloor.input);
        output = Math.max(output, resultFloor.output);
        cacheRead = Math.max(cacheRead, resultFloor.cacheRead);
        cacheCreation = Math.max(cacheCreation, resultFloor.cacheCreation);
      }
      return {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        apiRequests: byMessage.size,
      };
    },
  };
}

function nodeToolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const v = o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.command ?? o.url;
  return typeof v === 'string' ? v : '';
}

export async function runClaudeCompatNode(
  input: ClaudeCompatExecInput,
  deps: ClaudeCompatExecDeps = {},
): Promise<ClaudeCompatExecResult> {
  const effectiveConfig: AgentQueryConfig = {
    ...input.config,
    allowedTools: input.allowedTools,
    mcpServers: input.mcpServers,
  };

  const childAbort = new AbortController();
  if (input.abortSignal.aborted) childAbort.abort();
  else input.abortSignal.addEventListener('abort', () => childAbort.abort(), { once: true });

  const processOptions = deps.resolveCliPath
    ? {}
    : await defaultResolveProcessOptions();
  const cliPath = deps.resolveCliPath
    ? await deps.resolveCliPath()
    : (processOptions.pathToClaudeCodeExecutable as string) ??
      (await defaultResolveCliPath());
  const reqForBuilder = {
    agentId: 'dynamic-workflow-node',
    prompt: input.prompt,
    cwd: input.cwd,
    permission: {
      mode: 'default' as const,
      dangerouslySkipPermissions: false as const,
      canUseTool: input.canUseTool,
    },
  };

  let options: Record<string, unknown>;
  if (input.runtime === 'cloud') {
    const build = deps.buildCloudOptions ?? (await defaultBuildCloud());
    options = build(reqForBuilder, effectiveConfig, cliPath, childAbort);
  } else {
    const resolveKey = deps.resolveProviderApiKey ?? defaultResolveProviderApiKey;
    const apiKey = await resolveKey(input.runtime);
    const build =
      input.runtime === 'zai'
        ? deps.buildZaiOptions ?? (await defaultBuildZai())
        : deps.buildMinimaxOptions ?? (await defaultBuildMinimax());
    options = build(reqForBuilder, effectiveConfig, cliPath, childAbort, apiKey);
  }
  options = { ...options, ...processOptions };

  const query = deps.query ?? (await defaultQuery());
  const processStream = deps.processStream ?? (await defaultProcessStream());
  const calc = deps.calculateCost ?? (await defaultCalculateCost());

  let textBuf = '';
  let lastFlush = 0;
  const flushText = (force: boolean): void => {
    if (!input.onStreamChunk || textBuf.length === 0) return;
    const now = Date.now();
    if (!force && now - lastFlush < 800) return;
    input.onStreamChunk({ type: 'text', content: textBuf });
    textBuf = '';
    lastFlush = now;
  };

  const usageTap = createSdkUsageTap();
  const q = usageTap.wrap(query({ prompt: input.prompt, options }));
  let result: Awaited<ReturnType<ProcessStreamFn>>;
  try {
    result = await processStream(q, {
    shouldAbort: () => childAbort.signal.aborted,
    onText: input.onStreamChunk
      ? (t: string) => {
          textBuf += t;
          flushText(false);
        }
      : undefined,
    onToolUse: input.onStreamChunk
      ? (tool: string) => {
          flushText(true);
          input.onStreamChunk?.({ type: 'tool_call_start', toolName: tool });
        }
      : undefined,
    onToolUseComplete: input.onStreamChunk
      ? (tool: string, toolInput: unknown) => {
          flushText(true);
          input.onStreamChunk?.({
            type: 'tool_call',
            toolName: tool,
            content: nodeToolDetail(toolInput),
          });
        }
      : undefined,
    });
  } catch (err) {
    flushText(true);
    const partial = usageTap.snapshot();
    if (partial && err && typeof err === 'object') {
      (err as { partialUsage?: unknown }).partialUsage = {
        ...partial,
        costUsd: calc(
          input.config.model,
          partial.inputTokens,
          partial.outputTokens,
          partial.cacheReadTokens,
          partial.cacheCreationTokens,
        ),
      };
    }
    throw err;
  }
  flushText(true);

  const costUsd = calc(
    input.config.model,
    result.metrics.inputTokens,
    result.metrics.outputTokens,
    result.metrics.cacheReadTokens,
    result.metrics.cacheCreationTokens,
  );

  return {
    output: result.output,
    model: input.config.model,
    inputTokens: result.metrics.inputTokens,
    outputTokens: result.metrics.outputTokens,
    cacheReadTokens: result.metrics.cacheReadTokens,
    cacheCreationTokens: result.metrics.cacheCreationTokens,
    costUsd,
    apiRequests: result.metrics.apiRequests ?? 0,
    toolUses: result.metrics.toolUses ?? 0,
  };
}


async function defaultBuildCloud(): Promise<BuildOptionsFn> {
  const { buildClaudeQueryOptions } = await import('../agent-runtime/cloud-executor');
  return buildClaudeQueryOptions as unknown as BuildOptionsFn;
}
async function defaultBuildZai(): Promise<BuildOptionsWithKeyFn> {
  const { buildZaiQueryOptions } = await import('../agent-runtime/zai-executor');
  return buildZaiQueryOptions as unknown as BuildOptionsWithKeyFn;
}
async function defaultBuildMinimax(): Promise<BuildOptionsWithKeyFn> {
  const { buildMinimaxTpQueryOptions } = await import(
    '../agent-runtime/minimax-tokenplan-executor'
  );
  return buildMinimaxTpQueryOptions as unknown as BuildOptionsWithKeyFn;
}
async function defaultQuery(): Promise<
  (opts: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>
> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  return query as unknown as (
    opts: Record<string, unknown>,
  ) => AsyncIterable<Record<string, unknown>>;
}
async function defaultProcessStream(): Promise<ProcessStreamFn> {
  const { processAgentStream } = await import('../stream-processor');
  return processAgentStream as unknown as ProcessStreamFn;
}
type CalculateCostFn = (
  model: string,
  inT: number,
  outT: number,
  cacheR: number,
  cacheC: number,
) => number;
async function defaultCalculateCost(): Promise<CalculateCostFn> {
  const { calculateCost } = await import('../pricing');
  return calculateCost;
}
async function defaultResolveCliPath(): Promise<string> {
  const mod = await import('../pipeline-shared/sdk-bootstrap');
  mod.ensureNodeInPath();
  return mod.getClaudeCodeExecutablePath();
}
async function defaultResolveProcessOptions(): Promise<Record<string, unknown>> {
  const mod = await import('../pipeline-shared/sdk-bootstrap');
  mod.ensureNodeInPath();
  return mod.getClaudeSdkProcessOptions() as Record<string, unknown>;
}
async function defaultResolveProviderApiKey(
  runtime: 'zai' | 'minimax-tp',
): Promise<string> {
  const { getSetting } = await import('../db');
  const { getSecret } = await import('../secrets-vault');
  const settingKey =
    runtime === 'zai'
      ? 'orchestrator_zai_api_key_ref'
      : 'orchestrator_minimax_api_key_ref';
  const vaultRef = getSetting(settingKey);
  if (!vaultRef || vaultRef.trim().length === 0) {
    throw new Error(
      `${runtime} nao esta conectado: configure o provedor em Settings antes de rodar um node ${runtime} no workflow.`,
    );
  }
  const apiKey = await getSecret(vaultRef);
  if (!apiKey) {
    throw new Error(`Chave ${runtime} ausente no Vault (ref=${vaultRef}). Reconecte o provedor.`);
  }
  return apiKey;
}

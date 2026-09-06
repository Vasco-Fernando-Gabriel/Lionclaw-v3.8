import { randomUUID } from 'crypto';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { ChatFeatureToggles, OrchestratorRuntime } from '../../../src/types';
import type { SubagentDispatchContext } from './types';
import type { BrowserWindow } from 'electron';

export type GrokToolProfile = 'chat' | 'remote-chat' | 'pipeline' | 'agent-scoped' | 'one-shot' | 'workflow';

export interface GrokExternalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler(
    params: Record<string, unknown>,
    context?: {
      toolUseId?: string;
      transportCorrelation?: { kind: 'mcp-request-id'; value: string };
      signal?: AbortSignal;
    },
  ): Promise<{ output: string; message: string }>;
}

export interface BuildGrokSessionToolsArgs {
  profile: GrokToolProfile;
  config: AgentQueryConfig;
  cwd: string;
  abortController: AbortController;
  projectId?: string;
  capabilities?: ChatFeatureToggles;
  dispatchContext?: SubagentDispatchContext;
  allowUserQuestion?: boolean;
  getWindow?: () => BrowserWindow | null;
}

export interface GrokSessionTools {
  externalTools: GrokExternalTool[];
  systemPrompt: string;
}

export interface GrokNativeToolPolicy {
  argv: string[];
  effectiveTools: readonly string[];
}

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;
const MCP_TOKEN = /mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+/g;

export const GROK_0_2_103_NATIVE_TOOL_IDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Read: ['read_file'],
  Write: ['write_file'],
  Edit: ['search_replace'],
  Bash: ['run_terminal_cmd'],
  Glob: ['list_dir'],
  Grep: ['grep'],
  WebSearch: ['web_search'],
  WebFetch: ['web_fetch'],
} satisfies Record<string, readonly string[]>);

export function buildGrokNativeToolPolicy(
  profile: GrokToolProfile,
  allowedTools: readonly string[],
): GrokNativeToolPolicy {
  if (profile === 'one-shot') {
    return {
      argv: ['--tools', '', '--disable-web-search'],
      effectiveTools: [],
    };
  }
  const tools = [...new Set(allowedTools.flatMap((name) => GROK_0_2_103_NATIVE_TOOL_IDS[name] ?? []))];
  const argv = ['--tools', tools.join(',')];
  if (!tools.includes('web_search') && !tools.includes('web_fetch')) argv.push('--disable-web-search');
  return { argv, effectiveTools: tools };
}

function externalTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: GrokExternalTool['handler'],
): GrokExternalTool {
  return { name, description, parameters, handler };
}

function runtimeSurface(): OrchestratorRuntime {
  return 'grok-sdk' as unknown as OrchestratorRuntime;
}

interface GrokMcpInvocationScope {
  sessionId: string;
  turnId: string;
}

interface GrokMcpCatalogTool {
  fullName: string;
  serverId: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function parseMcpCatalogTool(entry: {
  mcpId: string;
  toolName: string;
  description: string | null;
  inputSchema: string | null;
}): GrokMcpCatalogTool | null {
  const description = entry.description?.trim();
  if (!description || !entry.inputSchema) return null;
  try {
    const parsed: unknown = JSON.parse(entry.inputSchema);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const inputSchema = parsed as Record<string, unknown>;
    if (inputSchema['type'] !== 'object') return null;
    return {
      fullName: `mcp__${entry.mcpId}__${entry.toolName}`,
      serverId: entry.mcpId,
      toolName: entry.toolName,
      description,
      inputSchema,
    };
  } catch {
    return null;
  }
}

async function buildSubagentTool(args: BuildGrokSessionToolsArgs): Promise<GrokExternalTool> {
  if (!args.dispatchContext) throw new Error('Grok subagent tool requires a host dispatchContext.');
  const host = args.dispatchContext;
  return externalTool(
    'lion_run_subagent',
    'Executa um subagente configurado no LionClaw para uma subtarefa especializada.',
    {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        prompt: { type: 'string' },
        context: { type: 'string' },
      },
      required: ['agentId', 'prompt'],
      additionalProperties: false,
    },
    async (params, callContext) => {
      const agentId = typeof params['agentId'] === 'string' ? params['agentId'] : '';
      const prompt = typeof params['prompt'] === 'string' ? params['prompt'] : '';
      const context = typeof params['context'] === 'string' ? params['context'] : '';
      if (!agentId || !prompt) throw new Error('agentId e prompt sao obrigatorios.');
      try {
        const { dispatchLionSubagent } = await import('./subagent-dispatch');
        const callHost = callContext?.signal
          ? {
              ...host,
              parentAbortSignal: AbortSignal.any([host.parentAbortSignal, callContext.signal]),
            }
          : host;
        const result = await dispatchLionSubagent({
          agentId,
          prompt,
          ...(context ? { context } : {}),
          ...(callContext?.toolUseId ? { toolUseId: callContext.toolUseId } : {}),
          ...(callContext?.transportCorrelation
            ? { transportCorrelation: callContext.transportCorrelation }
            : {}),
        }, callHost);
        if (!result.ok) throw new Error(result.error ?? `Subagent ${agentId} falhou.`);
        return { output: result.output ?? '', message: `subagent ${agentId} concluido` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Erro ao executar subagente "${agentId}": ${message}`, { cause: error });
      }
    },
  );
}

async function buildAskUserTool(
  getWindow: () => BrowserWindow | null,
  abortSignal: AbortSignal,
): Promise<GrokExternalTool> {
  return externalTool(
    'lion_ask_user_question',
    'Pergunta ao usuario quando uma decisao humana for indispensavel.',
    {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
      additionalProperties: false,
    },
    async (params, callContext) => {
      const question = typeof params['question'] === 'string' ? params['question'] : '';
      if (!question) throw new Error('question e obrigatoria.');
      try {
        const { sendAskQuestion } = await import('../ask-question');
        const response = await sendAskQuestion(
          getWindow,
          [{ question, header: 'Pergunta', options: [] }],
          callContext?.signal
            ? AbortSignal.any([abortSignal, callContext.signal])
            : abortSignal,
        );
        const answer = response.answers?.[question];
        return {
          output: Array.isArray(answer) ? answer.join(', ') : String(answer ?? ''),
          message: 'user answered',
        };
      } catch (error) {
        throw new Error(
          `Nao foi possivel perguntar ao usuario: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    },
  );
}

async function readChatCatalog(capabilities?: ChatFeatureToggles): Promise<{
  specs: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  tools: GrokMcpCatalogTool[];
}> {
  const { getMCPConfigForAgent, getMcpToolRegistryEntries } = await import('../mcp-manager');
  const specs = await getMCPConfigForAgent(undefined, {
    surface: runtimeSurface(),
    ...(capabilities ? { capabilities } : {}),
  }) ?? {};
  const allowedServers = new Set(Object.keys(specs));
  const tools = getMcpToolRegistryEntries()
    .filter((entry) => allowedServers.has(entry.mcpId))
    .map(parseMcpCatalogTool)
    .filter((tool): tool is GrokMcpCatalogTool => tool !== null);
  return { specs, tools };
}

async function readAllowedMcpTools(names: readonly string[]): Promise<GrokMcpCatalogTool[]> {
  const allowed = new Set(names.filter((name) => name.startsWith('mcp__')));
  if (allowed.size === 0) return [];
  const { getMcpToolRegistryEntries } = await import('../mcp-manager');
  return getMcpToolRegistryEntries()
    .map(parseMcpCatalogTool)
    .filter((tool): tool is GrokMcpCatalogTool => tool !== null && allowed.has(tool.fullName));
}

async function buildIndexTools(
  scope: GrokMcpInvocationScope,
  catalog: GrokMcpCatalogTool[],
  chatSurface: boolean,
): Promise<{ tools: GrokExternalTool[]; index: string }> {
  const allowedServerIds = [...new Set(catalog.map((tool) => tool.serverId))];
  const allowedTools = new Set(catalog.map((tool) => `${tool.serverId}\0${tool.toolName}`));
  const assertAllowed = (server: string, tool: string): void => {
    if (!allowedTools.has(`${server}\0${tool}`)) {
      throw new Error(`Tool ${server || '(vazio)'}/${tool || '(vazia)'} nao pertence ao escopo MCP desta sessao.`);
    }
  };
  const invoke = externalTool(
    'mcp_invoke',
    'Executa uma tool MCP do indice usando server, tool e args.',
    {
      type: 'object',
      properties: {
        server: { type: 'string' },
        tool: { type: 'string' },
        args: { type: 'object' },
      },
      required: ['server', 'tool'],
      additionalProperties: false,
    },
    async (params, callContext) => {
      const server = String(params['server'] ?? '');
      const tool = String(params['tool'] ?? '');
      try {
        assertAllowed(server, tool);
        const { invokeMcpTool } = await import('../mcp-invoke');
        const result = await invokeMcpTool({
          serverId: server,
          toolName: tool,
          args: record(params['args']),
          surface: 'grok-sdk',
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          allowedServerIds,
          ...(chatSurface ? { context: { surface: 'chat' as const } } : {}),
          ...(callContext?.signal ? { signal: callContext.signal } : {}),
        });
        if (result.isError) throw new Error(result.content);
        return { output: result.content, message: `${result.displayName} ok` };
      } catch (error) {
        throw new Error(
          `Erro ao invocar ${server}/${tool}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    },
  );
  const schema = externalTool(
    'mcp_schema',
    'Retorna o input schema de uma tool MCP do indice.',
    {
      type: 'object',
      properties: { server: { type: 'string' }, tool: { type: 'string' } },
      required: ['server', 'tool'],
      additionalProperties: false,
    },
    async (params) => {
      const server = String(params['server'] ?? '');
      const tool = String(params['tool'] ?? '');
      assertAllowed(server, tool);
      const { getMcpToolSchema } = await import('../mcp-invoke');
      const result = getMcpToolSchema(server, tool);
      if (result.isError) throw new Error(result.content);
      return { output: result.content, message: 'mcp_schema ok' };
    },
  );
  const index = allowedServerIds.length === 0
    ? 'Nenhum servidor MCP esta materializado neste turno.'
    : allowedServerIds.map((server) => {
      const tools = catalog.filter((tool) => tool.serverId === server);
      return `- ${server}: ${tools.map((tool) => tool.toolName).join(', ') || '(sem tools descobertas)'}`;
    }).join('\n');
  return { tools: [invoke, schema], index };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function stripUnmaterializedGrokTools(
  prompt: string,
  materializedNames: ReadonlySet<string>,
): string {
  return prompt
    .split('\n')
    .filter((line) => {
      const names = line.match(MCP_TOKEN) ?? [];
      return names.every((name) => materializedNames.has(name));
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function buildGrokSessionTools(
  args: BuildGrokSessionToolsArgs,
): Promise<GrokSessionTools> {
  let tools: GrokExternalTool[] = [];
  let index = '';
  const mcpScope = { sessionId: randomUUID(), turnId: randomUUID() };
  switch (args.profile) {
    case 'chat': {
      const [subagent, askUser] = await Promise.all([
        args.dispatchContext ? buildSubagentTool(args) : Promise.resolve(null),
        args.allowUserQuestion === true && args.getWindow
          ? buildAskUserTool(args.getWindow, args.abortController.signal)
          : Promise.resolve(null),
      ]);
      const hostTools = [subagent, askUser].filter((tool): tool is GrokExternalTool => tool !== null);
      const catalog = await readChatCatalog(args.capabilities);
      const indexed = await buildIndexTools(mcpScope, catalog.tools, true);
      tools = [...hostTools, ...indexed.tools];
      index = `\n\n## Servidores MCP (indice)\n\n${indexed.index}`;
      break;
    }
    case 'remote-chat': {
      const subagent = args.dispatchContext ? await buildSubagentTool(args) : null;
      tools = subagent ? [subagent] : [];
      break;
    }
    case 'agent-scoped':
    case 'workflow':
    case 'pipeline': {
      const subagent = args.dispatchContext && args.config.allowedTools.includes('Agent')
        ? await buildSubagentTool(args)
        : null;
      const mcpTools = await readAllowedMcpTools(args.config.allowedTools);
      if (mcpTools.length > 0) {
        const indexed = await buildIndexTools(mcpScope, mcpTools, false);
        tools = [...(subagent ? [subagent] : []), ...indexed.tools];
        index = `\n\n## Servidores MCP (indice)\n\n${indexed.index}`;
      } else {
        tools = subagent ? [subagent] : [];
      }
      break;
    }
    case 'one-shot':
      tools = [];
      break;
    default: {
      const exhaustive: never = args.profile;
      throw new Error(`Unhandled Grok tool profile: ${String(exhaustive)}`);
    }
  }
  const names = new Set(tools.map((tool) => tool.name));
  const prompt = stripUnmaterializedGrokTools(`${args.config.systemPrompt}${index}`, names);
  const steering = names.has('lion_run_subagent')
    ? 'Subagentes nativos do Grok Build estao desabilitados. Para delegar, use lion_run_subagent.'
    : 'Subagentes nativos do Grok Build estao desabilitados nesta sessao.';
  return {
    externalTools: tools,
    systemPrompt: `${prompt}\n\n${steering}`.trim(),
  };
}

export { EMPTY_SCHEMA as GROK_EMPTY_TOOL_SCHEMA };

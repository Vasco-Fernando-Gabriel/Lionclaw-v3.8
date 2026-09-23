import type { BrowserWindow } from 'electron';
import type { ChatFeatureToggles } from '../../../src/types';
import type { SubagentDispatchContext } from './types';
import type { CursorCustomToolDeclaration } from './cursor-sidecar/protocol';
import type { CursorToolHandler } from './cursor-sidecar/tool-dispatch';
import { createMcpInvokeToolHandler } from './cursor-sidecar/tool-dispatch';
import { chatInvocationContext, type McpInvocationLane } from '../mcp-invocation-context';

export type CursorChatToolProfile = 'chat' | 'remote-chat';

export interface CursorChatMcpScope {
  sessionId: string;
  turnId: string;
  lane?: McpInvocationLane;
}

export interface BuildCursorSessionToolsArgs {
  profile: CursorChatToolProfile;
  systemPrompt: string;
  scope: CursorChatMcpScope;
  agentId?: string;
  capabilities?: ChatFeatureToggles;
  dispatchContext?: SubagentDispatchContext;
  allowUserQuestion?: boolean;
  getWindow?: () => BrowserWindow | null;
  abortSignal: AbortSignal;
}

export interface CursorSessionTools {
  declarations: CursorCustomToolDeclaration[];
  handlers: Record<string, CursorToolHandler>;
  systemPrompt: string;
  allowedServerIds: string[];
}

const MCP_TOKEN = /mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+/g;
const STRING_PROP = { type: 'string' } as const;

interface CursorMcpCatalogTool {
  serverId: string;
  toolName: string;
}

interface McpCatalogRegistryEntry {
  mcpId: string;
  toolName: string;
  description: string | null;
  inputSchema: string | null;
}

function parseCatalogTool(entry: McpCatalogRegistryEntry): CursorMcpCatalogTool | null {
  if (!entry.description?.trim() || !entry.inputSchema) return null;
  try {
    const parsed: unknown = JSON.parse(entry.inputSchema);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if ((parsed as Record<string, unknown>)['type'] !== 'object') return null;
    return { serverId: entry.mcpId, toolName: entry.toolName };
  } catch {
    return null;
  }
}

async function readChatCatalog(
  agentId: string | undefined,
  capabilities: ChatFeatureToggles | undefined,
): Promise<{ tools: CursorMcpCatalogTool[]; allowedServerIds: string[] }> {
  const { getMCPConfigForAgent, getMcpToolRegistryEntries } = await import('../mcp-manager');
  const specs =
    (await getMCPConfigForAgent(agentId, {
      surface: 'cursor-sdk',
      ...(capabilities ? { capabilities } : {}),
    })) ?? {};
  const allowedServers = new Set(Object.keys(specs));
  const tools = getMcpToolRegistryEntries()
    .filter((entry) => allowedServers.has(entry.mcpId))
    .map(parseCatalogTool)
    .filter((tool): tool is CursorMcpCatalogTool => tool !== null);
  return { tools, allowedServerIds: [...allowedServers] };
}

function buildIndexTools(input: {
  scope: CursorChatMcpScope;
  catalog: CursorMcpCatalogTool[];
  allowedServerIds: string[];
  chatSurface: boolean;
}): {
  declarations: CursorCustomToolDeclaration[];
  handlers: Record<string, CursorToolHandler>;
  index: string;
} {
  const allowedPairs = new Set(input.catalog.map((tool) => `${tool.serverId}\0${tool.toolName}`));
  const assertAllowed = (server: string, tool: string): void => {
    if (!allowedPairs.has(`${server}\0${tool}`)) {
      throw new Error(`Tool ${server || '(vazio)'}/${tool || '(vazia)'} nao pertence ao escopo MCP desta sessao.`);
    }
  };

  const innerInvoke = createMcpInvokeToolHandler({
    surface: 'cursor-sdk',
    sessionId: input.scope.sessionId,
    allowedServerIds: input.allowedServerIds,
    getTurnId: () => input.scope.turnId,
    ...(input.chatSurface
      ? {
          context: chatInvocationContext(
            input.scope.lane
              ? { sessionId: input.scope.sessionId, turnId: input.scope.turnId, lane: input.scope.lane }
              : undefined,
          ),
        }
      : {}),
  });

  const invokeHandler: CursorToolHandler = async (invocation, ctx) => {
    const server = typeof invocation.args['server'] === 'string' ? (invocation.args['server'] as string).trim() : '';
    const tool = typeof invocation.args['tool'] === 'string' ? (invocation.args['tool'] as string).trim() : '';
    assertAllowed(server, tool);
    return innerInvoke(invocation, ctx);
  };

  const schemaHandler: CursorToolHandler = async (invocation) => {
    const server = typeof invocation.args['server'] === 'string' ? (invocation.args['server'] as string).trim() : '';
    const tool = typeof invocation.args['tool'] === 'string' ? (invocation.args['tool'] as string).trim() : '';
    assertAllowed(server, tool);
    const { getMcpToolSchema } = await import('../mcp-invoke');
    const result = getMcpToolSchema(server, tool);
    if (result.isError) throw new Error(result.content);
    return result.content;
  };

  const declarations: CursorCustomToolDeclaration[] = [
    {
      name: 'mcp_invoke',
      description: 'Executa uma tool MCP do indice usando server, tool e args.',
      inputSchema: {
        type: 'object',
        properties: {
          server: STRING_PROP,
          tool: STRING_PROP,
          args: { type: 'object' },
        },
        required: ['server', 'tool'],
        additionalProperties: false,
      },
    },
    {
      name: 'mcp_schema',
      description: 'Retorna o input schema de uma tool MCP do indice.',
      inputSchema: {
        type: 'object',
        properties: { server: STRING_PROP, tool: STRING_PROP },
        required: ['server', 'tool'],
        additionalProperties: false,
      },
    },
  ];

  const serverIdsWithTools = [...new Set(input.catalog.map((tool) => tool.serverId))];
  const index =
    serverIdsWithTools.length === 0
      ? 'Nenhum servidor MCP esta materializado neste turno.'
      : serverIdsWithTools
          .map((server) => {
            const tools = input.catalog.filter((tool) => tool.serverId === server);
            return `- ${server}: ${tools.map((tool) => tool.toolName).join(', ') || '(sem tools descobertas)'}`;
          })
          .join('\n');

  return {
    declarations,
    handlers: { mcp_invoke: invokeHandler, mcp_schema: schemaHandler },
    index,
  };
}

function buildSubagentTool(host: SubagentDispatchContext): {
  declaration: CursorCustomToolDeclaration;
  handler: CursorToolHandler;
} {
  return {
    declaration: {
      name: 'lion_run_subagent',
      description: 'Executa um subagente configurado no LionClaw para uma subtarefa especializada.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: STRING_PROP,
          prompt: STRING_PROP,
          context: STRING_PROP,
        },
        required: ['agentId', 'prompt'],
        additionalProperties: false,
      },
    },
    handler: async (invocation, ctx) => {
      const agentId = typeof invocation.args['agentId'] === 'string' ? (invocation.args['agentId'] as string) : '';
      const prompt = typeof invocation.args['prompt'] === 'string' ? (invocation.args['prompt'] as string) : '';
      const context = typeof invocation.args['context'] === 'string' ? (invocation.args['context'] as string) : '';
      if (!agentId || !prompt) throw new Error('agentId e prompt sao obrigatorios.');
      const { dispatchLionSubagent } = await import('./subagent-dispatch');
      const callHost: SubagentDispatchContext = {
        ...host,
        parentAbortSignal: AbortSignal.any([host.parentAbortSignal, ctx.signal]),
      };
      const result = await dispatchLionSubagent(
        {
          agentId,
          prompt,
          ...(context ? { context } : {}),
        },
        callHost,
      );
      if (!result.ok) throw new Error(result.error ?? `Subagent ${agentId} falhou.`);
      return result.output ?? '';
    },
  };
}

function buildAskUserTool(
  getWindow: () => BrowserWindow | null,
  sessionAbortSignal: AbortSignal,
  sessionId: string,
): { declaration: CursorCustomToolDeclaration; handler: CursorToolHandler } {
  return {
    declaration: {
      name: 'lion_ask_user_question',
      description: 'Pergunta ao usuario quando uma decisao humana for indispensavel.',
      inputSchema: {
        type: 'object',
        properties: { question: STRING_PROP },
        required: ['question'],
        additionalProperties: false,
      },
    },
    handler: async (invocation, ctx) => {
      const question = typeof invocation.args['question'] === 'string' ? (invocation.args['question'] as string) : '';
      if (!question) throw new Error('question e obrigatoria.');
      const { sendAskQuestion } = await import('../ask-question');
      const response = await sendAskQuestion(
        getWindow,
        [{ question, header: 'Pergunta', options: [] }],
        AbortSignal.any([sessionAbortSignal, ctx.signal]),
        undefined,
        { sessionId },
      );
      const answer = response.answers?.[question];
      return Array.isArray(answer) ? answer.join(', ') : String(answer ?? '');
    },
  };
}

export function stripUnmaterializedCursorTools(prompt: string, materializedNames: ReadonlySet<string>): string {
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

export async function buildCursorSessionTools(args: BuildCursorSessionToolsArgs): Promise<CursorSessionTools> {
  const declarations: CursorCustomToolDeclaration[] = [];
  const handlers: Record<string, CursorToolHandler> = {};
  let index = '';
  let allowedServerIds: string[] = [];

  if (args.dispatchContext) {
    const subagent = buildSubagentTool(args.dispatchContext);
    declarations.push(subagent.declaration);
    handlers[subagent.declaration.name] = subagent.handler;
  }

  switch (args.profile) {
    case 'chat': {
      if (args.allowUserQuestion === true && args.getWindow) {
        const askUser = buildAskUserTool(args.getWindow, args.abortSignal, args.scope.sessionId);
        declarations.push(askUser.declaration);
        handlers[askUser.declaration.name] = askUser.handler;
      }
      const catalog = await readChatCatalog(args.agentId, args.capabilities);
      allowedServerIds = catalog.allowedServerIds;
      const indexed = buildIndexTools({
        scope: args.scope,
        catalog: catalog.tools,
        allowedServerIds: catalog.allowedServerIds,
        chatSurface: true,
      });
      declarations.push(...indexed.declarations);
      Object.assign(handlers, indexed.handlers);
      index = `\n\n## Servidores MCP (indice)\n\n${indexed.index}`;
      break;
    }
    case 'remote-chat':
      break;
    default: {
      const exhaustive: never = args.profile;
      throw new Error(`Unhandled Cursor chat tool profile: ${String(exhaustive)}`);
    }
  }

  const names = new Set(declarations.map((decl) => decl.name));
  const prompt = stripUnmaterializedCursorTools(`${args.systemPrompt}${index}`, names);
  const steering = names.has('lion_run_subagent')
    ? 'Os subagents nativos do Cursor estao desabilitados. Para delegar, use lion_run_subagent.'
    : 'Os subagents nativos do Cursor estao desabilitados nesta sessao.';
  return {
    declarations,
    handlers,
    systemPrompt: `${prompt}\n\n${steering}`.trim(),
    allowedServerIds,
  };
}

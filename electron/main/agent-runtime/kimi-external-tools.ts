import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createLogger } from '../logger';
import { KimiUnavailableError } from './kimi-availability';
import { isDirectMcpHelper } from '../mcp-risk-patterns';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { ChatFeatureToggles } from '../../../src/types';
import type { SubagentDispatchContext } from './types';
import { chatInvocationContext, type McpInvocationTurnBinding } from '../mcp-invocation-context';

const logger = createLogger('kimi-external-tools');

export interface KimiExternalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (
    params: Record<string, unknown>,
    context?: {
      toolUseId?: string;
      transportCorrelation?: { kind: 'mcp-request-id'; value: string };
      signal?: AbortSignal;
    },
  ) => Promise<{ output: string; message: string; isError?: boolean }>;
}

export const KIMI_SUBAGENT_TOOL_NAME = 'lion_run_subagent';
export const KIMI_USER_QUESTION_TOOL_NAME = 'lion_ask_user_question';
export const KIMI_MCP_INVOKE_TOOL_NAME = 'mcp_invoke';
export const KIMI_MCP_SCHEMA_TOOL_NAME = 'mcp_schema';

interface SubagentToolArgs {
  cwd: string;
  abortController: AbortController;
  projectId?: string;
  dispatchContext?: SubagentDispatchContext;
}

async function makeExternalTool<T extends z.ZodObject<z.ZodRawShape>>(def: {
  name: string;
  description: string;
  parameters: T;
  handler: (
    params: z.infer<T>,
    context?: {
      toolUseId?: string;
      transportCorrelation?: { kind: 'mcp-request-id'; value: string };
      signal?: AbortSignal;
    },
  ) => Promise<{ output: string; message: string; isError?: boolean }>;
}): Promise<KimiExternalTool> {
  let sdk: typeof import('@moonshot-ai/kimi-agent-sdk');
  try {
    sdk = await import('@moonshot-ai/kimi-agent-sdk');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { tool: def.name, error: msg },
      'SDK do Kimi indisponivel: nao foi possivel materializar a external tool',
    );
    throw new KimiUnavailableError(
      `SDK do Kimi (@moonshot-ai/kimi-agent-sdk) indisponivel; a tool "${def.name}" nao pode ser criada.`,
    );
  }
  const sdkTool = sdk.createExternalTool(def) as unknown as KimiExternalTool;
  return {
    ...sdkTool,
    handler: (params, context) => def.handler(def.parameters.parse(params), context),
  };
}

async function withMcpInputSchema(tool: KimiExternalTool): Promise<KimiExternalTool> {
  const [prefix, serverId, ...nameParts] = tool.name.split('__');
  const toolName = nameParts.join('__');
  if (prefix !== 'mcp' || !serverId || !toolName) return tool;
  try {
    const { getMcpToolRegistryEntries } = await import('../mcp-manager');
    const entry = getMcpToolRegistryEntries(serverId).find((item) => item.toolName === toolName);
    if (!entry?.inputSchema) {
      logger.warn({ tool: tool.name }, 'MCP input schema unavailable for Kimi catalog tool');
      return tool;
    }
    const schema: unknown = JSON.parse(entry.inputSchema);
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new Error('MCP input schema must be an object');
    }
    return { ...tool, parameters: schema as Record<string, unknown> };
  } catch (error) {
    logger.warn(
      { tool: tool.name, error: error instanceof Error ? error.message : String(error) },
      'Could not load MCP input schema for Kimi catalog tool',
    );
    return tool;
  }
}

export async function buildSubagentTriggerTool(args: SubagentToolArgs): Promise<KimiExternalTool> {
  const { dispatchContext } = args;
  return makeExternalTool({
    name: KIMI_SUBAGENT_TOOL_NAME,
    description:
      'Dispara um subagente do Lion (qualquer agente configurado) e retorna sua saida. Use para delegar uma sub-tarefa a um agente especializado.',
    parameters: z.object({
      agentId: z.string().describe('ID do agente Lion a disparar (ex: "harness-coder")'),
      prompt: z.string().describe('A tarefa ou pergunta para o subagente'),
      context: z
        .string()
        .optional()
        .describe('Contexto adicional opcional (dados lidos, resultados de busca) prefixado ao prompt'),
    }),
    handler: async ({ agentId, prompt, context }, callContext) => {
      try {
        if (!dispatchContext) throw new Error('Contexto host de subagente indisponivel.');
        const { dispatchLionSubagent } = await import('./subagent-dispatch');
        const host = callContext?.signal
          ? {
              ...dispatchContext,
              parentAbortSignal: AbortSignal.any([dispatchContext.parentAbortSignal, callContext.signal]),
            }
          : dispatchContext;
        const result = await dispatchLionSubagent(
          {
            agentId,
            prompt,
            context,
            ...(callContext?.toolUseId ? { toolUseId: callContext.toolUseId } : {}),
            ...(callContext?.transportCorrelation ? { transportCorrelation: callContext.transportCorrelation } : {}),
          },
          host,
        );
        if (!result.ok) throw new Error(result.error ?? 'Falha desconhecida no subagente.');
        return { output: result.output ?? '', message: `subagent ${agentId} concluido (${result.executionId})` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ agentId, error: msg }, 'lion_run_subagent failed');
        return { output: `Erro ao executar subagente "${agentId}": ${msg}`, message: 'subagent failed', isError: true };
      }
    },
  });
}

export async function buildUserQuestionTool(sessionId?: string): Promise<KimiExternalTool> {
  return makeExternalTool({
    name: KIMI_USER_QUESTION_TOOL_NAME,
    description:
      'Pergunta ao usuario uma ou mais perguntas e aguarda a resposta. Use quando precisar de uma decisao ou esclarecimento humano antes de prosseguir.',
    parameters: z.object({
      question: z.string().describe('A pergunta a fazer ao usuario'),
    }),
    handler: async ({ question }, callContext) => {
      try {
        const { sendAskQuestion } = await import('../ask-question');
        const { BrowserWindow } = await import('electron');
        const getWindow = (): import('electron').BrowserWindow | null =>
          BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
        const response = await sendAskQuestion(
          getWindow,
          [{ question, header: 'Pergunta', options: [] }],
          callContext?.signal,
          undefined,
          sessionId ? { sessionId } : undefined,
        );
        const raw = response.answers?.[question];
        const answer = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '');
        return { output: answer, message: 'user answered' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg }, 'lion_ask_user_question failed');
        return { output: `Nao foi possivel perguntar ao usuario: ${msg}`, message: 'ask failed', isError: true };
      }
    },
  });
}

export async function readChatMcpCatalog(capabilities?: ChatFeatureToggles): Promise<
  Array<{
    serverId: string;
    spec: { command: string; args: string[]; env?: Record<string, string> };
    toolNames: string[];
  }>
> {
  const { getMCPConfigForAgent, getMCPToolsFromRegistry } = await import('../mcp-manager');
  const config = await getMCPConfigForAgent(undefined, { surface: 'kimi-sdk', capabilities });
  if (!config) return [];
  const out: Array<{
    serverId: string;
    spec: { command: string; args: string[]; env?: Record<string, string> };
    toolNames: string[];
  }> = [];
  for (const [serverId, spec] of Object.entries(config)) {
    const toolNames = getMCPToolsFromRegistry([serverId]);
    out.push({ serverId, spec, toolNames });
  }
  return out;
}

async function buildSpawnPerCallCatalogTool(
  serverId: string,
  spec: { command: string; args: string[]; env?: Record<string, string> },
  fullName: string,
  description?: string,
): Promise<KimiExternalTool> {
  return withMcpInputSchema(
    await makeExternalTool({
      name: fullName,
      description: description ?? `Tool MCP ${fullName} (servidor ${serverId}).`,
      parameters: z.object({}).passthrough(),
      handler: async (params, callContext) => {
        try {
          const { setupMCPsForSession, callMCPTool, teardownMCPsForSession } = await import('../mcp-tool-bridge');
          const setup = callContext?.signal
            ? await setupMCPsForSession({ [serverId]: spec }, { signal: callContext.signal })
            : await setupMCPsForSession({ [serverId]: spec });
          const { client } = setup;
          try {
            const result = callContext?.signal
              ? await callMCPTool(client, fullName, params, { signal: callContext.signal })
              : await callMCPTool(client, fullName, params);
            return { output: JSON.stringify(result ?? null), message: `${fullName} ok` };
          } finally {
            await teardownMCPsForSession(client);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ tool: fullName, error: msg }, 'core MCP catalog tool failed');
          return { output: `Erro ao chamar ${fullName}: ${msg}`, message: 'mcp tool failed', isError: true };
        }
      },
    }),
  );
}

async function buildScopedDirectCatalogTool(
  serverId: string,
  fullName: string,
  description: string | undefined,
  scope: KimiMcpScope,
  allowedServerIds: string[],
): Promise<KimiExternalTool> {
  const prefix = `mcp__${serverId}__`;
  const toolName = fullName.startsWith(prefix) ? fullName.slice(prefix.length) : '';
  if (!toolName) throw new Error(`Nome MCP invalido: ${fullName}`);
  return withMcpInputSchema(
    await makeExternalTool({
      name: fullName,
      description: description ?? `Tool MCP ${fullName} (servidor ${serverId}).`,
      parameters: z.object({}).passthrough(),
      handler: async (params, callContext) => {
        try {
          const { invokeMcpTool } = await import('../mcp-invoke');
          const result = await invokeMcpTool({
            serverId,
            toolName,
            args: params,
            surface: 'kimi-sdk',
            sessionId: scope.sessionId,
            turnId: scope.turnId,
            allowedServerIds,
            context: chatInvocationContext(scope.binding),
            ...(callContext?.signal ? { signal: callContext.signal } : {}),
          });
          return {
            output: result.content,
            message: `${result.displayName} ${result.isError ? 'failed' : 'ok'}`,
            ...(result.isError ? { isError: true } : {}),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ tool: fullName, error: msg }, 'direct MCP helper failed');
          return { output: `Erro ao chamar ${fullName}: ${msg}`, message: `${fullName} failed`, isError: true };
        }
      },
    }),
  );
}

interface KimiMcpScope {
  sessionId: string;
  turnId: string;
  binding?: McpInvocationTurnBinding;
}

async function buildMcpInvokeMetaTool(scope: KimiMcpScope, allowedServerIds: string[]): Promise<KimiExternalTool> {
  return makeExternalTool({
    name: KIMI_MCP_INVOKE_TOOL_NAME,
    description:
      'Executa uma tool de um servidor MCP do catalogo. Consulte o indice "Servidores MCP" no system prompt para servers e tools; em caso de duvida sobre os args, use mcp_schema antes.',
    parameters: z.object({
      server: z.string().describe('ID do servidor MCP (cabecalho do indice)'),
      tool: z.string().describe('Nome exato da tool como listada no indice'),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Argumentos da tool como objeto JSON conforme o schema. Preserve arrays, objetos, números e booleanos; não serialize valores aninhados como strings.',
        ),
    }),
    handler: async ({ server, tool, args }, callContext) => {
      try {
        const { invokeMcpTool } = await import('../mcp-invoke');
        const result = await invokeMcpTool({
          serverId: server,
          toolName: tool,
          args: args ?? {},
          surface: 'kimi-sdk',
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          allowedServerIds,
          context: chatInvocationContext(scope.binding),
          ...(callContext?.signal ? { signal: callContext.signal } : {}),
        });
        return {
          output: result.content,
          message: `${result.displayName} ${result.isError ? 'failed' : 'ok'}`,
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ server, tool, error: msg }, 'mcp_invoke failed');
        return {
          output: `Erro ao invocar ${tool} no servidor ${server}: ${msg}`,
          message: `${KIMI_MCP_INVOKE_TOOL_NAME} failed`,
          isError: true,
        };
      }
    },
  });
}

async function buildMcpSchemaMetaTool(): Promise<KimiExternalTool> {
  return makeExternalTool({
    name: KIMI_MCP_SCHEMA_TOOL_NAME,
    description:
      'Retorna o contrato completo (input schema) de uma tool MCP listada no indice "Servidores MCP" do system prompt, antes de invoca-la com mcp_invoke.',
    parameters: z.object({
      server: z.string().describe('ID do servidor MCP'),
      tool: z.string().describe('Nome exato da tool'),
    }),
    handler: async ({ server, tool }) => {
      try {
        const { getMcpToolSchema } = await import('../mcp-invoke');
        const r = getMcpToolSchema(server, tool);
        return {
          output: r.content,
          message: `${KIMI_MCP_SCHEMA_TOOL_NAME} ${r.isError ? 'failed' : 'ok'}`,
          ...(r.isError ? { isError: true } : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ server, tool, error: msg }, 'mcp_schema failed');
        return {
          output: `Erro ao consultar o schema de ${tool} no servidor ${server}: ${msg}`,
          message: `${KIMI_MCP_SCHEMA_TOOL_NAME} failed`,
          isError: true,
        };
      }
    },
  });
}

export async function buildCoreMcpCatalogTools(
  _config: AgentQueryConfig,
  mcpPromptMode: 'index' | 'full',
  capabilities?: ChatFeatureToggles,
  turnBinding?: McpInvocationTurnBinding,
): Promise<KimiExternalTool[]> {
  const catalog = await readChatMcpCatalog(capabilities);
  const tools: KimiExternalTool[] = [];

  if (mcpPromptMode === 'full') {
    for (const { serverId, spec, toolNames } of catalog) {
      for (const fullName of toolNames) {
        tools.push(await buildSpawnPerCallCatalogTool(serverId, spec, fullName));
      }
    }
    return tools;
  }

  const allowedServerIds = catalog.map((c) => c.serverId);
  const scope: KimiMcpScope = turnBinding
    ? { sessionId: turnBinding.sessionId, turnId: turnBinding.turnId, binding: turnBinding }
    : { sessionId: `kimi-sdk-${randomUUID()}`, turnId: '1' };

  tools.push(await buildMcpInvokeMetaTool(scope, allowedServerIds));
  tools.push(await buildMcpSchemaMetaTool());

  const helperDescriptions = new Map<string, string>();
  try {
    const { getMcpToolRegistryEntries } = await import('../mcp-manager');
    for (const { serverId } of catalog) {
      if (!isDirectMcpHelper(serverId)) continue;
      for (const entry of getMcpToolRegistryEntries(serverId)) {
        const desc = (entry.description ?? '').trim();
        if (desc.length > 0) {
          helperDescriptions.set(`mcp__${entry.mcpId}__${entry.toolName}`, desc);
        }
      }
    }
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'registry de descriptions indisponivel; helpers com description generica',
    );
  }
  for (const { serverId, toolNames } of catalog) {
    if (!isDirectMcpHelper(serverId)) continue;
    for (const fullName of toolNames) {
      tools.push(
        await buildScopedDirectCatalogTool(
          serverId,
          fullName,
          helperDescriptions.get(fullName),
          scope,
          allowedServerIds,
        ),
      );
    }
  }

  return tools;
}

export async function buildAllowlistTool(
  toolName: string,
  capabilities?: ChatFeatureToggles,
): Promise<KimiExternalTool> {
  return withMcpInputSchema(
    await makeExternalTool({
      name: toolName,
      description: `Tool MCP permitida ao agente: ${toolName}.`,
      parameters: z.object({}).passthrough(),
      handler: async (params, callContext) => {
        try {
          const parts = toolName.split('__');
          const serverId = parts[1];
          const { getMCPConfigForAgent } = await import('../mcp-manager');
          const config = await getMCPConfigForAgent(undefined, { surface: 'kimi-sdk', capabilities });
          const spec = config?.[serverId];
          if (!spec) {
            return { output: `Servidor MCP "${serverId}" indisponivel`, message: 'mcp server missing', isError: true };
          }
          const { setupMCPsForSession, callMCPTool, teardownMCPsForSession } = await import('../mcp-tool-bridge');
          const setup = callContext?.signal
            ? await setupMCPsForSession({ [serverId]: spec }, { signal: callContext.signal })
            : await setupMCPsForSession({ [serverId]: spec });
          const { client } = setup;
          try {
            const result = callContext?.signal
              ? await callMCPTool(client, toolName, params, { signal: callContext.signal })
              : await callMCPTool(client, toolName, params);
            return { output: JSON.stringify(result ?? null), message: `${toolName} ok` };
          } finally {
            await teardownMCPsForSession(client);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ tool: toolName, error: msg }, 'allowlist MCP tool failed');
          return { output: `Erro ao chamar ${toolName}: ${msg}`, message: 'tool failed', isError: true };
        }
      },
    }),
  );
}

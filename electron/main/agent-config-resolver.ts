import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { getAgent, getEnabledTools, getCompletedDocsCount } from './db';
import { getMCPToolsFromRegistry, buildMCPSpecForAgent, getAllMCPServers } from './mcp-manager';
import { getLionClawHome } from './paths';
import type { AgentConfig } from '../../src/types';

const logger = createLogger('agent-config-resolver');

// ---------------------------------------------------------------------------
// DECIDIDO invitation — injected at execution time for conversational pipeline
// agents so the phrase never gets persisted to the DB even if the user edits
// the seed prompt.
// ---------------------------------------------------------------------------

const DECIDIDO_INVITE =
  '\n\nSempre que voce concluir uma alteracao no documento, encerre sua mensagem perguntando ao usuario se ele deseja fazer mais alguma alteracao ou se pode clicar em APROVAR para avancar para a proxima etapa.';

const CONVERSATIONAL_AGENTS_NEEDING_INVITE = new Set([
  'discovery-agent',
  'prd-validator',
  'tech-database',
  'tech-backend',
  'tech-frontend',
  'tech-security',
  'spec-enricher',
  'architecture-spec-enricher',
  'sprint-validator',
]);

/** MCP server spec entry matching what the Agent SDK expects for subagent definitions. */
export type McpServerEntry = Record<string, {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}>;

// ---------------------------------------------------------------------------
// (A3, F12/11.1) repo-graph: merge de allowlist + spec do MCP para subagents
// cloud (SPEC spec-chat-repo-codegraph.md). O reader tem SO 7 tools — nenhuma
// de build/update (enforcement estrutural 5.2): subagent nunca ganha escrita.
// ---------------------------------------------------------------------------

/** Id do subprocess MCP repo-graph (registrado no boot, visibleTo 'all'). */
export const REPO_GRAPH_MCP_SERVER_ID = 'repo-graph';

/** As 7 tools READER-ONLY no formato `mcp__<serverId>__<tool>` do Agent SDK. */
export const REPO_GRAPH_READER_TOOLS: readonly string[] = [
  'repo_graph_status',
  'repo_graph_search',
  'repo_graph_minimal_context',
  'repo_graph_impact',
  'repo_graph_node',
  'repo_graph_callers',
  'repo_graph_callees',
].map((toolName) => `mcp__${REPO_GRAPH_MCP_SERVER_ID}__${toolName}`);

/**
 * MERGE da allowlist do subagent com as 7 tools repo-graph (F12): toolSet.add
 * SEM sobrescrever a allowlist existente do agente. Idempotente (Set dedupe).
 */
export function mergeRepoGraphAllowlist(allowedTools: string[]): string[] {
  const toolSet = new Set(allowedTools);
  for (const tool of REPO_GRAPH_READER_TOOLS) {
    toolSet.add(tool);
  }
  return [...toolSet];
}

/**
 * Spec do subprocess MCP repo-graph para a definition do subagent (mesmo shape
 * de buildMCPSpecForAgent). null quando o server nao esta registrado (boot sem
 * dist do subprocess) — nesse caso o merge de tools/spec e omitido no caller.
 */
export function buildRepoGraphMcpSpec(): McpServerEntry | null {
  const specs = buildMCPSpecForAgent([REPO_GRAPH_MCP_SERVER_ID]);
  const entry = specs?.find((spec) => REPO_GRAPH_MCP_SERVER_ID in spec);
  return entry ?? null;
}

/**
 * The fully resolved configuration for a single agent, ready to pass into the
 * Agent SDK subagent definition or any other consumer that needs the assembled
 * per-agent config.
 */
export interface AgentQueryConfig {
  model: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpServers: McpServerEntry[];
  maxTurns: number | undefined;
  effort: AgentConfig['effort'];
  thinking: AgentConfig['thinking'];
  thinkingBudget: number | undefined;
  runtime: AgentConfig['runtime'];
  /**
   * Eixos de permissao por agentType (SPEC dynamic-workflow claude-code, Sec 5):
   * o TETO re-fonteado da policy do node no modo claude-code. `resolveAgentQueryConfig`
   * SEMPRE os popula com defaults CONSERVADORES (read-only, sem Bash/rede) quando o
   * agent nao os define. OPCIONAIS no tipo (aditivo): os caminhos legados que montam
   * um `AgentQueryConfig` a mao SEM passar pelo resolver (Maestro lean, chat
   * orchestrator do Kimi) nao carregam eixos de node e seguem byte-identicos; o modo
   * manifest legado tampouco os consome.
   */
  access?: 'read-only' | 'workspace-write';
  allowBash?: boolean;
  allowedCommands?: string[];
  allowNetwork?: boolean;
}

/**
 * Resolve the complete query configuration for a single agent identified by
 * `agentId`. Reads the agent from the database, applies global tool filter,
 * merges MCP server specs, auto-injects Knowledge-Base and Skills MCPs when
 * applicable, and builds the final system prompt.
 *
 * Emits non-blocking warnings when expected tools are missing for well-known
 * agent roles (planner, coder, evaluator).
 *
 * @throws {Error} when no agent with the given id exists in the database.
 */
export async function resolveAgentQueryConfig(agentId: string): Promise<AgentQueryConfig> {
  const agent = getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const globalEnabled = new Set(getEnabledTools());

  // --- Tool resolution ---

  // Built-in tools: filtered by agent allowedTools AND global enabled set.
  const builtinTools = agent.allowedTools.filter((t: string) => globalEnabled.has(t));

  // Remote MCP tools (claude.ai managed): passed through directly from allowedTools.
  // These exist in the SDK session but are absent from the local registry.
  // The "mcp__claude_ai_" prefix identifies SDK-managed remote MCPs.
  const remoteMcpTools = agent.allowedTools.filter((t: string) => t.startsWith('mcp__claude_ai_'));

  // Local MCP tools: auto-derived from the registry based on the MCP servers
  // linked to the agent. Zero extra configuration needed — linking the MCP is enough.
  const mcpToolsFromLinked = getMCPToolsFromRegistry(agent.mcpServers);

  const tools: string[] = [...builtinTools, ...remoteMcpTools, ...mcpToolsFromLinked];

  // --- MCP server spec assembly ---

  const mcpSpec = agent.mcpServers.length > 0
    ? buildMCPSpecForAgent(agent.mcpServers)
    : undefined;

  const agentMcpServers: McpServerEntry[] = mcpSpec ? [...mcpSpec] : [];

  // Ensure knowledge-base MCP always carries KB_AGENT_ID so its subprocess
  // knows which agent's documents to search — even when it was manually added
  // to mcp_servers rather than auto-injected by the block below.
  for (const spec of agentMcpServers) {
    if ('knowledge-base' in spec) {
      const kbEntry = spec['knowledge-base'];
      if (!kbEntry.env) kbEntry.env = {};
      kbEntry.env['KB_AGENT_ID'] = agent.id;
    }
  }

  // --- Auto-inject Knowledge-Base MCP ---

  const kbDocCount = getCompletedDocsCount(agent.id);
  const agentRecord = agent as unknown as Record<string, unknown>;
  const kbEnabled = agentRecord['kb_enabled'] !== 0;

  if (kbEnabled && kbDocCount > 0) {
    const kbServer = getAllMCPServers().find((s) => s.id === 'knowledge-base');
    const hasKb = agentMcpServers.some((spec) => 'knowledge-base' in spec);
    if (!hasKb && kbServer) {
      agentMcpServers.push({
        'knowledge-base': {
          command: kbServer.command,
          args: kbServer.args,
          env: { KB_AGENT_ID: agent.id },
        },
      });
      const kbTools = getMCPToolsFromRegistry(['knowledge-base']);
      tools.push(...kbTools);
    }
  }

  // --- System prompt construction ---

  // Load per-agent RULES.md from the filesystem (non-fatal if absent).
  const rulesPath = path.join(getLionClawHome(), 'agents', agent.id, 'RULES.md');
  let agentRules = '';
  try {
    agentRules = fs.readFileSync(rulesPath, 'utf-8');
  } catch {
    // No RULES.md for this agent — that's acceptable.
  }

  let systemPrompt = '';
  if (agentRules) {
    systemPrompt += agentRules + '\n\n';
  }
  if (agent.systemPrompt) {
    systemPrompt += agent.systemPrompt;
  }

  // --- Auto-inject Skills MCP ---

  if (agent.skills.length > 0) {
    const skillsServer = getAllMCPServers().find((s) => s.id === 'skills');
    const hasSkillsMcp = agentMcpServers.some((spec) => 'skills' in spec);
    if (!hasSkillsMcp && skillsServer) {
      agentMcpServers.push({
        'skills': {
          command: skillsServer.command,
          args: skillsServer.args,
          env: { LIONCLAW_HOME: getLionClawHome() },
        },
      });
      const skillsTools = getMCPToolsFromRegistry(['skills']);
      if (skillsTools.length === 0) {
        // Corrida da descoberta de tools MCP (fire-and-forget no boot,
        // mcp-manager.ts:31): o registry do 'skills' ainda nao foi populado
        // (ou a descoberta falhou). O agente recebe as INSTRUCOES de skills no
        // prompt, mas SEM as tools mcp__skills__* no allowedTools — logo nao
        // consegue chama-las. Skills e o unico MCP que os subagents realmente
        // usam, por isso o aviso. Re-spawnar apos a descoberta resolve.
        logger.warn(
          { agentId: agent.id, skills: agent.skills },
          'Skills MCP sem tools no registry: agente subira com instrucoes de skills mas sem as tools mcp__skills__* chamaveis (descoberta de tools MCP ainda nao concluida ou falhou)',
        );
      }
      tools.push(...skillsTools);
    }

    // Auto-inject skills usage instructions into the system prompt.
    const skillNames = agent.skills.join(', ');
    systemPrompt += `\n\n## Skills Disponiveis (via MCP)
Voce tem acesso ao MCP server de skills com as seguintes tools:
- mcp__skills__list_skills: lista todas as skills disponiveis (aceita filtro por categoria)
- mcp__skills__load_skill: carrega o conteudo completo de uma skill pelo nome
- mcp__skills__get_skill_metadata: retorna metadados de uma skill sem o conteudo completo

Skills vinculadas a voce: ${skillNames}
Quando a tarefa exigir uma dessas skills, use load_skill para carregar o conteudo e siga as instrucoes da skill.`;
  }

  // --- DECIDIDO invitation (conversational pipeline agents only) ---
  // Injected at execution time so the phrase is never persisted to the DB.
  // The includes() guard prevents duplication when the agent already has the
  // phrase baked into its seed prompt (e.g. tech agents from Sprint 3).
  if (CONVERSATIONAL_AGENTS_NEEDING_INVITE.has(agent.id) && !systemPrompt.includes('APROVAR')) {
    systemPrompt += DECIDIDO_INVITE;
  }

  // --- Role-specific tool warnings ---

  _warnIfMissingExpectedTools(agent, tools);

  return {
    model: agent.model,
    systemPrompt,
    allowedTools: tools,
    mcpServers: agentMcpServers,
    maxTurns: agent.maxTurns ?? undefined,
    effort: agent.effort,
    thinking: agent.thinking,
    thinkingBudget: agent.thinkingBudget ?? undefined,
    runtime: agent.runtime,
    // Eixos de permissao por agentType (SPEC dynamic-workflow claude-code, Sec 5):
    // defaults conservadores quando o agent nao os define.
    access: agent.access ?? 'read-only',
    allowBash: agent.allowBash ?? false,
    allowedCommands: agent.allowedCommands ?? [],
    allowNetwork: agent.allowNetwork ?? false,
  };
}

/**
 * Emit non-blocking logger warnings when a well-known agent role is missing
 * tools that are critical for it to function correctly.
 */
function _warnIfMissingExpectedTools(agent: AgentConfig, resolvedTools: string[]): void {
  const toolSet = new Set(resolvedTools);
  const agentName = agent.name.toLowerCase();

  const isPlanner = agentName.includes('planner') || agent.squad === 'harness' && agentName.includes('plan');
  const isCoder = agentName.includes('coder') || agent.squad === 'harness' && agentName.includes('cod');
  const isEvaluator = agentName.includes('evaluator') || agent.squad === 'harness' && agentName.includes('eval');

  if (isPlanner) {
    const missing = ['Read', 'Glob', 'Grep'].filter((t) => !toolSet.has(t));
    if (missing.length > 0) {
      logger.warn(
        { agentId: agent.id, agentName: agent.name, missingTools: missing },
        'Planner agent is missing expected read tools — filesystem exploration may be limited',
      );
    }
  }

  if (isCoder) {
    const missing = ['Write', 'Edit'].filter((t) => !toolSet.has(t));
    if (missing.length > 0) {
      logger.warn(
        { agentId: agent.id, agentName: agent.name, missingTools: missing },
        'Coder agent is missing expected write tools — code generation will be read-only',
      );
    }
  }

  if (isEvaluator) {
    const missing = ['Read', 'Bash'].filter((t) => !toolSet.has(t));
    if (missing.length > 0) {
      logger.warn(
        { agentId: agent.id, agentName: agent.name, missingTools: missing },
        'Evaluator agent is missing expected tools — evaluation accuracy may be reduced',
      );
    }
  }
}

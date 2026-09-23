import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { getAgent, getEnabledTools, getCompletedDocsCount } from './db';
import { getMCPToolsFromRegistry, buildMCPSpecForAgent, getAllMCPServers } from './mcp-manager';
import { getLionClawHome } from './paths';
import type { AgentConfig } from '../../src/types';

const logger = createLogger('agent-config-resolver');

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

export type McpServerEntry = Record<
  string,
  {
    type?: 'stdio';
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }
>;

export const REPO_GRAPH_MCP_SERVER_ID = 'repo-graph';

export const REPO_GRAPH_READER_TOOLS: readonly string[] = [
  'repo_graph_status',
  'repo_graph_search',
  'repo_graph_minimal_context',
  'repo_graph_impact',
  'repo_graph_node',
  'repo_graph_callers',
  'repo_graph_callees',
].map((toolName) => `mcp__${REPO_GRAPH_MCP_SERVER_ID}__${toolName}`);

export function mergeRepoGraphAllowlist(allowedTools: string[]): string[] {
  const toolSet = new Set(allowedTools);
  for (const tool of REPO_GRAPH_READER_TOOLS) {
    toolSet.add(tool);
  }
  return [...toolSet];
}

export function buildRepoGraphMcpSpec(): McpServerEntry | null {
  const specs = buildMCPSpecForAgent([REPO_GRAPH_MCP_SERVER_ID]);
  const entry = specs?.find((spec) => REPO_GRAPH_MCP_SERVER_ID in spec);
  return entry ?? null;
}

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
  access?: 'read-only' | 'workspace-write';
  allowBash?: boolean;
  allowedCommands?: string[];
  allowNetwork?: boolean;
}

export async function resolveAgentQueryConfig(agentId: string): Promise<AgentQueryConfig> {
  const agent = getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const globalEnabled = new Set(getEnabledTools());

  const builtinTools = agent.allowedTools.filter((t: string) => globalEnabled.has(t));

  const remoteMcpTools = agent.allowedTools.filter((t: string) => t.startsWith('mcp__claude_ai_'));

  const mcpToolsFromLinked = getMCPToolsFromRegistry(agent.mcpServers);

  const tools: string[] = [...builtinTools, ...remoteMcpTools, ...mcpToolsFromLinked];

  const mcpSpec = agent.mcpServers.length > 0 ? buildMCPSpecForAgent(agent.mcpServers) : undefined;

  const agentMcpServers: McpServerEntry[] = mcpSpec ? [...mcpSpec] : [];

  for (const spec of agentMcpServers) {
    if ('knowledge-base' in spec) {
      const kbEntry = spec['knowledge-base'];
      if (!kbEntry.env) kbEntry.env = {};
      kbEntry.env['KB_AGENT_ID'] = agent.id;
    }
  }

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
        logger.warn(
          { agentId: agent.id, skills: agent.skills },
          'Skills MCP sem tools no registry: agente subira com instrucoes de skills mas sem as tools mcp__skills__* chamaveis (descoberta de tools MCP ainda nao concluida ou falhou)',
        );
      }
      tools.push(...skillsTools);
    }

    const skillNames = agent.skills.join(', ');
    systemPrompt += `\n\n## Skills Disponiveis (via MCP)
Voce tem acesso ao MCP server de skills com as seguintes tools:
- mcp__skills__list_skills: lista todas as skills disponiveis (aceita filtro por categoria)
- mcp__skills__load_skill: carrega o conteudo completo de uma skill pelo nome
- mcp__skills__get_skill_metadata: retorna metadados de uma skill sem o conteudo completo

Skills vinculadas a voce: ${skillNames}
Quando a tarefa exigir uma dessas skills, use load_skill para carregar o conteudo e siga as instrucoes da skill.`;
  }

  if (CONVERSATIONAL_AGENTS_NEEDING_INVITE.has(agent.id) && !systemPrompt.includes('APROVAR')) {
    systemPrompt += DECIDIDO_INVITE;
  }

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
    access: agent.access ?? 'read-only',
    allowBash: agent.allowBash ?? false,
    allowedCommands: agent.allowedCommands ?? [],
    allowNetwork: agent.allowNetwork ?? false,
  };
}

function _warnIfMissingExpectedTools(agent: AgentConfig, resolvedTools: string[]): void {
  const toolSet = new Set(resolvedTools);
  const agentName = agent.name.toLowerCase();

  const isPlanner = agentName.includes('planner') || (agent.squad === 'harness' && agentName.includes('plan'));
  const isCoder = agentName.includes('coder') || (agent.squad === 'harness' && agentName.includes('cod'));
  const isEvaluator = agentName.includes('evaluator') || (agent.squad === 'harness' && agentName.includes('eval'));

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

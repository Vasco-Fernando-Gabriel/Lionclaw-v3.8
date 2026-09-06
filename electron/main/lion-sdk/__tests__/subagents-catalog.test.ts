
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../db', () => ({
  getAllAgents: vi.fn(),
  getAgent: vi.fn(),
  insertAuditEntry: vi.fn(),
  getSetting: vi.fn(() => undefined),
  createSession: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getSessionMessages: vi.fn(() => []),
  insertMessage: vi.fn(),
}));

vi.mock('../../skills', () => ({ listSkills: vi.fn(() => []) }));
vi.mock('../../mcp-manager', () => ({ getMCPConfigForAgent: vi.fn(async () => ({})) }));
vi.mock('../../mcp-tool-bridge', () => ({
  setupMCPsForSession: vi.fn(async () => ({ client: { connections: [] }, tools: [] })),
  teardownMCPsForSession: vi.fn(async () => undefined),
}));

import { getAllAgents } from '../../db';
import { PIPELINE_INTERNAL_SQUADS } from '../tools/agent';
import { buildLionSubagentCatalogPrompt } from '../prompt';
import type { AgentConfig } from '../../../../src/types';

const mockGetAllAgents = getAllAgents as ReturnType<typeof vi.fn>;

function makeAgent(overrides: Partial<AgentConfig> & Pick<AgentConfig, 'id' | 'squad'>): AgentConfig {
  return {
    name: `Agent-${overrides.id}`,
    description: `Desc for ${overrides.id}`,
    systemPrompt: '',
    model: 'test-model',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'ExtraToolShouldBeTruncated'],
    mcpServers: [],
    isActive: true,
    sortOrder: 0,
    effort: 'medium',
    thinking: 'disabled',
    skills: [],
    runtime: 'cloud',
    ...overrides,
  };
}

const AGENTS: AgentConfig[] = [
  makeAgent({ id: 'dev-001', squad: 'dev', description: 'Backend dev specialist' }),
  makeAgent({ id: 'tool-001', squad: 'tooling' }),
  makeAgent({ id: 'harness-001', squad: 'harness' }),
  makeAgent({ id: 'pipeline-001', squad: 'pipeline' }),
  makeAgent({ id: 'security-001', squad: 'security' }),
  makeAgent({ id: 'feature-001', squad: 'feature' }),
  makeAgent({ id: 'enrich-001', squad: 'enrich' }),
  makeAgent({ id: 'custom-001', squad: 'custom-squad' }),
  makeAgent({ id: 'nosquad-001', squad: '' }),
];

function listChatEligibleAgents(): AgentConfig[] {
  return (getAllAgents() as AgentConfig[]).filter((a) => {
    if (!a.isActive) return false;
    const squad = (a.squad ?? '').trim().toLowerCase();
    return !squad || !PIPELINE_INTERNAL_SQUADS.has(squad);
  });
}

describe('listChatEligibleAgents squad filter', () => {
  beforeEach(() => {
    mockGetAllAgents.mockReturnValue(AGENTS);
  });

  it('includes dev, tooling, custom, and no-squad agents', () => {
    const result = listChatEligibleAgents();
    const ids = result.map((a) => a.id);
    expect(ids).toContain('dev-001');
    expect(ids).toContain('tool-001');
    expect(ids).toContain('custom-001');
    expect(ids).toContain('nosquad-001');
  });

  it('excludes all pipeline-internal squads', () => {
    const result = listChatEligibleAgents();
    const ids = result.map((a) => a.id);
    expect(ids).not.toContain('harness-001');
    expect(ids).not.toContain('pipeline-001');
    expect(ids).not.toContain('security-001');
    expect(ids).not.toContain('feature-001');
    expect(ids).not.toContain('enrich-001');
  });

  it('PIPELINE_INTERNAL_SQUADS does not contain dev', () => {
    expect(PIPELINE_INTERNAL_SQUADS.has('dev')).toBe(false);
  });
});

describe('buildLionSubagentCatalogPrompt enriched format', () => {
  const THREE_AGENTS: AgentConfig[] = [
    makeAgent({
      id: 'backend-developer',
      squad: 'dev',
      name: 'Backend Developer',
      description: 'Especialista em backend',
      model: 'claude-sonnet-4-5',
      runtime: 'cloud',
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob'],
      skills: ['skill-git', 'skill-tests'],
    }),
    makeAgent({
      id: 'electron-pro',
      squad: 'dev',
      name: 'Electron Pro',
      description: 'Especialista Electron',
      model: 'claude-opus-4-7',
      runtime: 'cloud',
      allowedTools: ['Read', 'Write', 'Edit'],
      skills: [],
    }),
    makeAgent({
      id: 'local-agent',
      squad: 'custom',
      name: 'Local Agent',
      description: 'Agente local',
      model: 'qwen2.5:72b',
      runtime: 'local',
      allowedTools: ['Read', 'Bash'],
      skills: ['skill-local'],
    }),
  ];

  it('snapshot - enriched catalog with runtime, model, tools, skills', () => {
    const output = buildLionSubagentCatalogPrompt(THREE_AGENTS, 'full');
    expect(output).toMatchSnapshot();
  });

  it('includes runtime and model for each agent', () => {
    const output = buildLionSubagentCatalogPrompt(THREE_AGENTS, 'full');
    expect(output).toContain('Runtime: cloud');
    expect(output).toContain('Model: claude-sonnet-4-5');
    expect(output).toContain('Runtime: local');
    expect(output).toContain('Model: qwen2.5:72b');
  });

  it('truncates allowedTools to first 5 and omits 6th', () => {
    const agent = makeAgent({
      id: 'many-tools',
      squad: 'dev',
      allowedTools: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6_SHOULD_NOT_APPEAR'],
    });
    const output = buildLionSubagentCatalogPrompt([agent], 'full');
    expect(output).toContain('T1, T2, T3, T4, T5');
    expect(output).not.toContain('T6_SHOULD_NOT_APPEAR');
  });

  it('omits Skills line when skills array is empty', () => {
    const agent = makeAgent({ id: 'no-skills', squad: 'dev', skills: [] });
    const output = buildLionSubagentCatalogPrompt([agent], 'full');
    expect(output).not.toContain('Skills:');
  });

  it('includes Skills line when skills are present', () => {
    const agent = makeAgent({ id: 'has-skills', squad: 'dev', skills: ['skill-a', 'skill-b'] });
    const output = buildLionSubagentCatalogPrompt([agent], 'full');
    expect(output).toContain('Skills: skill-a, skill-b');
  });

  it('returns fallback when agents list is empty', () => {
    expect(buildLionSubagentCatalogPrompt([], 'full')).toBe(
      '## Available Active Subagents\n\n(no chat-eligible subagents)',
    );
  });
});

describe('buildLionSubagentCatalogPrompt index (compact) mode', () => {
  const AGENTS_IDX: AgentConfig[] = [
    makeAgent({
      id: 'backend-developer',
      squad: 'dev',
      name: 'Backend Developer',
      description: 'Especialista em backend. Faz APIs, bancos e servicos com profundidade tecnica rara.',
      model: 'claude-sonnet-4-5',
      runtime: 'cloud',
    }),
    makeAgent({
      id: 'local-agent',
      squad: 'custom',
      name: 'Local Agent',
      description: 'Agente local',
      model: 'qwen2.5:72b',
      runtime: 'local',
    }),
    makeAgent({ id: 'sem-descricao', squad: 'dev', name: 'Sem Descricao', description: '' }),
  ];

  it('index e o DEFAULT do parametro mode', () => {
    expect(buildLionSubagentCatalogPrompt(AGENTS_IDX)).toBe(
      buildLionSubagentCatalogPrompt(AGENTS_IDX, 'index'),
    );
  });

  it('1 linha por agente `- id: resumo (runtime/model)` com TODO chat-eligible presente', () => {
    const output = buildLionSubagentCatalogPrompt(AGENTS_IDX, 'index');
    expect(output).toContain('- backend-developer: Especialista em backend. (cloud/claude-sonnet-4-5)');
    expect(output).toContain('- local-agent: Agente local (local/qwen2.5:72b)');
    expect(output).toContain('- sem-descricao: Sem Descricao (cloud/test-model)');
  });

  it('anuncia agent_details via mcp_call no lionclaw-agents (nome nominal do lion runtime)', () => {
    const output = buildLionSubagentCatalogPrompt(AGENTS_IDX, 'index');
    expect(output).toContain('mcp_call({ server_id: "lionclaw-agents", tool: "agent_details", args: { agent_id } })');
  });

  it('NAO emite o formato legado multi-linha (Runtime:/Tools:)', () => {
    const output = buildLionSubagentCatalogPrompt(AGENTS_IDX, 'index');
    expect(output).not.toContain('Runtime: cloud | ');
    expect(output).not.toContain('Tools:');
    expect(output).not.toContain('**Backend Developer**');
  });

  it('fallback vazio identico ao legado', () => {
    expect(buildLionSubagentCatalogPrompt([], 'index')).toBe(
      '## Available Active Subagents\n\n(no chat-eligible subagents)',
    );
  });
});

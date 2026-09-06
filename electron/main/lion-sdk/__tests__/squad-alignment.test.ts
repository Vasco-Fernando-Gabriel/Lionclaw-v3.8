
import { describe, it, expect } from 'vitest';
import { PIPELINE_INTERNAL_SQUADS } from '../tools/agent';


import { vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../db', () => ({ getAllAgents: vi.fn(), insertAuditEntry: vi.fn(), getSetting: vi.fn(() => undefined) }));
vi.mock('../../mcp-manager', () => ({ getAllMCPServers: vi.fn(() => []) }));
vi.mock('../../secrets-vault', () => ({ getSecret: vi.fn(() => null) }));
vi.mock('../../skills', () => ({
  listSkills: vi.fn(() => []),
  getSkill: vi.fn(() => null),
  buildSkillsPromptSection: vi.fn(() => ''),
  buildAgentSkillsPromptSection: vi.fn(() => ''),
}));
vi.mock('../../ask-question', () => ({ sendAskQuestion: vi.fn() }));

import { getAllAgents } from '../../db';
import { handleListAgents } from '../../local-ipc/jsonrpc-methods';
import type { AgentConfig } from '../../../../src/types';

const mockGetAllAgents = getAllAgents as ReturnType<typeof vi.fn>;

const TEST_SQUADS = ['harness', 'pipeline', 'security', 'feature', 'enrich', 'dev', 'tooling', 'custom'];

function agentForSquad(squad: string): AgentConfig {
  return {
    id: `agent-${squad}`,
    name: `Agent ${squad}`,
    description: '',
    systemPrompt: '',
    model: 'test-model',
    allowedTools: [],
    mcpServers: [],
    isActive: true,
    sortOrder: 0,
    effort: 'medium',
    thinking: 'disabled',
    skills: [],
    runtime: 'cloud',
    squad,
  };
}

describe('squad alignment: PIPELINE_INTERNAL_SQUADS == HIDDEN_SQUADS', () => {
  it('Lion-SDK and Codex hide the same squads', () => {
    const allAgents = TEST_SQUADS.map(agentForSquad);
    mockGetAllAgents.mockReturnValue(allAgents);

    const codexVisible = new Set(handleListAgents().map((a) => a.id));
    const lionVisible = new Set(
      allAgents
        .filter((a) => {
          const squad = (a.squad ?? '').trim().toLowerCase();
          return !squad || !PIPELINE_INTERNAL_SQUADS.has(squad);
        })
        .map((a) => a.id),
    );

    expect(lionVisible).toEqual(codexVisible);
  });

  it('PIPELINE_INTERNAL_SQUADS does not contain dev', () => {
    expect(PIPELINE_INTERNAL_SQUADS.has('dev')).toBe(false);
  });

  it('PIPELINE_INTERNAL_SQUADS contains exactly harness, pipeline, security, feature, enrich', () => {
    const expected = new Set(['harness', 'pipeline', 'security', 'feature', 'enrich']);
    expect(PIPELINE_INTERNAL_SQUADS).toEqual(expected);
  });
});

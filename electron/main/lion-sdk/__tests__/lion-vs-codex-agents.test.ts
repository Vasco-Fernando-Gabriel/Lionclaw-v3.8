
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { PIPELINE_INTERNAL_SQUADS } from '../tools/agent';
import type { AgentConfig } from '../../../../src/types';

const mockGetAllAgents = getAllAgents as ReturnType<typeof vi.fn>;

function makeAgent(id: string, squad: string, isActive = true): AgentConfig {
  return {
    id,
    name: `Agent-${id}`,
    description: '',
    systemPrompt: '',
    model: 'model',
    allowedTools: ['Read'],
    mcpServers: [],
    isActive,
    sortOrder: 0,
    effort: 'medium',
    thinking: 'disabled',
    skills: [],
    runtime: 'cloud',
    squad,
  };
}

const REALISTIC_AGENTS: AgentConfig[] = [
  makeAgent('backend-developer', 'dev'),
  makeAgent('frontend-developer', 'dev'),
  makeAgent('electron-pro', 'dev'),
  makeAgent('nextjs-developer', 'dev'),
  makeAgent('javascript-pro', 'dev'),
  makeAgent('skill-creator', 'dev'),
  makeAgent('custom-research', 'custom'),
  makeAgent('harness-coder', 'harness'),
  makeAgent('harness-planner', 'harness'),
  makeAgent('harness-evaluator', 'harness'),
  makeAgent('pipeline-spec-builder', 'pipeline'),
  makeAgent('security-owasp', 'security'),
  makeAgent('feature-discovery', 'feature'),
  makeAgent('enrich-spec', 'enrich'),
  makeAgent('inactive-agent', 'dev', false),
];

function listChatEligibleAgents(agents: AgentConfig[]): AgentConfig[] {
  return agents.filter((a) => {
    if (!a.isActive) return false;
    const squad = (a.squad ?? '').trim().toLowerCase();
    return !squad || !PIPELINE_INTERNAL_SQUADS.has(squad);
  });
}

describe('Lion-SDK vs Codex agent list parity (AC-004-6)', () => {
  beforeEach(() => {
    mockGetAllAgents.mockReturnValue(REALISTIC_AGENTS);
  });

  it('set of ids is identical between Lion-SDK and Codex list_agents', () => {
    const lionIds = new Set(listChatEligibleAgents(REALISTIC_AGENTS).map((a) => a.id));
    const codexIds = new Set(handleListAgents().map((a) => a.id));
    expect(lionIds).toEqual(codexIds);
  });

  it('both exclude pipeline-internal squads', () => {
    const lionIds = new Set(listChatEligibleAgents(REALISTIC_AGENTS).map((a) => a.id));
    const codexIds = new Set(handleListAgents().map((a) => a.id));

    const internalIds = REALISTIC_AGENTS
      .filter((a) => {
        const squad = (a.squad ?? '').toLowerCase();
        return PIPELINE_INTERNAL_SQUADS.has(squad);
      })
      .map((a) => a.id);

    for (const id of internalIds) {
      expect(lionIds.has(id)).toBe(false);
      expect(codexIds.has(id)).toBe(false);
    }
  });

  it('both exclude inactive agents', () => {
    const lionIds = new Set(listChatEligibleAgents(REALISTIC_AGENTS).map((a) => a.id));
    const codexIds = new Set(handleListAgents().map((a) => a.id));
    expect(lionIds.has('inactive-agent')).toBe(false);
    expect(codexIds.has('inactive-agent')).toBe(false);
  });

  it('both include dev squad agents (backend-developer, etc.)', () => {
    const lionIds = new Set(listChatEligibleAgents(REALISTIC_AGENTS).map((a) => a.id));
    const codexIds = new Set(handleListAgents().map((a) => a.id));
    const devAgents = ['backend-developer', 'frontend-developer', 'electron-pro', 'nextjs-developer', 'javascript-pro'];
    for (const id of devAgents) {
      expect(lionIds.has(id)).toBe(true);
      expect(codexIds.has(id)).toBe(true);
    }
  });
});

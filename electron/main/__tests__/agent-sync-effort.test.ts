import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  rootLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

const getSettingMock = vi.fn((_key: string): string | undefined => undefined);

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(),
  getSetting: (key: string) => getSettingMock(key),
  listHarnessProjects: vi.fn(() => []),
  updateAgent: vi.fn(),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(),
}));

vi.mock('../seed-agents', () => ({
  getSeedAgentById: vi.fn(),
}));

vi.mock('../pipeline-shared/lock', () => ({
  isProjectLocked: vi.fn(() => false),
}));

import { mapOrchestratorToAgentPatch } from '../agent-sync';
import type { OrchestratorSelection } from '../orchestrator-selection';

function settings(map: Record<string, string>): void {
  getSettingMock.mockImplementation((key: string) => map[key]);
}

const codexSel = (model: string, effort?: string): OrchestratorSelection =>
  ({ runtime: 'codex-sdk', provider: 'codex', model, ...(effort ? { effort } : {}) }) as OrchestratorSelection;

const claudeSel = (effort?: string): OrchestratorSelection =>
  ({
    runtime: 'claude-sdk',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    ...(effort ? { effort } : {}),
  }) as OrchestratorSelection;

beforeEach(() => {
  getSettingMock.mockReset();
  getSettingMock.mockImplementation(() => undefined);
});

describe('sync leva o effort da SELECAO (7.7), nunca o setting global (codex)', () => {
  it('xhigh da selecao chega no codexConfig quando o modelo suporta', () => {
    settings({ orchestrator_codex_effort: 'low' });
    const patch = mapOrchestratorToAgentPatch(codexSel('gpt-5.5', 'xhigh'));
    expect(patch.codexConfig?.reasoningEffort).toBe('xhigh');
  });

  it('xhigh e CLAMPADO pra high quando o modelo nao suporta (evita 400)', () => {
    const patch = mapOrchestratorToAgentPatch(codexSel('gpt-5.2', 'xhigh'));
    expect(patch.codexConfig?.reasoningEffort).toBe('high');
  });

  it('low/medium passam verbatim', () => {
    expect(mapOrchestratorToAgentPatch(codexSel('gpt-5.5', 'low')).codexConfig?.reasoningEffort).toBe('low');
    expect(mapOrchestratorToAgentPatch(codexSel('gpt-5.5', 'medium')).codexConfig?.reasoningEffort).toBe('medium');
  });

  it('effort ausente/invalido na selecao -> default high, mesmo com setting global setado', () => {
    settings({ orchestrator_codex_effort: 'xhigh' });
    expect(mapOrchestratorToAgentPatch(codexSel('gpt-5.5')).codexConfig?.reasoningEffort).toBe('high');
    expect(mapOrchestratorToAgentPatch(codexSel('gpt-5.5', 'banana')).codexConfig?.reasoningEffort).toBe('high');
  });
});

describe('sync leva o effort da SELECAO (7.7), nunca o setting global (claude)', () => {
  it('max da selecao chega no effort do agent', () => {
    settings({ orchestrator_effort: 'low' });
    expect(mapOrchestratorToAgentPatch(claudeSel('max')).effort).toBe('max');
  });

  it('effort ausente/invalido -> default high', () => {
    settings({ orchestrator_effort: 'max' });
    expect(mapOrchestratorToAgentPatch(claudeSel()).effort).toBe('high');
    expect(mapOrchestratorToAgentPatch(claudeSel('xhigh')).effort).toBe('high');
  });

  it('branch codex NAO seta o effort claude do agent (vive no codexConfig)', () => {
    const patch = mapOrchestratorToAgentPatch(codexSel('gpt-5.5', 'xhigh'));
    expect(patch.effort).toBeUndefined();
  });
});

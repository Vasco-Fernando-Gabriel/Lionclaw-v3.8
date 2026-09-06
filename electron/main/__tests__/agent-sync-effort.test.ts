
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

const codexSel = (model: string): OrchestratorSelection =>
  ({ runtime: 'codex-sdk', provider: 'codex', model }) as OrchestratorSelection;

const claudeSel: OrchestratorSelection = {
  runtime: 'claude-sdk',
  provider: 'anthropic',
  model: 'claude-opus-4-8',
} as OrchestratorSelection;

beforeEach(() => {
  getSettingMock.mockReset();
  getSettingMock.mockImplementation(() => undefined);
});

describe('sync leva o effort do orquestrador (codex)', () => {
  it('xhigh do orquestrador chega no codexConfig quando o modelo suporta', () => {
    settings({ orchestrator_codex_effort: 'xhigh' });
    const patch = mapOrchestratorToAgentPatch(codexSel('gpt-5.5'));
    expect(patch.codexConfig?.reasoningEffort).toBe('xhigh');
  });

  it('xhigh e CLAMPADO pra high quando o modelo nao suporta (evita 400)', () => {
    settings({ orchestrator_codex_effort: 'xhigh' });
    const patch = mapOrchestratorToAgentPatch(codexSel('gpt-5.2'));
    expect(patch.codexConfig?.reasoningEffort).toBe('high');
  });

  it('low/medium passam verbatim', () => {
    settings({ orchestrator_codex_effort: 'low' });
    expect(
      mapOrchestratorToAgentPatch(codexSel('gpt-5.5')).codexConfig
        ?.reasoningEffort,
    ).toBe('low');
    settings({ orchestrator_codex_effort: 'medium' });
    expect(
      mapOrchestratorToAgentPatch(codexSel('gpt-5.5')).codexConfig
        ?.reasoningEffort,
    ).toBe('medium');
  });

  it('setting ausente/invalida -> default high (NAO mais o medium hardcoded)', () => {
    const patch = mapOrchestratorToAgentPatch(codexSel('gpt-5.5'));
    expect(patch.codexConfig?.reasoningEffort).toBe('high');
    settings({ orchestrator_codex_effort: 'banana' });
    expect(
      mapOrchestratorToAgentPatch(codexSel('gpt-5.5')).codexConfig
        ?.reasoningEffort,
    ).toBe('high');
  });
});

describe('sync leva o effort do orquestrador (claude)', () => {
  it('max do orquestrador chega no effort do agent', () => {
    settings({ orchestrator_effort: 'max' });
    const patch = mapOrchestratorToAgentPatch(claudeSel);
    expect(patch.effort).toBe('max');
  });

  it('setting ausente/invalida -> default high', () => {
    expect(mapOrchestratorToAgentPatch(claudeSel).effort).toBe('high');
    settings({ orchestrator_effort: 'xhigh' }); // escala do codex, invalida no claude
    expect(mapOrchestratorToAgentPatch(claudeSel).effort).toBe('high');
  });

  it('branch codex NAO seta o effort claude do agent (vive no codexConfig)', () => {
    settings({ orchestrator_codex_effort: 'xhigh' });
    const patch = mapOrchestratorToAgentPatch(codexSel('gpt-5.5'));
    expect(patch.effort).toBeUndefined();
  });
});

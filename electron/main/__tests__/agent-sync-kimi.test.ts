import { describe, it, expect, vi } from 'vitest';

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

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(),
  getSetting: vi.fn(() => undefined),
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

describe('SPEC-011 S2: agent-sync lynchpin (kimi-sdk -> kimi)', () => {
  it('T-A1: maps orchestrator kimi-sdk|kimi to agent runtime kimi without throwing', () => {
    const sel: OrchestratorSelection = {
      runtime: 'kimi-sdk',
      provider: 'kimi',
      model: 'kimi-code/kimi-for-coding',
      source: 'settings',
    };
    const patch = mapOrchestratorToAgentPatch(sel);
    expect(patch).toEqual({
      runtime: 'kimi',
      model: 'kimi-code/kimi-for-coding',
      effort: 'max',
      localConfig: null,
      externalConfig: null,
      codexConfig: null,
    });
  });
});


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

import {
  mapOrchestratorToAgentPatch,
  InvalidOrchestratorMappingError,
} from '../agent-sync';
import type { OrchestratorSelection } from '../orchestrator-selection';

describe('agent-sync lynchpin (cursor-sdk -> cursor)', () => {
  it('maps orchestrator cursor-sdk|cursor to agent runtime cursor without throwing', () => {
    const sel: OrchestratorSelection = {
      runtime: 'cursor-sdk',
      provider: 'cursor',
      model: 'composer-2.5',
      source: 'settings',
    };
    const patch = mapOrchestratorToAgentPatch(sel);
    expect(patch).toEqual({
      runtime: 'cursor',
      model: 'composer-2.5',
      localConfig: null,
      externalConfig: null,
      codexConfig: null,
    });
    expect(patch.effort).toBeUndefined();
  });

  it('still throws for a cursor-sdk combo with provider errado', () => {
    const sel: OrchestratorSelection = {
      runtime: 'cursor-sdk',
      provider: 'kimi',
      model: 'composer-2.5',
      source: 'settings',
    };
    expect(() => mapOrchestratorToAgentPatch(sel)).toThrow(
      InvalidOrchestratorMappingError,
    );
  });
});

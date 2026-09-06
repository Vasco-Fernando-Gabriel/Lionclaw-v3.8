import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));
vi.mock('../db', () => ({ getSetting: vi.fn() }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn() }));

import { getSetting } from '../db';
import {
  __internal,
  InvalidOrchestratorSelectionError,
  resolveOrchestratorSelection,
  resolveSubscriptionSelectionFor,
} from '../orchestrator-selection';

const getSettingMock = vi.mocked(getSetting);

beforeEach(() => vi.clearAllMocks());

describe('Grok Build orchestrator selection', () => {
  it('keeps Grok explicit-only and excludes its curated model from Lion residual', () => {
    expect(__internal.inferRuntimeFromModel('grok-4.5')).toBe('lion-sdk');
    expect(__internal.isModelInRuntime('grok-4.5', 'grok-sdk')).toBe(true);
    expect(__internal.isModelInRuntime('grok-4.5', 'lion-sdk')).toBe(false);
    expect(__internal.defaultProviderForRuntime('grok-sdk')).toBe('grok');
    expect(__internal.defaultModelForRuntime('grok-sdk')).toBe('grok-4.6');
  });

  it('resolves the exact subscription triple and snapshots effort', async () => {
    getSettingMock.mockImplementation((key: string) => ({
      orchestrator_runtime: 'grok-sdk',
      orchestrator_provider: 'grok',
      orchestrator_model: 'grok-4.5',
      orchestrator_grok_effort: 'low',
    } as Record<string, string>)[key]);
    await expect(resolveOrchestratorSelection({ surface: 'main-chat' })).resolves.toEqual({
      runtime: 'grok-sdk',
      provider: 'grok',
      model: 'grok-4.5',
      effort: 'low',
      source: 'settings',
    });
  });

  it('rejects a provider or model outside the curated Grok triple', async () => {
    getSettingMock.mockImplementation((key: string) => ({
      orchestrator_runtime: 'grok-sdk',
      orchestrator_provider: 'grok',
      orchestrator_model: 'grok-future',
    } as Record<string, string>)[key]);
    await expect(resolveOrchestratorSelection({ surface: 'main-chat' }))
      .rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });

  it('rejects an agent-model override outside the curated Grok catalog', async () => {
    getSettingMock.mockImplementation((key: string) => ({
      orchestrator_runtime: 'grok-sdk',
      orchestrator_provider: 'grok',
      orchestrator_model: 'grok-4.5',
    } as Record<string, string>)[key]);
    await expect(resolveOrchestratorSelection({ surface: 'main-chat', agentModel: 'grok-future' }))
      .rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });

  it('supports an explicit Grok compaction selection without API key', async () => {
    getSettingMock.mockImplementation((key: string) => key === 'orchestrator_grok_effort' ? 'medium' : undefined);
    await expect(resolveSubscriptionSelectionFor('grok-sdk', 'grok', 'grok-4.5')).resolves.toEqual({
      runtime: 'grok-sdk',
      provider: 'grok',
      model: 'grok-4.5',
      effort: 'medium',
      source: 'request',
    });
  });

  it('rejects a mismatched provider in explicit Grok compaction', async () => {
    await expect(resolveSubscriptionSelectionFor('grok-sdk', 'kimi', 'grok-4.5'))
      .rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });
});

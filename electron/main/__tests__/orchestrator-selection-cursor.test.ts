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

describe('Cursor orchestrator selection (F2 item 1)', () => {
  it('keeps Cursor explicit-only and excludes its exclusive models from Lion residual', () => {
    expect(__internal.inferRuntimeFromModel('composer-2.5')).toBe('lion-sdk');
    expect(__internal.isModelInRuntime('composer-2.5', 'cursor-sdk')).toBe(true);
    expect(__internal.isModelInRuntime('composer-2.5', 'lion-sdk')).toBe(false);
    expect(__internal.isModelInRuntime('gemini-3.7-flash', 'lion-sdk')).toBe(false);
    expect(__internal.defaultProviderForRuntime('cursor-sdk')).toBe('cursor');
    expect(__internal.defaultModelForRuntime('cursor-sdk')).toBe('composer-2.5');
  });

  it('resolves the exact (cursor-sdk, cursor, catalog-model) triple without effort', async () => {
    getSettingMock.mockImplementation(
      (key: string) =>
        (
          ({
            orchestrator_runtime: 'cursor-sdk',
            orchestrator_provider: 'cursor',
            orchestrator_model: 'composer-2.5',
          }) as Record<string, string>
        )[key],
    );
    await expect(resolveOrchestratorSelection({ surface: 'default' })).resolves.toEqual({
      runtime: 'cursor-sdk',
      provider: 'cursor',
      model: 'composer-2.5',
      source: 'settings',
    });
  });

  it('accepts a requestedModel from the curated Cursor catalog', async () => {
    getSettingMock.mockImplementation(
      (key: string) =>
        (
          ({
            orchestrator_runtime: 'cursor-sdk',
            orchestrator_provider: 'cursor',
            orchestrator_model: 'composer-2.5',
          }) as Record<string, string>
        )[key],
    );
    await expect(
      resolveOrchestratorSelection({ surface: 'default', requestedModel: 'claude-sonnet-5' }),
    ).resolves.toMatchObject({ runtime: 'cursor-sdk', model: 'claude-sonnet-5', source: 'request' });
  });

  it('rejects a model outside the curated Cursor catalog', async () => {
    getSettingMock.mockImplementation(
      (key: string) =>
        (
          ({
            orchestrator_runtime: 'cursor-sdk',
            orchestrator_provider: 'cursor',
            orchestrator_model: 'cursor-future-model',
          }) as Record<string, string>
        )[key],
    );
    await expect(resolveOrchestratorSelection({ surface: 'default' })).rejects.toBeInstanceOf(
      InvalidOrchestratorSelectionError,
    );
  });

  it('rejects an agent-model override outside the curated Cursor catalog', async () => {
    getSettingMock.mockImplementation(
      (key: string) =>
        (
          ({
            orchestrator_runtime: 'cursor-sdk',
            orchestrator_provider: 'cursor',
            orchestrator_model: 'composer-2.5',
          }) as Record<string, string>
        )[key],
    );
    await expect(
      resolveOrchestratorSelection({ surface: 'default', agentModel: 'gpt-nao-existe' }),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });

  it('rejects a mismatched provider for the cursor-sdk runtime', async () => {
    getSettingMock.mockImplementation(
      (key: string) =>
        (
          ({
            orchestrator_runtime: 'cursor-sdk',
            orchestrator_provider: 'grok',
            orchestrator_model: 'composer-2.5',
          }) as Record<string, string>
        )[key],
    );
    await expect(resolveOrchestratorSelection({ surface: 'default' })).rejects.toBeInstanceOf(
      InvalidOrchestratorSelectionError,
    );
  });

  it('resolves cursor-sdk as a compaction subscription runtime (one-shot via sidecar)', async () => {
    const selection = await resolveSubscriptionSelectionFor('cursor-sdk', 'cursor', 'composer-2.5');
    expect(selection).toMatchObject({
      runtime: 'cursor-sdk',
      provider: 'cursor',
      model: 'composer-2.5',
    });
  });

  it('still rejects a cross-provider compaction triple for cursor-sdk', async () => {
    await expect(resolveSubscriptionSelectionFor('cursor-sdk', 'kimi', 'composer-2.5')).rejects.toBeInstanceOf(
      InvalidOrchestratorSelectionError,
    );
  });
});

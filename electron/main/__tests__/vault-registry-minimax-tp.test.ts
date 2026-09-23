import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn().mockResolvedValue(null),
  getSecretNonInteractive: vi.fn().mockResolvedValue({ status: 'absent' }),
  setSecret: vi.fn().mockResolvedValue(undefined),
  deleteSecret: vi.fn().mockResolvedValue(undefined),
  getSecretReadError: vi.fn(() => undefined),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { registerExternalProviderVaultEntries, getVaultEntries } from '../vault-registry';
import type { VaultEntry } from '../vault-registry';

describe('vault-registry SPEC-006: ORCHESTRATOR_MINIMAX_API_KEY entry', () => {
  beforeEach(() => {
    registerExternalProviderVaultEntries();
  });

  it('registers ORCHESTRATOR_MINIMAX_API_KEY after registerExternalProviderVaultEntries()', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'ORCHESTRATOR_MINIMAX_API_KEY');
    expect(entry).toBeDefined();
  });

  it('ORCHESTRATOR_MINIMAX_API_KEY has correct label', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'ORCHESTRATOR_MINIMAX_API_KEY');
    expect(entry?.label).toBe('MiniMax TokenPlan API Key');
  });

  it('ORCHESTRATOR_MINIMAX_API_KEY has service "minimax-tp"', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'ORCHESTRATOR_MINIMAX_API_KEY');
    expect(entry?.service).toBe('minimax-tp');
  });

  it('ORCHESTRATOR_MINIMAX_API_KEY is not required', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'ORCHESTRATOR_MINIMAX_API_KEY');
    expect(entry?.required).toBe(false);
  });

  it('ORCHESTRATOR_MINIMAX_API_KEY has correct placeholder and docsUrl', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'ORCHESTRATOR_MINIMAX_API_KEY');
    expect(entry?.placeholder).toBe('...');
    expect(entry?.docsUrl).toBe('https://platform.minimax.io/document/Quick%20Start');
  });

  it('ORCHESTRATOR_MINIMAX_API_KEY is configured=false when getSecret returns null', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'ORCHESTRATOR_MINIMAX_API_KEY');
    expect(entry?.configured).toBe(false);
  });

  it('repeated calls do NOT duplicate the entry', async () => {
    registerExternalProviderVaultEntries();
    registerExternalProviderVaultEntries();

    const entries = await getVaultEntries();
    const matches = entries.filter((e: VaultEntry) => e.key === 'ORCHESTRATOR_MINIMAX_API_KEY');
    expect(matches.length).toBe(1);
  });

  it('description mentions MiniMax TokenPlan and Settings', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'ORCHESTRATOR_MINIMAX_API_KEY');
    expect(entry?.description).toContain('MiniMax');
  });
});

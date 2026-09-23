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

describe('vault-registry SPEC-005: new entries from registerExternalProviderVaultEntries', () => {
  beforeEach(() => {
    registerExternalProviderVaultEntries();
  });

  it('registers HARNESS_KIMI_KEY', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'HARNESS_KIMI_KEY');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('Kimi (Moonshot) API Key');
    expect(entry?.service).toBe('kimi');
    expect(entry?.required).toBe(false);
  });

  it('registers HARNESS_DEEPSEEK_KEY', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'HARNESS_DEEPSEEK_KEY');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('DeepSeek API Key');
    expect(entry?.service).toBe('deepseek');
    expect(entry?.required).toBe(false);
  });

  it('registers HARNESS_QWEN_KEY', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'HARNESS_QWEN_KEY');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('Qwen (DashScope) API Key');
    expect(entry?.service).toBe('qwen');
    expect(entry?.required).toBe(false);
  });

  it('registers HARNESS_MINIMAX_PAYG_KEY', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'HARNESS_MINIMAX_PAYG_KEY');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('MiniMax (Pay-as-you-go) API Key');
    expect(entry?.service).toBe('minimax-payg');
    expect(entry?.required).toBe(false);
  });

  it('HARNESS_KIMI_KEY has correct placeholder and docsUrl', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'HARNESS_KIMI_KEY');
    expect(entry?.placeholder).toBe('sk-...');
    expect(entry?.docsUrl).toBe('https://platform.moonshot.ai/console/api-keys');
  });

  it('HARNESS_DEEPSEEK_KEY has correct placeholder and docsUrl', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'HARNESS_DEEPSEEK_KEY');
    expect(entry?.placeholder).toBe('sk-...');
    expect(entry?.docsUrl).toBe('https://platform.deepseek.com/api_keys');
  });

  it('HARNESS_QWEN_KEY has correct placeholder and docsUrl', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'HARNESS_QWEN_KEY');
    expect(entry?.placeholder).toBe('sk-...');
    expect(entry?.docsUrl).toBe('https://help.aliyun.com/zh/model-studio/get-api-key');
  });

  it('HARNESS_MINIMAX_PAYG_KEY has correct placeholder and docsUrl', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'HARNESS_MINIMAX_PAYG_KEY');
    expect(entry?.placeholder).toBe('...');
    expect(entry?.docsUrl).toBe('https://platform.minimax.io/document/Quick%20Start');
  });

  it('does NOT register HARNESS_GOOGLE_AI_STUDIO_KEY', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'HARNESS_GOOGLE_AI_STUDIO_KEY');
    expect(entry).toBeUndefined();
  });

  it('repeated calls do not duplicate any of the 4 new entries', async () => {
    registerExternalProviderVaultEntries();
    registerExternalProviderVaultEntries();

    const entries = await getVaultEntries();
    const keys = ['HARNESS_KIMI_KEY', 'HARNESS_DEEPSEEK_KEY', 'HARNESS_QWEN_KEY', 'HARNESS_MINIMAX_PAYG_KEY'];
    for (const key of keys) {
      const matches = entries.filter((e: VaultEntry) => e.key === key);
      expect(matches.length).toBe(1);
    }
  });

  it('all 4 new entries are marked configured=false (getSecret returns null)', async () => {
    const entries = await getVaultEntries();
    const newKeys = ['HARNESS_KIMI_KEY', 'HARNESS_DEEPSEEK_KEY', 'HARNESS_QWEN_KEY', 'HARNESS_MINIMAX_PAYG_KEY'];
    for (const key of newKeys) {
      const entry = entries.find((e: VaultEntry) => e.key === key);
      expect(entry?.configured).toBe(false);
    }
  });
});

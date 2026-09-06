
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


import {
  registerVaultEntry,
  registerExternalProviderVaultEntries,
  getVaultEntries,
  setVaultSecret,
  checkVaultSecret,
} from '../vault-registry';

import type { VaultEntry } from '../vault-registry';


describe('vault-registry: registerExternalProviderVaultEntries', () => {
  beforeEach(() => {
    registerExternalProviderVaultEntries();
  });

  it('registra a entry HARNESS_OPENROUTER_KEY', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'HARNESS_OPENROUTER_KEY');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('OpenRouter API Key');
    expect(entry?.service).toBe('openrouter');
    expect(entry?.required).toBe(false);
  });

  it('registra a entry HARNESS_OPENAI_KEY', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'HARNESS_OPENAI_KEY');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('OpenAI API Key (Harness)');
    expect(entry?.service).toBe('openai-harness');
    expect(entry?.required).toBe(false);
  });

  it('HARNESS_OPENROUTER_KEY tem placeholder correto', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'HARNESS_OPENROUTER_KEY');
    expect(entry?.placeholder).toBe('sk-or-v1-...');
  });

  it('HARNESS_OPENAI_KEY tem placeholder correto', async () => {
    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'HARNESS_OPENAI_KEY');
    expect(entry?.placeholder).toBe('sk-...');
  });

  it('chamadas multiplas a registerExternalProviderVaultEntries nao duplicam entries', async () => {
    registerExternalProviderVaultEntries();
    registerExternalProviderVaultEntries();

    const entries = await getVaultEntries();
    const openrouterEntries = entries.filter((e: VaultEntry) => e.key === 'HARNESS_OPENROUTER_KEY');
    const openaiEntries = entries.filter((e: VaultEntry) => e.key === 'HARNESS_OPENAI_KEY');

    expect(openrouterEntries.length).toBe(1);
    expect(openaiEntries.length).toBe(1);
  });

  it('entries de providers externos estao marcadas como nao-configuradas (getSecret retorna null)', async () => {
    const entries = await getVaultEntries();
    const or = entries.find((e: VaultEntry) => e.key === 'HARNESS_OPENROUTER_KEY');
    const oa = entries.find((e: VaultEntry) => e.key === 'HARNESS_OPENAI_KEY');

    expect(or?.configured).toBe(false);
    expect(oa?.configured).toBe(false);
  });
});

describe('vault-registry: registerVaultEntry', () => {
  it('registra entry custom corretamente', async () => {
    registerVaultEntry({
      key: 'CUSTOM_PROVIDER_KEY_TEST',
      label: 'Custom Provider Test',
      description: 'Chave para provider custom de teste.',
      service: 'custom-provider',
      required: false,
      placeholder: 'my-key-...',
    });

    const entries = await getVaultEntries();
    const entry = entries.find((e: VaultEntry) => e.key === 'CUSTOM_PROVIDER_KEY_TEST');
    expect(entry).toBeDefined();
    expect(entry?.service).toBe('custom-provider');
  });

  it('idempotente: registrar mesma key duas vezes nao duplica', async () => {
    registerVaultEntry({
      key: 'IDEMPOTENT_KEY_TEST',
      label: 'Idempotent Test',
      description: 'Test',
      service: 'test',
      required: false,
    });

    registerVaultEntry({
      key: 'IDEMPOTENT_KEY_TEST',
      label: 'Idempotent Test Duplicated',
      description: 'Should not be added',
      service: 'test',
      required: false,
    });

    const entries = await getVaultEntries();
    const matches = entries.filter((e: VaultEntry) => e.key === 'IDEMPOTENT_KEY_TEST');
    expect(matches.length).toBe(1);
    expect(matches[0].label).toBe('Idempotent Test');
  });
});

describe('vault-registry: setVaultSecret', () => {
  it('lanca erro para chave nao registrada', async () => {
    await expect(setVaultSecret('UNKNOWN_KEY_XYZ_NOT_IN_REGISTRY', 'my-secret')).rejects.toThrow(
      'Chave desconhecida',
    );
  });

  it('aceita chave valida registrada sem lancar erro', async () => {
    await expect(setVaultSecret('ANTHROPIC_API_KEY', 'sk-ant-test')).resolves.not.toThrow();
  });
});

describe('vault-registry: checkVaultSecret', () => {
  it('retorna false quando getSecret retorna null', async () => {
    const { getSecret } = await import('../secrets-vault');
    vi.mocked(getSecret).mockResolvedValueOnce(null);

    const configured = await checkVaultSecret('ANTHROPIC_API_KEY');
    expect(configured).toBe(false);
  });

  it('retorna true quando getSecret retorna valor nao-vazio', async () => {
    const { getSecret } = await import('../secrets-vault');
    vi.mocked(getSecret).mockResolvedValueOnce('sk-ant-test-value');

    const configured = await checkVaultSecret('ANTHROPIC_API_KEY');
    expect(configured).toBe(true);
  });

  it('retorna false quando getSecret retorna string vazia', async () => {
    const { getSecret } = await import('../secrets-vault');
    vi.mocked(getSecret).mockResolvedValueOnce('');

    const configured = await checkVaultSecret('ANTHROPIC_API_KEY');
    expect(configured).toBe(false);
  });
});

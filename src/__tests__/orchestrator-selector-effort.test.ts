import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDefaultEffortOptions } from '@/components/settings/OrchestratorSelector';
import type { ProviderStatusEntry } from '@/types';

const status: ProviderStatusEntry = {
  runtime: 'codex-sdk',
  provider: 'codex',
  connected: true,
  available: true,
  models: [
    {
      id: 'gpt-6-astra',
      displayName: 'GPT-6-Astra',
      label: 'GPT-6-Astra',
      reasoningOptions: ['max', 'low', 'high', 'xhigh'],
      defaultReasoning: 'high',
    },
    {
      id: 'gpt-5.2',
      displayName: 'GPT-5.2',
      label: 'GPT-5.2',
      reasoningOptions: ['low', 'medium', 'high'],
      defaultReasoning: 'high',
    },
  ],
};

describe('7.1: OrchestratorSelector decide o effort pelos reasoningOptions do snapshot', () => {
  it('a copia RUNTIME_SUPPORTS_EFFORT saiu do renderer', () => {
    const source = readFileSync(resolve(__dirname, '../components/settings/OrchestratorSelector.tsx'), 'utf8');
    expect(source).not.toContain('RUNTIME_SUPPORTS_EFFORT');
    expect(source).not.toContain('useCodexModelCapabilities');
  });

  it('opcoes ordenadas do modelo, valor salvo quando suportado, senao o default do modelo', () => {
    const saved = resolveDefaultEffortOptions(status, 'codex-sdk', 'gpt-6-astra', { orchestratorCodexEffort: 'xhigh' });
    expect(saved.options).toEqual(['low', 'high', 'xhigh', 'max']);
    expect(saved.field).toBe('orchestratorCodexEffort');
    expect(saved.value).toBe('xhigh');
    expect(saved.defaultReasoning).toBe('high');

    const clamped = resolveDefaultEffortOptions(status, 'codex-sdk', 'gpt-5.2', { orchestratorCodexEffort: 'xhigh' });
    expect(clamped.options).toEqual(['low', 'medium', 'high']);
    expect(clamped.value).toBe('high');
  });

  it('modelo sem reasoningOptions ou runtime sem chave de effort = sem tiers', () => {
    const lion: ProviderStatusEntry = {
      runtime: 'lion-sdk',
      provider: 'ollama',
      connected: true,
      available: true,
      models: [{ id: 'llama3', displayName: 'llama3', label: 'llama3', reasoningOptions: [], defaultReasoning: null }],
    };
    const none = resolveDefaultEffortOptions(lion, 'lion-sdk', 'llama3', {});
    expect(none.options).toEqual([]);
    expect(none.field).toBeNull();
    expect(none.value).toBe('');
    expect(
      resolveDefaultEffortOptions(undefined, 'claude-sdk', 'claude-opus-5', { orchestratorEffort: 'max' }).options,
    ).toEqual([]);
  });
});

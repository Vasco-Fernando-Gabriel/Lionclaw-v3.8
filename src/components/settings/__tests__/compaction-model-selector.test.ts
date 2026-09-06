
import { describe, it, expect } from 'vitest';
import type {
  AppSettings,
  ProviderStatusEntry,
  ProviderModelEntry,
  OrchestratorRuntime,
  OrchestratorProvider,
} from '@/types/index';
import {
  buildCompactionGroups,
  reconcileCompactionSelection,
  buildClearPatch,
  compactionProviderMissingCredential,
} from '../CompactionModelSelector';


function makeModels(...ids: string[]): ProviderModelEntry[] {
  return ids.map((id) => ({ id, displayName: id }));
}

function makeStatus(overrides: {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  connected: boolean;
  models?: ProviderModelEntry[];
}): ProviderStatusEntry {
  return {
    runtime: overrides.runtime,
    provider: overrides.provider,
    connected: overrides.connected,
    models: overrides.models,
  };
}

function makeSettings(overrides: Partial<AppSettings>): AppSettings {
  return {
    defaultModel: 'claude-sonnet-4-6',
    orchestratorRuntime: 'claude-sdk',
    orchestratorProvider: 'anthropic',
    orchestratorModel: 'claude-sonnet-4-6',
    orchestratorSetupCompleted: true,
    ...overrides,
  } as AppSettings;
}


describe('buildCompactionGroups - Grupo 1 (provedores de assinatura)', () => {
  it('lista todos os provedores de assinatura conectados, independente do orquestrador ativo', () => {
    const settings = makeSettings({
      orchestratorRuntime: 'codex-sdk',
      orchestratorProvider: 'codex',
      orchestratorModel: 'gpt-5-codex',
    });
    const statuses = [
      makeStatus({
        runtime: 'claude-sdk',
        provider: 'anthropic',
        connected: true,
        models: makeModels('claude-sonnet-4-6'),
      }),
      makeStatus({
        runtime: 'claude-compat-sdk',
        provider: 'zai',
        connected: true,
        models: makeModels('glm-4.7', 'glm-4.6'),
      }),
      makeStatus({
        runtime: 'claude-compat-sdk',
        provider: 'minimax',
        connected: true,
        models: makeModels('MiniMax-M2.7'),
      }),
      makeStatus({
        runtime: 'kimi-sdk',
        provider: 'kimi',
        connected: true,
        models: makeModels('kimi-for-coding'),
      }),
    ];

    const { subscriptionGroups } = buildCompactionGroups(statuses, settings);

    const byProvider = (p: OrchestratorProvider) =>
      subscriptionGroups.find((g) => g.provider === p);

    expect(subscriptionGroups.map((g) => g.provider).sort()).toEqual([
      'anthropic',
      'kimi',
      'minimax',
      'zai',
    ]);
    expect(byProvider('anthropic')?.runtime).toBe('claude-sdk');
    expect(byProvider('zai')?.runtime).toBe('claude-compat-sdk');
    expect(byProvider('zai')?.models.map((m) => m.id)).toEqual(['glm-4.7', 'glm-4.6']);
    expect(byProvider('minimax')?.runtime).toBe('claude-compat-sdk');
    expect(byProvider('kimi')?.runtime).toBe('kimi-sdk');
    expect(byProvider('anthropic')?.label).toBe('Anthropic');
    expect(byProvider('zai')?.label).toBe('Z.ai');
    expect(byProvider('minimax')?.label).toBe('Minimax TokenPlan');
    expect(byProvider('kimi')?.label).toBe('Kimi');
  });

  it('orquestrador claude-compat-sdk/zai conectado aparece em subscriptionGroups com seus modelos', () => {
    const settings = makeSettings({
      orchestratorRuntime: 'claude-compat-sdk',
      orchestratorProvider: 'zai',
      orchestratorModel: 'glm-4.6',
    });
    const statuses = [
      makeStatus({
        runtime: 'claude-compat-sdk',
        provider: 'zai',
        connected: true,
        models: makeModels('glm-4.6', 'glm-4.5'),
      }),
    ];

    const { subscriptionGroups, orchestratorDisconnected } = buildCompactionGroups(
      statuses,
      settings,
    );

    const zai = subscriptionGroups.find((g) => g.provider === 'zai');
    expect(zai).toBeDefined();
    expect(zai?.runtime).toBe('claude-compat-sdk');
    expect(zai?.models.map((m) => m.id)).toEqual(['glm-4.6', 'glm-4.5']);
    expect(orchestratorDisconnected).toBe(false);
  });

  it('provedor de assinatura desconectado NAO aparece em subscriptionGroups', () => {
    const settings = makeSettings({
      orchestratorRuntime: 'codex-sdk',
      orchestratorProvider: 'codex',
    });
    const statuses = [
      makeStatus({ runtime: 'codex-sdk', provider: 'codex', connected: false }),
      makeStatus({ runtime: 'claude-compat-sdk', provider: 'zai', connected: false }),
    ];

    const { subscriptionGroups, orchestratorDisconnected } = buildCompactionGroups(
      statuses,
      settings,
    );

    expect(subscriptionGroups.find((g) => g.provider === 'codex')).toBeUndefined();
    expect(subscriptionGroups.find((g) => g.provider === 'zai')).toBeUndefined();
    expect(orchestratorDisconnected).toBe(true);
  });

  it('codex-official presente nos statuses NAO gera chip extra (tabela estatica filtra)', () => {
    const settings = makeSettings({
      orchestratorRuntime: 'codex-sdk',
      orchestratorProvider: 'codex',
    });
    const statuses = [
      makeStatus({
        runtime: 'codex-sdk',
        provider: 'codex',
        connected: true,
        models: makeModels('gpt-5-codex'),
      }),
      makeStatus({
        runtime: 'codex-sdk',
        provider: 'codex-official',
        connected: true,
        models: makeModels('gpt-5-codex'),
      }),
    ];

    const { subscriptionGroups } = buildCompactionGroups(statuses, settings);

    expect(subscriptionGroups.filter((g) => g.provider === 'codex')).toHaveLength(1);
    expect(
      subscriptionGroups.find((g) => g.provider === 'codex-official'),
    ).toBeUndefined();
  });
});


describe('buildCompactionGroups - Grupo 2 (locais / Lion)', () => {
  it('ollama conectado aparece em lionGroups mesmo com orquestrador anthropic', () => {
    const settings = makeSettings({
      orchestratorRuntime: 'claude-sdk',
      orchestratorProvider: 'anthropic',
    });
    const statuses = [
      makeStatus({
        runtime: 'claude-sdk',
        provider: 'anthropic',
        connected: true,
        models: makeModels('claude-sonnet-4-6'),
      }),
      makeStatus({
        runtime: 'lion-sdk',
        provider: 'ollama',
        connected: true,
        models: makeModels('qwen2.5:14b'),
      }),
    ];

    const { lionGroups } = buildCompactionGroups(statuses, settings);

    const ollama = lionGroups.find((g) => g.provider === 'ollama');
    expect(ollama).toBeDefined();
    expect(ollama?.models.map((m) => m.id)).toEqual(['qwen2.5:14b']);
  });

  it('provider lion desconectado NAO aparece em lionGroups', () => {
    const settings = makeSettings({});
    const statuses = [
      makeStatus({ runtime: 'lion-sdk', provider: 'lmstudio', connected: false }),
    ];

    const { lionGroups } = buildCompactionGroups(statuses, settings);

    expect(lionGroups.find((g) => g.provider === 'lmstudio')).toBeUndefined();
  });

  it('orchestratorProvider vazio (fresh install) ainda oferece lion conectado', () => {
    const settings = makeSettings({
      orchestratorProvider: '' as unknown as OrchestratorProvider,
      orchestratorRuntime: '' as unknown as OrchestratorRuntime,
    });
    const statuses = [
      makeStatus({
        runtime: 'lion-sdk',
        provider: 'ollama',
        connected: true,
        models: makeModels('llama3'),
      }),
    ];

    const { subscriptionGroups, lionGroups } = buildCompactionGroups(statuses, settings);

    expect(subscriptionGroups).toHaveLength(0);
    expect(lionGroups.find((g) => g.provider === 'ollama')).toBeDefined();
  });
});


describe('buildClearPatch - Auto (chat) limpa os tres campos', () => {
  it('seta os tres campos de compactacao para vazio', () => {
    const patch = buildClearPatch();
    expect(patch.orchestratorCompactionRuntime).toBe('');
    expect(patch.orchestratorCompactionProvider).toBe('');
    expect(patch.orchestratorCompactionModel).toBe('');
  });
});


describe('reconcileCompactionSelection - pick de assinatura nao-ativo', () => {
  it('escolha de assinatura != orquestrador atual PERMANECE selecionada (regra stale removida)', () => {
    const settings = makeSettings({
      orchestratorRuntime: 'codex-sdk',
      orchestratorProvider: 'codex',
      orchestratorCompactionRuntime: 'claude-compat-sdk',
      orchestratorCompactionProvider: 'zai',
      orchestratorCompactionModel: 'glm-4.6',
    });
    const statuses = [
      makeStatus({ runtime: 'codex-sdk', provider: 'codex', connected: true }),
      makeStatus({
        runtime: 'claude-compat-sdk',
        provider: 'zai',
        connected: true,
        models: makeModels('glm-4.6'),
      }),
    ];

    const { selectedProvider, offline } = reconcileCompactionSelection(settings, statuses);

    expect(selectedProvider).toBe('zai');
    expect(offline).toBe(false);
  });

  it('escolha de assinatura == orquestrador atual permanece selecionada', () => {
    const settings = makeSettings({
      orchestratorRuntime: 'claude-compat-sdk',
      orchestratorProvider: 'zai',
      orchestratorCompactionRuntime: 'claude-compat-sdk',
      orchestratorCompactionProvider: 'zai',
      orchestratorCompactionModel: 'glm-4.6',
    });
    const statuses = [
      makeStatus({ runtime: 'claude-compat-sdk', provider: 'zai', connected: true }),
    ];

    const { selectedProvider, offline } = reconcileCompactionSelection(settings, statuses);

    expect(selectedProvider).toBe('zai');
    expect(offline).toBe(false);
  });

  it('escolha de assinatura nao-ativo desconectada permanece selecionada com offline=true', () => {
    const settings = makeSettings({
      orchestratorRuntime: 'codex-sdk',
      orchestratorProvider: 'codex',
      orchestratorCompactionRuntime: 'claude-compat-sdk',
      orchestratorCompactionProvider: 'zai',
      orchestratorCompactionModel: 'glm-4.6',
    });
    const statuses = [
      makeStatus({ runtime: 'codex-sdk', provider: 'codex', connected: true }),
      makeStatus({ runtime: 'claude-compat-sdk', provider: 'zai', connected: false }),
    ];

    const { selectedProvider, offline } = reconcileCompactionSelection(settings, statuses);

    expect(selectedProvider).toBe('zai');
    expect(offline).toBe(true);
  });
});


describe('reconcileCompactionSelection - lion permanece selecionado', () => {
  it('escolha lion desconectada permanece selecionada com offline=true (NAO vira Auto)', () => {
    const settings = makeSettings({
      orchestratorRuntime: 'claude-sdk',
      orchestratorProvider: 'anthropic',
      orchestratorCompactionRuntime: 'lion-sdk',
      orchestratorCompactionProvider: 'ollama',
      orchestratorCompactionModel: 'qwen2.5:14b',
    });
    const statuses = [
      makeStatus({ runtime: 'lion-sdk', provider: 'ollama', connected: false }),
    ];

    const { selectedProvider, offline } = reconcileCompactionSelection(settings, statuses);

    expect(selectedProvider).toBe('ollama');
    expect(offline).toBe(true);
  });

  it('escolha lion conectada permanece selecionada com offline=false', () => {
    const settings = makeSettings({
      orchestratorCompactionRuntime: 'lion-sdk',
      orchestratorCompactionProvider: 'ollama',
      orchestratorCompactionModel: 'qwen2.5:14b',
    });
    const statuses = [
      makeStatus({
        runtime: 'lion-sdk',
        provider: 'ollama',
        connected: true,
        models: makeModels('qwen2.5:14b'),
      }),
    ];

    const { selectedProvider, offline } = reconcileCompactionSelection(settings, statuses);

    expect(selectedProvider).toBe('ollama');
    expect(offline).toBe(false);
  });

  it('escolha lion permanece mesmo apos o orquestrador mudar de provider', () => {
    const settings = makeSettings({
      orchestratorRuntime: 'codex-sdk',
      orchestratorProvider: 'codex',
      orchestratorCompactionRuntime: 'lion-sdk',
      orchestratorCompactionProvider: 'ollama',
      orchestratorCompactionModel: 'qwen2.5:14b',
    });
    const statuses = [
      makeStatus({ runtime: 'codex-sdk', provider: 'codex', connected: true }),
      makeStatus({
        runtime: 'lion-sdk',
        provider: 'ollama',
        connected: true,
        models: makeModels('qwen2.5:14b'),
      }),
    ];

    const { selectedProvider, offline } = reconcileCompactionSelection(settings, statuses);

    expect(selectedProvider).toBe('ollama');
    expect(offline).toBe(false);
  });
});


describe('buildCompactionGroups - orquestrador lion-sdk', () => {
  it('orquestrador lion-sdk/ollama: ollama aparece so no Grupo 2, sem chip de assinatura', () => {
    const settings = makeSettings({
      orchestratorRuntime: 'lion-sdk',
      orchestratorProvider: 'ollama',
      orchestratorModel: 'qwen2.5:14b',
    });
    const statuses = [
      makeStatus({
        runtime: 'lion-sdk',
        provider: 'ollama',
        connected: true,
        models: makeModels('qwen2.5:14b'),
      }),
    ];

    const { subscriptionGroups, lionGroups } = buildCompactionGroups(statuses, settings);

    expect(subscriptionGroups).toHaveLength(0);
    const ollamaEntries = lionGroups.filter((g) => g.provider === 'ollama');
    expect(ollamaEntries).toHaveLength(1);
  });

  it('estado completo: assinatura + lion conectados produz ambos os grupos', () => {
    const settings = makeSettings({
      orchestratorRuntime: 'claude-sdk',
      orchestratorProvider: 'anthropic',
    });
    const statuses = [
      makeStatus({
        runtime: 'claude-sdk',
        provider: 'anthropic',
        connected: true,
        models: makeModels('claude-sonnet-4-6'),
      }),
      makeStatus({
        runtime: 'lion-sdk',
        provider: 'ollama',
        connected: true,
        models: makeModels('qwen2.5:14b'),
      }),
      makeStatus({
        runtime: 'lion-sdk',
        provider: 'lmstudio',
        connected: true,
        models: makeModels('local-model'),
      }),
    ];

    const { subscriptionGroups, lionGroups, orchestratorDisconnected } =
      buildCompactionGroups(statuses, settings);

    expect(subscriptionGroups.find((g) => g.provider === 'anthropic')).toBeDefined();
    expect(orchestratorDisconnected).toBe(false);
    expect(lionGroups.map((g) => g.provider).sort()).toEqual(['lmstudio', 'ollama']);
  });
});


describe('compactionProviderMissingCredential - aviso pre-flight (SPEC 4.1)', () => {
  it('Auto (nada salvo) -> false (nao ha provider explicito para avisar)', () => {
    const settings = makeSettings({
      orchestratorCompactionRuntime: '' as unknown as OrchestratorRuntime,
      orchestratorCompactionProvider: '' as unknown as OrchestratorProvider,
      orchestratorCompactionModel: '',
    });
    expect(compactionProviderMissingCredential(settings, [])).toBe(false);
  });

  it('pick de assinatura conectado -> false (tem credencial)', () => {
    const settings = makeSettings({
      orchestratorCompactionRuntime: 'claude-compat-sdk',
      orchestratorCompactionProvider: 'zai',
      orchestratorCompactionModel: 'glm-4.7',
    });
    const statuses = [makeStatus({ runtime: 'claude-compat-sdk', provider: 'zai', connected: true })];
    expect(compactionProviderMissingCredential(settings, statuses)).toBe(false);
  });

  it('pick de assinatura SEM credencial conectada -> true (aviso)', () => {
    const settings = makeSettings({
      orchestratorCompactionRuntime: 'claude-compat-sdk',
      orchestratorCompactionProvider: 'zai',
      orchestratorCompactionModel: 'glm-4.7',
    });
    const statuses = [makeStatus({ runtime: 'claude-compat-sdk', provider: 'zai', connected: false })];
    expect(compactionProviderMissingCredential(settings, statuses)).toBe(true);
  });

  it('pick sem NENHUM status reportado -> true (provider nao conectado)', () => {
    const settings = makeSettings({
      orchestratorCompactionRuntime: 'kimi-sdk',
      orchestratorCompactionProvider: 'kimi',
      orchestratorCompactionModel: 'kimi-code/kimi-for-coding',
    });
    expect(compactionProviderMissingCredential(settings, [])).toBe(true);
  });
});

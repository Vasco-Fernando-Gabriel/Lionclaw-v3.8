
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store, getSetting, setSetting, setOrchestratorCompactionSelection } = vi.hoisted(() => {
  const s = new Map<string, string>();
  return {
    store: s,
    getSetting: vi.fn((key: string): string | undefined => s.get(key)),
    setSetting: vi.fn((key: string, value: string): void => {
      s.set(key, value);
    }),
    setOrchestratorCompactionSelection: vi.fn((selection: {
      runtime: string;
      provider: string;
      model: string;
    } | null): void => {
      const keys = [
        'orchestrator_compaction_runtime',
        'orchestrator_compaction_provider',
        'orchestrator_compaction_model',
      ] as const;
      if (!selection) {
        keys.forEach((key) => s.delete(key));
        return;
      }
      s.set(keys[0], selection.runtime);
      s.set(keys[1], selection.provider);
      s.set(keys[2], selection.model);
    }),
  };
});

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../db', () => ({
  getSetting,
  setSetting,
  setOrchestratorCompactionSelection,
  getAuthRow: vi.fn(() => null),
  getDreamingTurnInterval: vi.fn(() => 20),
}));
vi.mock('../voice-engine', () => ({ DEFAULT_ELEVENLABS_VOICE_ID: 'default-voice' }));
vi.mock('../cartesia-engine', () => ({
  DEFAULT_CARTESIA_MODEL: 'sonic',
  DEFAULT_CARTESIA_SPEED: 1.0,
  DEFAULT_CARTESIA_VOICE_ID: 'cartesia-voice',
  DEFAULT_CARTESIA_LANGUAGE: 'pt',
}));

const compactActiveChatSession = vi.hoisted(() => vi.fn());
vi.mock('../ipc/_shared/chat-compaction', () => ({ compactActiveChatSession }));

const checkProvider = vi.hoisted(() => vi.fn());
vi.mock('../provider-availability', () => ({ checkProvider }));

vi.mock('../agent-sync', () => ({ syncAgentsToOrchestrator: vi.fn() }));
vi.mock('../seed-agents', () => ({ listSeedAgentIds: vi.fn(() => []) }));
vi.mock('../../../src/constants/transcription-models', () => ({
  DEFAULT_VOICE_TRANSCRIPTION_MODEL: 'whisper-1',
  isVoiceTranscriptionModel: vi.fn(() => true),
}));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

import { registerSettingsHandlers } from '../ipc/settings';
import type { AppSettings, SettingsUpdateResult } from '../../../src/types';

function register(): void {
  registerSettingsHandlers({
    getMainWindow: () => null,
    getHarnessEngine: () => null,
  } as never);
}

async function callUpdate(patch: Partial<AppSettings>): Promise<SettingsUpdateResult> {
  return (await handlers.get('settings:update')!(undefined, patch)) as SettingsUpdateResult;
}

describe('SB-4 settings:update — troca de orquestrador best-effort (P5, AC-B10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    handlers.clear();
    store.set('orchestrator_runtime', 'claude-sdk');
    store.set('orchestrator_provider', 'anthropic');
    store.set('orchestrator_model', 'claude-sonnet-4');
    checkProvider.mockResolvedValue({ usable: true });
    register();
  });

  it('AC-B10: compaction_failed NAO lanca — a troca CONCLUI e grava os orchestrator_*', async () => {
    compactActiveChatSession.mockResolvedValue({
      success: false,
      reason: 'compaction_failed',
      error: 'quota estourada',
      newSessionId: 'sess-nova',
    });

    const result = await callUpdate({
      orchestratorRuntime: 'codex-sdk',
      orchestratorProvider: 'codex',
      orchestratorModel: 'gpt-5.5',
    });

    expect(result.success).toBe(true);
    expect(result.compaction).toEqual({
      success: false,
      reason: 'compaction_failed',
      error: 'quota estourada',
      newSessionId: 'sess-nova',
    });
    expect(store.get('orchestrator_runtime')).toBe('codex-sdk');
    expect(store.get('orchestrator_provider')).toBe('codex');
    expect(store.get('orchestrator_model')).toBe('gpt-5.5');
    expect(compactActiveChatSession).toHaveBeenCalledWith(
      expect.any(Function),
      'orchestrator-switch',
    );
  });

  it('AC-B10: compactacao com sucesso segue identica (regressao zero)', async () => {
    compactActiveChatSession.mockResolvedValue({
      success: true,
      newSessionId: 'sess-ok',
    });

    const result = await callUpdate({
      orchestratorRuntime: 'codex-sdk',
      orchestratorProvider: 'codex',
      orchestratorModel: 'gpt-5.5',
    });

    expect(result.success).toBe(true);
    expect(result.compaction).toEqual({ success: true, newSessionId: 'sess-ok' });
    expect(store.get('orchestrator_runtime')).toBe('codex-sdk');
  });

  it('AC-B10: update sem mudanca de runtime/provider nao dispara compactacao (fronteira intacta)', async () => {
    const result = await callUpdate({
      orchestratorRuntime: 'claude-sdk',
      orchestratorProvider: 'anthropic',
      orchestratorModel: 'claude-opus-4-8',
    });

    expect(result.success).toBe(true);
    expect(compactActiveChatSession).not.toHaveBeenCalled();
    expect(store.get('orchestrator_model')).toBe('claude-opus-4-8');
  });

  it('rejeita runtime/provider/model cruzados antes de persistir ou compactar', async () => {
    const result = await callUpdate({
      orchestratorRuntime: 'codex-sdk',
      orchestratorProvider: 'grok',
      orchestratorModel: 'grok-4.5',
    });

    expect(result.error).toMatch(/grok.*nao pertence.*codex-sdk/i);
    expect(store.get('orchestrator_runtime')).toBe('claude-sdk');
    expect(store.get('orchestrator_provider')).toBe('anthropic');
    expect(store.get('orchestrator_model')).toBe('claude-sonnet-4');
    expect(compactActiveChatSession).not.toHaveBeenCalled();
  });

  it('rejeita modelo de outro preset dentro do runtime claude-compat', async () => {
    const result = await callUpdate({
      orchestratorRuntime: 'claude-compat-sdk',
      orchestratorProvider: 'minimax',
      orchestratorModel: 'glm-5.2',
    });

    expect(result.error).toMatch(/glm-5\.2.*minimax.*claude-compat-sdk/i);
    expect(store.get('orchestrator_runtime')).toBe('claude-sdk');
    expect(compactActiveChatSession).not.toHaveBeenCalled();
  });

  it('rejeita Grok quando o status operacional informa usable=false sem alterar o triple', async () => {
    checkProvider.mockResolvedValue({
      usable: false,
      reason: 'Grok nao autenticado',
    });

    const result = await callUpdate({
      orchestratorRuntime: 'grok-sdk',
      orchestratorProvider: 'grok',
      orchestratorModel: 'grok-4.5',
    });

    expect(result.error).toMatch(/nao autenticado/i);
    expect(checkProvider).toHaveBeenCalledWith('grok-sdk', 'grok');
    expect(store.get('orchestrator_runtime')).toBe('claude-sdk');
    expect(store.get('orchestrator_provider')).toBe('anthropic');
    expect(store.get('orchestrator_model')).toBe('claude-sonnet-4');
    expect(compactActiveChatSession).not.toHaveBeenCalled();
  });

  it('rejeita Kimi quando o status canonico nao confirma usable=true', async () => {
    checkProvider.mockResolvedValue({
      connected: true,
      reason: 'modelo gerenciado nao verificado',
    });

    const result = await callUpdate({
      orchestratorRuntime: 'kimi-sdk',
      orchestratorProvider: 'kimi',
      orchestratorModel: 'kimi-code/kimi-for-coding',
    });

    expect(result.error).toMatch(/modelo gerenciado nao verificado/i);
    expect(checkProvider).toHaveBeenCalledWith('kimi-sdk', 'kimi');
    expect(store.get('orchestrator_runtime')).toBe('claude-sdk');
    expect(compactActiveChatSession).not.toHaveBeenCalled();
  });

  it('permite Kimi somente quando o status canonico confirma usable=true', async () => {
    checkProvider.mockResolvedValue({ usable: true });
    compactActiveChatSession.mockResolvedValue({ success: true, newSessionId: 'sess-kimi' });

    const result = await callUpdate({
      orchestratorRuntime: 'kimi-sdk',
      orchestratorProvider: 'kimi',
      orchestratorModel: 'kimi-code/kimi-for-coding',
    });

    expect(result.success).toBe(true);
    expect(store.get('orchestrator_runtime')).toBe('kimi-sdk');
    expect(store.get('orchestrator_provider')).toBe('kimi');
    expect(store.get('orchestrator_model')).toBe('kimi-code/kimi-for-coding');
  });

  it('preserva Auto somente quando os tres campos de compactacao sao limpos juntos', async () => {
    store.set('orchestrator_compaction_runtime', 'claude-sdk');
    store.set('orchestrator_compaction_provider', 'anthropic');
    store.set('orchestrator_compaction_model', 'claude-sonnet-4-6');

    const result = await callUpdate({
      orchestratorCompactionRuntime: '' as AppSettings['orchestratorCompactionRuntime'],
      orchestratorCompactionProvider: '' as AppSettings['orchestratorCompactionProvider'],
      orchestratorCompactionModel: '',
    });

    expect(result.success).toBe(true);
    expect(store.has('orchestrator_compaction_runtime')).toBe(false);
    expect(store.has('orchestrator_compaction_provider')).toBe(false);
    expect(store.has('orchestrator_compaction_model')).toBe(false);
    expect(setOrchestratorCompactionSelection).toHaveBeenCalledWith(null);
  });

  it('rejeita compactacao parcial antes de persistir qualquer campo', async () => {
    store.set('grok_max_concurrency', '3');

    const result = await callUpdate({
      orchestratorCompactionRuntime: 'grok-sdk',
      grokMaxConcurrency: 7,
    });

    expect(result.error).toMatch(/compactacao incompleta/i);
    expect(store.has('orchestrator_compaction_runtime')).toBe(false);
    expect(store.get('grok_max_concurrency')).toBe('3');
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('rejeita compactacao cross-family e mantem o DB inalterado', async () => {
    const result = await callUpdate({
      orchestratorCompactionRuntime: 'codex-sdk',
      orchestratorCompactionProvider: 'grok',
      orchestratorCompactionModel: 'grok-4.5',
    });

    expect(result.error).toMatch(/compactacao incompativel/i);
    expect(store.has('orchestrator_compaction_runtime')).toBe(false);
    expect(store.has('orchestrator_compaction_provider')).toBe(false);
    expect(store.has('orchestrator_compaction_model')).toBe(false);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it.each([
    ['grok-sdk', 'grok', 'grok-4.5'],
    ['kimi-sdk', 'kimi', 'kimi-code/kimi-for-coding'],
  ] as const)(
    'rejeita compactacao %s quando availability.usable nao e true',
    async (runtime, provider, model) => {
      checkProvider.mockResolvedValue({ usable: false, reason: 'gate pendente' });

      const result = await callUpdate({
        orchestratorCompactionRuntime: runtime,
        orchestratorCompactionProvider: provider,
        orchestratorCompactionModel: model,
      });

      expect(result.error).toMatch(/gate pendente/i);
      expect(checkProvider).toHaveBeenCalledWith(runtime, provider);
      expect(store.has('orchestrator_compaction_runtime')).toBe(false);
      expect(store.has('orchestrator_compaction_provider')).toBe(false);
      expect(store.has('orchestrator_compaction_model')).toBe(false);
      expect(setSetting).not.toHaveBeenCalled();
    },
  );

  it('persiste triple de compactacao completo e valido somente apos validacao', async () => {
    checkProvider.mockResolvedValue({ usable: true });

    const result = await callUpdate({
      orchestratorCompactionRuntime: 'grok-sdk',
      orchestratorCompactionProvider: 'grok',
      orchestratorCompactionModel: 'grok-4.5',
    });

    expect(result.success).toBe(true);
    expect(checkProvider).toHaveBeenCalledWith('grok-sdk', 'grok');
    expect(store.get('orchestrator_compaction_runtime')).toBe('grok-sdk');
    expect(store.get('orchestrator_compaction_provider')).toBe('grok');
    expect(store.get('orchestrator_compaction_model')).toBe('grok-4.5');
    expect(setOrchestratorCompactionSelection).toHaveBeenCalledWith({
      runtime: 'grok-sdk',
      provider: 'grok',
      model: 'grok-4.5',
    });
  });
});

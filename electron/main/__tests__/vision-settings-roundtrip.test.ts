import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store, getSetting, setSetting } = vi.hoisted(() => {
  const s = new Map<string, string>();
  return {
    store: s,
    getSetting: vi.fn((key: string): string | undefined => s.get(key)),
    setSetting: vi.fn((key: string, value: string): void => {
      s.set(key, value);
    }),
  };
});

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../db', () => ({
  getSetting,
  setSetting,
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
vi.mock('./_shared/chat-compaction', () => ({
  compactActiveChatSession: vi.fn().mockResolvedValue({ reason: 'noop' }),
}));
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
import type { AppSettings } from '../../../src/types';
import { VISION_DEFAULT } from '../../../src/constants/vision-models';

function register(): void {
  registerSettingsHandlers({
    getMainWindow: () => null,
    getHarnessEngine: () => null,
  } as never);
}
async function callGet(): Promise<AppSettings> {
  return (await handlers.get('settings:get')!()) as AppSettings;
}
async function callUpdate(patch: Partial<AppSettings>): Promise<void> {
  await handlers.get('settings:update')!({} as never, patch);
}

beforeEach(() => {
  store.clear();
  handlers.clear();
  vi.clearAllMocks();
  register();
});

describe('vision settings round-trip', () => {
  it('settings:get retorna defaults do catalogo quando o store esta vazio', async () => {
    const s = await callGet();
    expect(s.visionProvider).toBe(VISION_DEFAULT.provider);
    expect(s.visionModel).toBe(VISION_DEFAULT.id);
  });

  it('settings:get reflete valores salvos coerentes', async () => {
    store.set('vision_provider', 'anthropic');
    store.set('vision_model', 'claude-sonnet-5');
    const s = await callGet();
    expect(s.visionProvider).toBe('anthropic');
    expect(s.visionModel).toBe('claude-sonnet-5');
  });

  it('settings:get realinha modelo incoerente com o provider salvo', async () => {
    store.set('vision_provider', 'anthropic');
    store.set('vision_model', 'gpt-5.5');
    const s = await callGet();
    expect(s.visionProvider).toBe('anthropic');
    expect(s.visionModel).toBe('claude-opus-4-8');
  });

  it('settings:update persiste provider + modelo coerente', async () => {
    await callUpdate({ visionProvider: 'anthropic', visionModel: 'claude-sonnet-5' });
    expect(setSetting).toHaveBeenCalledWith('vision_provider', 'anthropic');
    expect(setSetting).toHaveBeenCalledWith('vision_model', 'claude-sonnet-5');
  });

  it('settings:update com modelo incoerente cai no primeiro do provider', async () => {
    await callUpdate({ visionProvider: 'anthropic', visionModel: 'gpt-5.5' });
    expect(setSetting).toHaveBeenCalledWith('vision_provider', 'anthropic');
    expect(setSetting).toHaveBeenCalledWith('vision_model', 'claude-opus-4-8');
  });

  it('settings:update so do provider realinha o modelo salvo incompativel', async () => {
    store.set('vision_provider', 'openai');
    store.set('vision_model', 'gpt-5.5');
    await callUpdate({ visionProvider: 'anthropic' });
    expect(setSetting).toHaveBeenCalledWith('vision_provider', 'anthropic');
    expect(setSetting).toHaveBeenCalledWith('vision_model', 'claude-opus-4-8');
  });

  it('round-trip completo: update -> get devolve o que foi salvo', async () => {
    await callUpdate({ visionProvider: 'anthropic', visionModel: 'claude-sonnet-5' });
    const s = await callGet();
    expect(s.visionProvider).toBe('anthropic');
    expect(s.visionModel).toBe('claude-sonnet-5');
  });
});

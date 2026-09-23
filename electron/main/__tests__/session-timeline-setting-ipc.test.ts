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
vi.mock('../agent-sync', () => ({ syncAgentsToOrchestrator: vi.fn() }));
vi.mock('../seed-agents', () => ({ listSeedAgentIds: vi.fn(() => []) }));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

import { registerSettingsHandlers } from '../ipc/settings';
import { CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY } from '../chat-compaction-defaults';
import type { AppSettings } from '../../../src/types';

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
  registerSettingsHandlers({
    getMainWindow: () => null,
    getHarnessEngine: () => null,
  } as never);
});

describe('IPC do setting chat_timeline_reinject_enabled', () => {
  it('settings:get devolve false quando a chave nunca foi gravada', async () => {
    const s = await callGet();
    expect(s.chatTimelineReinjectEnabled).toBe(false);
  });

  it('settings:update grava true na chave e settings:get rele true', async () => {
    await callUpdate({ chatTimelineReinjectEnabled: true });
    expect(store.get(CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY)).toBe('true');
    expect((await callGet()).chatTimelineReinjectEnabled).toBe(true);
  });

  it('settings:update grava false na chave e settings:get rele false', async () => {
    await callUpdate({ chatTimelineReinjectEnabled: true });
    await callUpdate({ chatTimelineReinjectEnabled: false });
    expect(store.get(CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY)).toBe('false');
    expect((await callGet()).chatTimelineReinjectEnabled).toBe(false);
  });

  it('patch sem o campo preserva o true anterior', async () => {
    await callUpdate({ chatTimelineReinjectEnabled: true });
    await callUpdate({ chatCompactionTargetTokens: 60_000 });
    expect(store.get(CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY)).toBe('true');
    expect((await callGet()).chatTimelineReinjectEnabled).toBe(true);
  });

  it('patch sem o campo preserva o false anterior', async () => {
    await callUpdate({ chatTimelineReinjectEnabled: false });
    await callUpdate({ chatCompactionTargetTokens: 60_000 });
    expect(store.get(CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY)).toBe('false');
    expect((await callGet()).chatTimelineReinjectEnabled).toBe(false);
  });

  it('o setting de reinjecao nao mexe no de compactacao automatica', async () => {
    await callUpdate({ chatTimelineReinjectEnabled: true });
    const s = await callGet();
    expect(s.chatTimelineReinjectEnabled).toBe(true);
    expect(s.chatAutoCompactionEnabled).toBe(true);
    expect(store.has('chat_auto_compaction_enabled')).toBe(false);
  });
});

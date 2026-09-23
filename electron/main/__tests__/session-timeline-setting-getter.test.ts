import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  settings: new Map<string, string>(),
}));

vi.mock('../db', () => ({
  getSession: vi.fn(),
  getSessionOrchestrator: vi.fn(() => null),
  getSetting: (key: string) => h.settings.get(key),
}));
vi.mock('../chat-compaction-inplace', () => ({ compactChatSessionInPlace: vi.fn() }));
vi.mock('../clearing-sessions', () => ({ isSessionClearing: () => false }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
}));

import { isChatTimelineReinjectEnabled } from '../chat-compaction-trigger';
import { CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY } from '../chat-compaction-defaults';

beforeEach(() => {
  h.settings.clear();
});

describe('isChatTimelineReinjectEnabled', () => {
  it('a chave do setting e chat_timeline_reinject_enabled', () => {
    expect(CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY).toBe('chat_timeline_reinject_enabled');
  });

  it('default DESLIGADO: chave ausente devolve false', () => {
    expect(isChatTimelineReinjectEnabled()).toBe(false);
  });

  it("'false' devolve false", () => {
    h.settings.set(CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY, 'false');
    expect(isChatTimelineReinjectEnabled()).toBe(false);
  });

  it("'true' devolve true", () => {
    h.settings.set(CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY, 'true');
    expect(isChatTimelineReinjectEnabled()).toBe(true);
  });

  it('valor desconhecido nao liga a reinjecao', () => {
    h.settings.set(CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY, '1');
    expect(isChatTimelineReinjectEnabled()).toBe(false);
  });
});

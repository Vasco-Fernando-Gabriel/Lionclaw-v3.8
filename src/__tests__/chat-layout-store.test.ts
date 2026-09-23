import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  useChatLayoutStore,
  CHAT_WIDTH_MODES,
  CHAT_WIDTH_MAX_WIDTH,
  CHAT_WIDTH_LABELS,
  CHAT_WIDTH_PREVIEW_PERCENT,
} from '../stores/chat-layout-store';

const settingsGet = vi.fn();
const settingsUpdate = vi.fn();

beforeEach(() => {
  settingsGet.mockReset().mockResolvedValue({ chatWidthMode: 'compacto' });
  settingsUpdate.mockReset().mockResolvedValue(undefined);
  globalThis.window = {
    lionclaw: {
      settings: { get: settingsGet, update: settingsUpdate },
    },
  } as unknown as Window & typeof globalThis;
  useChatLayoutStore.setState({ width: 'compacto', hydrated: false });
});

describe('chat-layout-store', () => {
  it('default e compacto (layout pre-feature)', () => {
    expect(useChatLayoutStore.getState().width).toBe('compacto');
  });

  it('setWidth(amplo) troca o estado e persiste via settings:update', () => {
    useChatLayoutStore.getState().setWidth('amplo');
    expect(useChatLayoutStore.getState().width).toBe('amplo');
    expect(settingsUpdate).toHaveBeenCalledWith({ chatWidthMode: 'amplo' });
  });

  it('setWidth(full-width) troca o estado e persiste', () => {
    useChatLayoutStore.getState().setWidth('full-width');
    expect(useChatLayoutStore.getState().width).toBe('full-width');
    expect(settingsUpdate).toHaveBeenCalledWith({ chatWidthMode: 'full-width' });
  });

  it('setWidth no modo ja ativo e no-op (nao re-grava settings)', () => {
    useChatLayoutStore.getState().setWidth('compacto');
    expect(settingsUpdate).not.toHaveBeenCalled();
  });

  it('hydrate le o settings:get uma unica vez e aplica o modo persistido', async () => {
    settingsGet.mockResolvedValue({ chatWidthMode: 'full-width' });
    await useChatLayoutStore.getState().hydrate();
    expect(useChatLayoutStore.getState().width).toBe('full-width');
    await useChatLayoutStore.getState().hydrate();
    expect(settingsGet).toHaveBeenCalledTimes(1);
  });

  it('hydrate com valor invalido/ausente mantem o default compacto', async () => {
    settingsGet.mockResolvedValue({ chatWidthMode: 'gigante' });
    await useChatLayoutStore.getState().hydrate();
    expect(useChatLayoutStore.getState().width).toBe('compacto');
  });

  it('constantes cobrem todos os modos e compacto preserva 768px', () => {
    for (const mode of CHAT_WIDTH_MODES) {
      expect(CHAT_WIDTH_MAX_WIDTH[mode]).toBeTruthy();
      expect(CHAT_WIDTH_LABELS[mode]).toBeTruthy();
      expect(CHAT_WIDTH_PREVIEW_PERCENT[mode]).toBeGreaterThan(0);
    }
    expect(CHAT_WIDTH_MAX_WIDTH.compacto).toBe('768px');
  });
});

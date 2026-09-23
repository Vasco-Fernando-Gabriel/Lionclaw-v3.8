import { create } from 'zustand';
import { CHAT_WIDTH_MODES, type ChatWidthMode } from '@/types';

export { CHAT_WIDTH_MODES };
export type { ChatWidthMode };

export const CHAT_WIDTH_MAX_WIDTH: Record<ChatWidthMode, string> = {
  compacto: '768px',
  amplo: 'clamp(900px, 75vw, 1200px)',
  'full-width': '95vw',
};

export const CHAT_WIDTH_LABELS: Record<ChatWidthMode, string> = {
  compacto: 'Compacto',
  amplo: 'Amplo',
  'full-width': 'Full-width',
};

export const CHAT_WIDTH_PREVIEW_PERCENT: Record<ChatWidthMode, number> = {
  compacto: 40,
  amplo: 70,
  'full-width': 95,
};

interface ChatLayoutState {
  width: ChatWidthMode;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setWidth: (mode: ChatWidthMode) => void;
}

function isChatWidthMode(value: unknown): value is ChatWidthMode {
  return typeof value === 'string' && (CHAT_WIDTH_MODES as readonly string[]).includes(value);
}

export const useChatLayoutStore = create<ChatLayoutState>((set, get) => ({
  width: 'compacto',
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    set({ hydrated: true });
    try {
      const settings = await window.lionclaw.settings.get();
      const stored = (settings as { chatWidthMode?: unknown }).chatWidthMode;
      if (isChatWidthMode(stored)) set({ width: stored });
    } catch {}
  },
  setWidth: (mode) => {
    if (!isChatWidthMode(mode) || get().width === mode) return;
    set({ width: mode });
    void window.lionclaw.settings.update({ chatWidthMode: mode }).catch(() => {});
  },
}));

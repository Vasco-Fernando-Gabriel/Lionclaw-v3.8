import { create } from 'zustand';
import type { ArtifactData } from '@/types';
import type { ArtifactPanelMode } from '@/lib/artifact-panel-messages';
import { useChatStore } from './chat-store';

interface ArtifactPanelState {
  current: ArtifactData | null;
  sessionId: string | null;
  mode: ArtifactPanelMode;
  activitiesWereOpen: boolean | null;
  open: (artifact: ArtifactData, sessionId: string | null) => void;
  close: () => void;
  setMode: (mode: ArtifactPanelMode) => void;
}

function collapseActivities(sessionId: string | null): boolean | null {
  if (!sessionId) return null;
  const chat = useChatStore.getState();
  const thread = chat.threads[sessionId];
  const wasOpen = thread ? thread.activitiesPanelOpen : true;
  chat.toggleActivitiesPanel(false, sessionId);
  return wasOpen;
}

function restoreActivities(sessionId: string | null, wasOpen: boolean | null): void {
  if (!sessionId || wasOpen === null) return;
  useChatStore.getState().toggleActivitiesPanel(wasOpen, sessionId);
}

export const useArtifactPanelStore = create<ArtifactPanelState>((set, get) => ({
  current: null,
  sessionId: null,
  mode: 'side',
  activitiesWereOpen: null,

  open: (artifact, sessionId) => {
    const prev = get();
    const visibleSameLane = prev.current !== null && prev.sessionId === sessionId && prev.mode !== 'minimized';
    if (prev.current !== null && !visibleSameLane) {
      restoreActivities(prev.sessionId, prev.activitiesWereOpen);
    }
    const activitiesWereOpen = visibleSameLane ? prev.activitiesWereOpen : collapseActivities(sessionId);
    set({ current: artifact, sessionId, mode: 'side', activitiesWereOpen });
  },

  close: () => {
    const prev = get();
    if (prev.current === null) return;
    if (prev.mode !== 'minimized') restoreActivities(prev.sessionId, prev.activitiesWereOpen);
    set({ current: null, sessionId: null, mode: 'side', activitiesWereOpen: null });
  },

  setMode: (mode) => {
    const prev = get();
    if (prev.current === null || prev.mode === mode) return;
    if (mode === 'minimized') {
      restoreActivities(prev.sessionId, prev.activitiesWereOpen);
      set({ mode, activitiesWereOpen: null });
      return;
    }
    if (prev.mode === 'minimized') {
      set({ mode, activitiesWereOpen: collapseActivities(prev.sessionId) });
      return;
    }
    set({ mode });
  },
}));

import { create } from 'zustand';
import { useChatStore } from './chat-store';
import type { ChatLaneErrorCode, DriveState } from '@/types';

export type DriveOpResult = { ok: true; sessionId: string } | { error: string; code?: ChatLaneErrorCode };

interface DriveStoreState {
  drives: Map<string, DriveState | null>;
  pending: Set<string>;

  loadDrive: (projectId: string) => Promise<void>;
  getDrive: (projectId: string) => DriveState | null;

  start: (projectId: string, mode: 'semi' | 'full', sessionId: string) => Promise<DriveOpResult>;
  assumir: (projectId: string) => Promise<{ ok: true } | { error: string }>;
  stop: (projectId: string) => Promise<{ ok: true } | { error: string }>;
  resume: (projectId: string, sessionId: string) => Promise<DriveOpResult>;
  setMode: (projectId: string, mode: 'semi' | 'full') => Promise<{ ok: true } | { error: string }>;

  _apply: (projectId: string, drive: DriveState | null) => void;

  init: () => () => void;
}

const SESSION_REQUIRED = 'session_required: escolha a lane (conversa aberta) que vai dirigir o pipeline.';

export const useDriveStore = create<DriveStoreState>((set, get) => ({
  drives: new Map(),
  pending: new Set(),

  loadDrive: async (projectId: string) => {
    try {
      const drive = await window.lionclaw.drive.getState(projectId);
      get()._apply(projectId, drive);
    } catch (err) {
      console.warn('[drive-store] loadDrive failed', { projectId, err });
    }
  },

  getDrive: (projectId: string) => get().drives.get(projectId) ?? null,

  _apply: (projectId: string, drive: DriveState | null) => {
    const next = new Map(get().drives);
    if (drive === null) {
      next.delete(projectId);
    } else {
      next.set(projectId, drive);
    }
    set({ drives: next });
  },

  start: async (projectId, mode, sessionId) => {
    if (!sessionId) return { error: SESSION_REQUIRED, code: 'session_required' };
    return runOp(projectId, set, get, () => window.lionclaw.drive.start(projectId, mode, sessionId));
  },

  assumir: async (projectId) => {
    return runOp(projectId, set, get, () => window.lionclaw.drive.assumir(projectId));
  },

  stop: async (projectId) => {
    return runOp(projectId, set, get, async () => {
      const r = await window.lionclaw.drive.stop(projectId);
      if ('ok' in r) await get().loadDrive(projectId);
      return r;
    });
  },

  resume: async (projectId, sessionId) => {
    if (!sessionId) return { error: SESSION_REQUIRED, code: 'session_required' };
    return runOp(projectId, set, get, () => window.lionclaw.drive.resume(projectId, sessionId));
  },

  setMode: async (projectId, mode) => {
    return runOp(projectId, set, get, () => window.lionclaw.drive.setMode(projectId, mode));
  },

  init: () => {
    const unsub = window.lionclaw.drive.onStateChanged(({ projectId, drive, sessionId }) => {
      const chat = useChatStore.getState();
      void chat.loadOpenLanes();
      if (sessionId && drive?.status === 'driving') chat.setDrivePausedForSession(sessionId, false);
      if (!projectId) return;
      get()._apply(projectId, drive);
    });
    return unsub;
  },
}));

async function runOp<
  R extends { ok: true; drive?: DriveState; sessionId?: string } | { error: string; code?: ChatLaneErrorCode },
>(
  projectId: string,
  set: (partial: Partial<DriveStoreState> | ((s: DriveStoreState) => Partial<DriveStoreState>)) => void,
  get: () => DriveStoreState,
  op: () => Promise<R>,
): Promise<DriveOpResult> {
  const pending = new Set(get().pending);
  pending.add(projectId);
  set({ pending });
  try {
    const result = await op();
    if ('error' in result) {
      return result.code ? { error: result.error, code: result.code } : { error: result.error };
    }
    if ('drive' in result && result.drive) {
      get()._apply(projectId, result.drive);
    }
    return { ok: true, sessionId: 'sessionId' in result && result.sessionId ? result.sessionId : '' };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    const after = new Set(get().pending);
    after.delete(projectId);
    set({ pending: after });
  }
}

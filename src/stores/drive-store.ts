import { create } from 'zustand';
import type { DriveState } from '@/types';

interface DriveStoreState {
  drives: Map<string, DriveState | null>;
  pending: Set<string>;

  loadDrive: (projectId: string) => Promise<void>;
  getDrive: (projectId: string) => DriveState | null;

  start: (
    projectId: string,
    mode: 'semi' | 'full',
  ) => Promise<{ ok: true } | { error: string }>;
  assumir: (projectId: string) => Promise<{ ok: true } | { error: string }>;
  stop: (projectId: string) => Promise<{ ok: true } | { error: string }>;
  resume: (projectId: string) => Promise<{ ok: true } | { error: string }>;
  setMode: (
    projectId: string,
    mode: 'semi' | 'full',
  ) => Promise<{ ok: true } | { error: string }>;

  _apply: (projectId: string, drive: DriveState | null) => void;

  init: () => () => void;
}

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

  start: async (projectId, mode) => {
    return runOp(projectId, set, get, () =>
      window.lionclaw.drive.start(projectId, mode),
    );
  },

  assumir: async (projectId) => {
    return runOp(projectId, set, get, () =>
      window.lionclaw.drive.assumir(projectId),
    );
  },

  stop: async (projectId) => {
    return runOp(projectId, set, get, async () => {
      const r = await window.lionclaw.drive.stop(projectId);
      if ('ok' in r) await get().loadDrive(projectId);
      return r;
    });
  },

  resume: async (projectId) => {
    return runOp(projectId, set, get, () =>
      window.lionclaw.drive.resume(projectId),
    );
  },

  setMode: async (projectId, mode) => {
    return runOp(projectId, set, get, () =>
      window.lionclaw.drive.setMode(projectId, mode),
    );
  },

  init: () => {
    const unsub = window.lionclaw.drive.onStateChanged(({ projectId, drive }) => {
      if (!projectId) return;
      get()._apply(projectId, drive);
    });
    return unsub;
  },
}));

async function runOp(
  projectId: string,
  set: (
    partial:
      | Partial<DriveStoreState>
      | ((s: DriveStoreState) => Partial<DriveStoreState>),
  ) => void,
  get: () => DriveStoreState,
  op: () => Promise<{ ok: true; drive?: DriveState } | { error: string }>,
): Promise<{ ok: true } | { error: string }> {
  const pending = new Set(get().pending);
  pending.add(projectId);
  set({ pending });
  try {
    const result = await op();
    if ('error' in result) {
      return { error: result.error };
    }
    if ('drive' in result && result.drive) {
      get()._apply(projectId, result.drive);
    }
    return { ok: true };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    const after = new Set(get().pending);
    after.delete(projectId);
    set({ pending: after });
  }
}

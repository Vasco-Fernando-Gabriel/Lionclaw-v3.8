import { create } from 'zustand';


export interface SidecarStatus {
  running: boolean;
  daemonUrl: string | null;
  webUrl: string | null;
  daemonPort: number | null;
  webPort: number | null;
}


interface OpenDesignState {
  sidecarStatus: SidecarStatus | null;
  isStudioOpen: boolean;
  activeProjectId: string | null;
  setupDone: boolean;
  _pollHandle: ReturnType<typeof setInterval> | null;
}

interface OpenDesignActions {
  openStudio: (projectId: string) => void;
  closeStudio: () => void;
  refreshStatus: (projectId: string) => Promise<void>;
  startPolling: (projectId: string) => void;
  stopPolling: () => void;
  markSetupDone: () => void;
  resetSetup: () => void;
}

type OpenDesignStore = OpenDesignState & OpenDesignActions;

const INITIAL_STATE: OpenDesignState = {
  sidecarStatus: null,
  isStudioOpen: false,
  activeProjectId: null,
  setupDone: false,
  _pollHandle: null,
};

export const useOpenDesignStore = create<OpenDesignStore>()((set, get) => ({
  ...INITIAL_STATE,

  openStudio: (projectId: string) => {
    set({ isStudioOpen: true, activeProjectId: projectId });
    get().startPolling(projectId);
  },

  closeStudio: () => {
    get().stopPolling();
    window.lionclaw.openDesign.hideView().catch(() => { /* ignore */ });
    set({ isStudioOpen: false });
  },

  refreshStatus: async (projectId: string) => {
    try {
      const result = await window.lionclaw.openDesign.status(projectId);
      if ('error' in result) {
        set({ sidecarStatus: null });
        return;
      }
      set({ sidecarStatus: result });
    } catch {
      set({ sidecarStatus: null });
    }
  },

  startPolling: (projectId: string) => {
    const existing = get()._pollHandle;
    if (existing !== null) return; // already polling

    const handle = setInterval(() => {
      void get().refreshStatus(projectId);
    }, 2000);

    void get().refreshStatus(projectId);
    set({ _pollHandle: handle });
  },

  stopPolling: () => {
    const handle = get()._pollHandle;
    if (handle !== null) {
      clearInterval(handle);
      set({ _pollHandle: null });
    }
  },

  markSetupDone: () => set({ setupDone: true }),

  resetSetup: () => set({ setupDone: false, sidecarStatus: null }),
}));

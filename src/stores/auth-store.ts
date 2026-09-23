import { create } from 'zustand';

interface AuthState {
  isAuthenticated: boolean;
  isFirstRun: boolean;
  isLoading: boolean;
  onboardingCompleted: boolean;
  orchestratorSetupCompleted: boolean;
  setAuthenticated: (value: boolean) => void;
  setFirstRun: (value: boolean) => void;
  setLoading: (value: boolean) => void;
  checkAuth: () => Promise<void>;
  checkOnboarding: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  isFirstRun: false,
  isLoading: true,
  onboardingCompleted: true, // default true to avoid flicker
  orchestratorSetupCompleted: false, // default false; updated after auth check

  setAuthenticated: (value) => set({ isAuthenticated: value }),
  setFirstRun: (value) => set({ isFirstRun: value }),
  setLoading: (value) => set({ isLoading: value }),

  checkAuth: async () => {
    set({ isLoading: true });
    try {
      const [isFirstRun, isAuthenticated] = await Promise.all([
        window.lionclaw.auth.isFirstRun(),
        window.lionclaw.auth.isAuthenticated(),
      ]);

      if (isAuthenticated) {
        try {
          const settings = await window.lionclaw.settings.get();
          set({
            isFirstRun,
            isAuthenticated,
            orchestratorSetupCompleted: settings.orchestratorSetupCompleted,
            isLoading: false,
          });
        } catch {
          set({ isFirstRun, isAuthenticated, orchestratorSetupCompleted: false, isLoading: false });
        }
      } else {
        set({ isFirstRun, isAuthenticated, orchestratorSetupCompleted: false, isLoading: false });
      }
    } catch {
      set({ isLoading: false });
    }
  },

  checkOnboarding: async () => {
    try {
      const completed = await window.lionclaw.onboarding.isCompleted();
      set({ onboardingCompleted: completed });
    } catch {}
  },
}));

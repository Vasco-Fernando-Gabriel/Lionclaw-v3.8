import { create } from 'zustand';
import type { ProviderStatusEntry } from '@/types';

export type OrchestratorPickerPhase = 'idle' | 'loading' | 'ready' | 'error';

interface OrchestratorPickerState {
  phase: OrchestratorPickerPhase;
  entries: ProviderStatusEntry[];
  error: string | null;
  loadedAt: number | null;
  load: () => Promise<ProviderStatusEntry[]>;
  refresh: () => Promise<ProviderStatusEntry[]>;
}

let inFlight: Promise<ProviderStatusEntry[]> | null = null;

async function fetchStatuses(
  refresh: boolean,
  set: (patch: Partial<OrchestratorPickerState>) => void,
  get: () => OrchestratorPickerState,
): Promise<ProviderStatusEntry[]> {
  if (inFlight) return inFlight;
  set({ phase: 'loading', error: null });
  inFlight = (async () => {
    try {
      const result = await window.lionclaw.provider.listStatuses(refresh ? { refresh: true } : undefined);
      if (Array.isArray(result)) {
        set({ phase: 'ready', entries: result, error: null, loadedAt: Date.now() });
        return result;
      }
      set({ phase: 'error', error: result.error });
      return get().entries;
    } catch (err) {
      set({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
      return get().entries;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export const useOrchestratorPickerStore = create<OrchestratorPickerState>((set, get) => ({
  phase: 'idle',
  entries: [],
  error: null,
  loadedAt: null,
  load: () => fetchStatuses(false, set, get),
  refresh: () => fetchStatuses(true, set, get),
}));

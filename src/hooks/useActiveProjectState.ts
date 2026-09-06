import { usePipelineStore } from '@/stores/pipeline-store';
import type { PerProjectState } from '@/stores/pipeline-store';

export function useActiveProjectState<T>(
  selector: (s: PerProjectState) => T,
): T | null {
  return usePipelineStore(
    (store) => {
      const id = store.activeProjectId;
      if (!id) return null;
      const ps = store.projectStates.get(id);
      return ps ? selector(ps) : null;
    },
  );
}

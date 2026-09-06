import { create } from 'zustand';
import type { HarnessProject } from '@/types';

interface StreamEntry {
  type: string;
  content?: string;
  tool?: string;
}

interface HarnessState {
  projects: HarnessProject[];
  selectedProjectId: string | null;
  activeTab: 'sprints' | 'execution' | 'metrics';
  plannerStream: StreamEntry[];
  coderStream: StreamEntry[];
  evaluatorStream: StreamEntry[];
  isPlannerActive: boolean;
  isCoderActive: boolean;
  isEvaluatorActive: boolean;
  loadProjects: () => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  selectProject: (id: string | null) => void;
  setTab: (tab: 'sprints' | 'execution' | 'metrics') => void;
  appendStream: (agent: string, chunk: StreamEntry) => void;
  clearStreams: () => void;
  clearPlannerStream: () => void;
}

export const useHarnessStore = create<HarnessState>((set) => ({
  projects: [],
  selectedProjectId: null,
  activeTab: 'sprints',
  plannerStream: [],
  coderStream: [],
  evaluatorStream: [],
  isPlannerActive: false,
  isCoderActive: false,
  isEvaluatorActive: false,

  loadProjects: async () => {
    const projects = await window.lionclaw.harness.listProjects();
    set({ projects });
  },

  deleteProject: async (id) => {
    await window.lionclaw.harness.deleteProject(id);
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      selectedProjectId: state.selectedProjectId === id ? null : state.selectedProjectId,
    }));
  },

  selectProject: (id) => set({ selectedProjectId: id, activeTab: 'sprints' }),
  setTab: (tab) => set({ activeTab: tab }),

  appendStream: (agent, chunk) =>
    set((state) => {
      if (agent === 'planner') {
        return { plannerStream: [...state.plannerStream, chunk], isPlannerActive: true };
      }
      if (agent === 'coder') {
        return { coderStream: [...state.coderStream, chunk], isCoderActive: true };
      }
      if (agent === 'evaluator') {
        return {
          evaluatorStream: [...state.evaluatorStream, chunk],
          isEvaluatorActive: true,
        };
      }
      return state;
    }),

  clearStreams: () =>
    set({
      coderStream: [],
      evaluatorStream: [],
      isCoderActive: false,
      isEvaluatorActive: false,
    }),

  clearPlannerStream: () =>
    set({
      plannerStream: [],
      isPlannerActive: false,
    }),
}));

import { create } from 'zustand';
import type { KnowledgeSource, KnowledgeAgentConfig, KBSearchResult, BenchmarkResult, ChunkStrategy } from '@/types';

interface KnowledgeState {
  sources: KnowledgeSource[];
  selectedAgentId: string | null;
  config: KnowledgeAgentConfig | null;
  searchResults: KBSearchResult | null;
  benchmarkResult: BenchmarkResult | null;
  isLoading: boolean;
  isSearching: boolean;
  isUploading: boolean;
  uploadProgress: { stage: string; progress: number } | null;
  benchmarkProgress: {
    stage: string;
    strategy?: string;
    mode?: string;
    current: number;
    total: number;
    done?: boolean;
  } | null;

  loadSources: (agentId: string) => Promise<void>;
  loadAllSources: (agentIds: string[]) => Promise<void>;
  uploadDocument: (
    agentId: string,
    filePath: string,
    config: { strategy: ChunkStrategy; chunkSize: number; chunkOverlap: number; title?: string },
  ) => Promise<KnowledgeSource>;
  deleteSource: (sourceId: string) => Promise<void>;
  reprocessSource: (
    sourceId: string,
    strategy: ChunkStrategy,
    chunkSize: number,
    chunkOverlap: number,
  ) => Promise<void>;
  searchKnowledge: (agentId: string, query: string) => Promise<void>;
  startBenchmark: (
    sourceIds: string[],
    agentId: string,
    config: { totalQuestions: number; modelJudge: 'sonnet' | 'opus'; threshold: number },
  ) => Promise<string>;
  loadConfig: (agentId: string) => Promise<void>;
  updateConfig: (agentId: string, config: Partial<KnowledgeAgentConfig>) => Promise<void>;
  setSelectedAgent: (agentId: string) => void;
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  sources: [],
  selectedAgentId: null,
  config: null,
  searchResults: null,
  benchmarkResult: null,
  isLoading: false,
  isSearching: false,
  isUploading: false,
  uploadProgress: null,
  benchmarkProgress: null,

  setSelectedAgent: (agentId) => {
    set({ selectedAgentId: agentId, sources: [], searchResults: null });
  },

  loadSources: async (agentId) => {
    set({ isLoading: true });
    try {
      const sources = await window.lionclaw.knowledge.list({ agentId });
      set({ sources });
    } finally {
      set({ isLoading: false });
    }
  },

  loadAllSources: async (agentIds) => {
    set({ isLoading: true });
    try {
      const results = await Promise.all(
        agentIds.map((id) => window.lionclaw.knowledge.list({ agentId: id }).catch(() => [] as KnowledgeSource[])),
      );
      set({ sources: results.flat() });
    } finally {
      set({ isLoading: false });
    }
  },

  uploadDocument: async (agentId, filePath, config) => {
    set({ isUploading: true, uploadProgress: { stage: 'parsing', progress: 0 } });
    const unsubscribe = window.lionclaw.knowledge.onIngestionProgress((data) => {
      set({ uploadProgress: { stage: data.stage, progress: data.progress } });
    });
    try {
      const source = await window.lionclaw.knowledge.upload({ agentId, filePath, config });
      const { sources } = get();
      const existing = sources.findIndex((s) => s.id === source.id);
      if (existing >= 0) {
        const updated = [...sources];
        updated[existing] = source;
        set({ sources: updated });
      } else {
        set({ sources: [...sources, source] });
      }
      return source;
    } finally {
      unsubscribe();
      set({ isUploading: false, uploadProgress: null });
    }
  },

  deleteSource: async (sourceId) => {
    await window.lionclaw.knowledge.delete({ sourceId });
    set((state) => ({ sources: state.sources.filter((s) => s.id !== sourceId) }));
  },

  reprocessSource: async (sourceId, strategy, chunkSize, chunkOverlap) => {
    const updated = await window.lionclaw.knowledge.reprocess({
      sourceId,
      strategy,
      chunkSize,
      chunkOverlap,
    });
    set((state) => ({
      sources: state.sources.map((s) => (s.id === sourceId ? updated : s)),
    }));
  },

  searchKnowledge: async (agentId, query) => {
    set({ isSearching: true });
    try {
      const results = await window.lionclaw.knowledge.search({ agentId, query });
      set({ searchResults: results });
    } finally {
      set({ isSearching: false });
    }
  },

  startBenchmark: async (sourceIds, agentId, config) => {
    set({ benchmarkResult: null, benchmarkProgress: { stage: 'iniciando', current: 0, total: config.totalQuestions } });
    const { benchmarkId } = await window.lionclaw.knowledge.benchmark.start({
      sourceIds,
      agentId,
      config,
    });
    const unsubscribe = window.lionclaw.knowledge.onBenchmarkProgress((data) => {
      if (data.benchmarkId === benchmarkId) {
        set({
          benchmarkProgress: {
            stage: data.stage,
            strategy: data.strategy,
            mode: data.mode,
            current: data.current,
            total: data.total,
            done: data.done,
          },
        });
      }
    });
    const poll = async (): Promise<void> => {
      const status = await window.lionclaw.knowledge.benchmark.status({ benchmarkId });
      if (status.status === 'completed' && status.result) {
        unsubscribe();
        set({ benchmarkResult: status.result, benchmarkProgress: null });
      } else if (status.status === 'failed') {
        unsubscribe();
        set({ benchmarkProgress: null });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return poll();
      }
    };
    void poll();
    return benchmarkId;
  },

  loadConfig: async (agentId) => {
    const config = await window.lionclaw.knowledge.config.get({ agentId });
    set({ config });
  },

  updateConfig: async (agentId, config) => {
    const updated = await window.lionclaw.knowledge.config.update({ agentId, config });
    set({ config: updated });
  },
}));

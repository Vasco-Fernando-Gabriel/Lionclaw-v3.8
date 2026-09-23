import { ipcMain } from 'electron';
import crypto from 'crypto';
import { createLogger } from '../logger';
import type { IpcContext } from './context';
import { ingestDocument, reprocessDocument, hybridKnowledgeSearch } from '../knowledge-engine';
import { runBenchmarkPipeline } from '../knowledge-benchmark';
import {
  getKnowledgeSources,
  getKnowledgeSource,
  deleteKnowledgeSource,
  getKnowledgeAgentConfig,
  upsertKnowledgeAgentConfig,
  insertKnowledgeBenchmark,
  getKnowledgeBenchmark,
  updateKnowledgeBenchmark,
} from '../db';

const logger = createLogger('ipc');

export function registerKnowledgeHandlers(ctx: IpcContext): void {
  const { getMainWindow } = ctx;

  ipcMain.handle(
    'knowledge:upload',
    async (
      _event,
      payload: {
        agentId: string;
        filePath: string;
        config: {
          strategy: string;
          chunkSize: number;
          chunkOverlap: number;
          title?: string;
        };
      },
    ) => {
      const win = getMainWindow();
      const emitProgress = (data: { sourceId: string; stage: string; progress: number }) => {
        win?.webContents.send('knowledge:ingestion:progress', data);
      };
      return ingestDocument(
        {
          ...payload,
          config: {
            ...payload.config,
            strategy: payload.config.strategy as 'recursive' | 'semantic' | 'page' | 'markdown' | 'csv' | 'agentic',
          },
        },
        emitProgress,
      );
    },
  );

  ipcMain.handle(
    'knowledge:reprocess',
    async (
      _event,
      payload: {
        sourceId: string;
        strategy: string;
        chunkSize: number;
        chunkOverlap: number;
      },
    ) => {
      const win = getMainWindow();
      const emitProgress = (data: { sourceId: string; stage: string; progress: number }) => {
        win?.webContents.send('knowledge:ingestion:progress', data);
      };
      await reprocessDocument(
        payload.sourceId,
        payload.strategy as 'recursive' | 'semantic' | 'page' | 'markdown' | 'csv' | 'agentic',
        payload.chunkSize,
        payload.chunkOverlap,
        emitProgress,
      );
      return getKnowledgeSource(payload.sourceId);
    },
  );

  ipcMain.handle('knowledge:delete', async (_event, payload: { sourceId: string }) => {
    deleteKnowledgeSource(payload.sourceId);
    return { success: true };
  });

  ipcMain.handle('knowledge:list', async (_event, payload: { agentId: string }) => {
    return getKnowledgeSources(payload.agentId);
  });

  ipcMain.handle('knowledge:search', async (_event, payload: { agentId: string; query: string }) => {
    return hybridKnowledgeSearch(payload.agentId, payload.query);
  });

  ipcMain.handle(
    'knowledge:benchmark:start',
    async (
      _event,
      payload: {
        sourceIds: string[];
        agentId: string;
        config: {
          totalQuestions: number;
          modelJudge: 'sonnet' | 'opus';
          threshold: number;
        };
      },
    ) => {
      const benchmarkId = crypto.randomUUID();
      insertKnowledgeBenchmark({
        id: benchmarkId,
        sourceId: payload.sourceIds[0],
        agentId: payload.agentId,
        status: 'running',
        totalQuestions: payload.config.totalQuestions,
        modelJudge: payload.config.modelJudge,
        questions: [],
        results: {},
      });

      const win = getMainWindow();
      runBenchmarkPipeline(benchmarkId, payload, win).catch((err) => {
        logger.error({ err, benchmarkId }, 'Benchmark pipeline failed');
        updateKnowledgeBenchmark(benchmarkId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
        });
        win?.webContents.send('knowledge:benchmark:progress', {
          benchmarkId,
          stage: `Erro: ${err instanceof Error ? err.message : String(err)}`,
          current: 0,
          total: 0,
          done: true,
        });
      });

      return { benchmarkId };
    },
  );

  ipcMain.handle('knowledge:benchmark:status', async (_event, payload: { benchmarkId: string }) => {
    const benchmark = getKnowledgeBenchmark(payload.benchmarkId);
    if (!benchmark) return { status: 'failed', progress: 0, currentStage: 'not_found' };
    return {
      status: benchmark.status,
      progress: benchmark.status === 'completed' ? 100 : 0,
      currentStage: benchmark.status,
      result: benchmark.status === 'completed' ? benchmark.results : undefined,
    };
  });

  ipcMain.handle('knowledge:config:get', async (_event, payload: { agentId: string }) => {
    const config = getKnowledgeAgentConfig(payload.agentId);
    if (!config) {
      return {
        agentId: payload.agentId,
        hydeEnabled: true,
        hydeThreshold: 0.5,
        minScore: 0.4,
        defaultStrategy: 'recursive',
        rerankEnabled: true,
        rerankTopK: 3,
        searchTopK: 20,
      };
    }
    return config;
  });

  ipcMain.handle(
    'knowledge:config:update',
    async (
      _event,
      payload: {
        agentId: string;
        config: Partial<{
          hydeEnabled: boolean;
          hydeThreshold: number;
          minScore: number;
          defaultStrategy: string;
          rerankEnabled: boolean;
          rerankTopK: number;
          searchTopK: number;
        }>;
      },
    ) => {
      upsertKnowledgeAgentConfig(payload.agentId, payload.config);
      return getKnowledgeAgentConfig(payload.agentId);
    },
  );
}

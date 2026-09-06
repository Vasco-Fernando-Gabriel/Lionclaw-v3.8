import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string | undefined>,
  lionHome: '',
  lmStudioRequests: [] as Array<{ config: { baseUrl: string }; req: { model: string } }>,
  googleRequests: [] as Array<{ config: { apiKey?: string }; req: { model: string } }>,
  anthropicConstructed: 0,
}));

const compactionJson = JSON.stringify({
  executive_summary: 'Resumo local',
  decisions: [],
  tasks_created: [],
  facts: [],
  semantic_chunks: [],
  user_profile_updates: [],
  working_memory_updates: {
    add: [],
    remove: [],
  },
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../paths', () => ({
  getLionClawHome: () => state.lionHome,
}));

vi.mock('../db', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(() => {
        if (sql.includes('FROM messages')) {
          return [
            {
              role: 'user',
              content: 'precisamos compactar usando o modelo local',
              created_at: '2026-05-18T10:00:00.000Z',
              session_title: 'Teste local',
            },
          ];
        }
        return [];
      }),
      run: vi.fn(),
    })),
  })),
  getSessionMessages: vi.fn(),
  getSession: vi.fn(),
  getSetting: vi.fn((key: string) => state.settings[key]),
  insertChunkWithEmbedding: vi.fn(),
  insertChunkPlainWithFTS: vi.fn(),
  searchBM25: vi.fn(),
  searchVector: vi.fn(),
  setLastGateRunAt: vi.fn(),
}));

vi.mock('../embedding-provider', () => ({
  generateEmbedding: vi.fn(async () => null),
}));

vi.mock('../mgraph-engine', () => ({
  executeVaultOperation: vi.fn(),
  regenerateVaultIndex: vi.fn(),
  updateVaultHot: vi.fn(),
  appendVaultLog: vi.fn(),
  getExistingVaultFilesList: vi.fn(() => ''),
}));


vi.mock('../secrets-vault', () => ({
  getApiKey: vi.fn(async () => {
    throw new Error('Anthropic compaction should not be called');
  }),
  getSecret: vi.fn(async () => 'compat-key'),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => {
    state.anthropicConstructed += 1;
    return { messages: { create: vi.fn() } };
  }),
}));

vi.mock('../lion-sdk/adapters/ollama', () => ({
  createOllamaAdapter: vi.fn((config: { baseUrl: string }) => ({
    name: 'ollama',
    async *streamCompletion(req: { model: string }) {
      state.lmStudioRequests.push({ config, req });
      yield { type: 'text' as const, delta: compactionJson };
      yield { type: 'done' as const };
    },
  })),
}));

vi.mock('../lion-sdk/adapters/lmstudio', () => ({
  createLmStudioAdapter: vi.fn((config: { baseUrl: string }) => ({
    name: 'lmstudio',
    async *streamCompletion(req: { model: string }) {
      state.lmStudioRequests.push({ config, req });
      yield { type: 'text' as const, delta: compactionJson };
      yield { type: 'done' as const };
    },
  })),
}));

vi.mock('../lion-sdk/adapters/openai-compatible', () => ({
  createOpenAiCompatibleAdapter: vi.fn((config: { baseUrl: string }) => ({
    name: 'openai-compatible',
    async *streamCompletion(req: { model: string }) {
      state.lmStudioRequests.push({ config, req });
      yield { type: 'text' as const, delta: compactionJson };
      yield { type: 'done' as const };
    },
  })),
}));

vi.mock('../lion-sdk/adapters/google-genai', () => ({
  createGoogleGenAiAdapter: vi.fn((config: { apiKey?: string }) => ({
    name: 'vertex-ai',
    async *streamCompletion(req: { model: string }) {
      state.googleRequests.push({ config, req });
      yield { type: 'text' as const, delta: compactionJson };
      yield { type: 'done' as const };
    },
  })),
}));

import { runCompaction } from '../memory-pipeline';

describe('memory pipeline Lion-SDK compaction routing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    state.lmStudioRequests = [];
    state.googleRequests = [];
    state.anthropicConstructed = 0;
    state.lionHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lion-memory-pipeline-'));
    state.settings = {
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'lmstudio',
      orchestrator_model: 'qwen/qwen3.6-27b',
      orchestrator_lmstudio_base_url: 'http://localhost:1234',
      orchestrator_compaction_provider: '',
      orchestrator_compaction_model: '',
      mgraph_mode: 'false',
    };
  });

  afterEach(async () => {
    if (state.lionHome) {
      await fs.rm(state.lionHome, { recursive: true, force: true });
    }
  });

  it('uses the current Lion-SDK chat provider/model when compaction is Auto(chat)', async () => {
    await runCompaction(
      new Date('2026-05-18T00:00:00.000Z'),
      new Date('2026-05-18T10:30:00.000Z'),
      'session-1',
    );

    expect(state.lmStudioRequests).toHaveLength(1);
    expect(state.lmStudioRequests[0].config.baseUrl).toBe('http://localhost:1234');
    expect(state.lmStudioRequests[0].req.model).toBe('qwen/qwen3.6-27b');
    expect(state.anthropicConstructed).toBe(0);
  });

  it('uses Vertex Gemini when Auto(chat) points at vertex-ai', async () => {
    state.settings = {
      ...state.settings,
      orchestrator_provider: 'vertex-ai',
      orchestrator_model: 'gemini-3.1-pro-preview',
      orchestrator_vertex_api_key_ref: 'ORCHESTRATOR_VERTEX_API_KEY',
    };

    await runCompaction(
      new Date('2026-05-18T00:00:00.000Z'),
      new Date('2026-05-18T10:30:00.000Z'),
      'session-1',
    );

    expect(state.googleRequests).toHaveLength(1);
    expect(state.googleRequests[0].config.apiKey).toBe('compat-key');
    expect(state.googleRequests[0].req.model).toBe('gemini-3.1-pro-preview');
    expect(state.lmStudioRequests).toHaveLength(0);
    expect(state.anthropicConstructed).toBe(0);
  });
});

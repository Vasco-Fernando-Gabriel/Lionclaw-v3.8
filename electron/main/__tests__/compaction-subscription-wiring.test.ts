
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string | undefined>,
  lionHome: '',
  withFallback: vi.fn(),
  runClaudePromptCalls: 0,
}));

const compactionJson = JSON.stringify({
  executive_summary: 'Resumo',
  decisions: [],
  tasks_created: [],
  facts: [],
  semantic_chunks: [],
  user_profile_updates: [],
  working_memory_updates: { add: [], remove: [] },
});

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../paths', () => ({
  getLionClawHome: () => state.lionHome,
  getBackgroundCwd: () => path.join(state.lionHome, 'background'),
}));

vi.mock('../db', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(() => {
        if (sql.includes('FROM messages')) {
          return [{ role: 'user', content: 'compacta isso', created_at: '2026-05-18T10:00:00.000Z', session_title: 'T' }];
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

vi.mock('../embedding-provider', () => ({ generateEmbedding: vi.fn(async () => null) }));

vi.mock('../mgraph-engine', () => ({
  executeVaultOperation: vi.fn(),
  regenerateVaultIndex: vi.fn(),
  updateVaultHot: vi.fn(),
  appendVaultLog: vi.fn(),
  getExistingVaultFilesList: vi.fn(() => ''),
}));

vi.mock('../dreaming-gate', () => ({
  runDreamingGate: vi.fn(async () => ({ apply: { add: [], remove: [] }, failSafeTriggered: false })),
  saveDreamingReport: vi.fn(async () => {}),
}));

vi.mock('../memory-pipeline/oneshot-subscription', () => ({
  runSubscriptionPromptWithFallback: state.withFallback,
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => null),
  getApiKey: vi.fn(async () => {
    state.runClaudePromptCalls += 1;
    return 'should-not-be-used';
  }),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: vi.fn() } })),
}));

vi.mock('../lion-sdk/adapters/ollama', () => ({
  createOllamaAdapter: vi.fn(() => ({
    name: 'ollama',
    async *streamCompletion() {
      yield { type: 'error' as const, error: 'ECONNREFUSED: ollama offline' };
    },
  })),
}));
vi.mock('../lion-sdk/adapters/lmstudio', () => ({ createLmStudioAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/openai-compatible', () => ({ createOpenAiCompatibleAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/google-genai', () => ({ createGoogleGenAiAdapter: vi.fn() }));

import { runCompaction } from '../memory-pipeline';

beforeEach(async () => {
  vi.clearAllMocks();
  state.runClaudePromptCalls = 0;
  state.lionHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lion-sub-wiring-'));
  state.withFallback.mockResolvedValue({ text: compactionJson, actualModelLabel: 'Claude Opus 4.7' });
  state.settings = {
    orchestrator_runtime: 'claude-sdk',
    orchestrator_provider: 'anthropic',
    orchestrator_model: 'claude-opus-4-7',
    orchestrator_compaction_provider: '',
    orchestrator_compaction_model: '',
    mgraph_mode: 'false',
  };
});

afterEach(async () => {
  if (state.lionHome) await fs.rm(state.lionHome, { recursive: true, force: true });
});

const P_START = new Date('2026-05-18T00:00:00.000Z');
const P_END = new Date('2026-05-18T10:30:00.000Z');

describe('onModelLabel badge callback (subscription path)', () => {
  it('fires onModelLabel(actualModelLabel) on a successful subscription compaction', async () => {
    const onModelLabel = vi.fn();
    await runCompaction(P_START, P_END, 'session-1', { onModelLabel });

    expect(state.withFallback).toHaveBeenCalledTimes(1);
    expect(onModelLabel).toHaveBeenCalledTimes(1);
    expect(onModelLabel).toHaveBeenCalledWith('Claude Opus 4.7');
  });

  it('does NOT fire any badge callback when runCompaction is called without onModelLabel (Telegram case)', async () => {
    await runCompaction(P_START, P_END, 'session-1');
    expect(state.withFallback).toHaveBeenCalledTimes(1);
  });
});

describe('D-lion-offline: explicit Lion pick offline -> clear error, NO Sonnet fallback', () => {
  beforeEach(() => {
    state.settings = {
      ...state.settings,
      orchestrator_compaction_provider: 'ollama',
      orchestrator_compaction_model: 'qwen3:8b',
      orchestrator_ollama_base_url: 'http://localhost:11434',
    };
  });

  it('throws a clear adapter error and never calls the subscription helper nor the Sonnet API key', async () => {
    await expect(runCompaction(P_START, P_END, 'session-1')).rejects.toThrow(/ollama offline|adapter error/i);

    expect(state.withFallback).not.toHaveBeenCalled();
    expect(state.runClaudePromptCalls).toBe(0);
  });
});

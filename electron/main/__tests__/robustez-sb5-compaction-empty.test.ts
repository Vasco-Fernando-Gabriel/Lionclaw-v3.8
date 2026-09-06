
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string | undefined>,
  lionHome: '',
  withFallback: vi.fn(),
  lionText: '' as string,
}));

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
          return [
            {
              role: 'user',
              content: 'compacta isso',
              created_at: '2026-05-18T10:00:00.000Z',
              session_title: 'T',
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
  getApiKey: vi.fn(async () => 'unused'),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: vi.fn() } })),
}));

vi.mock('../lion-sdk/adapters/lmstudio', () => ({
  createLmStudioAdapter: vi.fn(() => ({
    name: 'lmstudio',
    async *streamCompletion() {
      if (state.lionText) {
        yield { type: 'text' as const, delta: state.lionText };
      }
      yield { type: 'done' as const };
    },
  })),
}));
vi.mock('../lion-sdk/adapters/ollama', () => ({ createOllamaAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/openai-compatible', () => ({ createOpenAiCompatibleAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/google-genai', () => ({ createGoogleGenAiAdapter: vi.fn() }));

import { runCompaction } from '../memory-pipeline';
import { EmptyProviderResponseError } from '../agent-runtime/llm-error';

const P_START = new Date('2026-05-18T00:00:00.000Z');
const P_END = new Date('2026-05-18T10:30:00.000Z');

beforeEach(async () => {
  vi.clearAllMocks();
  state.lionText = '';
  state.lionHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lion-sb5-empty-'));
  state.withFallback.mockResolvedValue({ text: '', actualModelLabel: 'X' });
});

afterEach(async () => {
  if (state.lionHome) await fs.rm(state.lionHome, { recursive: true, force: true });
});

function lionSettings(): void {
  state.settings = {
    orchestrator_runtime: 'lion-sdk',
    orchestrator_provider: 'lmstudio',
    orchestrator_model: 'qwen/qwen3.6-27b',
    orchestrator_lmstudio_base_url: 'http://localhost:1234',
    orchestrator_compaction_provider: '',
    orchestrator_compaction_model: '',
    mgraph_mode: 'false',
  };
}

function subscriptionSettings(): void {
  state.settings = {
    orchestrator_runtime: 'claude-sdk',
    orchestrator_provider: 'anthropic',
    orchestrator_model: 'claude-opus-4-7',
    orchestrator_compaction_provider: '',
    orchestrator_compaction_model: '',
    mgraph_mode: 'false',
  };
}

describe('SB-5 — compactacao com resposta vazia vira erro tipado', () => {
  it('AC-B14: summarizeWithLionSdk com resposta vazia lanca EmptyProviderResponseError, NAO JSON.parse("")', async () => {
    lionSettings();
    state.lionText = '';

    let caught: unknown;
    try {
      await runCompaction(P_START, P_END, 'session-1');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EmptyProviderResponseError);
    const typed = caught as EmptyProviderResponseError;
    expect(typed.message).not.toContain('Unexpected end of JSON input');
    expect(typed.provider).toBe('lmstudio');
    expect(typed.model).toBe('qwen/qwen3.6-27b');
    expect(typed.runtime).toBe('lion-sdk');
  });

  it('AC-B14: summarizeWithLionSdk com resposta whitespace-only tambem lanca o erro tipado', async () => {
    lionSettings();
    state.lionText = '   \n\t ';

    await expect(runCompaction(P_START, P_END, 'session-1')).rejects.toBeInstanceOf(
      EmptyProviderResponseError,
    );
  });

  it('AC-B13: provider de compactacao (subscription) vazio lanca EmptyProviderResponseError com COMPACT-EMPTY + userMessage acionavel', async () => {
    subscriptionSettings();
    state.withFallback.mockResolvedValue({ text: '', actualModelLabel: 'Claude Opus 4.7' });

    let caught: unknown;
    try {
      await runCompaction(P_START, P_END, 'session-1');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EmptyProviderResponseError);
    const typed = caught as EmptyProviderResponseError;
    expect(typed.code).toBe('COMPACT-EMPTY');
    expect(typed.userMessage).toBeTruthy();
    expect(typed.userMessage.length).toBeGreaterThan(0);
    expect(typed.suggestedAction).toBeTruthy();
    expect(typed.message).not.toContain('Unexpected end of JSON input');
    expect(typed.runtime).toBe('claude-sdk');
    expect(typed.provider).toBe('anthropic');
    expect(typed.model).toBe('claude-opus-4-7');
  });

  it('AC-B13: a classe EmptyProviderResponseError carrega COMPACT-EMPTY para o guard do path claude (anthropic-api)', () => {
    const err = new EmptyProviderResponseError('anthropic', 'claude-sonnet-4-6', 'anthropic-api');
    expect(err.code).toBe('COMPACT-EMPTY');
    expect(err.name).toBe('EmptyProviderResponseError');
    expect(err.userMessage).toBeTruthy();
    expect(err.suggestedAction).toBeTruthy();
    expect(err.provider).toBe('anthropic');
    expect(err.model).toBe('claude-sonnet-4-6');
    expect(err.runtime).toBe('anthropic-api');
  });

  it('caminho feliz intacto: resposta lion-sdk NAO vazia segue parseando normalmente (sem regressao)', async () => {
    lionSettings();
    state.lionText = JSON.stringify({
      executive_summary: 'Resumo',
      decisions: [],
      tasks_created: [],
      facts: [],
      semantic_chunks: [],
      user_profile_updates: [],
      working_memory_updates: { add: [], remove: [] },
    });

    await runCompaction(P_START, P_END, 'session-1');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
  runSubscriptionMock: vi.fn(),
  runDreamingGateMock: vi.fn(),
  saveDreamingReportMock: vi.fn(),
  insertChunkWithEmbeddingMock: vi.fn(),
  insertChunkPlainWithFTSMock: vi.fn(),
  executeVaultOperationMock: vi.fn(() => ({ success: true })),
  getSettingMock: vi.fn((_key: string): string | undefined => undefined),
  resolveOrchestratorSelectionMock: vi.fn(),
  dbRuns: [] as Array<{ sql: string; args: unknown[] }>,
  dbAlls: [] as Array<{ sql: string; args: unknown[] }>,
  dbMessages: [] as Array<Record<string, unknown>>,
  events: [] as string[],
  homeDir: '',
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('../db', () => ({
  getDb: vi.fn(() => ({
    prepare: (sql: string) => ({
      all: (...args: unknown[]) => {
        h.dbAlls.push({ sql, args });
        return h.dbMessages;
      },
      run: (...args: unknown[]) => {
        if (sql.includes('daily_summaries')) h.events.push('daily');
        h.dbRuns.push({ sql, args });
      },
      get: () => undefined,
    }),
  })),
  getSessionMessages: vi.fn(() => []),
  getSession: vi.fn(() => undefined),
  getSetting: (key: string) => h.getSettingMock(key),
  insertChunkWithEmbedding: (...args: unknown[]) => h.insertChunkWithEmbeddingMock(...(args as [])),
  insertChunkPlainWithFTS: (...args: unknown[]) => h.insertChunkPlainWithFTSMock(...(args as [])),
  searchBM25: vi.fn(() => []),
  searchVector: vi.fn(() => []),
  setLastGateRunAt: vi.fn(),
}));

vi.mock('../paths', async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const nodeFs = await import('node:fs');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'lionclaw-sa4-lightweight-test-'));
  h.homeDir = dir;
  return { getLionClawHome: () => dir };
});

vi.mock('../dreaming-gate', () => ({
  runDreamingGate: (...args: unknown[]) => {
    h.events.push('gate');
    return h.runDreamingGateMock(...(args as []));
  },
  saveDreamingReport: (...args: unknown[]) => h.saveDreamingReportMock(...(args as [])),
}));

vi.mock('../embedding-provider', () => ({ generateEmbedding: vi.fn(async () => null) }));

vi.mock('../mgraph-engine', () => ({
  executeVaultOperation: (...args: unknown[]) => h.executeVaultOperationMock(...(args as [])),
  regenerateVaultIndex: vi.fn(),
  updateVaultHot: vi.fn(),
  appendVaultLog: vi.fn(),
  getExistingVaultFilesList: vi.fn(() => ''),
}));

vi.mock('../orchestrator-selection', () => ({
  resolveOrchestratorSelection: (...args: unknown[]) => h.resolveOrchestratorSelectionMock(...(args as [])),
  resolveSubscriptionSelectionFor: vi.fn(),
  InvalidOrchestratorSelectionError: class extends Error {},
}));

vi.mock('../memory-pipeline/oneshot-subscription', () => ({
  runSubscriptionPromptWithFallback: (...args: unknown[]) => h.runSubscriptionMock(...(args as [])),
}));

vi.mock('../lion-sdk/adapters/lmstudio', () => ({ createLmStudioAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/ollama', () => ({ createOllamaAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/openai-compatible', () => ({ createOpenAiCompatibleAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/google-genai', () => ({ createGoogleGenAiAdapter: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = {
      create: (args: unknown) => h.anthropicCreateMock(args),
    };
    constructor(_opts: unknown) {}
  },
}));
vi.mock('../secrets-vault', () => ({
  getApiKey: vi.fn(async () => 'test-key'),
  getSecret: vi.fn(async () => null),
}));

import { summarizeLightweight } from '../memory-pipeline';
import { EmptyProviderResponseError } from '../agent-runtime/llm-error';

const VALID_SUMMARY = {
  executive_summary: 'resumo executivo do ciclo',
  decisions: [],
  tasks_created: [],
  facts: [],
  semantic_chunks: [{ topic: 'x', content: 'chunk que NAO pode ser embedado pela rota leve' }],
  user_profile_updates: [],
  working_memory_updates: { add: ['fato que NAO pode ir pro MEMORY.md pela rota leve'], remove: [] },
};

function isMapPrompt(prompt: string): boolean {
  return prompt.includes('sumarizador EXTRATIVO');
}

function subscriptionResponder() {
  return (...args: unknown[]) => {
    const prompt = args[1] as string;
    if (isMapPrompt(prompt)) {
      h.events.push('llm:map');
      return Promise.resolve({ text: 'RESUMO-DO-MAP', actualModelLabel: 'Claude Sonnet 4.6' });
    }
    h.events.push('llm:summarize');
    return Promise.resolve({ text: JSON.stringify(VALID_SUMMARY), actualModelLabel: 'Claude Sonnet 4.6' });
  };
}

function makeRow(id: number, role: string, content: string): Record<string, unknown> {
  return {
    id,
    session_id: 'sess-1',
    role,
    content,
    subagent: null,
    created_at: '2026-07-01 10:00:00',
    session_title: 'Conversa',
  };
}

function homeEntries(): string[] {
  if (!h.homeDir || !fs.existsSync(h.homeDir)) return [];
  return fs.readdirSync(h.homeDir);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.dbRuns.length = 0;
  h.dbAlls.length = 0;
  h.events.length = 0;
  h.dbMessages = [makeRow(1, 'user', 'primeira mensagem'), makeRow(2, 'assistant', 'primeira resposta')];
  h.getSettingMock.mockImplementation((key: string) => {
    if (key === 'orchestrator_runtime') return 'claude-sdk';
    if (key === 'orchestrator_provider') return 'anthropic';
    if (key === 'orchestrator_model') return 'claude-sonnet-4-6';
    return undefined;
  });
  h.resolveOrchestratorSelectionMock.mockResolvedValue({
    runtime: 'claude-sdk',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    source: 'settings',
  });
  h.runSubscriptionMock.mockImplementation(subscriptionResponder());
  h.runDreamingGateMock.mockResolvedValue({
    apply: { add: [], remove: [] },
    failSafeTriggered: false,
  });
  if (h.homeDir && fs.existsSync(h.homeDir)) {
    for (const entry of fs.readdirSync(h.homeDir)) {
      fs.rmSync(path.join(h.homeDir, entry), { recursive: true, force: true });
    }
  }
});

describe('AC-A8 — rota leve REAL (V2): so o summarize, nada do pipeline pesado', () => {
  it('AC-A8: roda EXATAMENTE 1 chamada LLM (o summarize) e retorna o executiveSummary', async () => {
    const result = await summarizeLightweight('sess-1');

    expect(result).toEqual({ executiveSummary: 'resumo executivo do ciclo', warnings: [] });
    expect(h.events.filter((e) => e.startsWith('llm:'))).toEqual(['llm:summarize']);
  });

  it('AC-A8: NAO chama runDreamingGate, insertChunkWithEmbedding, vault, daily nem archiveTranscript (spies zerados)', async () => {
    await summarizeLightweight('sess-1');

    expect(h.runDreamingGateMock).not.toHaveBeenCalled();
    expect(h.events).not.toContain('gate');
    expect(h.insertChunkWithEmbeddingMock).not.toHaveBeenCalled();
    expect(h.insertChunkPlainWithFTSMock).not.toHaveBeenCalled();
    expect(h.executeVaultOperationMock).not.toHaveBeenCalled();
    expect(h.events).not.toContain('daily');
    expect(h.dbRuns).toHaveLength(0);
    expect(homeEntries()).toEqual([]);
  });

  it('delta incremental: sinceMessageId entra no SQL (m.id > ?) e priorSummary vai pro prompt do summarize', async () => {
    await summarizeLightweight('sess-1', { sinceMessageId: 7, priorSummary: 'RESUMO-ANTERIOR-XYZ' });

    const deltaQuery = h.dbAlls.find((q) => q.sql.includes('m.id > ?'));
    expect(deltaQuery).toBeDefined();
    expect(deltaQuery!.args).toEqual(['sess-1', 7]);

    const summarizePrompt = h.runSubscriptionMock.mock.calls.map((c) => c[1] as string).find((p) => !isMapPrompt(p));
    expect(summarizePrompt).toBeDefined();
    expect(summarizePrompt).toContain('RESUMO-ANTERIOR-XYZ');
  });
});

describe('AC-A9b — delta vazio (V11)', () => {
  it('AC-A9b: sem mensagens no delta retorna undefined, ZERO chamadas LLM e ZERO escritas', async () => {
    h.dbMessages = [];

    const result = await summarizeLightweight('sess-1', { sinceMessageId: 99 });

    expect(result).toBeUndefined();
    expect(h.runSubscriptionMock).not.toHaveBeenCalled();
    expect(h.resolveOrchestratorSelectionMock).not.toHaveBeenCalled();
    expect(h.dbRuns).toHaveLength(0);
  });
});

describe('AC-A9 (backend) — falha do summarizer propaga (caller aborta sem re-seed)', () => {
  it('AC-A9: resposta vazia do provider lanca EmptyProviderResponseError (COMPACT-EMPTY), nao JSON cru', async () => {
    h.runSubscriptionMock.mockResolvedValue({ text: '', actualModelLabel: 'Claude Sonnet 4.6' });

    await expect(summarizeLightweight('sess-1')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(EmptyProviderResponseError);
      expect((err as EmptyProviderResponseError).code).toBe('COMPACT-EMPTY');
      return true;
    });
    expect(h.dbRuns).toHaveLength(0);
  });
});

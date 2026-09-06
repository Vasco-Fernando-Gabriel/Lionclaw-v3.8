
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
  runSubscriptionMock: vi.fn(),
  runDreamingGateMock: vi.fn(),
  saveDreamingReportMock: vi.fn(),
  setLastGateRunAtMock: vi.fn(),
  getSettingMock: vi.fn((_key: string): string | undefined => undefined),
  resolveOrchestratorSelectionMock: vi.fn(),
  dbRuns: [] as Array<{ sql: string; args: unknown[] }>,
  dbAlls: [] as Array<{ sql: string; args: unknown[] }>,
  dbMessages: [] as Array<Record<string, unknown>>,
  failDailyInsert: { value: false },
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
        if (h.failDailyInsert.value && sql.includes('daily_summaries')) {
          throw new Error('daily insert sabotado');
        }
        h.dbRuns.push({ sql, args });
      },
      get: () => undefined,
    }),
  })),
  getSessionMessages: vi.fn(() => []),
  getSession: vi.fn(() => undefined),
  getSetting: (key: string) => h.getSettingMock(key),
  insertChunkWithEmbedding: vi.fn(),
  insertChunkPlainWithFTS: vi.fn(),
  searchBM25: vi.fn(() => []),
  searchVector: vi.fn(() => []),
  setLastGateRunAt: h.setLastGateRunAtMock,
}));

vi.mock('../paths', async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const nodeFs = await import('node:fs');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'lionclaw-runcompaction-test-'));
  return { getLionClawHome: () => dir };
});

vi.mock('../dreaming-gate', () => ({
  runDreamingGate: (...args: unknown[]) => h.runDreamingGateMock(...(args as [])),
  saveDreamingReport: (...args: unknown[]) => h.saveDreamingReportMock(...(args as [])),
}));

vi.mock('../embedding-provider', () => ({ generateEmbedding: vi.fn(async () => null) }));

vi.mock('../mgraph-engine', () => ({
  executeVaultOperation: vi.fn(() => ({ success: true })),
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

import { runCompaction } from '../memory-pipeline';


const VALID_SUMMARY = {
  executive_summary: 'resumo executivo do ciclo',
  decisions: [],
  tasks_created: [],
  facts: [],
  semantic_chunks: [],
  user_profile_updates: [],
  working_memory_updates: { add: [], remove: [] },
};

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

function promptSentToSummarizer(callIndex = 0): string {
  const call = h.runSubscriptionMock.mock.calls[callIndex];
  expect(call, 'chamada ao summarizer deveria existir').toBeDefined();
  return call[1] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.dbRuns.length = 0;
  h.dbAlls.length = 0;
  h.failDailyInsert.value = false;
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
  h.runSubscriptionMock.mockResolvedValue({
    text: JSON.stringify(VALID_SUMMARY),
    actualModelLabel: 'Claude Sonnet 4.6',
  });
  h.runDreamingGateMock.mockResolvedValue({
    apply: { add: [], remove: [] },
    failSafeTriggered: false,
  });
  h.saveDreamingReportMock.mockResolvedValue(undefined);
});


describe('runCompaction estendido (SPEC 5.4 item 3)', () => {
  it('retorna { executiveSummary } (aditivo; callers antigos ignoram)', async () => {
    const result = await runCompaction(new Date(), new Date(), 'sess-1');
    expect(result).toEqual({ executiveSummary: 'resumo executivo do ciclo' });
  });

  it('sem mensagens retorna undefined (comportamento atual preservado)', async () => {
    h.dbMessages = [];
    const result = await runCompaction(new Date(), new Date(), 'sess-1');
    expect(result).toBeUndefined();
    expect(h.runSubscriptionMock).not.toHaveBeenCalled();
  });

  it('sinceMessageId: carrega APENAS o delta (SQL com m.id > ?)', async () => {
    await runCompaction(new Date(), new Date(), 'sess-1', { sinceMessageId: 5 });
    expect(h.dbAlls).toHaveLength(1);
    expect(h.dbAlls[0].sql).toContain('m.id > ?');
    expect(h.dbAlls[0].args).toEqual(['sess-1', 5]);
  });

  it('SEM sinceMessageId: carga integral da sessao (sem filtro de id)', async () => {
    await runCompaction(new Date(), new Date(), 'sess-1');
    expect(h.dbAlls).toHaveLength(1);
    expect(h.dbAlls[0].sql).not.toContain('m.id >');
    expect(h.dbAlls[0].args).toEqual(['sess-1']);
  });

  it('priorSummary: o prompt inclui o resumo anterior + instrucao de merge rolante', async () => {
    await runCompaction(new Date(), new Date(), 'sess-1', { priorSummary: 'RESUMO-ANTERIOR-XYZ' });
    const prompt = promptSentToSummarizer();
    expect(prompt).toContain('RESUMO ROLANTE ANTERIOR');
    expect(prompt).toContain('RESUMO-ANTERIOR-XYZ');
    expect(prompt).toContain('PREVALECE');
  });

  it('SEM priorSummary: o prompt NAO ganha o bloco de merge (retrocompat)', async () => {
    await runCompaction(new Date(), new Date(), 'sess-1');
    const prompt = promptSentToSummarizer();
    expect(prompt).not.toContain('RESUMO ROLANTE ANTERIOR');
  });
});


describe('skipDailySummary (SPEC 5.4 item 3 / AC-72)', () => {
  it('true: daily_summaries NAO e escrito; compaction_log continua', async () => {
    await runCompaction(new Date(), new Date(), 'sess-1', { skipDailySummary: true });
    expect(h.dbRuns.some(r => r.sql.includes('daily_summaries'))).toBe(false);
    expect(h.dbRuns.some(r => r.sql.includes('compaction_log'))).toBe(true);
  });

  it('ausente/false: daily_summaries e escrito (fluxo do desktop intacto)', async () => {
    await runCompaction(new Date(), new Date(), 'sess-1');
    const daily = h.dbRuns.filter(r => r.sql.includes('daily_summaries'));
    expect(daily).toHaveLength(1);
    expect(daily[0].args[1]).toBe('resumo executivo do ciclo');
  });
});


describe('guarda de resposta vazia do summarizer (SPEC 5.6 / AC-18)', () => {
  it('resposta whitespace lanca o erro TIPADO e aborta o ciclo (nada pos-summarize)', async () => {
    h.runSubscriptionMock.mockResolvedValue({ text: '   ', actualModelLabel: 'x' });
    await expect(
      runCompaction(new Date(), new Date(), 'sess-1'),
    ).rejects.toThrow('Resposta vazia do provider');
    expect(h.runDreamingGateMock).not.toHaveBeenCalled();
    expect(h.setLastGateRunAtMock).not.toHaveBeenCalled();
    expect(h.dbRuns).toHaveLength(0);
  });

  it('summarizeWithSubscription: resposta vazia lanca o MESMO erro tipado', async () => {
    h.runSubscriptionMock.mockResolvedValue({ text: '', actualModelLabel: 'x' });

    await expect(
      runCompaction(new Date(), new Date(), 'sess-1'),
    ).rejects.toThrow('Resposta vazia do provider');
    expect(h.runDreamingGateMock).not.toHaveBeenCalled();
  });
});


describe('taxonomia de falha: so load + summarize abortam (SPEC 5.4 item 4)', () => {
  it('dreaming gate lancando NAO aborta: o ciclo conclui com executiveSummary', async () => {
    h.runDreamingGateMock.mockRejectedValue(new Error('gate quebrou'));
    const result = await runCompaction(new Date(), new Date(), 'sess-1');
    expect(result).toEqual({ executiveSummary: 'resumo executivo do ciclo' });
    expect(h.dbRuns.some(r => r.sql.includes('daily_summaries'))).toBe(true);
    expect(h.dbRuns.some(r => r.sql.includes('compaction_log'))).toBe(true);
  });

  it('saveDreamingReport lancando NAO aborta', async () => {
    h.saveDreamingReportMock.mockRejectedValue(new Error('report quebrou'));
    const result = await runCompaction(new Date(), new Date(), 'sess-1');
    expect(result).toEqual({ executiveSummary: 'resumo executivo do ciclo' });
  });

  it('escrita do daily_summaries lancando NAO aborta (compaction_log e archive seguem)', async () => {
    h.failDailyInsert.value = true;
    const result = await runCompaction(new Date(), new Date(), 'sess-1');
    expect(result).toEqual({ executiveSummary: 'resumo executivo do ciclo' });
    expect(h.dbRuns.some(r => r.sql.includes('compaction_log'))).toBe(true);
  });

  it('falha do summarizer (nao-vazia: erro de rede) ABORTA o ciclo inteiro', async () => {
    h.runSubscriptionMock.mockRejectedValue(new Error('rede caiu'));
    await expect(runCompaction(new Date(), new Date(), 'sess-1')).rejects.toThrow('rede caiu');
    expect(h.runDreamingGateMock).not.toHaveBeenCalled();
    expect(h.dbRuns).toHaveLength(0);
  });
});

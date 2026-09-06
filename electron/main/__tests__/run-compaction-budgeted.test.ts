
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  events: [] as string[],
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: h.logInfo,
    warn: h.logWarn,
    error: h.logError,
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
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'lionclaw-budgeted-test-'));
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

function isMapPrompt(prompt: string): boolean {
  return prompt.includes('sumarizador EXTRATIVO');
}

function subscriptionResponder(mapResponse = 'RESUMO-DO-MAP') {
  return (...args: unknown[]) => {
    const prompt = args[1] as string;
    if (isMapPrompt(prompt)) {
      h.events.push('llm:map');
      return Promise.resolve({ text: mapResponse, actualModelLabel: 'Claude Sonnet 4.6' });
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

function promptsSent(): string[] {
  return h.runSubscriptionMock.mock.calls.map((c) => c[1] as string);
}

function summarizePrompt(): string {
  const p = promptsSent().find((x) => !isMapPrompt(x));
  expect(p, 'prompt de summarize deveria existir').toBeDefined();
  return p!;
}

const GIANT = 'INICIO-UNICO-ABC ' + 'g'.repeat(40000) + ' FIM-UNICO-XYZ';

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
    return undefined; // compaction provider/model vazios -> Auto
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
  h.saveDreamingReportMock.mockResolvedValue(undefined);
});


describe('ordem canonica 11.1 (AC-41)', () => {
  it('maps do builder -> summarize -> gate (lock) -> daily (pos-lock); nenhum map dentro do lock', async () => {
    h.dbMessages = [makeRow(1, 'user', GIANT), makeRow(2, 'assistant', 'resposta final')];
    await runCompaction(new Date(), new Date(), 'sess-1');

    const iMap = h.events.indexOf('llm:map');
    const iSummarize = h.events.indexOf('llm:summarize');
    const iGate = h.events.indexOf('gate');
    const iDaily = h.events.indexOf('daily');
    expect(iMap).toBeGreaterThanOrEqual(0);
    expect(iSummarize).toBeGreaterThan(iMap);
    expect(iGate).toBeGreaterThan(iSummarize);
    expect(iDaily).toBeGreaterThan(iGate);
    expect(h.events.slice(iGate)).not.toContain('llm:map');
  });

  it('conversationExcerpt do gate e a CAUDA do messageText orcado (11.4)', async () => {
    h.runSubscriptionMock.mockImplementation(subscriptionResponder('MAPRES ' + 'S'.repeat(9000)));
    h.dbMessages = [makeRow(1, 'user', GIANT), makeRow(2, 'assistant', 'FINAL-DA-CONVERSA-XYZ')];
    await runCompaction(new Date(), new Date(), 'sess-1');

    const gateInput = h.runDreamingGateMock.mock.calls[0][0] as { conversationExcerpt: string };
    expect(gateInput.conversationExcerpt.length).toBeLessThanOrEqual(8000);
    expect(gateInput.conversationExcerpt).toContain('FINAL-DA-CONVERSA-XYZ'); // cauda
    expect(gateInput.conversationExcerpt).not.toContain('MAPRES'); // inicio ficou fora
  });
});


describe('selection resolvida 1x (AC-35)', () => {
  it('mesmo com maps de gigante, orchestrator_compaction_provider e lido exatamente 1x', async () => {
    h.dbMessages = [makeRow(1, 'user', GIANT)];
    await runCompaction(new Date(), new Date(), 'sess-1');
    const reads = h.getSettingMock.mock.calls.filter(
      (c) => c[0] === 'orchestrator_compaction_provider',
    );
    expect(reads).toHaveLength(1);
    expect(h.events).toContain('llm:map');
    expect(h.events).toContain('llm:summarize');
  });
});


describe('tres callers passam pelo builder (AC-42)', () => {
  async function assertBuilderPath(): Promise<void> {
    const prompt = summarizePrompt();
    expect(prompt).toContain('[resumo automatico de mensagem longa');
    expect(prompt).toContain('RESUMO-DO-MAP');
    expect(prompt).not.toContain('g'.repeat(30000)); // gigante cru nao vaza
  }

  it('desktop: sessao INTEGRAL (sessionId sem sinceMessageId)', async () => {
    h.dbMessages = [makeRow(1, 'user', GIANT), makeRow(2, 'assistant', 'ok')];
    await runCompaction(new Date(), new Date(), 'sess-1');
    expect(h.dbAlls[0].sql).not.toContain('m.id >');
    await assertBuilderPath();
  });

  it('telegram: DELTA (sessionId + sinceMessageId)', async () => {
    h.dbMessages = [makeRow(7, 'user', GIANT), makeRow(8, 'assistant', 'ok')];
    await runCompaction(new Date(), new Date(), 'sess-1', { sinceMessageId: 6, skipDailySummary: true });
    expect(h.dbAlls[0].sql).toContain('m.id > ?');
    await assertBuilderPath();
  });

  it('date-range (ipc/system.ts): SEM sessionId', async () => {
    h.dbMessages = [makeRow(1, 'user', GIANT), makeRow(2, 'assistant', 'ok')];
    await runCompaction(new Date('2026-06-01'), new Date('2026-06-02'));
    expect(h.dbAlls[0].sql).toContain('m.created_at >= ?');
    await assertBuilderPath();
  });
});


describe('tudo-cabe via runCompaction (AC-34)', () => {
  it('mensagens pequenas entram byte-identicas ([role] content \\n\\n), zero maps', async () => {
    await runCompaction(new Date(), new Date(), 'sess-1');
    expect(h.events.filter((e) => e === 'llm:map')).toHaveLength(0);
    const prompt = summarizePrompt();
    expect(prompt).toContain('[user] primeira mensagem\n\n[assistant] primeira resposta');
  });
});


describe('orcamento: piso, priorSummary patologico e teto do resumo rolante (AC-40)', () => {
  it('priorSummary patologico e pre-comprimido por map dedicado antes do desconto', async () => {
    h.runSubscriptionMock.mockImplementation((...args: unknown[]) => {
      const prompt = args[1] as string;
      if (isMapPrompt(prompt)) {
        h.events.push('llm:map');
        return Promise.resolve({ text: 'PRIOR-COMPRIMIDO', actualModelLabel: 'Claude Sonnet 4.6' });
      }
      h.events.push('llm:summarize');
      return Promise.resolve({ text: JSON.stringify(VALID_SUMMARY), actualModelLabel: 'Claude Sonnet 4.6' });
    });
    const pathologicalPrior = 'P'.repeat(250000); // ~62.5k tok >> budget 48k
    await runCompaction(new Date(), new Date(), 'sess-1', { priorSummary: pathologicalPrior });

    const mapPrompt = promptsSent().find(isMapPrompt);
    expect(mapPrompt).toBeDefined();
    expect(mapPrompt).toContain('~1500 tokens');
    expect(mapPrompt).toContain('PPPP');

    const prompt = summarizePrompt();
    expect(prompt).toContain('RESUMO ROLANTE ANTERIOR');
    expect(prompt).toContain('PRIOR-COMPRIMIDO');
    expect(prompt).not.toContain('P'.repeat(2000));
  });

  it('prompt de reduce instrui executive_summary <= ~1500 tokens (11.7)', async () => {
    await runCompaction(new Date(), new Date(), 'sess-1');
    const prompt = summarizePrompt();
    expect(prompt).toContain('executive_summary: no maximo ~1500 tokens');
  });

  it('priorSummary normal NAO dispara pre-compressao (retrocompat)', async () => {
    await runCompaction(new Date(), new Date(), 'sess-1', { priorSummary: 'resumo anterior curto' });
    expect(h.events.filter((e) => e === 'llm:map')).toHaveLength(0);
    expect(summarizePrompt()).toContain('resumo anterior curto');
  });
});


describe('instrumentacao por ciclo (AC-43)', () => {
  it('emite logger.info "compaction input budget" com todos os campos de 11.8', async () => {
    h.dbMessages = [makeRow(1, 'user', GIANT), makeRow(2, 'assistant', 'ok')];
    await runCompaction(new Date(), new Date(), 'sess-1');
    const call = h.logInfo.mock.calls.find((c) => c[1] === 'compaction input budget');
    expect(call).toBeDefined();
    const fields = call![0] as Record<string, unknown>;
    for (const key of [
      'sessionId',
      'deltaMessages',
      'rawChars',
      'rawTokensEst',
      'budget',
      'verbatimCount',
      'presummarizedCount',
      'mapCalls',
      'mapInputTokensEst',
      'finalInputTokensEst',
      'deterministicFallbacks',
      'durationMs',
    ]) {
      expect(fields, `campo ${key} ausente`).toHaveProperty(key);
    }
    expect(fields['sessionId']).toBe('sess-1');
    expect(fields['deltaMessages']).toBe(2);
    expect(fields['budget']).toBe(48000);
    expect(fields['mapCalls']).toBeGreaterThanOrEqual(1);
  });
});


describe('builder sabotado (AC-39, nivel 3)', () => {
  it('conteudo nao-string derruba o builder -> assembly legado -> ciclo conclui', async () => {
    h.dbMessages = [
      makeRow(1, 'user', null as unknown as string),
      makeRow(2, 'assistant', 'mensagem valida'),
    ];
    const result = await runCompaction(new Date(), new Date(), 'sess-1');
    expect(result).toEqual({ executiveSummary: 'resumo executivo do ciclo' });
    expect(summarizePrompt()).toContain('[assistant] mensagem valida');
    expect(
      h.logError.mock.calls.some((c) => String(c[1]).includes('assembly legado')),
    ).toBe(true);
  });
});


describe('remocao do truncamento mecanico (AC-33)', () => {
  it('memory-pipeline.ts nao contem substring(0, 2000) nem substring(0, 50000)', () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL('../memory-pipeline.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).not.toContain('.substring(0, 2000)');
    expect(src).not.toContain('.substring(0, 50000)');
  });

  it('o padrao 2000/50000 sobrevive APENAS no assembly legado nomeado do builder', () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL('../memory-pipeline/budgeted-input.ts', import.meta.url)),
      'utf-8',
    );
    expect(src.match(/\.substring\(0, 2000\)/g) ?? []).toHaveLength(1);
    expect(src.match(/\.substring\(0, 50000\)/g) ?? []).toHaveLength(1);
    const legacyFn = src.slice(src.indexOf('function legacyCompactionAssembly'));
    expect(legacyFn).toContain('.substring(0, 2000)');
    expect(legacyFn).toContain('.substring(0, 50000)');
  });
});

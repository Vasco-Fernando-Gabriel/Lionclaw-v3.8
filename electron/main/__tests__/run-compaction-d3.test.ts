import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runSubscriptionMock: vi.fn(),
  runDreamingGateMock: vi.fn(),
  saveDreamingReportMock: vi.fn(),
  generateEmbeddingMock: vi.fn(),
  insertChunkWithEmbeddingMock: vi.fn(),
  executeVaultOperationMock: vi.fn((): { success: boolean; error?: string } => ({ success: true })),
  getSettingMock: vi.fn((_key: string): string | undefined => undefined),
  resolveOrchestratorSelectionMock: vi.fn(),
  dbRuns: [] as Array<{ sql: string; args: unknown[] }>,
  dbMessages: [] as Array<Record<string, unknown>>,
  mutexHeldInsideGate: null as boolean | null,
}));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
}));

vi.mock('../db', () => ({
  getDb: vi.fn(() => ({
    prepare: (sql: string) => ({
      all: () => h.dbMessages,
      run: (...args: unknown[]) => {
        h.dbRuns.push({ sql, args });
      },
      get: () => undefined,
    }),
  })),
  getSessionMessages: vi.fn(() => []),
  getSession: vi.fn(() => undefined),
  getSetting: (key: string) => h.getSettingMock(key),
  insertChunkWithEmbedding: (...args: unknown[]) => h.insertChunkWithEmbeddingMock(...(args as [])),
  searchBM25: vi.fn(() => []),
  searchVector: vi.fn(() => []),
  setLastGateRunAt: vi.fn(),
}));

vi.mock('../paths', async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const nodeFs = await import('node:fs');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'lionclaw-runcompaction-d3-'));
  return { getLionClawHome: () => dir };
});

vi.mock('../dreaming-gate', () => ({
  runDreamingGate: (...args: unknown[]) => h.runDreamingGateMock(...(args as [])),
  saveDreamingReport: (...args: unknown[]) => h.saveDreamingReportMock(...(args as [])),
}));

vi.mock('../embedding-provider', () => ({
  generateEmbedding: (...args: unknown[]) => h.generateEmbeddingMock(...(args as [])),
}));

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
vi.mock('../secrets-vault', () => ({
  getApiKey: vi.fn(async () => 'test-key'),
  getSecret: vi.fn(async () => null),
}));

import fs from 'node:fs';
import path from 'node:path';
import { runCompaction, EMBEDDINGS_PROVIDER_MISSING_WARNING } from '../memory-pipeline';
import { getLionClawHome } from '../paths';
import { isDreamingMutexHeld, resetDreamingMutexForTests, tryAcquireDreamingMutex } from '../dreaming-mutex';

const SUMMARY = {
  executive_summary: 'resumo executivo',
  decisions: [],
  tasks_created: [],
  facts: [],
  semantic_chunks: [
    { topic: 't1', content: 'chunk um' },
    { topic: 't2', content: 'chunk dois' },
    { topic: 't3', content: 'chunk tres' },
  ],
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
    created_at: '2026-09-08 10:00:00',
    session_title: 'C',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDreamingMutexForTests();
  h.dbRuns.length = 0;
  h.mutexHeldInsideGate = null;
  h.dbMessages = [makeRow(1, 'user', 'oi'), makeRow(2, 'assistant', 'ola')];
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
  h.runSubscriptionMock.mockResolvedValue({ text: JSON.stringify(SUMMARY), actualModelLabel: 'x' });
  h.runDreamingGateMock.mockImplementation(async () => {
    h.mutexHeldInsideGate = isDreamingMutexHeld();
    return { apply: { add: [], remove: [] }, failSafeTriggered: false };
  });
  h.saveDreamingReportMock.mockResolvedValue(undefined);
  h.generateEmbeddingMock.mockResolvedValue({
    ok: true,
    embedding: [0.1, 0.2],
    provider: 'openai',
    model: 'm',
    dimensions: 2,
  });
});

describe('AC-7 / D3: falhas por passo', () => {
  it('passo 1: sumarizador falha = COMPACT-SUMMARY-FAILED com a mensagem do provedor; nada posterior roda', async () => {
    h.runSubscriptionMock.mockRejectedValue(new Error('provider 529 overloaded'));
    await expect(runCompaction(new Date(), new Date(), 'sess-1')).rejects.toMatchObject({
      name: 'CompactionStepError',
      code: 'COMPACT-SUMMARY-FAILED',
      message: expect.stringContaining('provider 529 overloaded'),
    });
    expect(h.runDreamingGateMock).not.toHaveBeenCalled();
    expect(h.insertChunkWithEmbeddingMock).not.toHaveBeenCalled();
    expect(isDreamingMutexHeld()).toBe(false);
  });

  it('passo 1: selecao de compactacao indisponivel tambem e COMPACT-SUMMARY-FAILED', async () => {
    h.getSettingMock.mockImplementation(() => undefined);
    h.resolveOrchestratorSelectionMock.mockRejectedValue(new Error('orquestrador nao configurado'));
    await expect(runCompaction(new Date(), new Date(), 'sess-1')).rejects.toMatchObject({
      code: 'COMPACT-SUMMARY-FAILED',
    });
  });

  it('passo 2: gate falha = COMPACT-MEMORY-FAILED; embeddings, graph, log e transcript nao rodam', async () => {
    h.runDreamingGateMock.mockRejectedValue(new Error('gate llm_error'));
    await expect(runCompaction(new Date(), new Date(), 'sess-1')).rejects.toMatchObject({
      code: 'COMPACT-MEMORY-FAILED',
      message: expect.stringContaining('gate llm_error'),
    });
    expect(h.generateEmbeddingMock).not.toHaveBeenCalled();
    expect(h.insertChunkWithEmbeddingMock).not.toHaveBeenCalled();
    expect(h.dbRuns.some((r) => r.sql.includes('compaction_log'))).toBe(false);
    expect(fs.existsSync(path.join(getLionClawHome(), 'conversations'))).toBe(false);
    expect(isDreamingMutexHeld()).toBe(false);
  });

  it('passo 3: embedding falha num chunk = chunk NAO gravado (nenhuma linha sem vetor), Clear segue, warning com a contagem', async () => {
    h.generateEmbeddingMock
      .mockResolvedValueOnce({ ok: true, embedding: [1], provider: 'openai', model: 'm', dimensions: 1 })
      .mockResolvedValueOnce({ ok: false, code: 'EMBED-FAIL', reason: 'HTTP 500', provider: 'openai', status: 500 })
      .mockRejectedValueOnce(new Error('ECONNRESET'));

    const result = await runCompaction(new Date(), new Date(), 'sess-1');

    expect(h.insertChunkWithEmbeddingMock).toHaveBeenCalledTimes(1);
    expect(h.insertChunkWithEmbeddingMock).toHaveBeenCalledWith('chunk um', 't1', [1]);
    expect(h.dbRuns.some((r) => r.sql.includes('semantic_memories'))).toBe(false);
    expect(result).toEqual({
      executiveSummary: 'resumo executivo',
      warnings: [{ step: 'embeddings', detail: '2 de 3 chunks nao gravados por falha de embedding: ECONNRESET' }],
    });
    expect(h.dbRuns.some((r) => r.sql.includes('compaction_log'))).toBe(true);
  });

  it('provedor de embeddings ausente = nenhum chunk gravado, uma unica tentativa e aviso unico', async () => {
    h.generateEmbeddingMock.mockResolvedValue({
      ok: false,
      code: 'EMBED-FAIL',
      reason: 'Nenhum provider de embeddings configurado (OpenAI/Ollama)',
      provider: 'none',
    });

    const result = await runCompaction(new Date(), new Date(), 'sess-1');

    expect(h.generateEmbeddingMock).toHaveBeenCalledTimes(1);
    expect(h.insertChunkWithEmbeddingMock).not.toHaveBeenCalled();
    expect(result?.warnings).toEqual([
      { step: 'embeddings', detail: `${EMBEDDINGS_PROVIDER_MISSING_WARNING} (3 de 3 chunks nao gravados)` },
    ]);
  });

  it('passo 4: graph falha = segue e avisa', async () => {
    h.getSettingMock.mockImplementation((key: string) => {
      if (key === 'mgraph_mode') return 'true';
      if (key === 'orchestrator_runtime') return 'claude-sdk';
      if (key === 'orchestrator_provider') return 'anthropic';
      if (key === 'orchestrator_model') return 'claude-sonnet-4-6';
      return undefined;
    });
    h.runSubscriptionMock.mockResolvedValue({
      text: JSON.stringify({
        ...SUMMARY,
        semantic_chunks: [],
        vault_operations: [
          { action: 'create', path: 'entities/a.md', type: 'entity', title: 'A', tags: [], content: 'x' },
          { action: 'create', path: 'entities/b.md', type: 'entity', title: 'B', tags: [], content: 'y' },
        ],
      }),
      actualModelLabel: 'x',
    });
    h.executeVaultOperationMock
      .mockReturnValueOnce({ success: true })
      .mockReturnValueOnce({ success: false, error: 'path invalido' });

    const result = await runCompaction(new Date(), new Date(), 'sess-1');

    expect(result?.warnings).toEqual([{ step: 'graph', detail: '1 de 2 operacoes do graph falharam: path invalido' }]);
    expect(h.dbRuns.some((r) => r.sql.includes('compaction_log'))).toBe(true);
  });

  it('passo 5: transcriptName nomeia o arquivo e a falha do transcript vira warning', async () => {
    const result = await runCompaction(new Date('2026-09-08T12:00:00Z'), new Date(), 'sess-1', {
      skipDailySummary: true,
      transcriptName: '2026-09-08-sess-1',
    });
    expect(result?.warnings).toEqual([]);
    const file = path.join(getLionClawHome(), 'conversations', '2026-09-08-sess-1.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(h.dbRuns.some((r) => r.sql.includes('daily_summaries'))).toBe(false);

    fs.rmSync(path.join(getLionClawHome(), 'conversations'), { recursive: true, force: true });
    fs.writeFileSync(path.join(getLionClawHome(), 'conversations'), 'arquivo no lugar do diretorio');
    const failed = await runCompaction(new Date('2026-09-08T12:00:00Z'), new Date(), 'sess-1', {
      skipDailySummary: true,
      transcriptName: '2026-09-08-sess-1',
    });
    expect(failed?.warnings).toEqual([{ step: 'transcript', detail: expect.any(String) }]);
    fs.rmSync(path.join(getLionClawHome(), 'conversations'), { force: true });
  });

  it('delta vazio continua devolvendo undefined (Telegram depende disso)', async () => {
    h.dbMessages = [];
    await expect(runCompaction(new Date(), new Date(), 'sess-1')).resolves.toBeUndefined();
    expect(h.runSubscriptionMock).not.toHaveBeenCalled();
  });
});

describe('D6/RM10: ordem de locks (mutex do dreaming FORA do gate de memoria)', () => {
  it('runCompaction pega o mutex antes do gate e libera no fim; dreamingMutex held nao re-adquire', async () => {
    await runCompaction(new Date(), new Date(), 'sess-1');
    expect(h.mutexHeldInsideGate).toBe(true);
    expect(isDreamingMutexHeld()).toBe(false);

    const release = tryAcquireDreamingMutex();
    expect(release).not.toBeNull();
    const held = await runCompaction(new Date(), new Date(), 'sess-1', { dreamingMutex: 'held' });
    expect(held?.executiveSummary).toBe('resumo executivo');
    expect(isDreamingMutexHeld()).toBe(true);
    release!();
    expect(isDreamingMutexHeld()).toBe(false);
  });

  it('runCompaction espera (FIFO) enquanto outro dreaming segura o mutex', async () => {
    const release = tryAcquireDreamingMutex();
    let done = false;
    const pending = runCompaction(new Date(), new Date(), 'sess-1').then((r) => {
      done = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    expect(h.runSubscriptionMock).not.toHaveBeenCalled();
    release!();
    await expect(pending).resolves.toMatchObject({ executiveSummary: 'resumo executivo' });
  });
});

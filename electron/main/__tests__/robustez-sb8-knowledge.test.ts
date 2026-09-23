import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { settings, fakeDb, ipcHandlers, tmpHome, runStructuredMemoryLlmMock } = vi.hoisted(() => {
  const settings = new Map<string, string>();
  const sessionsRows = [{ id: 's1', title: 'Sessao', created_at: '2026-01-01T00:00:00Z' }];
  const messagesRows = [
    { role: 'user', content: 'ola' },
    { role: 'assistant', content: 'oi' },
  ];
  const fakeDb = {
    prepare: (sql: string) => ({
      get: (..._args: unknown[]) => (sql.includes('daily_summaries') ? { cnt: 0 } : undefined),
      all: (..._args: unknown[]) => {
        if (sql.includes('FROM sessions')) return sessionsRows;
        if (sql.includes('FROM messages')) return messagesRows;
        return [];
      },
      run: (..._args: unknown[]) => ({ changes: 1 }),
    }),
    transaction:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  };
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const tmpBase = process.env['TMPDIR'] || '/tmp';
  const tmpHome = `${tmpBase.replace(/\/$/, '')}/lionclaw-sb8-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const runStructuredMemoryLlmMock = vi.fn(async () => '');
  return { settings, fakeDb, ipcHandlers, tmpHome, runStructuredMemoryLlmMock };
});

vi.mock('../db', () => ({
  getDb: () => fakeDb,
  getSetting: (key: string) => settings.get(key),
  setSetting: (key: string, value: string) => settings.set(key, value),
  getKnowledgeSource: vi.fn(() => undefined),
  insertKnowledgeSource: vi.fn(),
  insertKnowledgeChunk: vi.fn(),
  insertKnowledgeChunkVec: vi.fn(),
  insertKnowledgeChunkFts: vi.fn(),
  getKnowledgeAgentConfig: vi.fn(() => undefined),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async (key: string) => (key === 'OPENAI_API_KEY' ? 'sk-test' : null)),
}));

vi.mock('../paths', () => ({
  getLionClawHome: () => tmpHome,
}));

vi.mock('../memory-pipeline', () => ({
  runStructuredMemoryLlm: runStructuredMemoryLlmMock,
  CompactionProviderUnavailableError: class CompactionProviderUnavailableError extends Error {},
}));

vi.mock('../ollama-client', () => ({
  ollamaChat: vi.fn(async () => ''),
}));

vi.mock('../graph-ingest', () => ({
  ingestFile: vi.fn(),
  ingestUrl: vi.fn(),
  ingestText: vi.fn(),
  resumeIngestJob: vi.fn(),
  cancelIngest: vi.fn(),
  discardPartialJob: vi.fn(),
  acceptPartialJob: vi.fn(),
  getIngestHistory: vi.fn(() => []),
  estimateIngestFile: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    },
  },
  BrowserWindow: class BrowserWindow {},
}));

import { generateEmbedding } from '../embedding-provider';
import { hybridKnowledgeSearch } from '../knowledge-engine';
import { registerMgraphHandlers } from '../ipc/mgraph';
import type { IpcContext } from '../ipc/context';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fs.mkdirSync(tmpHome, { recursive: true });
  settings.clear();
  settings.set('mgraph_mode', 'true');
  runStructuredMemoryLlmMock.mockReset();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SB-8 — generateEmbedding retorna união discriminada (AC-B19)', () => {
  it('AC-B19: 401 do provider vira {ok:false, provider:openai, status:401} (nao null mudo)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: { message: 'invalid api key' } })),
    );

    const result = await generateEmbedding('texto');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('EMBED-FAIL');
      expect(result.provider).toBe('openai');
      expect(result.status).toBe(401);
      expect(result.reason).toContain('401');
    }
  });

  it('AC-B19: quota (429) do provider vira falha discriminada com status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(429, { error: { message: 'quota exceeded' } })),
    );

    const result = await generateEmbedding('texto');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.provider).toBe('openai');
    }
  });

  it('AC-B19: nenhum provider configurado -> provider "none" (distinguivel de falha real)', async () => {
    const { getSecret } = await import('../secrets-vault');
    vi.mocked(getSecret).mockResolvedValueOnce(null);

    const result = await generateEmbedding('texto');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.provider).toBe('none');
      expect(result.reason).toContain('Nenhum provider');
    }
  });

  it('AC-B19: sucesso continua retornando embedding normalizado ({ok:true})', async () => {
    const embedding = new Array(1536).fill(0.5);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { data: [{ embedding }] })),
    );

    const result = await generateEmbedding('texto');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('openai');
      expect(result.embedding).toHaveLength(1536);
      expect(result.dimensions).toBe(1536);
    }
  });
});

describe('SB-8 — busca degradada em hybridKnowledgeSearch (AC-B19)', () => {
  it('AC-B19: provider de embeddings 401 faz a busca reportar degraded:true (nao "nada encontrado")', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: { message: 'invalid api key' } })),
    );

    const result = await hybridKnowledgeSearch('agent-1', 'qual o status?');
    expect(result.found).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBeTruthy();
    expect(result.degradedReason).toContain('401');
    expect(result.strategy).toBe('not_found');
    expect(result.results).toEqual([]);
  });

  it('AC-B19: falha interna da busca tambem reporta degraded:true (catch)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('rede caiu');
      }),
    );

    const result = await hybridKnowledgeSearch('agent-1', 'pergunta');
    expect(result.found).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBeTruthy();
  });
});

describe('SB-8 — mgraph:seed honesto (AC-B20)', () => {
  function registerAndGetSeedHandler(): (...args: unknown[]) => unknown {
    ipcHandlers.clear();
    const ctx = { getMainWindow: () => null } as unknown as IpcContext;
    registerMgraphHandlers(ctx);
    const handler = ipcHandlers.get('mgraph:seed');
    expect(handler).toBeDefined();
    return handler as (...args: unknown[]) => unknown;
  }

  it('AC-B20: LLM do seed vazio -> mgraph:seed retorna {error} (nao falso sucesso)', async () => {
    runStructuredMemoryLlmMock.mockResolvedValue('');
    const handler = registerAndGetSeedHandler();

    const result = (await handler({}, false)) as { error?: string };
    expect(result).toBeDefined();
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('falharam');
  });

  it('AC-B20: seed com LLM valido retorna {notes, connections} (nao void)', async () => {
    runStructuredMemoryLlmMock.mockResolvedValue('[]');
    const handler = registerAndGetSeedHandler();

    const result = (await handler({}, false)) as {
      notes?: number;
      connections?: number;
      error?: string;
    };
    expect(result.error).toBeUndefined();
    expect(result.notes).toBe(0);
    expect(typeof result.connections).toBe('number');
  });

  it('AC-B20: resposta vazia do LLM nao vira "Unexpected end of JSON input" cru', async () => {
    runStructuredMemoryLlmMock.mockResolvedValue('   ');
    const handler = registerAndGetSeedHandler();

    const result = (await handler({}, false)) as { error?: string };
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain('Unexpected end of JSON input');
    expect(result.error).toContain('resposta vazia');
  });
});

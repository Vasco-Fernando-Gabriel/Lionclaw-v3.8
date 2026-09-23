import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../db', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ all: vi.fn(() => []), run: vi.fn(), get: vi.fn() })),
  })),
  getSessionMessages: vi.fn(() => []),
  getSession: vi.fn(() => null),
  getSetting: vi.fn(() => null),
  insertChunkWithEmbedding: vi.fn(),
  insertChunkPlainWithFTS: vi.fn(),
  searchBM25: vi.fn(() => []),
  searchVector: vi.fn(() => []),
  setLastGateRunAt: vi.fn(),
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
  getLionClawHome: vi.fn(() => '/tmp/lionclaw-test'),
}));

vi.mock('../embedding-provider', () => ({
  generateEmbedding: vi.fn(async () => null),
}));

vi.mock('../ollama-client', () => ({
  ollamaChat: vi.fn(async () => ''),
}));

vi.mock('../mgraph-engine', () => ({
  executeVaultOperation: vi.fn(() => ({ success: false })),
  regenerateVaultIndex: vi.fn(),
  updateVaultHot: vi.fn(),
  appendVaultLog: vi.fn(),
  getExistingVaultFilesList: vi.fn(() => []),
}));

vi.mock('../lion-sdk/adapters/lmstudio', () => ({
  createLmStudioAdapter: vi.fn(),
}));

vi.mock('../lion-sdk/adapters/ollama', () => ({
  createOllamaAdapter: vi.fn(),
}));

vi.mock('../lion-sdk/adapters/openai-compatible', () => ({
  createOpenAiCompatibleAdapter: vi.fn(),
}));

vi.mock('../lion-sdk/adapters/google-genai', () => ({
  createGoogleGenAiAdapter: vi.fn(),
}));

vi.mock('../dreaming-gate', () => ({
  runDreamingGate: vi.fn(async () => ({
    apply: { add: [], remove: [] },
    quarantine: [],
    report: '',
    failSafeTriggered: false,
  })),
  saveDreamingReport: vi.fn(async () => '/tmp/report.md'),
}));

import { withMemoryGateLock, tryWithMemoryGateLock } from '../memory-pipeline';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('tryWithMemoryGateLock', () => {
  it('(a) executa fn e retorna resultado quando lock esta livre', async () => {
    const result = await tryWithMemoryGateLock(async () => 'valor-retornado');
    expect(result).toBe('valor-retornado');
  });

  it('(a) fn e chamada exatamente uma vez quando lock esta livre', async () => {
    const fn = vi.fn(async () => 42);
    await tryWithMemoryGateLock(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('(a) funciona com retorno number', async () => {
    const result = await tryWithMemoryGateLock(async () => 99);
    expect(result).toBe(99);
  });

  it('(b) retorna null imediatamente quando withMemoryGateLock esta ativo', async () => {
    const HOLD_MS = 100;

    const holder = withMemoryGateLock(() => delay(HOLD_MS));

    await delay(10);

    const fn = vi.fn(async () => 'nunca-deve-rodar');
    const result = await tryWithMemoryGateLock(fn);

    expect(result).toBeNull();
    expect(fn).not.toHaveBeenCalled();

    await holder;
  });

  it('(b same-tick) duas chamadas no MESMO tick: 1a roda, 2a retorna null sem enfileirar', async () => {
    const fn1 = vi.fn(async () => {
      await delay(50);
      return 'um';
    });
    const fn2 = vi.fn(async () => 'dois');

    const p1 = tryWithMemoryGateLock(fn1);
    const p2 = tryWithMemoryGateLock(fn2);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe('um');
    expect(r2).toBeNull();
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).not.toHaveBeenCalled();
  });

  it('(b) retorna null imediatamente quando tryWithMemoryGateLock esta ativo em outro caller', async () => {
    const HOLD_MS = 100;

    const holder = tryWithMemoryGateLock(() => delay(HOLD_MS));

    await delay(10);

    const fn = vi.fn(async () => 'nunca-deve-rodar');
    const result = await tryWithMemoryGateLock(fn);

    expect(result).toBeNull();
    expect(fn).not.toHaveBeenCalled();

    await holder;
  });

  it('(c) proximo tryWithMemoryGateLock adquire apos o anterior terminar', async () => {
    const result1 = await tryWithMemoryGateLock(async () => 'primeira');
    expect(result1).toBe('primeira');

    const result2 = await tryWithMemoryGateLock(async () => 'segunda');
    expect(result2).toBe('segunda');
  });

  it('(c) adquire novamente apos withMemoryGateLock terminar', async () => {
    await withMemoryGateLock(async () => delay(20));

    const fn = vi.fn(async () => 'ok');
    const result = await tryWithMemoryGateLock(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('(d) propaga o erro lancado por fn', async () => {
    await expect(
      tryWithMemoryGateLock(async () => {
        throw new Error('erro-de-fn');
      }),
    ).rejects.toThrow('erro-de-fn');
  });

  it('(d) libera o lock apos throw (sem deadlock para proximo caller)', async () => {
    await expect(
      tryWithMemoryGateLock(async () => {
        await delay(10);
        throw new Error('erro-esperado');
      }),
    ).rejects.toThrow('erro-esperado');

    const fn = vi.fn(async () => 'ok-apos-erro');
    const result = await tryWithMemoryGateLock(fn);
    expect(result).toBe('ok-apos-erro');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('(e) withMemoryGateLock enfileira e executa apos tryWithMemoryGateLock terminar', async () => {
    const HOLD_MS = 60;
    const callOrder: string[] = [];

    const tryHolder = tryWithMemoryGateLock(async () => {
      callOrder.push('try-start');
      await delay(HOLD_MS);
      callOrder.push('try-end');
    });

    await delay(10);

    const withHolder = withMemoryGateLock(async () => {
      callOrder.push('with-start');
      await delay(10);
      callOrder.push('with-end');
    });

    await Promise.all([tryHolder, withHolder]);

    expect(callOrder).toEqual(['try-start', 'try-end', 'with-start', 'with-end']);
  });

  it('(e) withMemoryGateLock completa normalmente (nao retorna null) enquanto try esta ativo', async () => {
    const HOLD_MS = 60;

    const tryHolder = tryWithMemoryGateLock(() => delay(HOLD_MS));

    await delay(10);

    const withResult = await withMemoryGateLock(async () => 'resultado-do-with');
    expect(withResult).toBe('resultado-do-with');

    await tryHolder;
  });
});

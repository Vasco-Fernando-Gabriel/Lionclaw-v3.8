
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
}));


import { withMemoryGateLock } from '../memory-pipeline';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


describe('withMemoryGateLock', () => {
  it('serializa 2 chamadas concorrentes (tempo total >= soma dos individuais)', async () => {
    const SLOT_MS = 50;

    const t0 = Date.now();

    const p1 = withMemoryGateLock(() => delay(SLOT_MS));
    const p2 = withMemoryGateLock(() => delay(SLOT_MS));

    await Promise.all([p1, p2]);

    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(SLOT_MS * 1.5);
  });

  it('respeita ordem FIFO em 3 chamadas concorrentes', async () => {
    const SLOT_MS = 30;
    const startOrder: number[] = [];
    let counter = 0;

    const makeTask = () =>
      withMemoryGateLock(async () => {
        startOrder.push(++counter);
        await delay(SLOT_MS);
      });

    const p1 = makeTask();
    const p2 = makeTask();
    const p3 = makeTask();

    await Promise.all([p1, p2, p3]);

    expect(startOrder).toEqual([1, 2, 3]);
  });

  it('libera o mutex mesmo quando fn lanca (sem deadlock para proximo caller)', async () => {
    const SLOT_MS = 20;
    let call2Completed = false;

    const p1 = withMemoryGateLock(async () => {
      await delay(SLOT_MS);
      throw new Error('erro-esperado');
    });

    const p2 = withMemoryGateLock(async () => {
      await delay(SLOT_MS);
      call2Completed = true;
    });

    await expect(p1).rejects.toThrow('erro-esperado');

    await expect(p2).resolves.toBeUndefined();

    expect(call2Completed).toBe(true);
  });

  it('retorna o valor de fn preservando o tipo generico (string)', async () => {
    const result = await withMemoryGateLock(async () => 'hello');
    expect(result).toBe('hello');
  });

  it('retorna o valor de fn preservando o tipo generico (number)', async () => {
    const result = await withMemoryGateLock(async () => 42);
    expect(result).toBe(42);
  });

  it('chamadas sequenciais completam sem interferencia', async () => {
    const results: number[] = [];

    await withMemoryGateLock(async () => { results.push(1); });
    await withMemoryGateLock(async () => { results.push(2); });
    await withMemoryGateLock(async () => { results.push(3); });

    expect(results).toEqual([1, 2, 3]);
  });
});

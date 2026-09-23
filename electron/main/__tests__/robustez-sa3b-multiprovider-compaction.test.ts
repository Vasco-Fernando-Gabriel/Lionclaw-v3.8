import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatMessage, ChatSession, StreamChunk } from '../../../src/types';

const h = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSessionMessagesMock: vi.fn((): unknown[] => []),
  getSettingMock: vi.fn((_key: string): string | undefined => undefined),
  setSessionCompactionStateMock: vi.fn(),
  setSessionActiveContextTokensMock: vi.fn(),
  createSessionMock: vi.fn(),
  updateSessionStatusMock: vi.fn(),
  transactionMock: vi.fn(
    (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  ),
  summarizeLightweightMock: vi.fn(),
  getContextWindowMock: vi.fn((_model: string, _provider?: string): number | undefined => undefined),
}));

vi.mock('../db', () => ({
  getDb: vi.fn(() => ({
    prepare: (_sql: string) => ({ get: () => undefined, all: () => [], run: () => undefined }),
    transaction: h.transactionMock,
  })),
  getSession: h.getSessionMock,
  getSessionMessages: h.getSessionMessagesMock,
  getSetting: h.getSettingMock,
  setSessionCompactionState: h.setSessionCompactionStateMock,
  setSessionActiveContextTokens: h.setSessionActiveContextTokensMock,
  createSession: h.createSessionMock,
  updateSessionStatus: h.updateSessionStatusMock,
}));

vi.mock('../memory-pipeline', () => ({
  summarizeLightweight: h.summarizeLightweightMock,
}));

vi.mock('../agent-runtime/model-context-windows', () => ({
  getContextWindow: h.getContextWindowMock,
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

import {
  maybeCompactChatSession,
  getChatCompactionThreshold,
  __resetChatCompactionGuardsForTests,
} from '../chat-compaction-trigger';
import { EmptyProviderResponseError } from '../agent-runtime/llm-error';

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    status: 'active',
    type: 'chat',
    createdAt: '2026-07-01 10:00:00',
    updatedAt: '2026-07-01 10:00:00',
    ...overrides,
  };
}

function makeMsg(id: number, role: 'user' | 'assistant', content: string): ChatMessage {
  return {
    id,
    sessionId: 's1',
    role,
    content,
    createdAt: `2026-07-01 10:0${Math.min(id, 9)}:00`,
  };
}

const OK_SUMMARY = { executiveSummary: 'resumo rolante novo' };

function readSource(relPath: string): string {
  return fs.readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');
}

const RUNTIMES = [
  {
    name: 'claude-compat-sdk',
    source: '../claude-compat-sdk/index.ts',
    model: 'glm-4.7',
    provider: 'zai',
    windowTokens: 200_000, // threshold default 80% = 160k
    catchMarker: "'Claude-compat orchestrator query failed'",
    successMarker: "sendSessionStream({ type: 'done', content: sessionId })",
    sinkPattern: /await maybeCompactChatSession\(sessionId, sendSessionStream, \{/,
  },
  {
    name: 'codex-sdk',
    source: '../codex-sdk/index.ts',
    model: 'gpt-5.5-codex',
    provider: 'openai',
    windowTokens: 400_000, // threshold default 80% = 320k
    catchMarker: "'Codex SDK query failed'",
    successMarker: 'turnOk = true',
    sinkPattern: /await maybeCompactChatSession\(sessionId, emit, \{/,
  },
  {
    name: 'kimi-sdk',
    source: '../kimi-sdk/index.ts',
    model: 'kimi-k2-turbo-preview',
    provider: 'kimi',
    windowTokens: 262_144, // threshold default 80% = 209_715
    catchMarker: "'Kimi SDK query failed'",
    successMarker: 'turnOk = true',
    sinkPattern: /await maybeCompactChatSession\(sessionId, emit, \{/,
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  __resetChatCompactionGuardsForTests();
  h.getSettingMock.mockReturnValue(undefined);
  h.getSessionMessagesMock.mockReturnValue([]);
  h.getContextWindowMock.mockReturnValue(undefined);
  h.transactionMock.mockImplementation(
    (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  );
  h.summarizeLightweightMock.mockResolvedValue(OK_SUMMARY);
});

function installTurnModel(rt: (typeof RUNTIMES)[number]): void {
  h.getSettingMock.mockImplementation((key: string) => {
    if (key === 'orchestrator_model') return 'modelo-do-setting';
    if (key === 'orchestrator_provider') return 'anthropic';
    return undefined;
  });
  h.getContextWindowMock.mockImplementation((model: string, provider?: string) =>
    model === rt.model && provider === rt.provider ? rt.windowTokens : undefined,
  );
}

describe('AC-A5b [INV] — hook UNICO no completion de SUCESSO de cada executor (nunca no catch)', () => {
  for (const rt of RUNTIMES) {
    it(`AC-A5b (${rt.name}): 1 callsite awaited, pos-sucesso, antes do catch, com selection.model/provider`, () => {
      const src = readSource(rt.source);

      const callMatches = src.match(/await maybeCompactChatSession\(/g) ?? [];
      expect(callMatches).toHaveLength(1);

      const callIdx = src.indexOf('await maybeCompactChatSession(');
      const successIdx = src.indexOf(rt.successMarker);
      expect(successIdx).toBeGreaterThan(-1);
      expect(callIdx).toBeGreaterThan(successIdx);
      const catchIdx = src.indexOf(rt.catchMarker);
      expect(catchIdx).toBeGreaterThan(-1);
      expect(callIdx).toBeLessThan(catchIdx);

      expect(src).toMatch(rt.sinkPattern);
      const callRegion = src.slice(callIdx, callIdx + 300);
      expect(callRegion).toContain('model: selection.model');
      expect(callRegion).toContain('provider: selection.provider');
    });
  }

  it('AC-A5b: lion-sdk fica FORA (rota propria compactIfNeeded — nenhum hook)', () => {
    const src = readSource('../lion-sdk/index.ts');
    expect(src).not.toContain('maybeCompactChatSession');
  });

  it('AC-A5b: o hook do claude-sdk (orchestrator.ts) continua UNICO e intacto', () => {
    const src = readSource('../orchestrator.ts');
    const callMatches = src.match(/await maybeCompactChatSession\(/g) ?? [];
    expect(callMatches).toHaveLength(1);
  });
});

for (const rt of RUNTIMES) {
  const threshold = Math.floor((rt.windowTokens * 80) / 100);
  const turnModel = { model: rt.model, provider: rt.provider };

  describe(`SA-3b (${rt.name}) — gatilho model-aware pela selection do turno`, () => {
    it(`AC-A5b (${rt.name}): threshold resolve pelo modelo REAL do turno (selection), nao pelo setting`, () => {
      installTurnModel(rt);
      expect(getChatCompactionThreshold(turnModel)).toBe(threshold);
      expect(h.getContextWindowMock).toHaveBeenCalledWith(rt.model, rt.provider);
      expect(getChatCompactionThreshold()).toBeUndefined();
    });

    it(`AC-A5b (${rt.name}): abaixo do threshold NAO dispara`, async () => {
      installTurnModel(rt);
      h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: threshold - 1 }));

      await maybeCompactChatSession('s1', undefined, turnModel);

      expect(h.summarizeLightweightMock).not.toHaveBeenCalled();
      expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
    });

    it(`AC-A5b (${rt.name}): janela desconhecida (getContextWindow undefined) = no-op, sem crash (D5)`, async () => {
      installTurnModel(rt);
      h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 999_999_999 }));

      await maybeCompactChatSession('s1', undefined, { model: 'modelo-sem-janela', provider: rt.provider });

      expect(h.summarizeLightweightMock).not.toHaveBeenCalled();
      expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
    });

    it(`AC-A6b (${rt.name}): acima do threshold dispara 1x e o proximo turno le sdk_session_id/pending_seed novos`, async () => {
      installTurnModel(rt);
      h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: threshold + 1 }));
      h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);

      const events: string[] = [];
      let resolveSummarize!: (v: typeof OK_SUMMARY) => void;
      h.summarizeLightweightMock.mockImplementation(
        () =>
          new Promise<typeof OK_SUMMARY>((res) => {
            resolveSummarize = res;
          }),
      );

      const trigger = maybeCompactChatSession('s1', undefined, turnModel).then(() => events.push('trigger:resolved'));
      await new Promise((r) => setTimeout(r, 0));
      expect(h.summarizeLightweightMock).toHaveBeenCalledTimes(1);
      expect(events).toEqual([]);

      events.push('summarize:done');
      resolveSummarize(OK_SUMMARY);
      await trigger;

      expect(events).toEqual(['summarize:done', 'trigger:resolved']);
      expect(h.setSessionCompactionStateMock).toHaveBeenCalledTimes(1);
      const [sid, state] = h.setSessionCompactionStateMock.mock.calls[0];
      expect(sid).toBe('s1');
      expect(state.pendingSeed).toContain('resumo rolante novo');
      expect(typeof state.sdkSessionId).toBe('string');
      expect(state.sdkSessionId).not.toBe('s1');
    });

    it(`AC-A9-b (${rt.name}): falha do summarizer nao quebra o turno (nunca lanca) e surfaca COMPACT-EMPTY no sink`, async () => {
      installTurnModel(rt);
      h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: threshold + 1 }));
      h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi')]);
      h.summarizeLightweightMock.mockRejectedValue(new EmptyProviderResponseError(rt.provider, rt.model, rt.name));

      const chunks: StreamChunk[] = [];
      await expect(maybeCompactChatSession('s1', (c) => chunks.push(c), turnModel)).resolves.toBeUndefined();

      expect(chunks.filter((c) => c.type === 'compacting').map((c) => c.isCompacting)).toEqual([true, false]);
      const errorChunks = chunks.filter((c) => c.type !== 'compacting');
      expect(errorChunks).toHaveLength(1);
      expect(errorChunks[0]).toMatchObject({ type: 'error', code: 'COMPACT-EMPTY' });
      expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
    });

    it(`AC-A7b (${rt.name}): sessao telegram/scheduled = no-op (guards de tipo de sessao)`, async () => {
      installTurnModel(rt);

      h.getSessionMock.mockReturnValue(makeSession({ type: 'telegram', activeContextTokensEst: 999_999_999 }));
      await maybeCompactChatSession('s1', undefined, turnModel);
      h.getSessionMock.mockReturnValue(makeSession({ type: 'scheduled', activeContextTokensEst: 999_999_999 }));
      await maybeCompactChatSession('s1', undefined, turnModel);

      expect(h.summarizeLightweightMock).not.toHaveBeenCalled();
      expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
    });
  });
}

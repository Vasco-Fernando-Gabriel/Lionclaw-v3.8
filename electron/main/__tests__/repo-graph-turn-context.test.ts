import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const getActiveChatSessionMock = vi.fn<() => { id: string } | null>(() => null);
vi.mock('../db', () => ({
  getActiveChatSession: () => getActiveChatSessionMock(),
}));

import {
  setRepoGraphTurnSession,
  clearRepoGraphTurnSession,
  hasRepoGraphTurnSession,
  getRepoGraphTurnRuntime,
  setRepoGraphTurnContext,
  getRepoGraphTurnContext,
  resolveRepoGraphSessionId,
  shouldEmitRuntimeLimited,
  type RepoChatContext,
} from '../repo-graph/turn-context';

const CTX: RepoChatContext = {
  repositoryId: 'repo-1',
  canonicalRootPath: '/tmp/fake-repo',
  status: 'ready',
  statsResumo: '10 arquivos, 50 simbolos',
};

beforeEach(() => {
  vi.clearAllMocks();
  clearRepoGraphTurnSession();
  getActiveChatSessionMock.mockReturnValue(null);
});

describe('9.4: contexto de turno POR SESSAO (Map<sessionId, state>)', () => {
  it('set/has/runtime/clear por sessao', () => {
    expect(hasRepoGraphTurnSession('sess-1')).toBe(false);
    setRepoGraphTurnSession('sess-1', 'claude-sdk');
    expect(hasRepoGraphTurnSession('sess-1')).toBe(true);
    expect(getRepoGraphTurnRuntime('sess-1')).toBe('claude-sdk');
    clearRepoGraphTurnSession('sess-1');
    expect(hasRepoGraphTurnSession('sess-1')).toBe(false);
    expect(getRepoGraphTurnRuntime('sess-1')).toBeNull();
  });

  it('duas sessoes em voo nao se misturam: clear de uma preserva a outra', () => {
    setRepoGraphTurnSession('sess-a', 'claude-sdk');
    setRepoGraphTurnSession('sess-b', 'codex-sdk');
    setRepoGraphTurnContext('sess-a', CTX);
    expect(getRepoGraphTurnContext('sess-a')).toEqual(CTX);
    expect(getRepoGraphTurnContext('sess-b')).toBeNull();
    expect(getRepoGraphTurnRuntime('sess-b')).toBe('codex-sdk');
    clearRepoGraphTurnSession('sess-a');
    expect(hasRepoGraphTurnSession('sess-a')).toBe(false);
    expect(hasRepoGraphTurnSession('sess-b')).toBe(true);
    expect(getRepoGraphTurnRuntime('sess-b')).toBe('codex-sdk');
  });

  it('resolveRepoGraphSessionId usa o binding como fonte PRIMARIA (ignora a sessao ativa do DB)', () => {
    getActiveChatSessionMock.mockReturnValue({ id: 'sess-ERRADA' });
    setRepoGraphTurnSession('sess-real');
    expect(resolveRepoGraphSessionId({ sessionId: 'sess-real' })).toBe('sess-real');
    expect(getActiveChatSessionMock).not.toHaveBeenCalled();
  });

  it('padrao try/finally do hook F6: clear roda DEPOIS do dispatch retornar', async () => {
    const observed: boolean[] = [];
    const dispatchSimulado = async (): Promise<void> => {
      observed.push(hasRepoGraphTurnSession('sess-turno'));
      await new Promise((resolve) => setTimeout(resolve, 5));
      observed.push(hasRepoGraphTurnSession('sess-turno'));
    };
    try {
      setRepoGraphTurnSession('sess-turno', 'lion-sdk');
      await dispatchSimulado();
    } finally {
      clearRepoGraphTurnSession('sess-turno');
    }
    expect(observed).toEqual([true, true]);
    expect(hasRepoGraphTurnSession('sess-turno')).toBe(false);
  });
});

describe('lanes RM2/RM4: sem binding valido a resolucao falha tipada', () => {
  it('sem sessionId no binding lanca turn_binding_required e NUNCA consulta a heuristica global', () => {
    getActiveChatSessionMock.mockReturnValue({ id: 'sess-fallback' });
    setRepoGraphTurnSession('sess-outra');
    expect(() => resolveRepoGraphSessionId({})).toThrow(/turn_binding_required/);
    expect(getActiveChatSessionMock).not.toHaveBeenCalled();
  });

  it('sessionId sem turno registrado lanca turn_binding_required', () => {
    expect(() => resolveRepoGraphSessionId({ sessionId: 'sess-x' })).toThrow(/turn_binding_required/);
  });

  it('o erro e tipado com code turn_binding_required', () => {
    try {
      resolveRepoGraphSessionId({});
      expect.unreachable('deveria lancar');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('turn_binding_required');
      expect((err as Error).name).toBe('RepoGraphTurnBindingError');
    }
  });

  it('o fonte nao importa o db (sem fallback possivel)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'repo-graph', 'turn-context.ts'), 'utf8');
    expect(source).not.toContain("from '../db'");
    expect(source).toContain('turn_binding_required');
  });
});

describe('RepoChatContext do turno', () => {
  it('set/get do contexto e limpeza no clear', () => {
    setRepoGraphTurnSession('sess-1');
    setRepoGraphTurnContext('sess-1', CTX);
    expect(getRepoGraphTurnContext('sess-1')).toEqual(CTX);
    clearRepoGraphTurnSession('sess-1');
    expect(getRepoGraphTurnContext('sess-1')).toBeNull();
  });

  it('novo turno da MESMA sessao NAO herda o contexto do turno anterior', () => {
    setRepoGraphTurnSession('sess-1');
    setRepoGraphTurnContext('sess-1', CTX);
    setRepoGraphTurnSession('sess-1');
    expect(getRepoGraphTurnContext('sess-1')).toBeNull();
  });

  it('setRepoGraphTurnContext sem turno registrado e ignorado', () => {
    setRepoGraphTurnContext('sess-sem-turno', CTX);
    expect(getRepoGraphTurnContext('sess-sem-turno')).toBeNull();
  });
});

describe('politica anti-ruido: runtime-limited 1x por turno POR SESSAO', () => {
  it('primeira chamada true, segunda false; outra sessao tem o proprio contador', () => {
    setRepoGraphTurnSession('sess-1', 'lion-sdk');
    setRepoGraphTurnSession('sess-2', 'lion-sdk');
    expect(shouldEmitRuntimeLimited('sess-1')).toBe(true);
    expect(shouldEmitRuntimeLimited('sess-1')).toBe(false);
    expect(shouldEmitRuntimeLimited('sess-2')).toBe(true);
    expect(shouldEmitRuntimeLimited('sess-2')).toBe(false);
  });

  it('fora de turno nunca emite', () => {
    expect(shouldEmitRuntimeLimited('sess-nenhuma')).toBe(false);
  });

  it('novo turno da sessao rearma o contador', () => {
    setRepoGraphTurnSession('sess-1');
    expect(shouldEmitRuntimeLimited('sess-1')).toBe(true);
    setRepoGraphTurnSession('sess-1');
    expect(shouldEmitRuntimeLimited('sess-1')).toBe(true);
  });
});

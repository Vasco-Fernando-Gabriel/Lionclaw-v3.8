
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
  getRepoGraphTurnSession,
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

describe('Z2 — contexto de turno (fonte primaria)', () => {
  it('set/get/clear do sessionId e runtime do turno', () => {
    expect(getRepoGraphTurnSession()).toBeNull();
    setRepoGraphTurnSession('sess-1', 'claude-sdk');
    expect(getRepoGraphTurnSession()).toBe('sess-1');
    expect(getRepoGraphTurnRuntime()).toBe('claude-sdk');
    clearRepoGraphTurnSession();
    expect(getRepoGraphTurnSession()).toBeNull();
    expect(getRepoGraphTurnRuntime()).toBeNull();
  });

  it('resolveRepoGraphSessionId usa o turno como fonte PRIMARIA (ignora a sessao ativa do DB)', () => {
    getActiveChatSessionMock.mockReturnValue({ id: 'sess-ERRADA' });
    setRepoGraphTurnSession('sess-real');
    expect(resolveRepoGraphSessionId()).toBe('sess-real');
    expect(getActiveChatSessionMock).not.toHaveBeenCalled();
  });

  it('padrao try/finally do hook F6: clear roda DEPOIS do dispatch retornar', async () => {
    const observed: Array<string | null> = [];
    const dispatchSimulado = async (): Promise<void> => {
      observed.push(getRepoGraphTurnSession());
      await new Promise((resolve) => setTimeout(resolve, 5));
      observed.push(getRepoGraphTurnSession());
    };
    try {
      setRepoGraphTurnSession('sess-turno', 'lion-sdk');
      await dispatchSimulado();
    } finally {
      clearRepoGraphTurnSession();
    }
    expect(observed).toEqual(['sess-turno', 'sess-turno']);
    expect(getRepoGraphTurnSession()).toBeNull();
  });

  it('subagent disparado dentro do turno herda o contexto (mesmo processo main)', async () => {
    setRepoGraphTurnSession('sess-pai', 'codex-sdk');
    const sessaoVistaPeloSubagente = await Promise.resolve().then(() =>
      resolveRepoGraphSessionId(),
    );
    expect(sessaoVistaPeloSubagente).toBe('sess-pai');
    clearRepoGraphTurnSession();
  });
});

describe('Z2 — fallback documentado (getActiveChatSession)', () => {
  it('sem turno setado cai no fallback getActiveChatSession', () => {
    getActiveChatSessionMock.mockReturnValue({ id: 'sess-fallback' });
    expect(getRepoGraphTurnSession()).toBeNull();
    expect(resolveRepoGraphSessionId()).toBe('sess-fallback');
    expect(getActiveChatSessionMock).toHaveBeenCalledTimes(1);
  });

  it('fallback sem sessao ativa resolve null (e nao lanca)', () => {
    getActiveChatSessionMock.mockReturnValue(null);
    expect(resolveRepoGraphSessionId()).toBeNull();
  });

  it('erro no fallback e engolido com log (resolve null)', () => {
    getActiveChatSessionMock.mockImplementation(() => {
      throw new Error('db indisponivel');
    });
    expect(resolveRepoGraphSessionId()).toBeNull();
  });

  it('o fonte documenta a limitacao do fallback com o texto EXATO da SPEC', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'repo-graph', 'turn-context.ts'),
      'utf8',
    );
    const normalized = source.replace(/\n \*\s{0,5}/g, ' ').replace(/\s+/g, ' ');
    expect(normalized).toContain(
      "getActiveChatSession resolve por status='active' + updated_at DESC (db.ts:~2919) e pode apontar a SESSAO ERRADA em chamada longa, troca de conversa ou pos-compaction; e fallback, nunca fonte primaria",
    );
  });
});

describe('RepoChatContext do turno', () => {
  it('set/get do contexto e limpeza no clear', () => {
    setRepoGraphTurnSession('sess-1');
    setRepoGraphTurnContext(CTX);
    expect(getRepoGraphTurnContext()).toEqual(CTX);
    clearRepoGraphTurnSession();
    expect(getRepoGraphTurnContext()).toBeNull();
  });

  it('novo turno NAO herda o contexto do turno anterior', () => {
    setRepoGraphTurnSession('sess-1');
    setRepoGraphTurnContext(CTX);
    setRepoGraphTurnSession('sess-2');
    expect(getRepoGraphTurnContext()).toBeNull();
  });
});

describe('politica anti-ruido — runtime-limited 1x/turno', () => {
  it('emite SOMENTE na primeira chamada do turno', () => {
    setRepoGraphTurnSession('sess-1');
    expect(shouldEmitRuntimeLimited()).toBe(true);
    expect(shouldEmitRuntimeLimited()).toBe(false);
    expect(shouldEmitRuntimeLimited()).toBe(false);
  });

  it('turno novo re-arma a emissao', () => {
    setRepoGraphTurnSession('sess-1');
    expect(shouldEmitRuntimeLimited()).toBe(true);
    setRepoGraphTurnSession('sess-1');
    expect(shouldEmitRuntimeLimited()).toBe(true);
  });

  it('fora de turno nao emite (false)', () => {
    expect(getRepoGraphTurnSession()).toBeNull();
    expect(shouldEmitRuntimeLimited()).toBe(false);
  });
});

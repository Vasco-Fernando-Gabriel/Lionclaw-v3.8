import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  registerChatCapabilityTurn,
  getChatCapabilityTurn,
  clearChatCapabilityTurn,
  setActiveChatTurn,
  getActiveChatTurn,
  getActiveChatTurnByLane,
  getActiveChatTurnBinding,
  listActiveDesktopTurns,
  resolveTurnBinding,
  clearActiveChatTurn,
  normalizeChatCapabilityServerId,
  __resetChatCapabilityContextForTests,
  DEFAULT_CHAT_TURN_CONTEXT_TTL_MS,
  type ChatCapabilityTurnContextInput,
} from '../chat-capability-context';

function baseCtx(overrides: Partial<ChatCapabilityTurnContextInput> = {}): ChatCapabilityTurnContextInput {
  return {
    surface: 'chat',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    capabilities: { pipelineControl: false, dynamicWorkflows: false },
    cwd: '/tmp/projeto',
    permissionProfile: { mode: 'default', dangerouslySkipPermissions: false },
    allowedServerIds: ['lionclaw-pipeline-control'],
    ...overrides,
  };
}

beforeEach(() => {
  __resetChatCapabilityContextForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-03T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('turn-context: register / get / clear', () => {
  it('register + get devolve o contexto com createdAt/expiresAt carimbados', () => {
    registerChatCapabilityTurn(baseCtx(), 60_000);

    const ctx = getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' });
    expect(ctx).toBeDefined();
    expect(ctx?.sessionId).toBe('sess-1');
    expect(ctx?.turnId).toBe('turn-1');
    expect(ctx?.origin).toBe('user');
    expect(ctx?.capabilities).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
    });
    expect(ctx?.cwd).toBe('/tmp/projeto');
    expect(ctx?.createdAt).toBe(Date.now());
  });

  it('get de turno desconhecido devolve undefined (fail closed no gate)', () => {
    expect(getChatCapabilityTurn({ sessionId: 'sess-x', turnId: 'turn-x' })).toBeUndefined();
  });

  it('a chave e sessionId+turnId — outro turnId da MESMA sessao nao resolve', () => {
    registerChatCapabilityTurn(baseCtx(), 60_000);
    expect(getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-2' })).toBeUndefined();
  });

  it('clear remove o registro do turno', () => {
    registerChatCapabilityTurn(baseCtx(), 60_000);
    clearChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' });
    expect(getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' })).toBeUndefined();
  });

  it('sem ttlMs usa o default de 30min (setting resolvido pelo caller)', () => {
    registerChatCapabilityTurn(baseCtx());
    const ctx = getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' });
    expect(ctx).toBeDefined();
    expect(ctx!.expiresAt - ctx!.createdAt).toBe(DEFAULT_CHAT_TURN_CONTEXT_TTL_MS);
  });
});

describe('turn-context: anti-aliasing da fonte unica', () => {
  it('mutacao externa no input do caller POS-register nao vaza pro registry', () => {
    const input = baseCtx();
    registerChatCapabilityTurn(input, 60_000);

    input.capabilities.pipelineControl = true;
    input.allowedServerIds!.push('server-intruso');

    const ctx = getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' });
    expect(ctx?.capabilities).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
    });
    expect(ctx?.allowedServerIds).toEqual(['lionclaw-pipeline-control']);
  });

  it('mutar o ctx retornado pelo get nao envenena a fonte unica do turno', () => {
    registerChatCapabilityTurn(baseCtx(), 60_000);

    const first = getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' });
    expect(first).toBeDefined();
    first!.capabilities.pipelineControl = true;
    first!.allowedServerIds!.push('server-intruso');
    first!.cwd = '/tmp/outro';

    const second = getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' });
    expect(second?.capabilities).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
    });
    expect(second?.allowedServerIds).toEqual(['lionclaw-pipeline-control']);
    expect(second?.cwd).toBe('/tmp/projeto');
    expect(second).not.toBe(first);
    expect(second?.capabilities).not.toBe(first?.capabilities);
    expect(second?.allowedServerIds).not.toBe(first?.allowedServerIds);
  });
});

describe('turn-context: TTL DESLIZANTE (backstop, nunca mata turno vivo)', () => {
  it('registro expira apos o TTL sem gets', () => {
    registerChatCapabilityTurn(baseCtx(), 1_000);

    vi.advanceTimersByTime(1_001);
    expect(getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' })).toBeUndefined();
  });

  it('cada get RENOVA o expiresAt — turno consultado alem do TTL original continua vivo', () => {
    registerChatCapabilityTurn(baseCtx(), 1_000);

    vi.advanceTimersByTime(800);
    expect(getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' })).toBeDefined();

    vi.advanceTimersByTime(800);
    expect(getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' })).toBeDefined();

    vi.advanceTimersByTime(800);
    const ctx = getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' });
    expect(ctx).toBeDefined();
    expect(ctx?.expiresAt).toBe(Date.now() + 1_000);
  });

  it('depois da ultima renovacao, o TTL cheio volta a valer (expira sem novos gets)', () => {
    registerChatCapabilityTurn(baseCtx(), 1_000);

    vi.advanceTimersByTime(800);
    expect(getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' })).toBeDefined();

    vi.advanceTimersByTime(1_001);
    expect(getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' })).toBeUndefined();
  });
});

describe('turn-context: variante system-event (0.5.1)', () => {
  it('guarda internalLeaseToken/driveProjectId/driveTurnId no VALOR, chave segue sessionId+turnId', () => {
    registerChatCapabilityTurn(
      baseCtx({
        origin: 'system-event',
        internalLeaseToken: 'token-opaco-nunca-logado',
        driveProjectId: 'proj-42',
        driveTurnId: 'drive-turn-7',
      }),
      60_000,
    );

    const ctx = getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' });
    expect(ctx).toBeDefined();
    expect(ctx?.origin).toBe('system-event');
    expect(ctx?.internalLeaseToken).toBe('token-opaco-nunca-logado');
    expect(ctx?.driveProjectId).toBe('proj-42');
    expect(ctx?.driveTurnId).toBe('drive-turn-7');
  });

  it('turno user nao carrega campos de lease', () => {
    registerChatCapabilityTurn(baseCtx(), 60_000);
    const ctx = getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' });
    expect(ctx?.origin).toBe('user');
    expect(ctx?.internalLeaseToken).toBeUndefined();
    expect(ctx?.driveProjectId).toBeUndefined();
    expect(ctx?.driveTurnId).toBeUndefined();
  });
});

describe('normalizeChatCapabilityServerId (0.4)', () => {
  it('resolve o alias historico pipeline-control -> lionclaw-pipeline-control', () => {
    expect(normalizeChatCapabilityServerId('pipeline-control')).toBe('lionclaw-pipeline-control');
  });

  it('e case-insensitive (alias e canonico)', () => {
    expect(normalizeChatCapabilityServerId('Pipeline-Control')).toBe('lionclaw-pipeline-control');
    expect(normalizeChatCapabilityServerId('LIONCLAW-PIPELINE-CONTROL')).toBe('lionclaw-pipeline-control');
  });

  it('faz trim de espacos antes de comparar', () => {
    expect(normalizeChatCapabilityServerId('  pipeline-control  ')).toBe('lionclaw-pipeline-control');
  });

  it('serverId nao-alias passa inalterado (normalizado para lowercase)', () => {
    expect(normalizeChatCapabilityServerId('google-calendar')).toBe('google-calendar');
    expect(normalizeChatCapabilityServerId('Google-Calendar')).toBe('google-calendar');
  });
});

describe('active-turn registry por (sessionId, lane) — 0.7', () => {
  it('set/get/clear por lane', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    expect(getActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop' })).toBe('turn-1');

    clearActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop' });
    expect(getActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop' })).toBeUndefined();
  });

  it('lanes sao independentes para a mesma sessao', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-d' });
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'telegram', turnId: 'turn-t' });
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'cron', turnId: 'turn-c' });

    expect(getActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop' })).toBe('turn-d');
    expect(getActiveChatTurn({ sessionId: 'sess-1', lane: 'telegram' })).toBe('turn-t');
    expect(getActiveChatTurn({ sessionId: 'sess-1', lane: 'cron' })).toBe('turn-c');

    clearActiveChatTurn({ sessionId: 'sess-1', lane: 'telegram' });
    expect(getActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop' })).toBe('turn-d');
    expect(getActiveChatTurn({ sessionId: 'sess-1', lane: 'telegram' })).toBeUndefined();
  });

  it('set sobrescreve o turno ativo da lane (turno novo assume)', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-2' });
    expect(getActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop' })).toBe('turn-2');
  });

  it('clear guardado por turnId: finally atrasado de turno antigo NAO derruba o turno novo', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-2' });

    clearActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    expect(getActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop' })).toBe('turn-2');

    clearActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-2' });
    expect(getActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop' })).toBeUndefined();
  });
});

describe('9.1: activeTurns por lane::sessionId como fonte; desktop sem indice por lane', () => {
  it('getActiveChatTurnByLane serve so telegram/cron; desktop e resolvido por sessao', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    setActiveChatTurn({ sessionId: 'sess-t', lane: 'telegram', turnId: 'turn-t' });
    expect(getActiveChatTurnByLane('telegram')).toEqual({ sessionId: 'sess-t', turnId: 'turn-t' });
    expect(getActiveChatTurnByLane('cron')).toBeUndefined();
    expect(getActiveChatTurnBinding({ sessionId: 'sess-1', lane: 'desktop' })).toEqual({
      sessionId: 'sess-1',
      turnId: 'turn-1',
    });
    expect(getActiveChatTurnBinding({ sessionId: 'sess-2', lane: 'desktop' })).toBeUndefined();
  });

  it('duas sessoes desktop ativas ao mesmo tempo, cada uma com o proprio turno', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    setActiveChatTurn({ sessionId: 'sess-2', lane: 'desktop', turnId: 'turn-2' });
    expect(getActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop' })).toBe('turn-1');
    expect(getActiveChatTurn({ sessionId: 'sess-2', lane: 'desktop' })).toBe('turn-2');
    expect(listActiveDesktopTurns()).toEqual(
      expect.arrayContaining([
        { sessionId: 'sess-1', turnId: 'turn-1' },
        { sessionId: 'sess-2', turnId: 'turn-2' },
      ]),
    );
    expect(listActiveDesktopTurns()).toHaveLength(2);
  });

  it('clear de uma sessao desktop nao derruba a outra', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    setActiveChatTurn({ sessionId: 'sess-2', lane: 'desktop', turnId: 'turn-2' });
    clearActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    expect(listActiveDesktopTurns()).toEqual([{ sessionId: 'sess-2', turnId: 'turn-2' }]);
  });

  it('clear atrasado de turno antigo NAO derruba o turno novo da mesma sessao', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-2' });
    clearActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    expect(getActiveChatTurnBinding({ sessionId: 'sess-1', lane: 'desktop' })).toEqual({
      sessionId: 'sess-1',
      turnId: 'turn-2',
    });
  });

  it('telegram continua serial: turno novo assume a lane e o clear limpa o indice', () => {
    setActiveChatTurn({ sessionId: 'sess-t1', lane: 'telegram', turnId: 'turn-1' });
    setActiveChatTurn({ sessionId: 'sess-t2', lane: 'telegram', turnId: 'turn-2' });
    expect(getActiveChatTurnByLane('telegram')).toEqual({ sessionId: 'sess-t2', turnId: 'turn-2' });
    clearActiveChatTurn({ sessionId: 'sess-t1', lane: 'telegram', turnId: 'turn-1' });
    expect(getActiveChatTurnByLane('telegram')).toEqual({ sessionId: 'sess-t2', turnId: 'turn-2' });
    clearActiveChatTurn({ sessionId: 'sess-t2', lane: 'telegram', turnId: 'turn-2' });
    expect(getActiveChatTurnByLane('telegram')).toBeUndefined();
  });

  it('devolve COPIA: mutar o retorno nao envenena o indice', () => {
    setActiveChatTurn({ sessionId: 'sess-t', lane: 'telegram', turnId: 'turn-1' });
    const first = getActiveChatTurnByLane('telegram');
    first!.turnId = 'turn-hackeado';
    expect(getActiveChatTurnByLane('telegram')).toEqual({ sessionId: 'sess-t', turnId: 'turn-1' });
  });

  it('reset de testes limpa tudo', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    setActiveChatTurn({ sessionId: 'sess-t', lane: 'telegram', turnId: 'turn-t' });
    __resetChatCapabilityContextForTests();
    expect(listActiveDesktopTurns()).toEqual([]);
    expect(getActiveChatTurnByLane('telegram')).toBeUndefined();
  });
});

describe('resolveTurnBinding (9.3): validado contra activeTurns', () => {
  it('desktop sem sessionId -> turn_binding_required (session-missing), mesmo com turno ativo', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    expect(resolveTurnBinding({ lane: 'desktop' })).toEqual({
      ok: false,
      code: 'turn_binding_required',
      reason: 'session-missing',
    });
  });

  it('desktop com sessionId valido resolve o turno; turnId defasado e recusado', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-2' });
    expect(resolveTurnBinding({ lane: 'desktop', sessionId: 'sess-1' })).toEqual({
      ok: true,
      binding: { sessionId: 'sess-1', turnId: 'turn-2' },
    });
    expect(resolveTurnBinding({ lane: 'desktop', sessionId: 'sess-1', turnId: 'turn-2' }).ok).toBe(true);
    expect(resolveTurnBinding({ lane: 'desktop', sessionId: 'sess-1', turnId: 'turn-1' })).toEqual({
      ok: false,
      code: 'turn_binding_required',
      reason: 'turn-mismatch',
    });
    expect(resolveTurnBinding({ lane: 'desktop', sessionId: 'sess-9' })).toEqual({
      ok: false,
      code: 'turn_binding_required',
      reason: 'no-active-turn',
    });
  });

  it('telegram/cron resolvem pelo indice da lane, sem exigir sessionId', () => {
    expect(resolveTurnBinding({ lane: 'cron' }).ok).toBe(false);
    setActiveChatTurn({ sessionId: 'sess-c', lane: 'cron', turnId: 'turn-c' });
    expect(resolveTurnBinding({ lane: 'cron' })).toEqual({
      ok: true,
      binding: { sessionId: 'sess-c', turnId: 'turn-c' },
    });
  });
});

describe('campos de Fase B opcionais (S3a) — sem placeholder falso', () => {
  it('registra e resolve turno SEM cwd/permissionProfile/allowedServerIds', () => {
    registerChatCapabilityTurn(
      {
        surface: 'chat',
        sessionId: 'sess-a',
        turnId: 'turn-a',
        capabilities: { pipelineControl: true, dynamicWorkflows: false },
      },
      60_000,
    );

    const ctx = getChatCapabilityTurn({ sessionId: 'sess-a', turnId: 'turn-a' });
    expect(ctx).toBeDefined();
    expect(ctx?.capabilities).toEqual({
      pipelineControl: true,
      dynamicWorkflows: false,
    });
    expect(ctx?.cwd).toBeUndefined();
    expect(ctx?.permissionProfile).toBeUndefined();
    expect(ctx?.allowedServerIds).toBeUndefined();
  });

  it('quando presentes (Fase B), os campos seguem copiados defensivamente', () => {
    const input = baseCtx();
    registerChatCapabilityTurn(input, 60_000);
    input.allowedServerIds!.push('server-intruso');

    const ctx = getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' });
    expect(ctx?.allowedServerIds).toEqual(['lionclaw-pipeline-control']);
  });
});


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
  clearActiveChatTurn,
  toChatLane,
  normalizeChatCapabilityServerId,
  __resetChatCapabilityContextForTests,
  DEFAULT_CHAT_TURN_CONTEXT_TTL_MS,
  type ChatCapabilityTurnContextInput,
} from '../chat-capability-context';

function baseCtx(
  overrides: Partial<ChatCapabilityTurnContextInput> = {},
): ChatCapabilityTurnContextInput {
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
    expect(ctx?.origin).toBe('user'); // default quando omitido
    expect(ctx?.capabilities).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
    });
    expect(ctx?.cwd).toBe('/tmp/projeto');
    expect(ctx?.createdAt).toBe(Date.now());
  });

  it('get de turno desconhecido devolve undefined (fail closed no gate)', () => {
    expect(
      getChatCapabilityTurn({ sessionId: 'sess-x', turnId: 'turn-x' }),
    ).toBeUndefined();
  });

  it('a chave e sessionId+turnId — outro turnId da MESMA sessao nao resolve', () => {
    registerChatCapabilityTurn(baseCtx(), 60_000);
    expect(
      getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-2' }),
    ).toBeUndefined();
  });

  it('clear remove o registro do turno', () => {
    registerChatCapabilityTurn(baseCtx(), 60_000);
    clearChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' });
    expect(
      getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' }),
    ).toBeUndefined();
  });

  it('sem ttlMs usa o default de 30min (setting resolvido pelo caller)', () => {
    registerChatCapabilityTurn(baseCtx());
    const ctx = getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' });
    expect(ctx).toBeDefined();
    expect(ctx!.expiresAt - ctx!.createdAt).toBe(
      DEFAULT_CHAT_TURN_CONTEXT_TTL_MS,
    );
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
    expect(
      getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' }),
    ).toBeUndefined();
  });

  it('cada get RENOVA o expiresAt — turno consultado alem do TTL original continua vivo', () => {
    registerChatCapabilityTurn(baseCtx(), 1_000);

    vi.advanceTimersByTime(800); // t=800
    expect(
      getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' }),
    ).toBeDefined();

    vi.advanceTimersByTime(800); // t=1600 (> TTL original, < 800+1000)
    expect(
      getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' }),
    ).toBeDefined();

    vi.advanceTimersByTime(800); // t=2400 (< 1600+1000)
    const ctx = getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' });
    expect(ctx).toBeDefined();
    expect(ctx?.expiresAt).toBe(Date.now() + 1_000);
  });

  it('depois da ultima renovacao, o TTL cheio volta a valer (expira sem novos gets)', () => {
    registerChatCapabilityTurn(baseCtx(), 1_000);

    vi.advanceTimersByTime(800);
    expect(
      getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' }),
    ).toBeDefined(); // renovou: expira em t=1800

    vi.advanceTimersByTime(1_001); // t=1801
    expect(
      getChatCapabilityTurn({ sessionId: 'sess-1', turnId: 'turn-1' }),
    ).toBeUndefined();
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
    expect(normalizeChatCapabilityServerId('pipeline-control')).toBe(
      'lionclaw-pipeline-control',
    );
  });

  it('e case-insensitive (alias e canonico)', () => {
    expect(normalizeChatCapabilityServerId('Pipeline-Control')).toBe(
      'lionclaw-pipeline-control',
    );
    expect(normalizeChatCapabilityServerId('LIONCLAW-PIPELINE-CONTROL')).toBe(
      'lionclaw-pipeline-control',
    );
  });

  it('faz trim de espacos antes de comparar', () => {
    expect(normalizeChatCapabilityServerId('  pipeline-control  ')).toBe(
      'lionclaw-pipeline-control',
    );
  });

  it('serverId nao-alias passa inalterado (normalizado para lowercase)', () => {
    expect(normalizeChatCapabilityServerId('google-calendar')).toBe(
      'google-calendar',
    );
    expect(normalizeChatCapabilityServerId('Google-Calendar')).toBe(
      'google-calendar',
    );
  });
});

describe('active-turn registry por (sessionId, lane) — 0.7', () => {
  it('set/get/clear por lane', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    expect(getActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop' })).toBe(
      'turn-1',
    );

    clearActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop' });
    expect(
      getActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop' }),
    ).toBeUndefined();
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
    expect(
      getActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop' }),
    ).toBeUndefined();
  });
});

describe('getActiveChatTurnByLane (S3a, 0.7 item 3) — resolucao por lane', () => {
  it('devolve o turno ativo da lane; lane sem turno -> undefined', () => {
    expect(getActiveChatTurnByLane('desktop')).toBeUndefined();

    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    expect(getActiveChatTurnByLane('desktop')).toEqual({
      sessionId: 'sess-1',
      turnId: 'turn-1',
    });
    expect(getActiveChatTurnByLane('telegram')).toBeUndefined();
    expect(getActiveChatTurnByLane('cron')).toBeUndefined();
  });

  it('lanes sao independentes entre si', () => {
    setActiveChatTurn({ sessionId: 'sess-d', lane: 'desktop', turnId: 'turn-d' });
    setActiveChatTurn({ sessionId: 'sess-t', lane: 'telegram', turnId: 'turn-t' });

    expect(getActiveChatTurnByLane('desktop')).toEqual({
      sessionId: 'sess-d',
      turnId: 'turn-d',
    });
    expect(getActiveChatTurnByLane('telegram')).toEqual({
      sessionId: 'sess-t',
      turnId: 'turn-t',
    });
  });

  it('turno novo assume a lane, mesmo vindo de OUTRA sessao (lane e serial)', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    setActiveChatTurn({ sessionId: 'sess-2', lane: 'desktop', turnId: 'turn-2' });
    expect(getActiveChatTurnByLane('desktop')).toEqual({
      sessionId: 'sess-2',
      turnId: 'turn-2',
    });
  });

  it('clear do turno ativo limpa o indice da lane', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    clearActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    expect(getActiveChatTurnByLane('desktop')).toBeUndefined();
  });

  it('clear atrasado de turno antigo NAO derruba o turno novo no indice da lane', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-2' });

    clearActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    expect(getActiveChatTurnByLane('desktop')).toEqual({
      sessionId: 'sess-1',
      turnId: 'turn-2',
    });
  });

  it('clear atrasado de SESSAO antiga NAO derruba o turno novo de outra sessao na lane', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    setActiveChatTurn({ sessionId: 'sess-2', lane: 'desktop', turnId: 'turn-2' });

    clearActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    expect(getActiveChatTurnByLane('desktop')).toEqual({
      sessionId: 'sess-2',
      turnId: 'turn-2',
    });
  });

  it('devolve COPIA — mutar o retorno nao envenena o indice', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    const first = getActiveChatTurnByLane('desktop');
    first!.turnId = 'turn-hackeado';
    expect(getActiveChatTurnByLane('desktop')).toEqual({
      sessionId: 'sess-1',
      turnId: 'turn-1',
    });
  });

  it('reset de testes limpa o indice por lane', () => {
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    __resetChatCapabilityContextForTests();
    expect(getActiveChatTurnByLane('desktop')).toBeUndefined();
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

describe('toChatLane (S3a) — narrowing de SdkLane.name', () => {
  it('aceita as 3 lanes conhecidas', () => {
    expect(toChatLane('desktop')).toBe('desktop');
    expect(toChatLane('telegram')).toBe('telegram');
    expect(toChatLane('cron')).toBe('cron');
  });

  it('nome desconhecido -> undefined (host pula o registro)', () => {
    expect(toChatLane('background')).toBeUndefined();
    expect(toChatLane('')).toBeUndefined();
    expect(toChatLane('Desktop')).toBeUndefined();
  });
});

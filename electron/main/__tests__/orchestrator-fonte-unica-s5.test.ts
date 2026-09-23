import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { CliAgenticResponse, CliStreamCallbacks } from '../agent-runtime/cli-agentic/contract';
import type { OrchestratorSelection } from '../orchestrator-selection';
import type { QueryOptions } from '../orchestrator';
import { cronLane, telegramLane } from '../sdk-lane';
import {
  normalizeUsage,
  canonicalPromptTokens,
  estimateStrongFloor,
  CODEX_PRESET_TOKENS,
} from '../agent-runtime/context-measure';

const insertMessage = vi.fn((): number => 1);
const insertAuditEntry = vi.fn((): void => {});
const getActiveChatSession = vi.fn((): { id: string } | null => null);
const createSession = vi.fn((): void => {});
const clearSessionPendingSeed = vi.fn((): void => {});
const updateSessionTokens = vi.fn((): void => {});
const setSessionActiveContextTokens = vi.fn((): void => {});
const setSessionAgenticContextTokens = vi.fn((): void => {});
const getSessionMessagesAfterFence = vi.fn((): Array<Record<string, unknown>> => [
  { content: lastPrompt },
  { content: 'resposta viva do codex' },
]);
const getEnabledTools = vi.fn((): string[] => []);
const getSessionMessages = vi.fn((): Array<Record<string, unknown>> => []);
const getSetting = vi.fn((key: string): string | undefined => (key === 'onboarding_completed' ? 'true' : undefined));
const getTurnIndexForUserMessage = vi.fn((): number => 1);
const getLatestUserTurnIndex = vi.fn((): number => 0);
const getSession = vi.fn((): Record<string, unknown> | null => null);
const ensureInitialSessionTitle = vi.fn();
const generateSessionTitle = vi.fn(async () => {});

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({
  insertMessage: (...a: unknown[]) => insertMessage(...(a as [])),
  insertAuditEntry: (...a: unknown[]) => insertAuditEntry(...(a as [])),
  getActiveChatSession: () => getActiveChatSession(),
  createSession: (...a: unknown[]) => createSession(...(a as [])),
  clearSessionPendingSeed: (...a: unknown[]) => clearSessionPendingSeed(...(a as [])),
  updateSessionTokens: (...a: unknown[]) => updateSessionTokens(...(a as [])),
  setSessionActiveContextTokens: (...a: unknown[]) => setSessionActiveContextTokens(...(a as [])),
  setSessionAgenticContextTokens: (...a: unknown[]) => setSessionAgenticContextTokens(...(a as [])),
  getSessionMessagesAfterFence: (...a: unknown[]) => getSessionMessagesAfterFence(...(a as [])),
  getEnabledTools: () => getEnabledTools(),
  getSessionMessages: () => getSessionMessages(),
  getSetting: (key: string) => getSetting(key),
  getTurnIndexForUserMessage: () => getTurnIndexForUserMessage(),
  getLatestUserTurnIndex: () => getLatestUserTurnIndex(),
  getSession: () => getSession(),
  upsertActivityLog: vi.fn(),
}));

vi.mock('../title-generator', () => ({
  ensureInitialSessionTitle: (...a: unknown[]) => ensureInitialSessionTitle(...(a as [])),
  generateSessionTitle: (...a: unknown[]) => generateSessionTitle(...(a as [])),
}));

vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(() => null),
  captureToolResult: vi.fn(() => null),
}));

vi.mock('../pricing', () => ({
  calculateCost: vi.fn(() => 0.42),
  hasKnownPricing: vi.fn(() => true),
}));

const recordCompletedMainChatTurn = vi.fn();
vi.mock('../dreaming-turn-engine', () => ({
  recordCompletedMainChatTurn: () => recordCompletedMainChatTurn(),
}));

vi.mock('../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
  completeOnboardingFromPersistedProfile: vi.fn(() => false),
}));

let sessionSendImpl: (prompt: string, cb: CliStreamCallbacks, signal: AbortSignal) => Promise<CliAgenticResponse>;
let lastPrompt = '';
const sessionClose = vi.fn(async () => {});

const makeSessionFactory = () =>
  vi.fn(async () => ({
    send: (prompt: string, cb: CliStreamCallbacks, signal: AbortSignal) => {
      lastPrompt = prompt;
      return sessionSendImpl(prompt, cb, signal);
    },
    close: sessionClose,
    contextMeta: { systemPromptTokens: 0, toolSchemasTokens: 0 },
  }));

const createChatKimiSession = makeSessionFactory();
vi.mock('../kimi-sdk/session', () => ({
  createChatKimiSession: () => createChatKimiSession(),
}));

const createChatCodexSession = makeSessionFactory();
vi.mock('../codex-sdk/session', () => ({
  createChatCodexSession: () => createChatCodexSession(),
}));
vi.mock('../repo-graph/turn-context', () => ({
  getRepoGraphTurnContext: vi.fn(() => null),
}));
vi.mock('../repo-graph/validate-root', () => ({
  validateRepoRootPath: vi.fn(() => ({ error: 'no repo' })),
}));
vi.mock('../repo-graph/minimal-context', () => ({
  prefetchRepoGraphTurnContext: vi.fn(async () => null),
}));

function collectStream(): {
  getWindow: () => BrowserWindow | null;
  chunks: Array<{ type: string; content?: string }>;
} {
  const chunks: Array<{ type: string; content?: string }> = [];
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        if (channel === 'chat:stream') chunks.push(payload as { type: string; content?: string });
      },
    },
  } as unknown as BrowserWindow;
  return { getWindow: () => fakeWindow, chunks };
}

function makeOptions(overrides?: Partial<QueryOptions>): QueryOptions {
  return { sessionId: 'sess-s5', ...overrides };
}

function kimiSelection(): OrchestratorSelection {
  return { runtime: 'kimi-sdk', provider: 'kimi', model: 'kimi-code/kimi-for-coding', source: 'settings' };
}

function codexSelection(): OrchestratorSelection {
  return { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-5.5', source: 'settings' };
}

function kimiResponse(text: string): CliAgenticResponse {
  return {
    content: text,
    usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 7, cacheCreationTokens: 0 },
    toolUses: 0,
    status: 'finished',
  };
}

function codexResponse(text: string): CliAgenticResponse {
  return {
    content: text,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    usage: { inputTokens: 200, outputTokens: 60, cachedInputTokens: 11, totalTokens: 260 } as any,
    toolUses: 0,
    status: 'finished',
  } as CliAgenticResponse;
}

beforeEach(async () => {
  const { resetCodexSdkSessionState } = await import('../codex-sdk/index');
  resetCodexSdkSessionState();
  vi.clearAllMocks();
  lastPrompt = '';
  getActiveChatSession.mockReturnValue(null);
  getSessionMessages.mockReturnValue([]);
  getSetting.mockImplementation((key: string) => (key === 'onboarding_completed' ? 'true' : undefined));
  getTurnIndexForUserMessage.mockReturnValue(1);
  getLatestUserTurnIndex.mockReturnValue(0);
  getSession.mockReturnValue(null);
  telegramLane.currentAbortController = null;
  cronLane.currentAbortController = null;
});

describe('pending_seed universal (SPEC 3.4)', () => {
  it('kimi: seed vira preambulo do prompt e clearSessionPendingSeed roda no sucesso', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat', pendingSeed: 'RESUMO-SEED' });
    sessionSendImpl = async () => kimiResponse('resposta kimi');

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await executeKimiSdkQuery('nova pergunta', makeOptions(), getWindow, undefined, kimiSelection());

    expect(lastPrompt.startsWith('RESUMO-SEED\n\n')).toBe(true);
    expect(lastPrompt).toContain('nova pergunta');
    expect(clearSessionPendingSeed).toHaveBeenCalledWith('sess-s5');
  });

  it('kimi: SEM seed nao ha preambulo e clearSessionPendingSeed NUNCA roda', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat', pendingSeed: undefined });
    sessionSendImpl = async () => kimiResponse('resposta');

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await executeKimiSdkQuery('oi', makeOptions(), getWindow, undefined, kimiSelection());

    expect(lastPrompt.startsWith('RESUMO-SEED')).toBe(false);
    expect(clearSessionPendingSeed).not.toHaveBeenCalled();
  });

  it('kimi: turno somente-tool valido consome o seed', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat', pendingSeed: 'RESUMO-SEED' });
    sessionSendImpl = async () => ({ ...kimiResponse(''), toolUses: 1 });

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await executeKimiSdkQuery('use a tool', makeOptions(), getWindow, undefined, kimiSelection());

    expect(clearSessionPendingSeed).toHaveBeenCalledOnce();
    expect(clearSessionPendingSeed).toHaveBeenCalledWith('sess-s5');
  });

  it('kimi: cancelamento e erro preservam o seed', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat', pendingSeed: 'RESUMO-SEED' });
    sessionSendImpl = async () => ({ ...kimiResponse('parcial'), status: 'cancelled' });

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await executeKimiSdkQuery('cancele', makeOptions(), getWindow, undefined, kimiSelection());
    expect(clearSessionPendingSeed).not.toHaveBeenCalled();

    sessionSendImpl = async () => {
      throw new Error('provider caiu');
    };
    await executeKimiSdkQuery('tente', makeOptions(), getWindow, undefined, kimiSelection());
    expect(clearSessionPendingSeed).not.toHaveBeenCalled();
  });

  it('codex: seed vira preambulo do prompt e clearSessionPendingSeed roda no sucesso', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat', pendingSeed: 'RESUMO-CODEX' });
    sessionSendImpl = async () => codexResponse('resposta codex');

    const { executeCodexSdkQuery } = await import('../codex-sdk/index');
    const { getWindow } = collectStream();
    await executeCodexSdkQuery('nova', makeOptions(), getWindow, undefined, codexSelection());

    expect(lastPrompt.startsWith('RESUMO-CODEX\n\n')).toBe(true);
    expect(clearSessionPendingSeed).toHaveBeenCalledWith('sess-s5');
  });

  it('codex: seed NAO e consumido se o turno falha (preservado p/ proxima tentativa)', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat', pendingSeed: 'RESUMO-CODEX' });
    sessionSendImpl = async () => {
      throw new Error('provider caiu');
    };

    const { executeCodexSdkQuery } = await import('../codex-sdk/index');
    const { getWindow } = collectStream();
    await executeCodexSdkQuery('nova', makeOptions(), getWindow, undefined, codexSelection());

    expect(clearSessionPendingSeed).not.toHaveBeenCalled();
  });
});

describe('corte de historia por compactedUpToMessageId (SPEC 3.4)', () => {
  const history = [
    { id: 1, role: 'user', content: 'MSG-ANTIGA-1' },
    { id: 2, role: 'assistant', content: 'RESP-ANTIGA-1' },
    { id: 3, role: 'user', content: 'MSG-NOVA-3' },
    { id: 4, role: 'assistant', content: 'RESP-NOVA-4' },
  ];

  it('kimi: sessao compactada nao vaza mensagens antigas (id <= boundary) no preamble', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat', compactedUpToMessageId: 2 });
    getSessionMessages.mockReturnValue(history);
    sessionSendImpl = async () => kimiResponse('ok');

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await executeKimiSdkQuery('pergunta', makeOptions(), getWindow, undefined, kimiSelection());

    expect(lastPrompt).not.toContain('MSG-ANTIGA-1');
    expect(lastPrompt).not.toContain('RESP-ANTIGA-1');
    expect(lastPrompt).toContain('MSG-NOVA-3');
  });

  it('kimi: SEM compactedUpToMessageId toda a historia entra (no-op)', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat' });
    getSessionMessages.mockReturnValue(history);
    sessionSendImpl = async () => kimiResponse('ok');

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await executeKimiSdkQuery('pergunta', makeOptions(), getWindow, undefined, kimiSelection());

    expect(lastPrompt).toContain('MSG-ANTIGA-1');
    expect(lastPrompt).toContain('MSG-NOVA-3');
  });

  it('codex: sessao compactada nao vaza mensagens antigas no preamble', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat', compactedUpToMessageId: 2 });
    getSessionMessages.mockReturnValue(history);
    sessionSendImpl = async () => codexResponse('ok');

    const { executeCodexSdkQuery } = await import('../codex-sdk/index');
    const { getWindow } = collectStream();
    await executeCodexSdkQuery('pergunta', makeOptions(), getWindow, undefined, codexSelection());

    expect(lastPrompt).not.toContain('MSG-ANTIGA-1');
    expect(lastPrompt).not.toContain('RESP-ANTIGA-1');
    expect(lastPrompt).toContain('MSG-NOVA-3');
  });
});

describe('usage/custo por turno (SPEC 3.5)', () => {
  it('codex: persiste runtime e proveniencia equivalente da assinatura', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat' });
    sessionSendImpl = async () => codexResponse('resposta');

    const { executeCodexSdkQuery } = await import('../codex-sdk/index');
    const { getWindow } = collectStream();
    await executeCodexSdkQuery('oi', makeOptions(), getWindow, undefined, codexSelection());

    expect(updateSessionTokens).toHaveBeenCalledWith('sess-s5', 200, 60, 0.42, {
      costStatus: 'known',
      tokenStatus: 'reported',
      runtime: 'codex',
      costEstimationKind: 'subscription-equivalent-payg',
    });
  });

  it('kimi: updateSessionTokens chamado com os numeros do response', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat' });
    sessionSendImpl = async () => kimiResponse('resposta');

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await executeKimiSdkQuery('oi', makeOptions(), getWindow, undefined, kimiSelection());

    expect(updateSessionTokens).toHaveBeenCalledWith('sess-s5', 100, 40, 0.42, {
      costStatus: 'known',
      tokenStatus: 'reported',
      costUnknownReason: null,
      runtime: 'kimi',
      costEstimationKind: 'subscription-equivalent-payg',
    });
  });

  it('kimi: response com zero tokens persiste qualidade not_reported', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat' });
    sessionSendImpl = async () => ({
      content: 'x',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      toolUses: 0,
      status: 'finished',
    });

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await executeKimiSdkQuery('oi', makeOptions(), getWindow, undefined, kimiSelection());

    expect(updateSessionTokens).toHaveBeenCalledWith('sess-s5', 0, 0, 0, {
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
      costUnknownReason: 'no-usage-reported',
      runtime: 'kimi',
      costEstimationKind: 'subscription-equivalent-payg',
    });
  });

  it('kimi: turno somente-tool persiste usage sem mensagem assistant vazia', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat' });
    sessionSendImpl = async () => ({
      content: '',
      usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 7, cacheCreationTokens: 0 },
      toolUses: 1,
      status: 'finished',
    });

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await executeKimiSdkQuery('use a tool', makeOptions(), getWindow, undefined, kimiSelection());

    expect(insertMessage).not.toHaveBeenCalledWith('sess-s5', 'assistant', '', expect.anything(), expect.anything());
    expect(updateSessionTokens).toHaveBeenCalledWith('sess-s5', 100, 40, 0.42, {
      costStatus: 'known',
      tokenStatus: 'reported',
      costUnknownReason: null,
      runtime: 'kimi',
      costEstimationKind: 'subscription-equivalent-payg',
    });
  });
});

describe('Kimi: contrato de erro das lanes', () => {
  it('mantem falha de create como chunk no desktop, sem rejeitar o turno', async () => {
    const failure = new Error('Kimi OAuth indisponivel');
    createChatKimiSession.mockRejectedValueOnce(failure);

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await expect(
      executeKimiSdkQuery('oi', makeOptions(), getWindow, undefined, kimiSelection()),
    ).resolves.toBeUndefined();
  });

  it('rejeita falha de create no Telegram depois de limpar o abort da lane', async () => {
    const failure = new Error('Kimi OAuth indisponivel');
    createChatKimiSession.mockRejectedValueOnce(failure);

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await expect(executeKimiSdkQuery('oi', makeOptions(), getWindow, telegramLane, kimiSelection())).rejects.toBe(
      failure,
    );
    expect(telegramLane.currentAbortController).toBeNull();
  });

  it('mantem falha de send como chunk no desktop, sem rejeitar o turno', async () => {
    sessionSendImpl = async () => {
      throw new Error('processo Kimi encerrou');
    };

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await expect(
      executeKimiSdkQuery('oi', makeOptions(), getWindow, undefined, kimiSelection()),
    ).resolves.toBeUndefined();
  });

  it('rejeita falha de send no cron depois de fechar a sessao', async () => {
    const failure = new Error('processo Kimi encerrou');
    sessionSendImpl = async () => {
      throw failure;
    };

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await expect(executeKimiSdkQuery('oi', makeOptions(), getWindow, cronLane, kimiSelection())).rejects.toBe(failure);
    expect(sessionClose).toHaveBeenCalledOnce();
    expect(cronLane.currentAbortController).toBeNull();
  });
});

describe('contador ativo: SET absoluto por estimativa chars/4 (fonte-unica)', () => {
  it('kimi: sucesso do turno SETA o contador ativo = usage real reconciliado (CTX-FINAL)', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat' });
    sessionSendImpl = async () => kimiResponse('resposta viva do kimi');

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await executeKimiSdkQuery('pergunta viva', makeOptions(), getWindow, undefined, kimiSelection());

    const canonical = normalizeUsage(kimiResponse('x').usage, 'anthropic');
    const esperado = canonicalPromptTokens(canonical) + canonical.outputTokens;
    expect(setSessionActiveContextTokens).toHaveBeenCalledWith('sess-s5', esperado);
    expect(esperado).toBeGreaterThan(0);
  });

  it('codex: sucesso do turno SETA o contador ativo = PISO estimado do payload (sem tokenUsage.last)', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat' });
    sessionSendImpl = async () => codexResponse('resposta viva do codex');

    const { executeCodexSdkQuery } = await import('../codex-sdk/index');
    const { getWindow } = collectStream();
    await executeCodexSdkQuery('pergunta viva', makeOptions(), getWindow, undefined, codexSelection());

    const esperado = estimateStrongFloor({
      systemPromptTokens: 0,
      presetTokens: CODEX_PRESET_TOKENS,
      mcpSchemasTokens: 0,
      messageTexts: [lastPrompt, 'resposta viva do codex'],
      agenticTokens: 0,
    });
    expect(setSessionActiveContextTokens).toHaveBeenCalledWith('sess-s5', esperado);
    expect(esperado).toBeGreaterThan(0);
    expect(esperado).not.toBe(260);
  });

  it('codex: turno que FALHA NAO seta o contador ativo (valor anterior preservado)', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat' });
    sessionSendImpl = async () => {
      throw new Error('provider caiu');
    };

    const { executeCodexSdkQuery } = await import('../codex-sdk/index');
    const { getWindow } = collectStream();
    await executeCodexSdkQuery('pergunta', makeOptions(), getWindow, undefined, codexSelection());

    expect(setSessionActiveContextTokens).not.toHaveBeenCalled();
  });

  it('kimi: resposta VAZIA NAO seta o contador ativo (turno nao conta)', async () => {
    getSession.mockReturnValue({ id: 'sess-s5', title: 't', type: 'chat' });
    sessionSendImpl = async () => kimiResponse('   ');

    const { executeKimiSdkQuery } = await import('../kimi-sdk/index');
    const { getWindow } = collectStream();
    await executeKimiSdkQuery('oi', makeOptions(), getWindow, undefined, kimiSelection());

    expect(setSessionActiveContextTokens).not.toHaveBeenCalled();
  });
});

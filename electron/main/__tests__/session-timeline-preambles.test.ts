import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, TimelineEvent, TimelineTurnWithEvents } from '../../../src/types';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const h = vi.hoisted(() => ({
  reinject: false,
  messages: [] as unknown[],
  runs: [] as unknown[],
  sessions: [] as Array<{
    send: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
  replyError: null as string | null,
}));

vi.mock('../db', () => ({
  createSession: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getSession: vi.fn(() => undefined),
  clearSessionPendingSeed: vi.fn(),
  updateSessionTokens: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
  setSessionAgenticContextTokens: vi.fn(),
  getSessionMessages: vi.fn(() => h.messages),
  getSessionMessagesAfterFence: vi.fn(() => []),
  getSetting: vi.fn((key: string) => (key === 'onboarding_completed' ? 'true' : null)),
  getTurnIndexForUserMessage: vi.fn(() => 1),
  getLatestUserTurnIndex: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  insertMessage: vi.fn(() => 3),
  getAllMCPServers: vi.fn(() => []),
  getPermissionBypass: () => false,
  insertRepoGraphTurnUsage: vi.fn(),
  deleteSessionsByIds: vi.fn(),
  getTimelineTurnsAfterFence: vi.fn(() => h.runs),
  insertTimelineEvent: vi.fn(),
  insertTimelineTurn: vi.fn(),
  setTimelineTurnAssistantMessageId: vi.fn(),
  setTimelineTurnMetrics: vi.fn(),
  setTimelineTurnStatus: vi.fn(),
}));

vi.mock('../chat-compaction-trigger', () => ({
  maybeCompactChatSession: vi.fn(async () => undefined),
  isChatTimelineReinjectEnabled: () => h.reinject,
}));

vi.mock('../session-timeline', async (importOriginal) => {
  const original = await importOriginal<typeof import('../session-timeline')>();
  return {
    ...original,
    buildToolsBlocksByAnchor: vi.fn((...args: Parameters<typeof original.buildToolsBlocksByAnchor>) =>
      original.buildToolsBlocksByAnchor(...args),
    ),
  };
});

vi.mock('../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: vi.fn(async () => {
    const response = {
      status: 'completed',
      threadId: `thread-${h.sessions.length}`,
      content: 'resposta',
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, totalTokens: 15 },
    };
    const session = {
      threadId: response.threadId,
      send: vi.fn(async () => response),
      reply: vi.fn(async () => {
        if (h.replyError !== null) {
          const error = new Error(h.replyError);
          h.replyError = null;
          throw error;
        }
        return response;
      }),
      setModel: vi.fn(),
      setReasoningEffort: vi.fn(),
      isClosed: () => false,
      close: vi.fn(),
    };
    h.sessions.push(session);
    return session;
  }),
}));

vi.mock('../pipeline-engine/codex-sessions', () => ({
  isTransientCodexSessionError: (message: string) => message.includes('codex app-server exited'),
}));

vi.mock('../prompt-builder', () => ({
  buildSystemPrompt: () => 'LION-PROMPT',
  loadGeneratedAgentContext: () => '',
}));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/lionclaw/agents-home',
  getBackgroundCwd: () => '/lionclaw/agents-home',
  getLionClawHome: () => '/lionclaw',
}));
vi.mock('../codex-sdk/stream-translator', () => ({
  createCodexStreamTranslator: () => ({
    callbacks: {},
    finalize: vi.fn(),
    fail: vi.fn(),
    timelineEvents: () => [],
  }),
}));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../onboarding', () => ({
  completeOnboardingFromPersistedProfile: vi.fn(),
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
}));
vi.mock('../repo-graph/turn-context', () => ({
  getRepoGraphTurnContext: vi.fn(() => null),
}));
vi.mock('../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(),
}));

import {
  TOOLS_BLOCK_MAX_CHARS,
  attachToolsBlocks,
  buildToolsBlocksByAnchor,
  formatToolsBlock,
} from '../session-timeline';
import { buildGrokHistoryPreamble, GROK_HISTORY_MAX_CHARS } from '../grok-sdk/history';
import { buildKimiHistoryPreamble, KIMI_HISTORY_MAX_CHARS } from '../kimi-sdk/history';
import { buildCodexHistoryPreamble } from '../codex-sdk/history';
import { buildCursorHistoryPreamble } from '../cursor-sdk/history';
import { closeAllCachedChatCodexSessions, executeCodexSdkQuery, resetCodexSdkSessionState } from '../codex-sdk';
import { resetDesktopLanesForTests } from '../desktop-lanes';
import type { OrchestratorSelection } from '../orchestrator-selection';

function message(id: number, role: ChatMessage['role'], content = `msg-${id}`): ChatMessage {
  return {
    id,
    sessionId: 's',
    role,
    content,
    createdAt: `2026-01-01 10:00:${String(id).padStart(2, '0')}`,
  };
}

function event(partial: Partial<TimelineEvent> & Pick<TimelineEvent, 'kind'>): TimelineEvent {
  return {
    id: 0,
    runId: 'run',
    sessionId: 's',
    seq: 0,
    toolUseId: null,
    toolName: null,
    content: '',
    toolCallsJson: null,
    reasoningContent: null,
    isError: false,
    originalBytes: null,
    spillPath: null,
    createdAt: '2026-01-01 10:00:00',
    ...partial,
  };
}

function run(partial: Partial<TimelineTurnWithEvents> = {}): TimelineTurnWithEvents {
  return {
    seqId: 1,
    runId: 'run',
    sessionId: 's',
    turnIndex: 0,
    anchorMessageId: 1,
    currentUserMessageId: 1,
    assistantMessageId: null,
    origin: 'turn',
    runtime: 'grok',
    fidelity: 'observed',
    status: 'complete',
    cwd: null,
    textTokensEst: null,
    toolTokensEst: null,
    createdAt: '2026-01-01 10:00:00',
    events: [],
    ...partial,
  };
}

function toolPair(id: string, name: string, args: string, result: Partial<TimelineEvent> | null): TimelineEvent[] {
  const call = event({ kind: 'tool_call', toolUseId: id, toolName: name, content: args });
  if (result === null) return [call];
  return [call, event({ kind: 'tool_result', toolUseId: id, toolName: name, ...result })];
}

const irregularHistory: ChatMessage[] = [
  message(1, 'user', 'primeira'),
  message(2, 'assistant', 'resposta um'),
  message(3, 'user', 'sem resposta'),
  message(4, 'user', 'de novo'),
  message(5, 'assistant', 'resposta a'),
  message(6, 'assistant', 'resposta b'),
  message(7, 'system', 'oculto'),
  message(8, 'user', 'atual'),
];

const builders = {
  grok: buildGrokHistoryPreamble,
  kimi: buildKimiHistoryPreamble,
  codex: buildCodexHistoryPreamble,
  cursor: buildCursorHistoryPreamble,
} as const;

const selection: OrchestratorSelection = {
  runtime: 'codex-sdk',
  provider: 'codex',
  model: 'gpt-5.5',
  effort: 'medium',
  source: 'session',
} as unknown as OrchestratorSelection;

const readerSpy = buildToolsBlocksByAnchor as unknown as ReturnType<typeof vi.fn>;

async function codexTurn(sessionId: string): Promise<void> {
  await executeCodexSdkQuery('oi', { sessionId }, () => null, undefined, selection);
}

beforeEach(() => {
  resetCodexSdkSessionState();
  resetDesktopLanesForTests();
  closeAllCachedChatCodexSessions('test-reset');
  h.reinject = false;
  h.messages = [];
  h.runs = [];
  h.sessions.length = 0;
  h.replyError = null;
  readerSpy.mockClear();
});

describe('buildToolsBlocksByAnchor (feat-039)', () => {
  it('devolve Map vazio quando o leitor nao tem runs', () => {
    h.runs = [];
    expect(buildToolsBlocksByAnchor('s', [message(1, 'user')], null).size).toBe(0);
  });

  it('um bloco por anchor com run, usando o run mais recente de qualquer status e fidelity', () => {
    h.runs = [
      run({
        seqId: 1,
        anchorMessageId: 1,
        status: 'interrupted',
        fidelity: 'observed',
        events: toolPair('a', 'Read', '{"file_path":"a.ts"}', { content: 'antigo' }),
      }),
      run({
        seqId: 2,
        anchorMessageId: 1,
        status: 'interrupted',
        fidelity: 'observed',
        events: toolPair('b', 'Read', '{"file_path":"b.ts"}', { content: 'recente' }),
      }),
      run({
        seqId: 3,
        anchorMessageId: 3,
        status: 'complete',
        fidelity: 'exact',
        events: toolPair('c', 'Grep', '', { content: 'x' }),
      }),
      run({ seqId: 4, anchorMessageId: 99, events: toolPair('d', 'Bash', '', { content: 'y' }) }),
      run({ seqId: 5, anchorMessageId: null, events: toolPair('e', 'Bash', '', { content: 'z' }) }),
    ];
    const blocks = buildToolsBlocksByAnchor('s', irregularHistory, null);

    expect([...blocks.keys()]).toEqual([1, 3]);
    expect(blocks.get(1)).toBe('Tools:\n- Read({"file_path":"b.ts"}) -> recente\n(interrompido)');
    expect(blocks.get(3)).toBe('Tools:\n- Grep() -> x');
  });
});

describe('attachToolsBlocks (feat-039)', () => {
  it('anexa ao ultimo assistant do intervalo, ao user sem assistant, e ignora anchor sem intervalo', () => {
    const toolsByAnchor = new Map([
      [1, 'Tools:\n- A() -> 1'],
      [3, 'Tools:\n- B() -> 3'],
      [4, 'Tools:\n- C() -> 4'],
      [42, 'Tools:\n- Z() -> orfao'],
    ]);
    const attached = attachToolsBlocks(irregularHistory, toolsByAnchor);

    expect(attached.map((entry) => entry.message)).toEqual(irregularHistory);
    expect(attached.map((entry) => entry.toolsBlock)).toEqual([
      undefined,
      'Tools:\n- A() -> 1',
      'Tools:\n- B() -> 3',
      undefined,
      undefined,
      'Tools:\n- C() -> 4',
      undefined,
      undefined,
    ]);
  });

  it('mapa vazio devolve as mensagens intactas sem campo toolsBlock', () => {
    const attached = attachToolsBlocks(irregularHistory, new Map());
    expect(attached).toEqual(irregularHistory.map((entry) => ({ message: entry })));
  });
});

describe('T-01 CLIs: setting desligado = saida byte a byte igual a sem toolsByAnchor', () => {
  for (const [name, build] of Object.entries(builders)) {
    it(`T-01 ${name}: sem mapa, mapa ausente e mapa vazio rendem o mesmo preambulo`, () => {
      const plain = build(irregularHistory);
      expect(build(irregularHistory, {})).toBe(plain);
      expect(build(irregularHistory, { toolsByAnchor: new Map() })).toBe(plain);
      expect(build(irregularHistory, { dropLast: false })).toBe(
        build(irregularHistory, { dropLast: false, toolsByAnchor: new Map() }),
      );
      expect(plain).not.toContain('Tools:');
      expect(plain).not.toContain('oculto');
      expect(plain).not.toContain('atual');
      expect(plain.split('\n\n')).toEqual([
        'User: primeira',
        'Assistant: resposta um',
        'User: sem resposta',
        'User: de novo',
        'Assistant: resposta a',
        'Assistant: resposta b',
      ]);
    });
  }
});

describe('T-09 Grok/Kimi: bloco sobrevive ao corte de 8 e respeita os tetos', () => {
  const tenIntervals: ChatMessage[] = [];
  let nextId = 1;
  for (let interval = 1; interval <= 10; interval += 1) {
    tenIntervals.push(message(nextId++, 'user', `pergunta ${interval}`));
    tenIntervals.push(message(nextId++, 'assistant', `resposta ${interval}`));
    if (interval === 7) tenIntervals.push(message(nextId++, 'assistant', `complemento ${interval}`));
  }
  tenIntervals.push(message(nextId++, 'user', 'atual'));
  const users = tenIntervals.filter((entry) => entry.role === 'user');
  const anchor7 = users[6].id;
  const anchor10 = users[9].id;

  const manyTools: TimelineEvent[] = [];
  for (let index = 0; index < 20; index += 1) {
    manyTools.push(
      ...toolPair(`t${index}`, `Tool7_${index}`, `{"index":${index},"pad":"${'p'.repeat(60)}"}`, {
        content: `linha um ${index}\nlinha dois ${'r'.repeat(80)}`,
      }),
    );
  }
  manyTools.push(
    ...toolPair('big', 'Bash', '{"command":"npm test"}', {
      content: '<persisted-output>\nOutput too large\n</persisted-output>',
      originalBytes: 35_500,
    }),
  );
  manyTools.push(...toolPair('none', 'Grep', '{"pattern":"x"}', null));
  manyTools.push(...toolPair('err', 'Write', '{"file_path":"z.ts"}', { content: 'EACCES', isError: true }));

  const toolsByAnchor = new Map<number, string>([
    [anchor7, formatToolsBlock(run({ anchorMessageId: anchor7, status: 'complete', events: manyTools }))],
    [
      anchor10,
      formatToolsBlock(
        run({
          anchorMessageId: anchor10,
          status: 'interrupted',
          events: toolPair('r', 'Read', '{"file_path":"a.ts"}', { content: '120 linhas' }),
        }),
      ),
    ],
  ]);

  for (const [name, build, maxChars] of [
    ['grok', buildGrokHistoryPreamble, GROK_HISTORY_MAX_CHARS],
    ['kimi', buildKimiHistoryPreamble, KIMI_HISTORY_MAX_CHARS],
  ] as const) {
    it(`T-09 ${name}: user 7 cortado, bloco fica com o ultimo assistant do intervalo 7`, () => {
      const preamble = build(tenIntervals, { toolsByAnchor });
      const turns = preamble.match(/^(User|Assistant): /gm)?.length ?? 0;

      expect(preamble).not.toContain('pergunta 7');
      expect(preamble.startsWith('Assistant: resposta 7\n\nAssistant: complemento 7\n\nTools:\n')).toBe(true);
      expect(preamble).not.toContain('Assistant: resposta 7\n\nTools:');
      expect(turns).toBe(8);
      expect(preamble).toContain(`${toolsByAnchor.get(anchor7)}\n\nUser: pergunta 8`);
      expect(preamble.endsWith(`Assistant: resposta 10\n\n${toolsByAnchor.get(anchor10)}`)).toBe(true);
      expect(preamble).toContain('(interrompido)');
      expect(preamble).toContain('[persisted 34.7KB]');
      expect(preamble).toContain('Grep({"pattern":"x"}) -> (sem resultado)');
      expect(preamble).toContain('-> ERRO: EACCES');
      expect(preamble).toContain('- [... ');
      expect(preamble).toContain(' tools omitidas ...]');
      expect(preamble.length).toBeLessThanOrEqual(maxChars);
      for (const block of toolsByAnchor.values()) {
        expect(block.length).toBeLessThanOrEqual(TOOLS_BLOCK_MAX_CHARS);
      }
      expect(toolsByAnchor.get(anchor7)!.length).toBeGreaterThan(TOOLS_BLOCK_MAX_CHARS - 200);
    });

    it(`T-09 ${name}: bloco fica fora do corte de 3.000 da mensagem e conta no orcamento de 12.000`, () => {
      const long = 'x'.repeat(5000);
      const history = [message(1, 'user', 'p'), message(2, 'assistant', long), message(3, 'user', 'atual')];
      const block = 'Tools:\n- Read({"file_path":"a.ts"}) -> ok';
      const preamble = build(history, { toolsByAnchor: new Map([[1, block]]) });

      expect(preamble).toBe(`User: p\n\nAssistant: ${'x'.repeat(3000)}\n[...message truncated...]\n\n${block}`);

      const filler = 'y'.repeat(2900);
      const crowded: ChatMessage[] = [];
      for (let id = 1; id <= 8; id += 1) crowded.push(message(id, id % 2 === 1 ? 'user' : 'assistant', filler));
      crowded.push(message(9, 'user', 'atual'));
      const withoutBlock = build(crowded);
      const withBlock = build(crowded, { toolsByAnchor: new Map([[1, block]]) });

      expect(withoutBlock.split('\n\n')).toHaveLength(4);
      expect(withBlock.length).toBeLessThanOrEqual(maxChars);
      expect(withBlock).not.toContain('Tools:');
      expect(withBlock).toBe(withoutBlock);
    });
  }
});

describe('Codex: leitor so na reidratacao', () => {
  const priorMessages = [
    message(1, 'user', 'primeira'),
    message(2, 'assistant', 'resposta um'),
    message(3, 'user', 'oi'),
  ];

  it('T-07: thread viva -> session.reply recebe so o prompt e o leitor tem 0 chamadas', async () => {
    h.reinject = true;
    h.messages = priorMessages;
    h.runs = [run({ anchorMessageId: 1, events: toolPair('a', 'Read', '', { content: 'ok' }) })];

    await codexTurn('sess-t07');
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].send).toHaveBeenCalledTimes(1);
    expect(h.sessions[0].send.mock.calls[0][0]).toContain('Tools:');
    readerSpy.mockClear();

    await codexTurn('sess-t07');
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].reply).toHaveBeenCalledTimes(1);
    expect(h.sessions[0].reply.mock.calls[0][0]).toBe('oi');
    expect(readerSpy).toHaveBeenCalledTimes(0);
  });

  it('T-07 (setting desligado): montagem inicial sem leitor e preambulo sem Tools:', async () => {
    h.reinject = false;
    h.messages = priorMessages;
    h.runs = [run({ anchorMessageId: 1, events: toolPair('a', 'Read', '', { content: 'ok' }) })];

    await codexTurn('sess-t07-off');
    expect(readerSpy).toHaveBeenCalledTimes(0);
    const prompt = h.sessions[0].send.mock.calls[0][0] as string;
    expect(prompt).toContain('Conversation so far:\nUser: primeira\n\nAssistant: resposta um');
    expect(prompt).not.toContain('Tools:');
  });

  it('T-08: apos closeCachedChatCodexSession com setting ligado, o preambulo traz Tools: com name() -> result', async () => {
    h.reinject = true;
    h.messages = priorMessages;
    h.runs = [run({ anchorMessageId: 1, events: toolPair('a', 'Read', '', { content: 'ok' }) })];

    await codexTurn('sess-t08');
    closeAllCachedChatCodexSessions('test-close');
    readerSpy.mockClear();

    await codexTurn('sess-t08');
    expect(h.sessions).toHaveLength(2);
    expect(readerSpy).toHaveBeenCalledTimes(1);
    expect(readerSpy.mock.calls[0][0]).toBe('sess-t08');
    expect(readerSpy.mock.calls[0][2]).toBeNull();
    const prompt = h.sessions[1].send.mock.calls[0][0] as string;
    expect(prompt).toContain(
      'Conversation so far:\nUser: primeira\n\nAssistant: resposta um\n\nTools:\n- Read() -> ok\n\nNew user message:\noi',
    );
    expect(h.sessions[1].reply).not.toHaveBeenCalled();
  });

  it('T-08 (SC-1): recuperacao apos reply transiente reidrata com Tools: e uma chamada ao leitor', async () => {
    h.reinject = true;
    h.messages = priorMessages;
    h.runs = [run({ anchorMessageId: 1, events: toolPair('a', 'Read', '', { content: 'ok' }) })];

    await codexTurn('sess-sc1');
    readerSpy.mockClear();
    h.replyError = 'codex app-server exited';

    await codexTurn('sess-sc1');
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[0].reply).toHaveBeenCalledTimes(1);
    expect(h.sessions[0].reply.mock.calls[0][0]).toBe('oi');
    expect(readerSpy).toHaveBeenCalledTimes(1);
    const prompt = h.sessions[1].send.mock.calls[0][0] as string;
    expect(prompt).toContain('Assistant: resposta um\n\nTools:\n- Read() -> ok\n\nNew user message:\noi');
  });
});

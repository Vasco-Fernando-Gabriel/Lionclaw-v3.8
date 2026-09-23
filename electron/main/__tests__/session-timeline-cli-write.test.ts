import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAgenticResponse, CliStreamCallbacks } from '../agent-runtime/cli-agentic/contract';
import type { CodexResponse, CodexStreamCallbacks } from '../codex-runtime/types';
import type { OrchestratorSelection } from '../orchestrator-selection';
import type { QueryOptions } from '../orchestrator';
import type { AcpSessionUpdate } from '../kimi-acp/types';
import type { TimelineTurnHandle } from '../session-timeline';

const h = vi.hoisted(() => ({
  logs: [] as Array<{ name: string; args: unknown[] }>,
  grokSend: null as null | ((prompt: string, cb: CliStreamCallbacks, signal: AbortSignal) => Promise<unknown>),
  kimiSend: null as
    null | ((prompt: string, cb: CliStreamCallbacks, signal: AbortSignal) => Promise<CliAgenticResponse>),
  codexSend: null as null | ((prompt: string, cb: CodexStreamCallbacks, signal: AbortSignal) => Promise<CodexResponse>),
  cursorSend: null as null | ((prompt: string, onEvent: (relayed: { event: unknown }) => void) => Promise<unknown>),
}));

vi.mock('../logger', () => ({
  createLogger: (name: string) => ({
    info: (...args: unknown[]) => h.logs.push({ name, args }),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../db', () => ({
  clearSessionPendingSeed: vi.fn(),
  createSession: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getSession: vi.fn((id: string) => ({
    id,
    title: 'titulo',
    type: 'chat',
    pendingSeed: null,
    compactedUpToMessageId: null,
    threadResetMessageId: null,
    rollingSummary: null,
    agenticContextTokensEst: 0,
  })),
  getSessionMessages: vi.fn(() => []),
  getSessionMessagesAfterFence: vi.fn(() => []),
  getSessionActiveRepository: vi.fn(() => null),
  getLocalRepository: vi.fn(() => null),
  getLatestUserTurnIndex: vi.fn(() => 0),
  getSetting: vi.fn((key: string) => (key === 'onboarding_completed' ? 'true' : undefined)),
  getTurnIndexForUserMessage: vi.fn(() => 3),
  getPermissionBypass: vi.fn(() => false),
  getAllMCPServers: vi.fn(() => []),
  insertAuditEntry: vi.fn(),
  insertMessage: vi.fn(() => 11),
  insertRepoGraphTurnUsage: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
  setSessionAgenticContextTokens: vi.fn(),
  updateSessionTokens: vi.fn(),
  upsertActivityLog: vi.fn(),
  insertTimelineTurn: vi.fn(),
  insertTimelineEvent: vi.fn(),
  setTimelineTurnStatus: vi.fn(),
  setTimelineTurnMetrics: vi.fn(),
  setTimelineTurnAssistantMessageId: vi.fn(),
  getTimelineTurnsAfterFence: vi.fn(() => []),
  deleteSessionsByIds: vi.fn(),
}));

vi.mock('../activity-log', () => ({
  recordActivity: vi.fn(),
  isWriteTool: vi.fn(() => false),
}));
vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(() => null),
  captureToolResult: vi.fn(() => null),
}));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/lionclaw/agents-home',
  getBackgroundCwd: () => '/lionclaw/background',
  getCronCwd: () => '/lionclaw/cron',
  getLionClawHome: () => '/lionclaw',
}));
vi.mock('../user-attachments-meta', () => ({ persistUserChatMessage: vi.fn(() => 7) }));
vi.mock('../token-estimator', () => ({ estimateTokens: vi.fn(() => 1) }));
vi.mock('../agent-runtime/context-measure', () => ({
  estimateAgenticContentTokens: vi.fn(() => 0),
  estimateStrongFloor: vi.fn(() => 0),
  reconcileActiveContext: vi.fn(() => 0),
  normalizeUsage: vi.fn(() => ({ inputTokens: 0, outputTokens: 0 })),
  canonicalPromptTokens: vi.fn(() => 0),
  resolveHistoryFence: vi.fn(() => null),
  KIMI_PRESET_TOKENS: 0,
  CODEX_PRESET_TOKENS: 0,
}));
vi.mock('../chat-context-usage', () => ({ buildChatContextUsage: vi.fn(() => null) }));
vi.mock('../chat-compaction-trigger', () => ({
  maybeCompactChatSession: vi.fn(async () => undefined),
  isChatTimelineReinjectEnabled: () => false,
}));
vi.mock('../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(async () => undefined),
}));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../onboarding', () => ({
  completeOnboardingFromPersistedProfile: vi.fn(),
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
}));
vi.mock('../chat-capability-context', () => ({
  computeEffectiveCapabilitiesForTurn: vi.fn(() => undefined),
  getActiveChatTurnBinding: vi.fn(() => undefined),
  getChatCapabilityTurn: vi.fn(() => undefined),
}));
vi.mock('../agent-runtime/subagent-dispatch', () => ({
  isSubagentProviderAuthError: vi.fn(() => false),
  subagentAuthFailure: vi.fn(() => ({ code: 'LLM-AUTH-401', error: 'auth' })),
  pendingSubagentProviderAuthError: vi.fn(() => null),
}));
vi.mock('../smoke-audit', () => ({ smokeAudit: vi.fn() }));
vi.mock('../swarm/aggregation-policy', () => ({ swarmAggregationGuard: vi.fn() }));
vi.mock('../swarm/chat-persistence', () => ({ persistSwarmResponse: vi.fn(() => false) }));
vi.mock('../permission-guard', () => ({
  createPermissionGuard: vi.fn(() => async () => ({ behavior: 'allow' })),
}));
vi.mock('../agent-runtime/permission-profiles', () => ({
  PERM_BYPASS_NO_GUARD: {},
  PERM_DEFAULT_WITH_GUARD: vi.fn(() => ({})),
}));
vi.mock('../agent-runtime/kimi-executor', () => ({ KIMI_PRICING_REMAP: {} }));
vi.mock('../grok-sdk/workspace', () => ({
  assertGrokWorkspaceUnchanged: vi.fn(),
  resolveGrokWorkspaceGrant: vi.fn(() => ({
    processCwd: '/tmp/grok',
    sessionCwd: '/tmp/grok',
    readRoots: ['/tmp/grok'],
    writeRoots: [],
    source: 'neutral',
    projectSources: [],
  })),
}));
vi.mock('../grok-sdk/session', () => ({
  createChatGrokSession: vi.fn(async () => ({
    contextMeta: { systemPromptTokens: 0, toolSchemasTokens: 0 },
    send: (prompt: string, cb: CliStreamCallbacks, signal: AbortSignal) => h.grokSend!(prompt, cb, signal),
    close: vi.fn(async () => undefined),
  })),
}));
vi.mock('../kimi-sdk/session', () => ({
  createChatKimiSession: vi.fn(async () => ({
    contextMeta: { systemPromptTokens: 0, toolSchemasTokens: 0 },
    send: (prompt: string, cb: CliStreamCallbacks, signal: AbortSignal) => h.kimiSend!(prompt, cb, signal),
    close: vi.fn(async () => undefined),
  })),
}));
vi.mock('../codex-sdk/session', () => ({
  createChatCodexSession: vi.fn(async (opts: { onContextMeta?: (meta: unknown) => void }) => {
    opts.onContextMeta?.({ systemPromptTokens: 0, mcpSchemasTokens: 0 });
    return {
      threadId: 'thread-1',
      send: (prompt: string, cb: CodexStreamCallbacks, signal: AbortSignal) => h.codexSend!(prompt, cb, signal),
      reply: (prompt: string, cb: CodexStreamCallbacks, signal: AbortSignal) => h.codexSend!(prompt, cb, signal),
      close: vi.fn(),
      isClosed: () => false,
      setModel: vi.fn(),
      setReasoningEffort: vi.fn(),
    };
  }),
}));
vi.mock('../cursor-sdk/session', () => ({
  createChatCursorSession: vi.fn(async () => ({
    resuming: false,
    contextMeta: { systemPromptTokens: 0, toolSchemasTokens: 0 },
    workspace: { workspaceDir: '/tmp/cursor-ws' },
    send: (prompt: string, onEvent: (relayed: { event: unknown }) => void) => h.cursorSend!(prompt, onEvent),
    close: vi.fn(),
  })),
}));
vi.mock('../repo-graph/turn-context', () => ({ getRepoGraphTurnContext: vi.fn(() => null) }));
vi.mock('../repo-graph/validate-root', () => ({ validateRepoRootPath: vi.fn(() => ({ error: 'n/a' })) }));
vi.mock('../repo-graph/minimal-context', () => ({ prefetchRepoGraphTurnContext: vi.fn(async () => null) }));
vi.mock('../codex-chat-spawn-extras', () => ({
  buildChatRepoContextFingerprint: vi.fn(() => ''),
  buildChatThreadConfigSignature: vi.fn(() => 'sig'),
  resolveChatCodexMcpComposition: vi.fn(() => ({})),
}));
vi.mock('../turn-settle', () => ({ registerExternalStopWaiter: vi.fn() }));
vi.mock('../codex-runtime/turn-barrier', () => ({ awaitCodexTurnBarrier: vi.fn(async () => undefined) }));
vi.mock('../codex-runtime/model-capabilities', () => ({
  clampCodexEffortForModelDiscovered: vi.fn((effort: string) => effort),
}));

import * as db from '../db';
import { recordActivity } from '../activity-log';
import { createGrokStreamTranslator } from '../grok-sdk/stream-translator';
import { createKimiStreamTranslator } from '../kimi-sdk/stream-translator';
import { createCodexStreamTranslator } from '../codex-sdk/stream-translator';
import { createCursorStreamTranslator } from '../cursor-sdk/stream-translator';
import { createAccumulator, translateSessionUpdate } from '../kimi-acp/acp-translator';
import { computeTimelineMetrics, resolveCliTimelineOrigin } from '../session-timeline';
import { executeGrokSdkQuery } from '../grok-sdk';
import { executeKimiSdkQuery } from '../kimi-sdk';
import { executeCodexSdkQuery, resetCodexSdkSessionState } from '../codex-sdk';
import { executeCursorSdkQuery } from '../cursor-sdk';

interface RecordedCall {
  op: 'toolCall' | 'toolCallArgs' | 'toolResult';
  ev: { toolUseId: string | null; toolName: string; content: string; isError?: boolean };
}

function fakeHandle(): { handle: TimelineTurnHandle; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const handle: TimelineTurnHandle = {
    runId: 'run-fake',
    persistFailed: false,
    degraded: false,
    user: () => {},
    assistantStep: () => {},
    toolCall: (ev) => calls.push({ op: 'toolCall', ev }),
    toolCallArgs: (ev) => calls.push({ op: 'toolCallArgs', ev }),
    toolResult: (ev) => calls.push({ op: 'toolResult', ev }),
    assistantFinal: () => {},
    metrics: () => {},
    assistantMessage: () => {},
    complete: () => {},
  };
  return { handle, calls };
}

const noop = (): void => {};

function insertedEvents(): Array<{
  kind: string;
  toolUseId: string | null;
  toolName: string | null;
  content: string;
  isError?: boolean;
}> {
  return vi.mocked(db.insertTimelineEvent).mock.calls.map((call) => call[0] as never);
}

function timelineLogs(): Array<Record<string, unknown>> {
  return h.logs
    .filter((entry) => entry.name === 'session-timeline' && entry.args[1] === 'session-timeline: metricas do run (D2)')
    .map((entry) => entry.args[0] as Record<string, unknown>);
}

function completeCalls(): number {
  return vi.mocked(db.setTimelineTurnStatus).mock.calls.filter((call) => call[1] === 'complete').length;
}

function cliResponse(status: CliAgenticResponse['status'], content = 'ok'): CliAgenticResponse {
  return {
    content,
    usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
    toolUses: 0,
    status,
  };
}

function codexResponse(status: CodexResponse['status'], content = 'ok'): CodexResponse {
  return {
    threadId: 'thread-1',
    content,
    filesChanged: [],
    commandsRun: [],
    usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 8 },
    status,
    applyPatchFailures: 0,
    applyPatchFailureSamples: [],
  };
}

const GROK_SELECTION: OrchestratorSelection = {
  runtime: 'grok-sdk',
  provider: 'grok',
  model: 'grok-4.5',
  source: 'settings',
  effort: 'high',
};
const KIMI_SELECTION: OrchestratorSelection = {
  runtime: 'kimi-sdk',
  provider: 'kimi',
  model: 'kimi-code/kimi-for-coding',
  source: 'settings',
};
const CODEX_SELECTION: OrchestratorSelection = {
  runtime: 'codex-sdk',
  provider: 'codex',
  model: 'gpt-5.5',
  source: 'settings',
  effort: 'high',
};
const CURSOR_SELECTION: OrchestratorSelection = {
  runtime: 'cursor-sdk',
  provider: 'cursor',
  model: 'composer-2.5',
  source: 'settings',
};

function options(sessionId: string, overrides?: Partial<QueryOptions>): QueryOptions {
  return { sessionId, silent: true, ...overrides };
}

const runGrok = (o?: Partial<QueryOptions>) =>
  executeGrokSdkQuery('oi', options('sess-grok', o), () => null, undefined, GROK_SELECTION);
const runKimi = (o?: Partial<QueryOptions>) =>
  executeKimiSdkQuery('oi', options('sess-kimi', o), () => null, undefined, KIMI_SELECTION);
const runCodex = (o?: Partial<QueryOptions>) =>
  executeCodexSdkQuery('oi', options('sess-codex', o), () => null, undefined, CODEX_SELECTION);
const runCursor = (o?: Partial<QueryOptions>) =>
  executeCursorSdkQuery('oi', options('sess-cursor', o), () => null, undefined, CURSOR_SELECTION);

beforeEach(() => {
  vi.clearAllMocks();
  h.logs.length = 0;
  resetCodexSdkSessionState();
  h.grokSend = async () => cliResponse('finished');
  h.kimiSend = async () => cliResponse('finished');
  h.codexSend = async () => codexResponse('completed');
  h.cursorSend = async () => ({ status: 'finished', finalText: 'ok', agentId: 'agent-1' });
});

describe('gravacao observada nos translators (handle espiao)', () => {
  it('T-30 Grok: chamada abortada antes do onToolUseIO deixa tool_call sem tool_result', () => {
    const { handle, calls } = fakeHandle();
    const translator = createGrokStreamTranslator({ sessionId: 's', model: 'grok-4.5', emit: noop, timeline: handle });

    translator.callbacks.onToolUse?.('Bash', 'drv-1');
    translator.fail(new Error('abort'));

    expect(calls).toEqual([{ op: 'toolCall', ev: { toolUseId: 'drv-1', toolName: 'Bash', content: '' } }]);
  });

  it('T-32 Grok: tool_call_args depois do tool_call = dois eventos com o mesmo id, nenhum UPDATE', () => {
    const { handle, calls } = fakeHandle();
    const translator = createGrokStreamTranslator({ sessionId: 's', model: 'grok-4.5', emit: noop, timeline: handle });

    translator.callbacks.onToolUse?.('Read', 'drv-2');
    translator.callbacks.onToolUseIO?.('Read', { file_path: 'a.ts' }, 'conteudo', 'drv-2');

    expect(calls.map((c) => c.op)).toEqual(['toolCall', 'toolCallArgs', 'toolResult']);
    expect(calls[0].ev).toEqual({ toolUseId: 'drv-2', toolName: 'Read', content: '' });
    expect(calls[1].ev).toEqual({ toolUseId: 'drv-2', toolName: 'Read', content: '{"file_path":"a.ts"}' });
    expect(calls[2].ev).toEqual({ toolUseId: 'drv-2', toolName: 'Read', content: 'conteudo', isError: false });
    expect(Object.keys(handle)).not.toContain('update');
  });

  it('T-32 Grok: onToolUseIO sem input NAO gera tool_call_args', () => {
    const { handle, calls } = fakeHandle();
    const translator = createGrokStreamTranslator({ sessionId: 's', model: 'grok-4.5', emit: noop, timeline: handle });

    translator.callbacks.onToolUse?.('Grep', 'drv-3');
    translator.callbacks.onToolUseIO?.('Grep', undefined, 'x', 'drv-3');

    expect(calls.map((c) => c.op)).toEqual(['toolCall', 'toolResult']);
  });

  it('T-41 Grok: tool_result orfao (onToolUseIO sem onToolUse) e gravado com o id do driver', () => {
    const { handle, calls } = fakeHandle();
    const translator = createGrokStreamTranslator({ sessionId: 's', model: 'grok-4.5', emit: noop, timeline: handle });

    translator.callbacks.onToolUseIO?.('Bash', { cmd: 'ls' }, 'saida', 'drv-orfao');

    expect(calls.map((c) => c.op)).toEqual(['toolCallArgs', 'toolResult']);
    expect(calls[1].ev).toEqual({ toolUseId: 'drv-orfao', toolName: 'Bash', content: 'saida', isError: false });
  });

  it('T-31 Grok/Kimi: is_error e sempre false, mesmo com exitCode != 0 no result', () => {
    const grok = fakeHandle();
    const grokTranslator = createGrokStreamTranslator({
      sessionId: 's',
      model: 'grok-4.5',
      emit: noop,
      timeline: grok.handle,
    });
    grokTranslator.callbacks.onToolUse?.('Bash', 'g1');
    grokTranslator.callbacks.onToolUseIO?.('Bash', { cmd: 'false' }, { exitCode: 2, success: false }, 'g1');

    const kimi = fakeHandle();
    const kimiTranslator = createKimiStreamTranslator({ sessionId: 's', emit: noop, timeline: kimi.handle });
    kimiTranslator.callbacks.onToolUse?.('Bash', 'k1');
    kimiTranslator.callbacks.onToolUseComplete?.('Bash', { cmd: 'false' }, 'k1');
    kimiTranslator.callbacks.onToolUseIO?.('Bash', { cmd: 'false' }, { exitCode: 2, success: false }, 'k1');

    for (const calls of [grok.calls, kimi.calls]) {
      const results = calls.filter((c) => c.op === 'toolResult');
      expect(results).toHaveLength(1);
      expect(results[0].ev.isError).toBe(false);
    }
  });

  it('T-31 Codex: sem exitCode e success default true = 0; success=false = 1; exitCode 2 = 1', () => {
    const { handle, calls } = fakeHandle();
    const translator = createCodexStreamTranslator({ sessionId: 's', emit: noop, timeline: handle });

    translator.callbacks.onToolUse?.('Bash', { callId: 'c1', kind: 'bash' });
    translator.callbacks.onToolUseComplete?.('Bash', { command: 'ls', output: 'a' }, { callId: 'c1' });
    translator.callbacks.onToolUse?.('Bash', { callId: 'c2', kind: 'bash' });
    translator.callbacks.onToolUseComplete?.('Bash', { command: 'x', success: false }, { callId: 'c2' });
    translator.callbacks.onToolUse?.('Bash', { callId: 'c3', kind: 'bash' });
    translator.callbacks.onToolUseComplete?.('Bash', { command: 'y', exitCode: 2 }, { callId: 'c3' });

    const results = calls.filter((c) => c.op === 'toolResult');
    expect(results.map((c) => [c.ev.toolUseId, c.ev.isError])).toEqual([
      ['c1', false],
      ['c2', true],
      ['c3', true],
    ]);
    expect(calls.filter((c) => c.op === 'toolCallArgs')).toHaveLength(0);
    expect(calls.filter((c) => c.op === 'toolCall').map((c) => c.ev.content)).toEqual(['', '', '']);
  });

  it('T-41 Codex: segundo terminal com o mesmo id e gravado (imutabilidade) sem UPDATE', () => {
    const { handle, calls } = fakeHandle();
    const translator = createCodexStreamTranslator({ sessionId: 's', emit: noop, timeline: handle });

    translator.callbacks.onToolUse?.('Read', { callId: 'dup', kind: 'file' });
    translator.callbacks.onToolUseComplete?.('Read', 'primeiro', { callId: 'dup' });
    translator.callbacks.onToolUseComplete?.('Read', 'segundo', { callId: 'dup' });

    const results = calls.filter((c) => c.op === 'toolResult');
    expect(results.map((c) => [c.ev.toolUseId, c.ev.content])).toEqual([
      ['dup', 'primeiro'],
      ['dup', 'segundo'],
    ]);
  });

  it('T-41 Kimi: dois onToolUse sem id em paralelo geram uuids distintos, nunca NULL', () => {
    const { handle, calls } = fakeHandle();
    const translator = createKimiStreamTranslator({ sessionId: 's', emit: noop, timeline: handle });

    translator.callbacks.onToolUse?.('Read');
    translator.callbacks.onToolUse?.('Grep');

    const ids = calls.filter((c) => c.op === 'toolCall').map((c) => c.ev.toolUseId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toEqual(expect.any(String));
    expect(ids[1]).toEqual(expect.any(String));
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('T-41 Codex: dois onToolUse sem callId em sequencia geram uuids distintos', () => {
    const { handle, calls } = fakeHandle();
    const translator = createCodexStreamTranslator({ sessionId: 's', emit: noop, timeline: handle });

    translator.callbacks.onToolUse?.('Read');
    translator.callbacks.onToolUseComplete?.('Read', 'a');
    translator.callbacks.onToolUse?.('Grep');
    translator.callbacks.onToolUseComplete?.('Grep', 'b');

    const toolCalls = calls.filter((c) => c.op === 'toolCall');
    const results = calls.filter((c) => c.op === 'toolResult');
    expect(toolCalls[0].ev.toolUseId).not.toBeNull();
    expect(toolCalls[0].ev.toolUseId).not.toBe(toolCalls[1].ev.toolUseId);
    expect(results[0].ev.toolUseId).toBe(toolCalls[0].ev.toolUseId);
    expect(results[1].ev.toolUseId).toBe(toolCalls[1].ev.toolUseId);
  });

  it('Kimi: onToolUseComplete NAO grava na timeline; onToolUseIO grava args e result pelo id do ACP', () => {
    const { handle, calls } = fakeHandle();
    const translator = createKimiStreamTranslator({ sessionId: 's', emit: noop, timeline: handle });

    translator.callbacks.onToolUse?.('Read', 'tc_1');
    translator.callbacks.onToolUseComplete?.('Read', { path: 'a.ts' }, 'tc_1');
    expect(calls.map((c) => c.op)).toEqual(['toolCall']);

    translator.callbacks.onToolUseIO?.('Read', { path: 'a.ts' }, 'export const x = 1;', 'tc_1');
    expect(calls.map((c) => c.op)).toEqual(['toolCall', 'toolCallArgs', 'toolResult']);
    expect(calls[1].ev).toEqual({ toolUseId: 'tc_1', toolName: 'Read', content: '{"path":"a.ts"}' });
    expect(calls[2].ev).toEqual({
      toolUseId: 'tc_1',
      toolName: 'Read',
      content: 'export const x = 1;',
      isError: false,
    });
  });

  it('T-22 Cursor: settlePending grava "interrompido" com is_error e settledPending() vira true', () => {
    const { handle, calls } = fakeHandle();
    const emitted: Array<{ type: string }> = [];
    const translator = createCursorStreamTranslator({
      sessionId: 's',
      model: 'composer-2.5',
      emit: (chunk) => emitted.push(chunk),
      timeline: handle,
    });

    translator.onEvent({
      type: 'tool_call',
      call_id: 'call-1',
      name: 'Read',
      status: 'running',
      args: { file_path: 'a.ts' },
    });
    translator.onEvent({
      type: 'tool_call',
      call_id: 'call-1',
      name: 'Read',
      status: 'running',
      args: { file_path: 'a.ts' },
    });
    expect(translator.settledPending()).toBe(false);
    translator.finalize({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });

    expect(calls).toEqual([
      { op: 'toolCall', ev: { toolUseId: 'call-1', toolName: 'Read', content: '{"file_path":"a.ts"}' } },
      { op: 'toolResult', ev: { toolUseId: 'call-1', toolName: 'Read', content: 'interrompido', isError: true } },
    ]);
    expect(translator.settledPending()).toBe(true);
    expect(emitted.map((c) => c.type)).toEqual(['tool_call', 'tool_result', 'usage', 'done']);
  });

  it('Cursor: terminal completed/error grava tool_result com isError = (status === "error")', () => {
    const { handle, calls } = fakeHandle();
    const translator = createCursorStreamTranslator({
      sessionId: 's',
      model: 'composer-2.5',
      emit: noop,
      timeline: handle,
    });

    translator.onEvent({ type: 'tool_call', call_id: 'ok', name: 'Read', status: 'running', args: {} });
    translator.onEvent({ type: 'tool_call', call_id: 'ok', name: 'Read', status: 'completed', result: { text: 'a' } });
    translator.onEvent({ type: 'tool_call', call_id: 'bad', name: 'Bash', status: 'running', args: {} });
    translator.onEvent({ type: 'tool_call', call_id: 'bad', name: 'Bash', status: 'error', result: 'boom' });
    translator.finalize({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });

    const results = calls.filter((c) => c.op === 'toolResult');
    expect(results.map((c) => [c.ev.toolUseId, c.ev.content, c.ev.isError])).toEqual([
      ['ok', '{"text":"a"}', false],
      ['bad', 'boom', true],
    ]);
    expect(translator.settledPending()).toBe(false);
  });

  it('gravacao falhando no handle nunca afeta o emit para a UI', () => {
    const emitted: Array<{ type: string }> = [];
    const broken: TimelineTurnHandle = {
      ...fakeHandle().handle,
      toolCall: () => {
        throw new Error('db down');
      },
      toolResult: () => {
        throw new Error('db down');
      },
    };
    const translator = createGrokStreamTranslator({
      sessionId: 's',
      model: 'grok-4.5',
      emit: (chunk) => emitted.push(chunk),
      timeline: broken,
    });

    expect(() => {
      translator.callbacks.onToolUse?.('Read', 'd');
      translator.callbacks.onToolUseIO?.('Read', { a: 1 }, 'r', 'd');
    }).not.toThrow();
    expect(emitted.map((c) => c.type)).toContain('tool_call');
    expect(emitted.map((c) => c.type)).toContain('tool_result');
  });
});

describe('T-21 Kimi ACP: dois Reads intercalados com completes fora de ordem, atravessando o wrapper de kimi-sdk/index.ts', () => {
  it('tool_call com id do ACP, tool_call_args e tool_result pareados por id (result = rawOutput)', async () => {
    const updates: AcpSessionUpdate[] = [
      { sessionUpdate: 'tool_call', toolCallId: 'tc_a', title: 'Read', rawInput: { path: 'a.ts' } },
      { sessionUpdate: 'tool_call', toolCallId: 'tc_b', title: 'Read', rawInput: { path: 'b.ts' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc_b', status: 'completed', rawOutput: 'B!' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc_a', status: 'completed', rawOutput: 'A!' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pronto' } },
    ];
    h.kimiSend = async (_prompt, cb) => {
      const acc = createAccumulator('sess-kimi');
      for (const update of updates) translateSessionUpdate(update, acc, { callbacks: cb });
      return { ...cliResponse('finished', acc.content), toolUses: acc.toolUses };
    };

    await runKimi();

    const events = insertedEvents().map((e) => [e.kind, e.toolUseId, e.content]);
    expect(events).toEqual([
      ['tool_call', 'tc_a', ''],
      ['tool_call', 'tc_b', ''],
      ['tool_call_args', 'tc_b', '{"path":"b.ts"}'],
      ['tool_result', 'tc_b', 'B!'],
      ['tool_call_args', 'tc_a', '{"path":"a.ts"}'],
      ['tool_result', 'tc_a', 'A!'],
    ]);
    expect(
      insertedEvents()
        .filter((e) => e.kind === 'tool_result')
        .every((e) => e.isError === false),
    ).toBe(true);
    expect(completeCalls()).toBe(1);

    const activities = vi
      .mocked(recordActivity)
      .mock.calls.map((call) => call[2])
      .filter((ev) => ev.kind === 'tool')
      .map((ev) => ({ id: ev.id, phase: ev.phase }));
    expect(activities.map((a) => a.phase)).toEqual(['start', 'start', 'end', 'end']);
    const startIds = activities.filter((a) => a.phase === 'start').map((a) => a.id);
    const endIds = activities.filter((a) => a.phase === 'end').map((a) => a.id);
    expect(endIds).toEqual([startIds[1], startIds[0]]);
    expect(new Set(activities.map((a) => a.id)).size).toBe(2);
  });
});

describe('T-41 matriz de desfecho nos index.ts reais', () => {
  it.each([
    ['finished', 1],
    ['cancelled', 0],
    ['max_steps_reached', 0],
  ] as const)('Grok: status %s -> complete chamado %i vez(es)', async (status, expected) => {
    h.grokSend = async () => cliResponse(status);
    await runGrok();
    expect(db.insertTimelineTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-grok',
        runtime: 'grok',
        fidelity: 'observed',
        origin: 'turn',
        anchorMessageId: 7,
        currentUserMessageId: 7,
        cwd: '/tmp/grok',
        turnIndex: 3,
      }),
    );
    expect(completeCalls()).toBe(expected);
    expect(timelineLogs()).toHaveLength(1);
    expect(timelineLogs()[0].status).toBe(expected === 1 ? 'complete' : 'interrupted');
  });

  it.each([
    ['finished', 1],
    ['cancelled', 0],
    ['max_steps_reached', 0],
  ] as const)('Kimi: status %s -> complete chamado %i vez(es)', async (status, expected) => {
    h.kimiSend = async () => cliResponse(status);
    await runKimi();
    expect(db.insertTimelineTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-kimi',
        runtime: 'kimi',
        fidelity: 'observed',
        origin: 'turn',
        anchorMessageId: 7,
        cwd: '/lionclaw/agents-home',
      }),
    );
    expect(completeCalls()).toBe(expected);
    expect(timelineLogs()[0].status).toBe(expected === 1 ? 'complete' : 'interrupted');
  });

  it.each([
    ['completed', 1],
    ['failed', 0],
    ['timeout', 0],
    ['auth_required', 0],
  ] as const)('Codex: status %s -> complete chamado %i vez(es)', async (status, expected) => {
    h.codexSend = async () => codexResponse(status);
    await runCodex();
    expect(db.insertTimelineTurn).toHaveBeenCalledTimes(1);
    expect(db.insertTimelineTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-codex',
        runtime: 'codex',
        fidelity: 'observed',
        origin: 'turn',
        anchorMessageId: 7,
        cwd: '/lionclaw/agents-home',
      }),
    );
    expect(completeCalls()).toBe(expected);
    expect(timelineLogs()).toHaveLength(1);
    expect(timelineLogs()[0].status).toBe(expected === 1 ? 'complete' : 'interrupted');
  });

  it('Codex: session.reply/send recebe apenas o prompt e nenhum tool_call_args e gravado', async () => {
    let receivedPrompt: unknown;
    h.codexSend = async (prompt, cb) => {
      receivedPrompt = prompt;
      cb.onToolUse?.('Bash', { callId: 'c1', kind: 'bash' });
      cb.onToolUseComplete?.('Bash', { command: 'ls', exitCode: 0 }, { callId: 'c1' });
      return codexResponse('completed');
    };
    await runCodex();
    expect(typeof receivedPrompt).toBe('string');
    expect(insertedEvents().map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
    expect(insertedEvents()[0].content).toBe('');
  });

  it('Cursor: fim normal conclui; status cancelled e settlePending ficam interrupted', async () => {
    await runCursor();
    expect(db.insertTimelineTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-cursor',
        runtime: 'cursor',
        fidelity: 'observed',
        origin: 'turn',
        cwd: '/tmp/cursor-ws',
      }),
    );
    expect(completeCalls()).toBe(1);

    vi.clearAllMocks();
    h.logs.length = 0;
    h.cursorSend = async () => ({ status: 'cancelled', finalText: '' });
    await runCursor();
    expect(completeCalls()).toBe(0);
    expect(timelineLogs()[0].status).toBe('interrupted');

    vi.clearAllMocks();
    h.logs.length = 0;
    h.cursorSend = async (_prompt, onEvent) => {
      onEvent({
        event: { type: 'tool_call', call_id: 'c-open', name: 'Read', status: 'running', args: { file_path: 'a.ts' } },
      });
      return { status: 'finished', finalText: 'ok' };
    };
    await runCursor();
    expect(insertedEvents().map((e) => [e.kind, e.toolUseId, e.content, e.isError])).toEqual([
      ['tool_call', 'c-open', '{"file_path":"a.ts"}', undefined],
      ['tool_result', 'c-open', 'interrompido', true],
    ]);
    expect(completeCalls()).toBe(0);
    expect(timelineLogs()[0].status).toBe('interrupted');
  });

  it('abort local durante o send deixa o run interrupted (Grok)', async () => {
    const { stopGrokSdkQuery } = await import('../grok-sdk');
    h.grokSend = (_prompt, _cb, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(cliResponse('cancelled')), { once: true });
      });
    const run = runGrok();
    await new Promise((r) => setImmediate(r));
    stopGrokSdkQuery();
    await run;
    expect(completeCalls()).toBe(0);
    expect(timelineLogs()[0].status).toBe('interrupted');
  });

  it('origem: system-event, swarm e lanes sem user viram runs com anchor NULL', () => {
    expect(
      resolveCliTimelineOrigin({
        laneKind: 'desktop',
        origin: 'system-event',
        swarmDelivery: false,
        forceNewSession: false,
        persistedUserMessageId: null,
      }),
    ).toBe('system-event');
    expect(
      resolveCliTimelineOrigin({
        laneKind: 'desktop',
        origin: 'user',
        swarmDelivery: true,
        forceNewSession: false,
        persistedUserMessageId: 7,
      }),
    ).toBe('swarm');
    expect(
      resolveCliTimelineOrigin({
        laneKind: 'desktop',
        origin: 'user',
        swarmDelivery: false,
        forceNewSession: true,
        persistedUserMessageId: 7,
      }),
    ).toBe('retry');
    expect(
      resolveCliTimelineOrigin({
        laneKind: 'telegram',
        origin: 'user',
        swarmDelivery: false,
        forceNewSession: false,
        persistedUserMessageId: 7,
      }),
    ).toBe('turn');
    expect(
      resolveCliTimelineOrigin({
        laneKind: 'telegram',
        origin: 'user',
        swarmDelivery: false,
        forceNewSession: false,
        persistedUserMessageId: null,
      }),
    ).toBe('telegram');
    expect(
      resolveCliTimelineOrigin({
        laneKind: 'cron',
        origin: undefined,
        swarmDelivery: false,
        forceNewSession: false,
        persistedUserMessageId: null,
      }),
    ).toBe('cron');
    expect(
      resolveCliTimelineOrigin({
        laneKind: 'desktop',
        origin: undefined,
        swarmDelivery: false,
        forceNewSession: false,
        persistedUserMessageId: null,
      }),
    ).toBe('turn');
  });

  it('system-event: o index.ts grava anchor NULL e currentUserMessageId NULL', async () => {
    await runGrok({ origin: 'system-event' });
    expect(db.insertTimelineTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'system-event',
        anchorMessageId: null,
        currentUserMessageId: null,
      }),
    );
  });
});

describe('T-42 metricas e logTimelineMetrics nos quatro index.ts', () => {
  function expectMetricsLog(runtime: string, status: string): Record<string, unknown> {
    const logs = timelineLogs();
    expect(logs).toHaveLength(1);
    const entry = logs[0];
    expect(entry.runId).toEqual(expect.any(String));
    expect(entry.runtime).toBe(runtime);
    expect(entry.status).toBe(status);
    expect(entry.textTokensEst).toBeNull();
    expect(entry.ratio).toBeNull();
    expect(typeof entry.toolTokensEst).toBe('number');
    return entry;
  }

  it('args contados uma vez: tool_call vazio + tool_call_args com o mesmo id (Grok)', () => {
    const argsContent = '{"file_path":"' + 'x'.repeat(100) + '"}';
    const metrics = computeTimelineMetrics('grok', [
      { kind: 'tool_call', toolUseId: 'd1', content: '', toolCallsJson: null, reasoningContent: null },
      { kind: 'tool_call_args', toolUseId: 'd1', content: argsContent, toolCallsJson: null, reasoningContent: null },
      { kind: 'tool_result', toolUseId: 'd1', content: 'r'.repeat(40), toolCallsJson: null, reasoningContent: null },
    ]);
    expect(metrics.textTokensEst).toBeNull();
    expect(metrics.toolTokensEst).toBe(Math.ceil(argsContent.length / 4) + 10);
  });

  it('Grok: sucesso, interrupcao e persistFailed', async () => {
    h.grokSend = async (_prompt, cb) => {
      cb.onToolUse?.('Read', 'd1');
      cb.onToolUseIO?.('Read', { file_path: 'a.ts' }, 'conteudo'.repeat(10), 'd1');
      return cliResponse('finished');
    };
    await runGrok();
    const ok = expectMetricsLog('grok', 'complete');
    expect(ok.toolTokensEst as number).toBeGreaterThan(0);
    expect(db.setTimelineTurnMetrics).toHaveBeenCalledWith(ok.runId, null, ok.toolTokensEst);

    vi.clearAllMocks();
    h.logs.length = 0;
    h.grokSend = async () => cliResponse('cancelled');
    await runGrok();
    expectMetricsLog('grok', 'interrupted');

    vi.clearAllMocks();
    h.logs.length = 0;
    vi.mocked(db.insertTimelineEvent).mockImplementationOnce(() => {
      throw new Error('disk cheio');
    });
    h.grokSend = async (_prompt, cb) => {
      cb.onToolUse?.('Read', 'd1');
      cb.onToolUseIO?.('Read', { file_path: 'a.ts' }, 'x', 'd1');
      return cliResponse('finished');
    };
    await runGrok();
    expectMetricsLog('grok', 'interrupted');
    expect(completeCalls()).toBe(0);
  });

  it('Kimi: sucesso, interrupcao e persistFailed', async () => {
    h.kimiSend = async (_prompt, cb) => {
      cb.onToolUse?.('Read', 'tc1');
      cb.onToolUseComplete?.('Read', { path: 'a.ts' }, 'tc1');
      cb.onToolUseIO?.('Read', { path: 'a.ts' }, 'conteudo'.repeat(10), 'tc1');
      return cliResponse('finished');
    };
    await runKimi();
    const ok = expectMetricsLog('kimi', 'complete');
    expect(ok.toolTokensEst as number).toBeGreaterThan(0);

    vi.clearAllMocks();
    h.logs.length = 0;
    h.kimiSend = async () => cliResponse('max_steps_reached');
    await runKimi();
    expectMetricsLog('kimi', 'interrupted');

    vi.clearAllMocks();
    h.logs.length = 0;
    vi.mocked(db.setTimelineTurnMetrics).mockImplementationOnce(() => {
      throw new Error('disk cheio');
    });
    h.kimiSend = async () => cliResponse('finished');
    await runKimi();
    expectMetricsLog('kimi', 'interrupted');
    expect(completeCalls()).toBe(0);
  });

  it('Codex: sucesso (args ausentes), interrupcao e persistFailed', async () => {
    h.codexSend = async (_prompt, cb) => {
      cb.onToolUse?.('Bash', { callId: 'c1', kind: 'bash' });
      cb.onToolUseComplete?.('Bash', { command: 'ls', output: 'a'.repeat(40) }, { callId: 'c1' });
      return codexResponse('completed');
    };
    await runCodex();
    const ok = expectMetricsLog('codex', 'complete');
    expect(ok.toolTokensEst as number).toBeGreaterThan(0);

    vi.clearAllMocks();
    h.logs.length = 0;
    resetCodexSdkSessionState();
    h.codexSend = async () => codexResponse('timeout');
    await runCodex();
    expectMetricsLog('codex', 'interrupted');

    vi.clearAllMocks();
    h.logs.length = 0;
    resetCodexSdkSessionState();
    vi.mocked(db.insertTimelineEvent).mockImplementationOnce(() => {
      throw new Error('disk cheio');
    });
    h.codexSend = async (_prompt, cb) => {
      cb.onToolUse?.('Bash', { callId: 'c1', kind: 'bash' });
      cb.onToolUseComplete?.('Bash', 'ok', { callId: 'c1' });
      return codexResponse('completed');
    };
    await runCodex();
    expectMetricsLog('codex', 'interrupted');
    expect(completeCalls()).toBe(0);
  });

  it('Cursor: sucesso, interrupcao e persistFailed', async () => {
    h.cursorSend = async (_prompt, onEvent) => {
      onEvent({
        event: { type: 'tool_call', call_id: 'c1', name: 'Read', status: 'running', args: { file_path: 'a.ts' } },
      });
      onEvent({
        event: { type: 'tool_call', call_id: 'c1', name: 'Read', status: 'completed', result: 'x'.repeat(40) },
      });
      return { status: 'finished', finalText: 'ok' };
    };
    await runCursor();
    const ok = expectMetricsLog('cursor', 'complete');
    expect(ok.toolTokensEst as number).toBeGreaterThan(0);

    vi.clearAllMocks();
    h.logs.length = 0;
    h.cursorSend = async () => ({ status: 'error', finalText: '', errorMessage: 'boom' });
    await runCursor();
    expectMetricsLog('cursor', 'interrupted');

    vi.clearAllMocks();
    h.logs.length = 0;
    vi.mocked(db.insertTimelineEvent).mockImplementationOnce(() => {
      throw new Error('disk cheio');
    });
    h.cursorSend = async (_prompt, onEvent) => {
      onEvent({ event: { type: 'tool_call', call_id: 'c1', name: 'Read', status: 'running', args: {} } });
      onEvent({ event: { type: 'tool_call', call_id: 'c1', name: 'Read', status: 'completed', result: 'x' } });
      return { status: 'finished', finalText: 'ok' };
    };
    await runCursor();
    expectMetricsLog('cursor', 'interrupted');
    expect(completeCalls()).toBe(0);
  });
});

import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import type { ChatMessage, TimelineTurnWithEvents } from '../../../src/types';
import type { SummaryRow } from '../lion-sdk/compaction/db';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SdkLane } from '../sdk-lane';
import type { LionAdapter, LionChatMessage, LionStreamRequest } from '../lion-sdk/adapters/types';
const h = vi.hoisted(() => ({
  enabled: true,
  messages: [] as ChatMessage[],
  cache: new Map<string, SummaryRow>(),
  warn: vi.fn(),
}));
vi.mock('../db', () => ({ getSessionMessages: () => h.messages }));
vi.mock('../logger', () => ({ createLogger: () => ({ warn: h.warn, info: vi.fn(), error: vi.fn() }) }));
vi.mock('../chat-compaction-trigger', () => ({ isChatTimelineReinjectEnabled: () => h.enabled }));
vi.mock('../lion-sdk/compaction/db', () => ({
  getCachedSummary: vi.fn((sid: string, id: number, mode: string, hash: string) =>
    h.cache.get(JSON.stringify([sid, id, mode, hash])),
  ),
  saveCachedSummary: vi.fn((sid: string, id: number, mode: SummaryRow['mode'], hash: string, text: string) => {
    h.cache.set(JSON.stringify([sid, id, mode, hash]), {
      session_id: sid,
      covers_until_message_id: id,
      mode,
      selection_hash: hash,
      summary_text: text,
      model_used: 'test',
      provider_used: 'ollama',
      input_tokens: 0,
      output_tokens: 0,
      created_at: 0,
    });
  }),
}));
import { compactIfNeeded, estimateTimelineIntervalTokens } from '../lion-sdk/compaction';
import { getCachedSummary, saveCachedSummary } from '../lion-sdk/compaction/db';
import { groupMessageIntervals } from '../session-timeline';
import { message, run } from './session-timeline-lion-fixtures';
let runs: TimelineTurnWithEvents[];
let summary: string;
const requests: LionStreamRequest[] = [];
const adapter: LionAdapter = {
  name: 'ollama',
  async *streamCompletion(req) {
    requests.push(req);
    yield { type: 'text', delta: summary };
  },
};
function fixture(count: number, size = 1000) {
  runs = Array.from({ length: count }, (_, i) => run(i * 2 + 1));
  for (const r of runs) r.events[2].content = 'x'.repeat(size);
  h.messages = Array.from({ length: count * 2 }, (_, i) => message(i + 1, i % 2 ? 'assistant' : 'user'));
}
function compact(maxContextTokens = 2000, newUserMsg = 'next') {
  return compactIfNeeded({
    sessionId: 's',
    newUserMsg,
    retryWithoutPersistedUser: true,
    systemPrompt: 'system',
    primaryAdapter: adapter,
    primaryModel: 'test',
    primaryProvider: 'ollama',
    maxContextTokens,
    thresholdRatio: 0.5,
    timeline: { runs, excludeUserMessageId: null, fence: null },
    emitChunk: vi.fn(),
  });
}
describe('local timeline compaction', () => {
  beforeEach(() => {
    h.enabled = true;
    h.messages = [];
    h.cache.clear();
    requests.length = 0;
    runs = [];
    summary = 'Bash summary';
    vi.clearAllMocks();
  });
  it('T-01 preserves irregular text history and the retry exception with the setting off', async () => {
    h.enabled = false;
    h.messages = [
      message(1, 'user'),
      message(2, 'user'),
      message(3, 'assistant'),
      message(4, 'assistant'),
      message(5, 'user', 'current'),
    ];
    const opts = {
      sessionId: 's',
      newUserMsg: 'seed',
      systemPrompt: '',
      primaryAdapter: adapter,
      primaryModel: 'test',
      primaryProvider: 'ollama',
      emitChunk: vi.fn(),
    };
    expect((await compactIfNeeded(opts)).messages).toStrictEqual([
      ...h.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: 'seed' },
    ]);
    expect((await compactIfNeeded({ ...opts, retryWithoutPersistedUser: true })).messages).toStrictEqual([
      ...h.messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: 'seed' },
    ]);
  });
  it('T-23 retains whole tool exchanges and keeps tools and text caches together', async () => {
    fixture(8);
    const result = await compact();
    expect(result.compacted).toBe(true);
    expect(getCachedSummary).toHaveBeenCalledWith('s', 3, 'tools', expect.any(String));
    expect(requests[0].messages[0].content.match(/Tools:/g)).toHaveLength(2);
    for (let i = 0; i < result.messages.length; i++)
      if (result.messages[i].tool_calls) expect(result.messages[i + 1].role).toBe('tool');
    h.enabled = false;
    for (const m of h.messages) m.content = 'long'.repeat(300);
    await compact();
    expect([...h.cache.values()].map((row) => row.mode)).toEqual(['tools', 'text']);
  });
  it('T-24 drops oldest retained intervals without splitting the last one', async () => {
    fixture(6);
    const result = await compact();
    expect(result.messages.filter((m) => m.role === 'tool').length).toBeLessThan(6);
    const requestTokens = result.messages.reduce(
      (sum, m) =>
        sum +
        Math.ceil(m.content.length / 4) +
        Math.ceil((m.reasoning_content?.length ?? 0) / 4) +
        Math.ceil((m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) / 4),
      Math.ceil('system'.length / 4),
    );
    expect(requestTokens).toBeLessThanOrEqual(1000);
    expect(result.messages.filter((m) => m.role === 'tool').at(-1)?.content).toBe(runs[5].events[2].content);
    fixture(1, 10000);
    expect((await compact()).messages.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(h.warn).toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    expect(saveCachedSummary).not.toHaveBeenCalled();
  });
  it('T-28 returns every native block below threshold and counts D17 extras', async () => {
    fixture(2, 1);
    h.messages.push(message(5, 'assistant', 'extra'));
    const result = await compact(100000);
    expect(result.compacted).toBe(false);
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
    expect(result.messages.at(-2)?.content).toBe('extra');
    expect(requests).toHaveLength(0);
    const interval = groupMessageIntervals(h.messages)[1];
    expect(estimateTimelineIntervalTokens(interval, [runs[1]])).toBeGreaterThan(
      estimateTimelineIntervalTokens({ ...interval, messages: interval.messages.slice(0, -1) }, [runs[1]]),
    );
  });
  it.each(['results', 'extra assistant'])('T-29 short text crosses threshold only because of %s', async (source) => {
    fixture(8, 1);
    expect((await compact()).compacted).toBe(false);
    if (source === 'results') runs[0].events[2].content = 'x'.repeat(8000);
    else h.messages.splice(2, 0, { ...message(100, 'assistant', 'x'.repeat(8000)), createdAt: '2026-01-01' });
    expect((await compact()).compacted).toBe(true);
    expect(requests).toHaveLength(1);
  });
  it('T-38 handles empty history, one huge interval, and a huge summary', async () => {
    expect((await compact(2000, 'x'.repeat(8000))).messages).toHaveLength(1);
    fixture(1, 8000);
    expect((await compact()).messages.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(requests).toHaveLength(0);
    expect(saveCachedSummary).not.toHaveBeenCalled();
    fixture(8);
    summary = 's'.repeat(8000);
    const result = await compact();
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(result.messages[0].content).toContain(summary);
    expect(h.warn).toHaveBeenCalledTimes(3);
  });
  it('respects fence and current-user exclusion before estimating and serializing', async () => {
    fixture(3, 8000);
    const result = await compactIfNeeded({
      sessionId: 's',
      newUserMsg: 'seed',
      systemPrompt: '',
      primaryAdapter: adapter,
      primaryModel: 'test',
      primaryProvider: 'ollama',
      maxContextTokens: 100000,
      timeline: { runs, fence: 2, excludeUserMessageId: 5 },
      emitChunk: vi.fn(),
    });
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(result.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['effective', 'seed']);
  });
  it('appends the older tools block to the user when no assistant was persisted', async () => {
    fixture(7, 8000);
    h.messages = h.messages.filter((m) => m.id !== 2);
    runs[0].assistantMessageId = null;
    await compact();
    expect(requests[0].messages[0].content).toContain('[USER]: message-1\n\nTools:');
    expect(requests[0].messages[0].content.match(/Tools:/g)).toHaveLength(1);
  });
  it('T-39 a newly selected run changes the hash and leaves the prior cache entry', async () => {
    fixture(8);
    await compact();
    const first = [...h.cache.keys()][0];
    await compact();
    expect(requests).toHaveLength(1);
    runs.push(run(1, { seqId: 99 }));
    await compact();
    expect(requests).toHaveLength(2);
    expect(h.cache.size).toBe(2);
    expect(h.cache.has(first)).toBe(true);
    expect(vi.mocked(saveCachedSummary).mock.calls[0][3]).not.toBe(vi.mocked(saveCachedSummary).mock.calls[1][3]);
  });
});

describe('real lion context persistence', () => {
  const context = {
    root: '',
    opened: false,
    requests: [] as LionChatMessage[][],
    summaries: [] as string[],
    round: 0,
    logs: vi.fn(),
  };
  let executeLionSdkQuery: typeof import('../lion-sdk').executeLionSdkQuery;
  let initDatabase: typeof import('../db').initDatabase;
  let getDb: typeof import('../db').getDb;
  let createSession: typeof import('../db').createSession;
  let getSession: typeof import('../db').getSession;
  let setSetting: typeof import('../db').setSetting;

  beforeAll(async () => {
    vi.resetModules();
    vi.doUnmock('../db');
    vi.doUnmock('../lion-sdk/compaction/db');
    vi.doUnmock('../chat-compaction-trigger');
    vi.doMock('../logger', () => ({
      createLogger: () => ({ info: context.logs, error: context.logs, warn: context.logs, debug: context.logs }),
    }));
    vi.doMock('../paths', () => ({ getAgentCwd: () => context.root, getLionClawHome: () => context.root }));
    vi.doMock('../chat-compaction-inplace', () => ({ compactChatSessionInPlace: vi.fn() }));
    vi.doMock('../lion-sdk/adapters/ollama', () => ({
      createOllamaAdapter: (): LionAdapter => ({
        name: 'ollama',
        async *streamCompletion(req: LionStreamRequest) {
          if (req.messages.length === 1) {
            context.summaries.push(req.messages[0].content);
            yield { type: 'text', delta: 'Tools: Write() -> written' };
            return;
          }
          context.requests.push(structuredClone(req.messages));
          yield { type: 'usage', usage: { inputTokens: JSON.stringify(req.messages).length, outputTokens: 1 } };
          if (context.round++ % 2 === 0)
            yield {
              type: 'tool_call_delta',
              toolCalls: [
                {
                  id: `c${context.round}`,
                  type: 'function',
                  function: { name: 'Write', arguments: '{"file_path":"/test","content":"test"}' },
                },
              ],
            };
          else yield { type: 'text', delta: 'done' };
        },
      }),
    }));
    vi.doMock('../lion-sdk/adapters/lmstudio', () => ({ createLmStudioAdapter: vi.fn() }));
    vi.doMock('../lion-sdk/adapters/openai-compatible', () => ({ createOpenAiCompatibleAdapter: vi.fn() }));
    vi.doMock('../lion-sdk/adapters/google-genai', () => ({ createGoogleGenAiAdapter: vi.fn() }));
    vi.doMock('../lion-sdk/tools/filesystem', () => ({
      createSessionFsState: vi.fn(() => ({})),
      lionRead: vi.fn(),
      lionEdit: vi.fn(),
      lionGlob: vi.fn(),
      lionGrep: vi.fn(),
      lionWrite: vi.fn(async () => ({ isError: false, value: 'w'.repeat(12000) })),
    }));
    vi.doMock('../lion-sdk/tools/bash', () => ({ lionBash: vi.fn() }));
    vi.doMock('../lion-sdk/tools/skill', () => ({ lionSkillLoad: vi.fn() }));
    vi.doMock('../lion-sdk/tools/agent', () => ({ lionAgentDispatch: vi.fn(), PIPELINE_INTERNAL_SQUADS: new Set() }));
    vi.doMock('../lion-sdk/tools/mcp', () => ({ lionMcpCall: vi.fn(), lionMcpCallViaWrapper: vi.fn() }));
    vi.doMock('../lion-sdk/tools/ask-user', () => ({ lionAskUserQuestion: vi.fn() }));
    vi.doMock('../lion-sdk/tools/memory', () => ({ lionMemorySearch: vi.fn() }));
    vi.doMock('../lion-sdk/runtime-context', () => ({ buildLionRuntimeContextPrompt: () => '' }));
    vi.doMock('../lion-sdk/title', () => ({ maybeGenerateLionSessionTitle: vi.fn(async () => {}) }));
    vi.doMock('../lion-sdk/stream-translator', () => ({
      mcpToolLabel: vi.fn(),
      createLionStreamTranslator: vi.fn(() => ({
        emitText: vi.fn(),
        emitError: vi.fn(),
        emitDone: vi.fn(),
        emitUsage: vi.fn(),
        emitContextUsage: vi.fn(),
        emitToolCall: vi.fn(),
        emitToolResult: vi.fn(),
      })),
    }));
    vi.doMock('../chat-context-usage', () => ({ resolveLionContextWindowTokens: () => 100000 }));
    vi.doMock('../pricing', () => ({ calculateCost: () => 0 }));
    vi.doMock('../title-generator', () => ({ ensureInitialSessionTitle: vi.fn() }));
    vi.doMock('../skills', () => ({ listSkills: () => [] }));
    vi.doMock('../mcp-manager', () => ({ getMCPConfigForAgent: async () => ({}), getMCPToolsFromRegistry: () => [] }));
    vi.doMock('../mcp-tool-bridge', () => ({ setupMCPsForSession: vi.fn(), teardownMCPsForSession: vi.fn() }));
    vi.doMock('../mcp-tool-index', () => ({ buildMcpToolIndex: () => '', buildDirectHelperCatalog: () => '' }));
    vi.doMock('../prompt-builder', () => ({
      buildSystemPrompt: () => '',
      buildPipelineControlSection: () => '',
      buildPipelineControlStub: () => '',
      getSubagentsPromptMode: () => 'index',
    }));
    vi.doMock('../prompt-builder-repo-graph', () => ({ getRepoGraphPromptSection: () => '' }));
    vi.doMock('../repo-graph/turn-context', () => ({ getRepoGraphTurnContext: () => null }));
    vi.doMock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
    vi.doMock('../smoke-audit', () => ({ smokeAudit: vi.fn() }));
    vi.doMock('../swarm/chat-persistence', () => ({ persistSwarmResponse: vi.fn(() => false) }));
    vi.doMock('../chat-capability-context', () => ({
      getActiveChatTurnBinding: () => undefined,
      getChatCapabilityTurn: vi.fn(),
      computeEffectiveCapabilitiesForTurn: vi.fn(),
    }));
    vi.doMock('../agent-runtime/subagent-dispatch', () => ({
      createSubagentDispatchContext: () => ({}),
      pendingSubagentProviderAuthError: vi.fn(() => null),
      isSubagentProviderAuthError: () => false,
      subagentAuthFailure: vi.fn(),
    }));
    vi.doMock('../onboarding', () => ({
      extractAndProcessOnboardingData: vi.fn(() => null),
      resolveOnboardingCompletedFromState: () => false,
      completeOnboardingFromConversationMessages: vi.fn(),
      completeOnboardingFromUserProfileMessage: vi.fn(),
    }));
    ({ executeLionSdkQuery } = await import('../lion-sdk'));
    ({ initDatabase, getDb, createSession, getSession, setSetting } = await import('../db'));
    context.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lion-timeline-context-'));
    initDatabase();
    context.opened = true;
    setSetting('onboarding_completed', 'true');
    setSetting('chat_timeline_reinject_enabled', 'true');
    setSetting('chat_auto_compaction_enabled', 'false');
  });
  afterAll(() => {
    if (context.opened) getDb().close();
    const root = path.resolve(context.root);
    if (
      !root.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(root).startsWith('lion-timeline-context-')
    )
      throw new Error('Unexpected test directory');
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function turn(sessionId: string): Promise<number> {
    const lane: SdkLane = { name: 'test', kind: 'desktop', currentAbortController: null, sdkActiveSessionId: null };
    await executeLionSdkQuery('fixed user', { sessionId }, () => null, lane, {
      runtime: 'lion-sdk',
      provider: 'ollama',
      model: 'test-model',
      source: 'settings',
    });
    const value = getSession(sessionId)?.activeContextTokensEst;
    expect(value, JSON.stringify(context.logs.mock.calls)).toBeGreaterThan(0);
    return value!;
  }
  it('T-12 persists growing active_context_tokens_est over five tool turns with compaction disabled', async () => {
    createSession('growth', 'title');
    const values: number[] = [];
    for (let i = 0; i < 5; i++) values.push(await turn('growth'));
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    expect(
      context.requests
        .filter((_, i) => i % 2 === 0)
        .map((messages) => messages[0].content)
        .every((content) => content === context.requests[0][0].content),
    ).toBe(true);
    expect(context.summaries).toHaveLength(0);
  });
  it('T-12b real compaction lowers persisted active_context_tokens_est and summarizes tool names', async () => {
    createSession('compact', 'title');
    let before = 0;
    for (let i = 0; i < 8; i++) before = await turn('compact');
    setSetting('chat_auto_compaction_enabled', 'true');
    setSetting('orchestrator_context_window_tokens', '2000');
    setSetting('orchestrator_compaction_threshold_percent', '50');
    const after = await turn('compact');
    expect(after).toBeLessThan(before);
    expect(context.summaries.at(-1)).toContain('Write(');
    expect(
      context.requests
        .at(-1)
        ?.some((message) => message.role === 'system' && message.content.includes('Tools: Write()')),
    ).toBe(true);
    expect(getSession('compact')?.compactedUpToMessageId).toBeUndefined();
  });
});

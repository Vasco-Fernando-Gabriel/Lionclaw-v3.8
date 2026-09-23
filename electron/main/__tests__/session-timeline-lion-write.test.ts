import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LionAdapter, LionChatMessage, LionStreamEvent, LionStreamRequest } from '../lion-sdk/adapters/types';
import type { TimelineTurnHandle } from '../session-timeline';
import type { QueryOptions } from '../orchestrator';
import type { SdkLane } from '../sdk-lane';

const h = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  history: [] as Array<{ id: number; role: string; content: string }>,
  requests: [] as LionChatMessage[][],
  eventsFor: (_round: number): LionStreamEvent[] => [],
  round: 0,
  handle: undefined as TimelineTurnHandle | undefined,
  order: [] as string[],
  logs: vi.fn(),
  autoCompact: false,
  status: 'interrupted',
}));
vi.mock('../logger', () => ({ createLogger: () => ({ info: h.logs, error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) }));
vi.mock('../db', () => ({
  getSession: vi.fn(() => ({ id: 'sid', title: 'title' })),
  getSessionMessages: vi.fn(() => h.history),
  getAllAgents: vi.fn(() => []),
  getSetting: vi.fn((key: string) => h.settings.get(key)),
  getLatestUserTurnIndex: vi.fn(() => 2),
  getTurnIndexForUserMessage: vi.fn(() => 3),
  insertMessage: vi.fn(() => 99),
  clearSessionPendingSeed: vi.fn(),
  updateSessionTokens: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
  insertTimelineTurn: vi.fn(() => {
    h.status = 'interrupted';
  }),
  insertTimelineEvent: vi.fn(),
  setTimelineTurnMetrics: vi.fn(),
  setTimelineTurnStatus: vi.fn((_id: string, status: string) => {
    h.status = status;
  }),
  setTimelineTurnAssistantMessageId: vi.fn(),
}));
vi.mock('../user-attachments-meta', () => ({
  persistUserChatMessage: vi.fn((_sid: string, content: string) => {
    h.history.push({ id: 30, role: 'user', content });
    return 30;
  }),
}));
vi.mock('../session-timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-timeline')>();
  return {
    ...actual,
    writeSpillFile: vi.fn(async () => '/spill/output.txt'),
    beginTimelineTurn: vi.fn((args: Parameters<typeof actual.beginTimelineTurn>[0]) => {
      const handle = actual.beginTimelineTurn(args);
      h.handle = handle;
      for (const key of [
        'user',
        'assistantStep',
        'toolResult',
        'assistantFinal',
        'metrics',
        'complete',
        'assistantMessage',
      ] as const) {
        vi.spyOn(handle, key);
      }
      return handle;
    }),
  };
});
vi.mock('../lion-sdk/adapters/ollama', () => ({
  createOllamaAdapter: (): LionAdapter => ({
    name: 'ollama',
    async *streamCompletion(req: LionStreamRequest) {
      h.requests.push(structuredClone(req.messages));
      h.order.push('adapter');
      for (const event of h.eventsFor(h.round++)) yield event;
    },
  }),
}));
vi.mock('../lion-sdk/adapters/lmstudio', () => ({ createLmStudioAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/openai-compatible', () => ({ createOpenAiCompatibleAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/google-genai', () => ({ createGoogleGenAiAdapter: vi.fn() }));
vi.mock('../lion-sdk/tools/filesystem', () => ({
  createSessionFsState: vi.fn(() => ({})),
  lionRead: vi.fn(),
  lionEdit: vi.fn(),
  lionGlob: vi.fn(),
  lionGrep: vi.fn(),
  lionWrite: vi.fn(async () => ({ isError: false, value: 'written' })),
}));
vi.mock('../lion-sdk/tools/bash', () => ({ lionBash: vi.fn() }));
vi.mock('../lion-sdk/tools/skill', () => ({ lionSkillLoad: vi.fn() }));
vi.mock('../lion-sdk/tools/agent', () => ({ lionAgentDispatch: vi.fn(), PIPELINE_INTERNAL_SQUADS: new Set() }));
vi.mock('../lion-sdk/tools/mcp', () => ({ lionMcpCall: vi.fn(), lionMcpCallViaWrapper: vi.fn() }));
vi.mock('../lion-sdk/tools/ask-user', () => ({ lionAskUserQuestion: vi.fn() }));
vi.mock('../lion-sdk/tools/memory', () => ({ lionMemorySearch: vi.fn() }));
vi.mock('../lion-sdk/runtime-context', () => ({ buildLionRuntimeContextPrompt: () => '' }));
vi.mock('../lion-sdk/title', () => ({ maybeGenerateLionSessionTitle: vi.fn(async () => {}) }));
vi.mock('../lion-sdk/compaction/db', () => ({ getCachedSummary: vi.fn(), saveCachedSummary: vi.fn() }));
vi.mock('../lion-sdk/stream-translator', () => ({
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
vi.mock('../chat-compaction-trigger', () => ({
  isChatTimelineReinjectEnabled: () => false,
  isChatAutoCompactionEnabled: () => h.autoCompact,
}));
vi.mock('../chat-context-usage', () => ({ resolveLionContextWindowTokens: () => 100000 }));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));
vi.mock('../agent-runtime/context-measure', () => ({
  estimateRequestTokens: () => 1,
  reconcileActiveContext: () => 1,
}));
vi.mock('../title-generator', () => ({ ensureInitialSessionTitle: vi.fn() }));
vi.mock('../skills', () => ({ listSkills: () => [] }));
vi.mock('../mcp-manager', () => ({ getMCPConfigForAgent: async () => ({}), getMCPToolsFromRegistry: () => [] }));
vi.mock('../mcp-tool-bridge', () => ({ setupMCPsForSession: vi.fn(), teardownMCPsForSession: vi.fn() }));
vi.mock('../mcp-tool-index', () => ({ buildMcpToolIndex: () => '', buildDirectHelperCatalog: () => '' }));
vi.mock('../prompt-builder', () => ({
  buildSystemPrompt: () => '',
  buildPipelineControlSection: () => '',
  buildPipelineControlStub: () => '',
  getSubagentsPromptMode: () => 'index',
}));
vi.mock('../prompt-builder-repo-graph', () => ({ getRepoGraphPromptSection: () => '' }));
vi.mock('../repo-graph/turn-context', () => ({ getRepoGraphTurnContext: () => null }));
vi.mock('../paths', () => ({ getAgentCwd: () => '/workspace', getLionClawHome: () => '/lionclaw' }));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../smoke-audit', () => ({ smokeAudit: vi.fn() }));
vi.mock('../swarm/chat-persistence', () => ({ persistSwarmResponse: vi.fn(() => false) }));
vi.mock('../chat-capability-context', () => ({
  getActiveChatTurnBinding: () => undefined,
  getChatCapabilityTurn: vi.fn(),
  computeEffectiveCapabilitiesForTurn: vi.fn(),
}));
vi.mock('../agent-runtime/subagent-dispatch', () => ({
  createSubagentDispatchContext: () => ({}),
  pendingSubagentProviderAuthError: vi.fn(() => null),
  isSubagentProviderAuthError: () => false,
  subagentAuthFailure: vi.fn(),
}));
vi.mock('../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: () => false,
  completeOnboardingFromConversationMessages: vi.fn(),
  completeOnboardingFromUserProfileMessage: vi.fn(),
}));

import { executeLionSdkQuery } from '../lion-sdk';
import * as db from '../db';
import { beginTimelineTurn } from '../session-timeline';
import { persistUserChatMessage } from '../user-attachments-meta';
import { lionWrite } from '../lion-sdk/tools/filesystem';
import { lionBash } from '../lion-sdk/tools/bash';
import { extractAndProcessOnboardingData } from '../onboarding';
import { persistSwarmResponse } from '../swarm/chat-persistence';
import { runLionLoop } from '../lion-sdk/runtime';
import { createLionStreamTranslator } from '../lion-sdk/stream-translator';
import { estimateTokens } from '../lion-sdk/compaction/token-estimate';

let lane: SdkLane;
const text = (delta = 'final'): LionStreamEvent => ({ type: 'text', delta });
function calls(
  count = 1,
  name = 'Write',
  args = JSON.stringify({ file_path: '/file', content: 'data', command: 'echo ok' }),
): LionStreamEvent {
  return {
    type: 'tool_call_delta',
    toolCalls: Array.from({ length: count }, (_, i) => ({
      id: `call-${h.round}-${i}`,
      type: 'function',
      function: { name, arguments: args },
      providerMetadata: { googleGenAi: { thoughtSignature: 'opaque' } },
    })),
  };
}
async function run(message = 'user', options: Partial<QueryOptions> = {}): Promise<void> {
  await executeLionSdkQuery(message, { sessionId: 'sid', ...options }, () => null, lane, {
    runtime: 'lion-sdk',
    provider: 'ollama',
    model: 'test-model',
    source: 'settings',
  });
}
function events() {
  return vi.mocked(db.insertTimelineEvent).mock.calls.map(([ev]) => ev);
}
function expectOutcome(complete: boolean) {
  expect(h.status).toBe(complete ? 'complete' : 'interrupted');
  expect(h.handle?.metrics).toHaveBeenCalledTimes(1);
  expect(h.handle?.complete).toHaveBeenCalledTimes(complete ? 1 : 0);
  if (complete) expect(db.setTimelineTurnStatus).toHaveBeenCalledWith(h.handle?.runId, 'complete');
  else expect(db.setTimelineTurnStatus).not.toHaveBeenCalled();
  expect(h.logs).toHaveBeenCalledWith(
    expect.objectContaining({ runtime: 'lion-sdk', status: complete ? 'complete' : 'interrupted' }),
    expect.any(String),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  h.settings.clear();
  h.settings.set('onboarding_completed', 'true');
  h.settings.set('chat_timeline_reinject_enabled', 'false');
  h.history = [];
  h.requests = [];
  h.round = 0;
  h.handle = undefined;
  h.order = [];
  h.autoCompact = false;
  h.eventsFor = () => [text()];
  lane = { name: 'test', kind: 'desktop', currentAbortController: null, sdkActiveSessionId: null };
  vi.mocked(db.insertTimelineEvent).mockImplementation((ev) => {
    h.order.push(ev.kind);
    return 1;
  });
  vi.mocked(db.setTimelineTurnMetrics).mockImplementation(() => {});
  vi.mocked(lionWrite).mockImplementation(async () => ({ isError: false, value: 'written' }));
  vi.mocked(extractAndProcessOnboardingData).mockImplementation(() => null);
});

describe('lion-sdk timeline incremental write', () => {
  it('T-02a inserts user + one step + three results + final in order before the next push', async () => {
    h.eventsFor = (n) => (n === 0 ? [text('step'), calls(3), { type: 'reasoning', delta: 'reason' }] : [text()]);
    vi.mocked(lionWrite).mockImplementation(async () => {
      h.order.push('dispatch');
      return { isError: false, value: 'written' };
    });
    await run();
    expect(events().map((e) => e.kind)).toEqual([
      'user',
      'assistant_step',
      'tool_result',
      'tool_result',
      'tool_result',
      'assistant_final',
    ]);
    expect(events().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(h.order).toEqual([
      'user',
      'adapter',
      'assistant_step',
      'dispatch',
      'tool_result',
      'dispatch',
      'tool_result',
      'dispatch',
      'tool_result',
      'adapter',
      'assistant_final',
    ]);
    const step = vi.mocked(h.handle!.assistantStep);
    const results = vi.mocked(h.handle!.toolResult);
    expect(step.mock.invocationCallOrder[0]).toBeLessThan(results.mock.invocationCallOrder[0]);
    expect(results.mock.invocationCallOrder[2]).toBeLessThan(
      vi.mocked(h.handle!.assistantFinal).mock.invocationCallOrder[0],
    );
    expect(JSON.parse(events()[1].toolCallsJson!)[0].providerMetadata).toEqual({
      googleGenAi: { thoughtSignature: 'opaque' },
    });
    expect(events()[1].reasoningContent).toBe('reason');
    expect(h.requests[1].filter((m) => m.role === 'tool')).toHaveLength(3);
    expect(h.requests[1].find((m) => m.role === 'tool')).not.toHaveProperty('meta');
    expect(h.handle?.assistantMessage).toHaveBeenCalledWith(99);
    expectOutcome(true);
  });
  it('T-02b records three sequential rounds', async () => {
    h.eventsFor = (n) => (n < 3 ? [calls()] : [text()]);
    await run();
    expect(events().map((e) => e.kind)).toEqual([
      'user',
      'assistant_step',
      'tool_result',
      'assistant_step',
      'tool_result',
      'assistant_step',
      'tool_result',
      'assistant_final',
    ]);
    expectOutcome(true);
  });
  it('T-17 preserves a completed Write before adapter-error', async () => {
    h.eventsFor = (n) => (n === 0 ? [calls()] : [{ type: 'error', error: 'provider failed' }]);
    await run();
    expect(events().map((e) => e.kind)).toEqual(['user', 'assistant_step', 'tool_result']);
    expect(events()[2].content).toBe('written');
    expectOutcome(false);
  });
  it('T-18 keeps results produced during abort in a batch of two tools', async () => {
    h.eventsFor = () => [calls(2)];
    vi.mocked(lionWrite).mockImplementation(async () => {
      lane.currentAbortController?.abort();
      return { isError: false, value: 'written' };
    });
    await run();
    expect(events().map((e) => e.kind)).toEqual(['user', 'assistant_step', 'tool_result', 'tool_result']);
    expectOutcome(false);
  });
  it('T-19 max-turns never records assistant_final', async () => {
    h.eventsFor = () => [calls()];
    await run();
    expect(events().filter((e) => e.kind === 'assistant_step')).toHaveLength(31);
    expect(events().filter((e) => e.kind === 'tool_result')).toHaveLength(30);
    expect(events().some((e) => e.kind === 'assistant_final')).toBe(false);
    expectOutcome(false);
  });
  it('T-20 includes dominant user, assistant_step and reasoning in interrupted metrics', async () => {
    const user = 'u'.repeat(4000);
    h.eventsFor = (n) =>
      n === 0
        ? [text('step'), { type: 'reasoning', delta: 'thinking' }, calls()]
        : [{ type: 'error', error: 'failed' }];
    await run(user);
    expect(h.handle?.metrics).toHaveBeenCalledWith({
      textTokensEst: estimateTokens(user) + estimateTokens('step') + estimateTokens('thinking'),
      toolTokensEst: estimateTokens(events()[1].toolCallsJson!) + estimateTokens('written'),
    });
    expectOutcome(false);
  });
  it('T-20 logs ratio null for zero text', async () => {
    h.eventsFor = () => [];
    await run('');
    expect(h.handle?.metrics).toHaveBeenCalledWith({ textTokensEst: 0, toolTokensEst: 0 });
    expect(h.logs).toHaveBeenCalledWith(expect.objectContaining({ ratio: null }), expect.any(String));
    expectOutcome(false);
  });
  it('T-27 records invalid call and dispatcher exception as errors through the callback', async () => {
    h.eventsFor = (n) => (n === 0 ? [calls(1, 'Write', '{invalid')] : n === 1 ? [calls()] : [text()]);
    vi.mocked(lionWrite).mockRejectedValue(new Error('dispatch exploded'));
    await run();
    expect(events().filter((e) => e.kind === 'tool_result')).toEqual([
      expect.objectContaining({ isError: true, originalBytes: null, spillPath: null }),
      expect.objectContaining({
        isError: true,
        originalBytes: null,
        spillPath: null,
        content: 'Tool dispatch falhou: dispatch exploded',
      }),
    ]);
    expectOutcome(true);
  });
  it.each([
    'ok',
    'LLM-EMPTY',
    'abort',
    'max-turns',
    'max-tool-errors',
    'post-loop-exception',
    'persistFailed',
    'metricsFailed',
    'loop-exception',
    'assistant-insert-failed',
  ] as const)('T-40 real executor outcome: %s', async (scenario) => {
    if (scenario === 'LLM-EMPTY') h.eventsFor = () => [];
    if (scenario === 'abort')
      h.eventsFor = () => {
        lane.currentAbortController?.abort();
        return [text()];
      };
    if (scenario === 'max-turns') h.eventsFor = () => [calls()];
    if (scenario === 'max-tool-errors') {
      h.eventsFor = () => [calls()];
      vi.mocked(lionWrite).mockRejectedValue(new Error('failed'));
    }
    if (scenario === 'post-loop-exception')
      vi.mocked(extractAndProcessOnboardingData).mockImplementation(() => {
        throw new Error('post-loop');
      });
    if (scenario === 'persistFailed')
      vi.mocked(db.insertTimelineEvent).mockImplementationOnce(() => {
        throw new Error('insert failed');
      });
    if (scenario === 'metricsFailed')
      vi.mocked(db.setTimelineTurnMetrics).mockImplementation(() => {
        throw new Error('metrics failed');
      });
    if (scenario === 'assistant-insert-failed')
      vi.mocked(db.insertMessage).mockImplementationOnce(() => {
        throw new Error('assistant insert');
      });
    if (scenario === 'loop-exception') {
      vi.mocked(createLionStreamTranslator).mockReturnValueOnce({
        ...createLionStreamTranslator({ sessionId: 'sid', emit: () => {} }),
        emitContextUsage: () => {
          throw new Error('loop');
        },
      });
    }
    await run();
    expectOutcome(scenario === 'ok');
  });
  it.each([false, true])(
    'T-05c retry preserves X, assistant and newer Y with compaction=%s and reinjection disabled',
    async (compact) => {
      h.autoCompact = compact;
      h.history = [
        { id: 1, role: 'user', content: 'X' },
        { id: 2, role: 'assistant', content: 'previous' },
        { id: 3, role: 'user', content: 'Y' },
      ];
      await run('X', { _forceNewSession: true, answeredUserMessageId: 1 });
      expect(h.requests[0].slice(1)).toEqual([
        { role: 'user', content: 'X' },
        { role: 'assistant', content: 'previous' },
        { role: 'user', content: 'Y' },
        { role: 'user', content: 'X' },
      ]);
      expect(persistUserChatMessage).not.toHaveBeenCalled();
      expect(h.history.filter((m) => m.role === 'user')).toHaveLength(2);
      expect(beginTimelineTurn).toHaveBeenCalledWith(
        expect.objectContaining({ origin: 'retry', anchorMessageId: 1, currentUserMessageId: null }),
      );
      expect(h.handle?.user).toHaveBeenCalledExactlyOnceWith('X');
    },
  );
  it('T-42 metrics and final status are logged for complete lion runs', async () => {
    h.eventsFor = (n) => (n === 0 ? [text('step'), calls()] : [text('raw final')]);
    vi.mocked(extractAndProcessOnboardingData).mockReturnValueOnce('clean final');
    await run();
    expect(h.handle?.assistantFinal).toHaveBeenCalledWith({ content: 'raw final', reasoningContent: null });
    expect(db.insertMessage).toHaveBeenCalledWith('sid', 'assistant', 'clean final');
    expect(h.logs).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: 'lion-sdk',
        status: 'complete',
        textTokensEst: estimateTokens('user') + estimateTokens('step') + estimateTokens('raw final'),
        toolTokensEst: estimateTokens(events()[1].toolCallsJson!) + estimateTokens('written'),
      }),
      expect.any(String),
    );
    expectOutcome(true);
  });
  it('does not associate a swarm response with assistantMessage', async () => {
    vi.mocked(persistSwarmResponse).mockReturnValueOnce(true);
    await run('user', { swarmDelivery: {} as NonNullable<QueryOptions['swarmDelivery']> });
    expect(h.handle?.assistantMessage).not.toHaveBeenCalled();
  });
  it('passes normal tool result metadata without adding it to model messages', async () => {
    h.eventsFor = (n) => (n === 0 ? [calls(1, 'Bash')] : [text()]);
    vi.mocked(lionBash).mockResolvedValueOnce({ exitCode: 1, durationMs: 3, stdout: 'out'.repeat(11000), stderr: '' });
    await run();
    expect(h.handle?.toolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        isError: true,
        originalBytes: Buffer.byteLength(
          'exit=1 duration=3ms\n--- stdout ---\n' + 'out'.repeat(11000) + '\n--- stderr ---\n',
        ),
        spillPath: '/spill/output.txt',
      }),
    );
    expect(h.requests[1].find((m) => m.role === 'tool')).not.toHaveProperty('meta');
  });
  it.each([
    [{}, 'turn', 30, 30],
    [{ _forceNewSession: true }, 'retry', null, null],
    [{ origin: 'system-event' }, 'system-event', null, null],
    [{ skipUserMessagePersistence: true }, 'turn', null, null],
  ] as const)('resolves explicit origin for %j', async (options, origin, anchorMessageId, currentUserMessageId) => {
    await run('user', options);
    expect(beginTimelineTurn).toHaveBeenCalledWith({
      sessionId: 'sid',
      turnIndex: currentUserMessageId === null ? 2 : 3,
      origin,
      anchorMessageId,
      currentUserMessageId,
      runtime: 'lion-sdk',
      fidelity: 'exact',
      cwd: '/workspace',
    });
  });
  it('uses a null anchor when user persistence fails', async () => {
    vi.mocked(persistUserChatMessage).mockImplementationOnce(() => {
      throw new Error('user insert');
    });
    await run();
    expect(beginTimelineTurn).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'turn', anchorMessageId: null, currentUserMessageId: null }),
    );
  });
  it('T-40 complete persistence failure logs interrupted', async () => {
    vi.mocked(db.setTimelineTurnStatus).mockImplementationOnce(() => {
      throw new Error('complete failed');
    });
    await run();
    expect(h.handle?.complete).toHaveBeenCalledTimes(1);
    expect(h.handle?.persistFailed).toBe(true);
    expect(h.status).toBe('interrupted');
    expect(h.logs).toHaveBeenCalledWith(expect.objectContaining({ status: 'interrupted' }), expect.any(String));
  });
  it('callback exceptions never modify transcript or stop the runtime', async () => {
    const onTranscriptPush = vi.fn(() => {
      throw new Error('callback');
    });
    const result = await runLionLoop({
      adapter: {
        name: 'ollama',
        async *streamCompletion() {
          yield text();
        },
      },
      model: 'm',
      initialMessages: [],
      tools: [],
      dispatcher: async () => ({ content: '' }),
      translator: createLionStreamTranslator({ sessionId: 'sid', emit: () => {} }),
      onTranscriptPush,
    });
    expect(result.ok).toBe(true);
    expect(result.transcript).toEqual([{ role: 'assistant', content: 'final', tool_calls: undefined }]);
    expect(onTranscriptPush).toHaveBeenCalledTimes(1);
  });
});

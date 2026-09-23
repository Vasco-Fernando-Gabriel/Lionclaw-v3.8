import type { ChatMessage, TimelineEvent, TimelineTurnWithEvents } from '../../../src/types';
export function message(id: number, role: ChatMessage['role'], content = `message-${id}`): ChatMessage {
  return { id, sessionId: 's', role, content, createdAt: '2026-01-01' };
}
export function event(kind: TimelineEvent['kind'], seq: number, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: seq,
    runId: 'r',
    sessionId: 's',
    seq,
    kind,
    toolUseId: null,
    toolName: null,
    content: kind,
    toolCallsJson: null,
    reasoningContent: null,
    isError: false,
    originalBytes: null,
    spillPath: null,
    createdAt: '2026-01-01',
    ...overrides,
  };
}
export const calls = [
  {
    id: 'call',
    type: 'function' as const,
    function: { name: 'Bash', arguments: '{"command":"false"}' },
    providerMetadata: { googleGenAi: { thoughtSignature: 'opaque' } },
  },
];
export function run(anchor = 1, overrides: Partial<TimelineTurnWithEvents> = {}): TimelineTurnWithEvents {
  return {
    seqId: anchor,
    runId: `r${anchor}`,
    sessionId: 's',
    turnIndex: 0,
    anchorMessageId: anchor,
    currentUserMessageId: anchor,
    assistantMessageId: anchor + 1,
    origin: 'turn',
    runtime: 'lion-sdk',
    fidelity: 'exact',
    status: 'complete',
    cwd: null,
    textTokensEst: null,
    toolTokensEst: null,
    createdAt: '2026-01-01',
    events: [
      event('user', 0, { content: 'effective' }),
      event('assistant_step', 1, {
        content: 'step',
        reasoningContent: 'thinking',
        toolCallsJson: JSON.stringify(calls),
      }),
      event('tool_result', 2, { content: 'result', toolUseId: 'call', toolName: 'Bash' }),
      event('assistant_final', 3, { content: 'final' }),
    ],
    ...overrides,
  };
}

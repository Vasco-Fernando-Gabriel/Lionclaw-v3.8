import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));
vi.mock('../chat-capability-lease', () => ({
  verifyInternalCapabilityLease: vi.fn(() => false),
}));

import {
  __resetChatCapabilityContextForTests,
  getActiveChatTurn,
  getChatCapabilityTurn,
  registerChatCapabilityTurn,
  setActiveChatTurn,
} from '../chat-capability-context';
import { resolveChatInheritedEffort } from '../agent-runtime/chat-effort-inheritance';

const OFF = { pipelineControl: false, dynamicWorkflows: false };

function registerTurn(sessionId: string, turnId: string, effort: string): void {
  registerChatCapabilityTurn({
    surface: 'chat',
    sessionId,
    turnId,
    capabilities: OFF,
    orchestrator: { runtime: 'claude-sdk', effort },
    cwd: '/repo',
    allowedTools: [],
    allowedServerIds: [],
    readRoots: [],
    writeRoots: [],
  });
  setActiveChatTurn({ sessionId, lane: 'desktop', turnId });
}

function inheritedFor(sessionId: string) {
  const turnId = getActiveChatTurn({ sessionId, lane: 'desktop' });
  expect(turnId).toBeDefined();
  const ctx = getChatCapabilityTurn({ sessionId, turnId: turnId! });
  expect(ctx?.orchestrator).toBeDefined();
  return resolveChatInheritedEffort(ctx!.orchestrator!.runtime, ctx!.orchestrator!.effort);
}

beforeEach(() => {
  __resetChatCapabilityContextForTests();
});

describe('AC-14: subagente herda o effort da LANE que o chamou, pelo turn-context (7.6)', () => {
  it('Lane 2 em max herda max enquanto a Lane 1 esta em low', () => {
    registerTurn('lane-1', 't1', 'low');
    registerTurn('lane-2', 't2', 'max');

    expect(inheritedFor('lane-2')).toEqual({ claude: 'max', codex: 'max', kimi: 'max', grok: 'high' });
    expect(inheritedFor('lane-1')).toEqual({ claude: 'low', codex: 'low', kimi: 'low', grok: 'low' });
  });

  it('o turn-context devolve uma copia do orquestrador (mutacao do caller nao vaza)', () => {
    registerTurn('lane-1', 't1', 'high');
    const ctx = getChatCapabilityTurn({ sessionId: 'lane-1', turnId: 't1' });
    ctx!.orchestrator!.effort = 'low';
    expect(getChatCapabilityTurn({ sessionId: 'lane-1', turnId: 't1' })?.orchestrator).toEqual({
      runtime: 'claude-sdk',
      effort: 'high',
    });
  });

  it('turno sem orchestrator no contexto = sem heranca (nunca cai no setting global)', () => {
    registerChatCapabilityTurn({
      surface: 'chat',
      sessionId: 'lane-x',
      turnId: 'tx',
      capabilities: OFF,
    });
    const ctx = getChatCapabilityTurn({ sessionId: 'lane-x', turnId: 'tx' });
    expect(ctx?.orchestrator).toBeUndefined();
    expect(
      ctx?.orchestrator ? resolveChatInheritedEffort(ctx.orchestrator.runtime, ctx.orchestrator.effort) : undefined,
    ).toBeUndefined();
  });
});

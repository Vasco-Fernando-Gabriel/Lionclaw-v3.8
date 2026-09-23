import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { OrchestratorSelection } from '../../orchestrator-selection';
import type { QueryOptions } from '../../orchestrator';
import type { ChatFeatureToggles } from '../../../../src/types';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../paths', () => ({
  getLionClawHome: () => '/tmp/lion-home-cursor-wiring',
}));

vi.mock('../../db', () => ({
  clearSessionPendingSeed: vi.fn(),
  createSession: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getSession: vi.fn(() => null),
  getSessionMessages: vi.fn(() => []),
  getLatestUserTurnIndex: vi.fn(() => 0),
  getSetting: vi.fn((key: string) => (key === 'onboarding_completed' ? 'true' : undefined)),
  getTurnIndexForUserMessage: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  insertMessage: vi.fn(() => 1),
  setSessionActiveContextTokens: vi.fn(),
  updateSessionTokens: vi.fn(),
}));

vi.mock('../../user-attachments-meta', () => ({
  persistUserChatMessage: vi.fn(() => 1),
}));

vi.mock('../../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(async () => {}),
}));

vi.mock('../../chat-compaction-trigger', () => ({
  maybeCompactChatSession: vi.fn(async () => {}),
  isChatTimelineReinjectEnabled: () => false,
}));

vi.mock('../../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));

vi.mock('../../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
  completeOnboardingFromPersistedProfile: vi.fn(() => false),
}));

vi.mock('../../agent-runtime/subagent-dispatch', () => ({
  isSubagentProviderAuthError: vi.fn(() => false),
  subagentAuthFailure: vi.fn(() => ({ code: 'LLM-AUTH-401', error: 'auth' })),
}));

vi.mock('../stream-translator', () => ({
  createCursorStreamTranslator: vi.fn(() => ({
    onEvent: vi.fn(),
    assistantText: vi.fn(() => ''),
    toolUses: vi.fn(() => 0),
    finalize: vi.fn(),
    fail: vi.fn(),
  })),
  buildCursorUsageSnapshot: vi.fn(() => ({
    inputTokens: 0,
    outputTokens: 0,
    tokenStatus: 'not_reported',
    costStatus: 'unknown',
  })),
}));

const capturedSessionOpts: Array<Record<string, unknown>> = [];
vi.mock('../session', () => ({
  createChatCursorSession: vi.fn(async (opts: Record<string, unknown>) => {
    capturedSessionOpts.push(opts);
    throw new Error('stop-after-capture');
  }),
}));

import { executeCursorSdkQuery } from '../index';
import { telegramLane } from '../../sdk-lane';
import { getDesktopLane } from '../../desktop-lanes';

const desktopLane = getDesktopLane('sess-cursor-turn');
import {
  registerChatCapabilityTurn,
  setActiveChatTurn,
  __resetChatCapabilityContextForTests,
} from '../../chat-capability-context';

const OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false };
const ON: ChatFeatureToggles = { pipelineControl: true, dynamicWorkflows: true };
const MIXED: ChatFeatureToggles = { pipelineControl: true, dynamicWorkflows: false };

function makeSelection(): OrchestratorSelection {
  return {
    runtime: 'cursor-sdk',
    provider: 'cursor',
    model: 'composer-2.5',
    source: 'settings',
  };
}

function makeOptions(overrides?: Partial<QueryOptions>): QueryOptions {
  return { sessionId: 'sess-cursor-turn', silent: true, ...overrides };
}

function registerDesktopTurn(capabilities: ChatFeatureToggles, turnId = 'turn-1'): void {
  registerChatCapabilityTurn({
    surface: 'chat',
    sessionId: 'sess-cursor-turn',
    turnId,
    capabilities,
  });
  setActiveChatTurn({ sessionId: 'sess-cursor-turn', lane: 'desktop', turnId });
}

function lastCapturedCapabilities(): unknown {
  expect(capturedSessionOpts.length).toBeGreaterThan(0);
  return capturedSessionOpts[capturedSessionOpts.length - 1]['capabilities'];
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedSessionOpts.length = 0;
  __resetChatCapabilityContextForTests();
});

describe('cursor: executeCursorSdkQuery computa as capabilities do turno (receita padrao)', () => {
  it('turno desktop OFF -> createChatCursorSession recebe capabilities OFF', async () => {
    registerDesktopTurn({ ...OFF });
    await executeCursorSdkQuery('oi', makeOptions(), () => null, desktopLane, makeSelection());
    expect(lastCapturedCapabilities()).toEqual(OFF);
  });

  it('turno desktop ON -> createChatCursorSession recebe capabilities ON', async () => {
    registerDesktopTurn({ ...ON });
    await executeCursorSdkQuery('oi', makeOptions(), () => null, desktopLane, makeSelection());
    expect(lastCapturedCapabilities()).toEqual(ON);
  });

  it('toggles mistos passam intactos (pipeline ON, workflows OFF)', async () => {
    registerDesktopTurn({ ...MIXED });
    await executeCursorSdkQuery('oi', makeOptions(), () => null, desktopLane, makeSelection());
    expect(lastCapturedCapabilities()).toEqual(MIXED);
  });

  it('desktop SEM turn-context (miss tolerado S3a) -> capabilities undefined = legado byte-identico', async () => {
    await executeCursorSdkQuery('oi', makeOptions(), () => null, desktopLane, makeSelection());
    expect(lastCapturedCapabilities()).toBeUndefined();
  });

  it('lane telegram -> undefined MESMO com turno desktop OFF registrado', async () => {
    registerDesktopTurn({ ...OFF });
    await expect(
      executeCursorSdkQuery('oi tg', makeOptions(), () => null, telegramLane, makeSelection()),
    ).rejects.toThrow('stop-after-capture');
    expect(lastCapturedCapabilities()).toBeUndefined();
  });

  it('a lane cursor recebe a lane correta e o modelo da selection', async () => {
    registerDesktopTurn({ ...ON });
    await executeCursorSdkQuery('oi', makeOptions(), () => null, desktopLane, makeSelection());
    const opts = capturedSessionOpts[capturedSessionOpts.length - 1];
    expect(opts['lane']).toBe('desktop');
    expect(opts['model']).toBe('composer-2.5');
    expect(opts['sessionId']).toBe('sess-cursor-turn');
  });
});

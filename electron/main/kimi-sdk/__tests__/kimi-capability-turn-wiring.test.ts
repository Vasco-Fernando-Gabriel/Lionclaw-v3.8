import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { OrchestratorSelection } from '../../orchestrator-selection';
import type { QueryOptions } from '../../orchestrator';
import type { ChatFeatureToggles } from '../../../../src/types';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../db', () => ({
  getPermissionBypass: vi.fn(() => false),
  insertMessage: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  createSession: vi.fn(),
  getSessionMessages: vi.fn(() => []),
  getSetting: vi.fn((key: string) => (key === 'onboarding_completed' ? 'true' : undefined)),
  getTurnIndexForUserMessage: vi.fn(() => 1),
  getLatestUserTurnIndex: vi.fn(() => 0),
  getSession: vi.fn(() => null),
  updateSessionTokens: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
  clearSessionPendingSeed: vi.fn(),
  upsertActivityLog: vi.fn(),
}));

vi.mock('../../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(async () => {}),
}));

vi.mock('../../artifact-detector', () => ({
  captureToolUse: vi.fn(() => null),
  captureToolResult: vi.fn(() => null),
}));

vi.mock('../../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));

vi.mock('../../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
  completeOnboardingFromPersistedProfile: vi.fn(() => false),
}));

const capturedSessionOpts: Array<Record<string, unknown>> = [];
vi.mock('../session', () => ({
  createChatKimiSession: vi.fn(async (opts: Record<string, unknown>) => {
    capturedSessionOpts.push(opts);
    throw new Error('stop-after-capture');
  }),
}));

import { executeKimiSdkQuery } from '../index';
import { telegramLane } from '../../sdk-lane';
import { getDesktopLane } from '../../desktop-lanes';

const desktopLane = getDesktopLane('sess-kimi-turn');
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
    runtime: 'kimi-sdk',
    provider: 'kimi',
    model: 'kimi-code/kimi-for-coding',
    source: 'settings',
  };
}

function makeOptions(overrides?: Partial<QueryOptions>): QueryOptions {
  return { sessionId: 'sess-kimi-turn', silent: true, ...overrides };
}

function registerDesktopTurn(capabilities: ChatFeatureToggles, turnId = 'turn-1'): void {
  registerChatCapabilityTurn({
    surface: 'chat',
    sessionId: 'sess-kimi-turn',
    turnId,
    capabilities,
  });
  setActiveChatTurn({ sessionId: 'sess-kimi-turn', lane: 'desktop', turnId });
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

describe('S5c kimi: executeKimiSdkQuery computa as capabilities do turno (receita padrao)', () => {
  it('turno desktop OFF -> createChatKimiSession recebe capabilities OFF', async () => {
    registerDesktopTurn({ ...OFF });
    await executeKimiSdkQuery('oi', makeOptions(), () => null, desktopLane, makeSelection());
    expect(lastCapturedCapabilities()).toEqual(OFF);
  });

  it('turno desktop ON -> createChatKimiSession recebe capabilities ON', async () => {
    registerDesktopTurn({ ...ON });
    await executeKimiSdkQuery('oi', makeOptions(), () => null, desktopLane, makeSelection());
    expect(lastCapturedCapabilities()).toEqual(ON);
  });

  it('toggles mistos passam intactos (pipeline ON, workflows OFF)', async () => {
    registerDesktopTurn({ ...MIXED });
    await executeKimiSdkQuery('oi', makeOptions(), () => null, desktopLane, makeSelection());
    expect(lastCapturedCapabilities()).toEqual(MIXED);
  });

  it('desktop SEM turn-context (miss tolerado S3a) -> capabilities undefined = legado byte-identico', async () => {
    await executeKimiSdkQuery('oi', makeOptions(), () => null, desktopLane, makeSelection());
    expect(lastCapturedCapabilities()).toBeUndefined();
  });

  it('lane telegram (A.9/A.16) -> undefined MESMO com turno desktop OFF registrado', async () => {
    registerDesktopTurn({ ...OFF });
    await expect(
      executeKimiSdkQuery('oi tg', makeOptions(), () => null, telegramLane, makeSelection()),
    ).rejects.toThrow('stop-after-capture');
    expect(lastCapturedCapabilities()).toBeUndefined();
  });
});

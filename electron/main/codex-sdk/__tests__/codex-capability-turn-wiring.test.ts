
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { OrchestratorSelection } from '../../orchestrator-selection';
import type { QueryOptions } from '../../orchestrator';
import type { ChatFeatureToggles } from '../../../../src/types';


vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../db', () => ({
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

vi.mock('../../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));

vi.mock('../../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
  completeOnboardingFromPersistedProfile: vi.fn(() => false),
}));

vi.mock('../stream-translator', () => ({
  createCodexStreamTranslator: vi.fn(() => ({})),
}));

vi.mock('../../repo-graph/turn-context', () => ({
  getRepoGraphTurnContext: vi.fn(() => null),
}));
vi.mock('../../repo-graph/validate-root', () => ({
  validateRepoRootPath: vi.fn(() => ({ error: 'not-used' })),
}));
vi.mock('../../repo-graph/minimal-context', () => ({
  prefetchRepoGraphTurnContext: vi.fn(async () => null),
}));

const capturedSessionOpts: Array<Record<string, unknown>> = [];
vi.mock('../session', () => ({
  createChatCodexSession: vi.fn(async (opts: Record<string, unknown>) => {
    capturedSessionOpts.push(opts);
    throw new Error('stop-after-capture');
  }),
}));


import { executeCodexSdkQuery } from '../index';
import { desktopLane, telegramLane } from '../../sdk-lane';
import {
  registerChatCapabilityTurn,
  setActiveChatTurn,
  __resetChatCapabilityContextForTests,
} from '../../chat-capability-context';

const OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false };
const ON: ChatFeatureToggles = { pipelineControl: true, dynamicWorkflows: true };
const MIXED: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: true };

function makeSelection(): OrchestratorSelection {
  return {
    runtime: 'codex-sdk',
    provider: 'codex',
    model: 'gpt-5.5',
    source: 'settings',
  };
}

function makeOptions(overrides?: Partial<QueryOptions>): QueryOptions {
  return { sessionId: 'sess-codex-turn', silent: true, ...overrides };
}

function registerDesktopTurn(capabilities: ChatFeatureToggles, turnId = 'turn-1'): void {
  registerChatCapabilityTurn({
    surface: 'chat',
    sessionId: 'sess-codex-turn',
    turnId,
    capabilities,
  });
  setActiveChatTurn({ sessionId: 'sess-codex-turn', lane: 'desktop', turnId });
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

describe('S5c codex: executeCodexSdkQuery computa as capabilities do turno (receita padrao)', () => {
  it('turno desktop OFF -> createChatCodexSession recebe capabilities OFF', async () => {
    registerDesktopTurn({ ...OFF });
    await executeCodexSdkQuery('oi', makeOptions(), () => null, desktopLane, makeSelection());
    expect(lastCapturedCapabilities()).toEqual(OFF);
  });

  it('turno desktop ON -> createChatCodexSession recebe capabilities ON', async () => {
    registerDesktopTurn({ ...ON });
    await executeCodexSdkQuery('oi', makeOptions(), () => null, desktopLane, makeSelection());
    expect(lastCapturedCapabilities()).toEqual(ON);
  });

  it('toggles mistos passam intactos (pipeline OFF, workflows ON)', async () => {
    registerDesktopTurn({ ...MIXED });
    await executeCodexSdkQuery('oi', makeOptions(), () => null, desktopLane, makeSelection());
    expect(lastCapturedCapabilities()).toEqual(MIXED);
  });

  it('desktop SEM turn-context (miss tolerado S3a) -> capabilities undefined = legado byte-identico', async () => {
    await executeCodexSdkQuery('oi', makeOptions(), () => null, desktopLane, makeSelection());
    expect(lastCapturedCapabilities()).toBeUndefined();
  });

  it('lane telegram (A.9/A.16) -> undefined MESMO com turno desktop OFF registrado', async () => {
    registerDesktopTurn({ ...OFF });
    await executeCodexSdkQuery('oi tg', makeOptions(), () => null, telegramLane, makeSelection());
    expect(lastCapturedCapabilities()).toBeUndefined();
  });
});

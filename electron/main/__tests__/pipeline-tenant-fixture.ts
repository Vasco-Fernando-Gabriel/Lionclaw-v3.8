import { vi, beforeEach } from 'vitest';
import type { DriveState } from '../../../src/types';
const h = vi.hoisted(() => ({
  drive: null as DriveState | null,
  closed: false,
  createdDrive: false,
  mode: 'shadow' as 'shadow' | 'enforce',
  start: vi.fn(async (): Promise<void> => undefined),
  engage: vi.fn((): { ok: true } | { ok: false; error: string; code: string } => ({ ok: true })),
  create: vi.fn(() => ({ id: 'P3', name: 'New', pipelineType: 'feature' })),
  engineRead: vi.fn(() => null),
  send: vi.fn(),
  insert: vi.fn(() => 7),
  emit: vi.fn(),
  capability: vi.fn<typeof import('../chat-capability-gate').assertChatCapability>(),
  consume: vi.fn<typeof import('../chat-capability-lease').verifyInternalCapabilityLease>(),
  permission: vi.fn(async () => ({ behavior: 'allow' })),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: h.send } }] },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../db', () => ({
  getHarnessProject: (id: string) => ({
    id,
    name: id,
    pipelineType: 'feature',
    status: 'running',
    pipelineCurrentPhase: 1,
  }),
  listHarnessProjects: () => ['P1', 'P2'].map((id) => ({ id, name: id, status: 'running', pipelineType: 'feature' })),
  getDriveState: (id: string) => (id === 'P1' || (id === 'P3' && h.createdDrive) ? h.drive : null),
  getDriveSessionId: (id: string) => (id === 'P1' || (id === 'P3' && h.createdDrive) ? 'A' : null),
  isDriveEngaged: (id: string) => id === 'P1' && h.drive !== null && h.drive.status !== 'stopped',
  getOpenLaneSessionById: (id: string) => (h.closed ? null : { id, laneBadge: id === 'A' ? 1 : 2, title: id }),
  getSession: (id: string) => ({ id }),
  getPipelinePhaseMessagesAsChatHistory: () => [],
  getAllAgents: () => [],
  getAgent: () => undefined,
  insertAuditEntry: vi.fn(),
  getPermissionBypass: () => true,
  getCompletedDocsCount: () => 0,
  getSetting: (key: string) => (key === 'chat_capability_gate_mode' ? h.mode : undefined),
  insertMessage: h.insert,
}));
vi.mock('../pipeline-create', () => ({ createPipelineProject: h.create }));
vi.mock('../pipeline-engine-ref', () => ({
  getPipelineEngineRef: () => ({ startPipeline: h.start, getCurrentPhase: h.engineRead }),
}));
vi.mock('../pipeline-drive-coordinator', () => ({ getPipelineDriveCoordinator: () => ({ startDrive: h.engage }) }));
vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: h.emit }));
vi.mock('../pipeline-shared/lock', () => ({ ensureProjectLock: vi.fn() }));
vi.mock('../mcp-manager', () => ({ getAllMCPServers: () => [] }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn() }));
vi.mock('../skills', () => ({ listSkills: () => [], getSkill: vi.fn() }));
vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));
vi.mock('../permission-guard', () => ({ createPermissionGuard: () => h.permission }));
vi.mock('../lion-sdk/tools/agent', () => ({ lionAgentDispatch: vi.fn() }));
vi.mock('../chat-capability-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat-capability-gate')>();
  h.capability.mockImplementation(actual.assertChatCapability);
  return { ...actual, getChatCapabilityGateMode: () => h.mode, assertChatCapability: h.capability };
});
vi.mock('../chat-capability-lease', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat-capability-lease')>();
  h.consume.mockImplementation(actual.verifyInternalCapabilityLease);
  return { ...actual, verifyInternalCapabilityLease: h.consume };
});
import { _resetDriveLockForTesting } from '../drive-lock';
import {
  __resetChatCapabilityContextForTests,
  setActiveChatTurn,
  registerChatCapabilityTurn,
} from '../chat-capability-context';
import { dispatch } from '../local-ipc/jsonrpc-methods';
export function bind(sessionId = 'B', driveProjectId?: string, lane: 'desktop' | 'telegram' = 'desktop') {
  setActiveChatTurn({ sessionId, lane, turnId: 't' });
  registerChatCapabilityTurn({
    surface: 'chat',
    sessionId,
    turnId: 't',
    capabilities: { pipelineControl: true, dynamicWorkflows: true },
    driveProjectId,
  });
  return { sessionId, turnId: 't', lane };
}
export function rpc(method: string, params: Record<string, unknown> = {}) {
  return dispatch(
    { getWindow: () => null, connection: { authenticatedHelper: true, serverId: 'lionclaw-pipeline-control' } },
    { jsonrpc: '2.0', id: 1, method, params },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  _resetDriveLockForTesting();
  __resetChatCapabilityContextForTests();
  h.closed = false;
  h.createdDrive = false;
  h.mode = 'shadow';
  h.drive = { status: 'driving', driver: 'orchestrator', mode: 'semi', handoff: 'none', requiresHumanPhases: [] };
  h.start.mockResolvedValue(undefined);
  h.engage.mockReturnValue({ ok: true });
});

export { h };

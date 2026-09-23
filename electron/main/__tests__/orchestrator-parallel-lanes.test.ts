import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const iter = (async function* () {})();
    return Object.assign(iter, { toggleMcpServer: vi.fn(async () => undefined) });
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

const settings = vi.hoisted(() => new Map<string, string>());
vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => [] as unknown[]),
  getAgent: vi.fn(() => undefined),
  insertMessage: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  getSetting: vi.fn((key: string) => settings.get(key)),
  updateSessionTokens: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getSession: vi.fn(() => null),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  insertTaskExecution: vi.fn(),
  getTurnIndexForUserMessage: vi.fn(() => 0),
  getLatestUserTurnIndex: vi.fn(() => 0),
  getAllMCPServers: vi.fn(() => []),
  getPermissionBypass: () => false,
  insertRepoGraphTurnUsage: vi.fn(),
  clearSessionPendingSeed: vi.fn(),
  getHarnessProject: vi.fn(() => null),
}));

vi.mock('../knowledge-state', () => ({ setActiveAgentId: vi.fn() }));
vi.mock('../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
  completeOnboardingFromPersistedProfile: vi.fn(() => false),
}));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));
vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => 'fake-api-key'),
  getApiKey: vi.fn(async () => null),
}));
vi.mock('../permission-guard', () => ({ createPermissionGuard: () => vi.fn(), GUARD_GATED_TOOLS: [] }));
vi.mock('../mcp-manager', () => ({ getMCPConfigForAgent: vi.fn(async () => ({})) }));
vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => ({ allowedTools: [], systemPrompt: '', mcpServers: [], maxTurns: 0 })),
}));
vi.mock('../mcp-discovery', () => ({ getDisabledSDKMcps: () => [], getCachedSDKMcpServers: () => [] }));
vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(),
  captureToolResult: vi.fn(),
  resetArtifactDetector: vi.fn(),
}));
vi.mock('../prompt-builder', () => ({ buildSystemPrompt: () => '', loadGeneratedAgentContext: () => '' }));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/tmp',
  getBackgroundCwd: () => '/tmp',
  getCronCwd: () => '/tmp',
  getLionClawHome: () => '/tmp',
}));
vi.mock('../codex-agents-mcp', () => ({ getCodexAgentsServer: () => undefined }));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  ensureNodeInPath: vi.fn(),
  getClaudeCodeExecutablePath: () => '/tmp/claude-cli.js',
  getClaudeSdkProcessOptions: () => ({ pathToClaudeCodeExecutable: '/tmp/claude-cli.js', executable: 'node' }),
}));
vi.mock('../title-generator', () => ({ ensureInitialSessionTitle: vi.fn(), generateSessionTitle: vi.fn() }));
vi.mock('../prompt-builder-repo-graph', () => ({
  appendRepoGraphSection: (p: string) => p,
  buildRepoGraphSection: () => '',
}));
const driveComplete = vi.hoisted(() => vi.fn());
vi.mock('../drive-usage-sink', () => ({
  reportDriveTurnUsage: vi.fn(),
  reportDriveTurnComplete: (...args: unknown[]) => driveComplete(...args),
}));

import type { OrchestratorSelection } from '../orchestrator-selection';
vi.mock('../orchestrator-selection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator-selection')>();
  return {
    ...actual,
    resolveOrchestratorSelection: vi.fn(async (): Promise<OrchestratorSelection> => ({
      runtime: 'claude-compat-sdk',
      provider: 'zai',
      model: 'glm-5',
      source: 'settings',
    })),
  };
});

import type { SdkLane } from '../sdk-lane';

interface ExecCall {
  sessionId: string;
  lane: SdkLane;
  origin: string;
  aborted: boolean;
  finish: () => void;
}
const execCalls: ExecCall[] = [];

vi.mock('../claude-compat-sdk', () => ({
  executeClaudeCompatSdkQuery: (
    _message: string,
    opts: { sessionId?: string; origin?: string },
    _getWindow: unknown,
    lane: SdkLane,
  ) =>
    new Promise<void>((resolve) => {
      const abort = new AbortController();
      lane.currentAbortController = abort;
      const call: ExecCall = {
        sessionId: opts.sessionId ?? '?',
        lane,
        origin: opts.origin ?? 'user',
        aborted: false,
        finish: () => {
          lane.currentAbortController = null;
          resolve();
        },
      };
      abort.signal.addEventListener('abort', () => {
        call.aborted = true;
        call.finish();
      });
      execCalls.push(call);
    }),
  isClaudeCompatQueryActive: (lane?: SdkLane) => (lane ? lane.currentAbortController !== null : false),
  resetClaudeCompatSdkSessionState: vi.fn(),
  stopClaudeCompatQuery: (lane?: SdkLane) => {
    if (lane?.currentAbortController) {
      lane.currentAbortController.abort();
      lane.currentAbortController = null;
    }
  },
  buildCompatEnv: vi.fn(() => ({})),
}));
vi.mock('../codex-sdk', () => ({
  executeCodexSdkQuery: vi.fn(async () => undefined),
  isCodexSdkQueryActive: vi.fn(() => false),
  resetCodexSdkSessionState: vi.fn(),
  stopCodexSdkQuery: vi.fn(),
}));
vi.mock('../kimi-sdk', () => ({
  executeKimiSdkQuery: vi.fn(async () => undefined),
  isKimiSdkQueryActive: vi.fn(() => false),
  resetKimiSdkSessionState: vi.fn(),
  stopKimiSdkQuery: vi.fn(),
}));
vi.mock('../lion-sdk', () => ({
  executeLionSdkQuery: vi.fn(async () => undefined),
  isLionSdkQueryActive: vi.fn(() => false),
  resetLionSdkSessionState: vi.fn(),
  stopLionSdkQuery: vi.fn(),
}));

import {
  submitMessage,
  stopCurrentQuery,
  getDesktopSessionExecutionState,
  getInFlightDesktopSessions,
  getDriveTurnSemaphoreForTests,
  hasActiveOrchestratorWork,
} from '../orchestrator';
import {
  getDesktopLane,
  listDesktopLanes,
  pruneIdleDesktopLane,
  pruneIdleDesktopLanes,
  resetDesktopLanesForTests,
} from '../desktop-lanes';
import { resetInFlightDesktopSessionsForTests } from '../in-flight-desktop-session';
import { listActiveDesktopTurns, __resetChatCapabilityContextForTests } from '../chat-capability-context';
import { clearRepoGraphTurnSession } from '../repo-graph/turn-context';

const noopGetWindow = () => null;

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout aguardando o processor'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

function submitHuman(sessionId: string, text = 'oi'): void {
  submitMessage(text, { sessionId, silent: true }, noopGetWindow);
}

function submitDrive(sessionId: string, driveTurnId: string): void {
  submitMessage(
    '[WAKE]',
    { sessionId, silent: true, origin: 'system-event', driveProjectId: `run-${sessionId}`, driveTurnId },
    noopGetWindow,
  );
}

beforeEach(async () => {
  for (const call of execCalls.splice(0)) call.finish();
  await settle();
  settings.clear();
  driveComplete.mockClear();
  resetDesktopLanesForTests();
  resetInFlightDesktopSessionsForTests();
  __resetChatCapabilityContextForTests();
  clearRepoGraphTurnSession();
  getDriveTurnSemaphoreForTests().resetForTests();
});

describe('AC-17: turnos humanos em lanes distintas rodam em paralelo (uma vaga por lane)', () => {
  it('A e B entram em voo ao mesmo tempo; a terceira mensagem de A espera na fila de A', async () => {
    submitHuman('lane-a');
    submitHuman('lane-b');
    await waitFor(() => execCalls.length === 2);

    expect(execCalls.map((c) => c.sessionId).sort()).toEqual(['lane-a', 'lane-b']);
    expect(execCalls[0]!.lane).not.toBe(execCalls[1]!.lane);
    expect(getInFlightDesktopSessions().sort()).toEqual(['lane-a', 'lane-b']);
    expect(
      listActiveDesktopTurns()
        .map((t) => t.sessionId)
        .sort(),
    ).toEqual(['lane-a', 'lane-b']);
    expect(getDesktopSessionExecutionState('lane-a')).toBe('streaming');
    expect(getDesktopSessionExecutionState('lane-b')).toBe('streaming');
    expect(hasActiveOrchestratorWork()).toBe(true);

    submitHuman('lane-a', 'segunda de A');
    await settle();
    expect(execCalls).toHaveLength(2);
    expect(getDesktopSessionExecutionState('lane-a')).toBe('streaming');
    expect(getDesktopLane('lane-a').queue.length).toBe(1);
    expect(getDesktopLane('lane-b').queue.length).toBe(0);

    execCalls[0]!.finish();
    execCalls[1]!.finish();
    await waitFor(() => execCalls.length === 3);
    expect(execCalls[2]!.sessionId).toBe('lane-a');
    execCalls[2]!.finish();
    await waitFor(() => getInFlightDesktopSessions().length === 0);
    expect(hasActiveOrchestratorWork()).toBe(false);
  });

  it('chat:stop(A) aborta so A: B conclui normalmente', async () => {
    submitHuman('lane-a');
    submitHuman('lane-b');
    await waitFor(() => execCalls.length === 2);
    const a = execCalls.find((c) => c.sessionId === 'lane-a')!;
    const b = execCalls.find((c) => c.sessionId === 'lane-b')!;

    stopCurrentQuery('lane-a');
    await waitFor(() => !getInFlightDesktopSessions().includes('lane-a'));
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(false);
    expect(getInFlightDesktopSessions()).toEqual(['lane-b']);
    expect(getDesktopSessionExecutionState('lane-b')).toBe('streaming');

    b.finish();
    await waitFor(() => getInFlightDesktopSessions().length === 0);
    expect(b.aborted).toBe(false);
  });

  it('stopCurrentQuery() sem argumento aborta TODAS as lanes desktop e esvazia as filas', async () => {
    submitHuman('lane-a');
    submitHuman('lane-b');
    submitHuman('lane-a', 'na fila de A');
    await waitFor(() => execCalls.length === 2);

    stopCurrentQuery();
    await waitFor(() => getInFlightDesktopSessions().length === 0);
    expect(execCalls.every((c) => c.aborted)).toBe(true);
    expect(listDesktopLanes().every((lane) => lane.queue.length === 0)).toBe(true);
    await settle();
    expect(execCalls).toHaveLength(2);
  });

  it('turno de drive (dw-drive-*) entra pela vaga propria em paralelo com dois humanos em voo', async () => {
    submitHuman('lane-a');
    submitHuman('lane-b');
    await waitFor(() => execCalls.length === 2);

    submitDrive('dw-drive-run1-abc', 'dt-1');
    await waitFor(() => execCalls.length === 3);
    const drive = execCalls[2]!;
    expect(drive.sessionId).toBe('dw-drive-run1-abc');
    expect(drive.origin).toBe('system-event');
    expect(drive.lane).not.toBe(execCalls[0]!.lane);
    expect(getInFlightDesktopSessions()).toHaveLength(3);

    drive.finish();
    await waitFor(() => !getInFlightDesktopSessions().includes('dw-drive-run1-abc'));
    expect(driveComplete).toHaveBeenCalledWith('run-dw-drive-run1-abc', 'dt-1', 'executed');
    execCalls[0]!.finish();
    execCalls[1]!.finish();
    await waitFor(() => getInFlightDesktopSessions().length === 0);
  });
});

describe('8.3: semaforo de drives separado do humano (drive_parallel_turns)', () => {
  it('default 1: o segundo wake espera o primeiro; o humano nunca espera o drive', async () => {
    submitDrive('dw-drive-1-a', 'dt-1');
    await waitFor(() => execCalls.length === 1);
    submitDrive('dw-drive-2-b', 'dt-2');
    await settle();
    expect(execCalls).toHaveLength(1);
    expect(getDriveTurnSemaphoreForTests().activeCount).toBe(1);
    expect(getDriveTurnSemaphoreForTests().waitingCount).toBe(1);

    submitHuman('lane-a');
    await waitFor(() => execCalls.length === 2);
    expect(execCalls[1]!.sessionId).toBe('lane-a');

    execCalls[0]!.finish();
    await waitFor(() => execCalls.length === 3);
    expect(execCalls[2]!.sessionId).toBe('dw-drive-2-b');
    expect(getDriveTurnSemaphoreForTests().waitingCount).toBe(0);
    execCalls[1]!.finish();
    execCalls[2]!.finish();
    await waitFor(() => getInFlightDesktopSessions().length === 0);
  });

  it('drive_parallel_turns=2 deixa dois wakes em voo; o terceiro espera', async () => {
    settings.set('drive_parallel_turns', '2');
    submitDrive('dw-drive-1-a', 'dt-1');
    submitDrive('dw-drive-2-b', 'dt-2');
    await waitFor(() => execCalls.length === 2);
    submitDrive('dw-drive-3-c', 'dt-3');
    await settle();
    expect(execCalls).toHaveLength(2);
    expect(getDriveTurnSemaphoreForTests().waitingCount).toBe(1);
    execCalls[0]!.finish();
    await waitFor(() => execCalls.length === 3);
    expect(execCalls[2]!.sessionId).toBe('dw-drive-3-c');
    for (const c of execCalls) c.finish();
    await waitFor(() => getInFlightDesktopSessions().length === 0);
  });

  it('chat:stop na lane de um drive que aguarda vaga descarta o turno com sinal discarded', async () => {
    submitDrive('dw-drive-1-a', 'dt-1');
    await waitFor(() => execCalls.length === 1);
    submitDrive('dw-drive-2-b', 'dt-2');
    await settle();
    expect(getDriveTurnSemaphoreForTests().waitingCount).toBe(1);

    stopCurrentQuery('dw-drive-2-b');
    await waitFor(() => !getInFlightDesktopSessions().includes('dw-drive-2-b'));
    expect(getDriveTurnSemaphoreForTests().waitingCount).toBe(0);
    expect(driveComplete).toHaveBeenCalledWith('run-dw-drive-2-b', 'dt-2', 'discarded');
    expect(execCalls).toHaveLength(1);
    execCalls[0]!.finish();
    await waitFor(() => getInFlightDesktopSessions().length === 0);
  });
});

describe('8.3/8.4 (P2-1): so drives de WORKFLOW (dw-drive-*) passam pelo semaforo de drives', () => {
  it('drive de PIPELINE na lane humana nao espera vaga nem consome o semaforo; o humano atras dele so espera a lane', async () => {
    submitDrive('dw-drive-1-a', 'dt-1');
    await waitFor(() => execCalls.length === 1);
    expect(getDriveTurnSemaphoreForTests().activeCount).toBe(1);

    submitDrive('lane-a', 'pipe-1');
    await waitFor(() => execCalls.length === 2);
    const pipelineDrive = execCalls[1]!;
    expect(pipelineDrive.sessionId).toBe('lane-a');
    expect(pipelineDrive.origin).toBe('system-event');
    expect(getDriveTurnSemaphoreForTests().activeCount).toBe(1);
    expect(getDriveTurnSemaphoreForTests().waitingCount).toBe(0);

    submitHuman('lane-a', 'mensagem humana atras do drive');
    await settle();
    expect(execCalls).toHaveLength(2);
    expect(getDesktopSessionExecutionState('lane-a')).toBe('streaming');

    pipelineDrive.finish();
    await waitFor(() => execCalls.length === 3);
    expect(execCalls[2]!.sessionId).toBe('lane-a');
    expect(execCalls[2]!.origin).toBe('user');
    expect(getDriveTurnSemaphoreForTests().activeCount).toBe(1);
    expect(driveComplete).toHaveBeenCalledWith('run-lane-a', 'pipe-1', 'executed');

    execCalls[0]!.finish();
    execCalls[2]!.finish();
    await waitFor(() => getInFlightDesktopSessions().length === 0);
    expect(getDriveTurnSemaphoreForTests().activeCount).toBe(0);
  });
});

describe('P3-3: lanes ociosas saem do Map', () => {
  it('stopCurrentQuery() global remove a lane ociosa (fila vazia) e preserva a lane com turno em voo', async () => {
    submitHuman('lane-idle');
    await waitFor(() => execCalls.length === 1);
    execCalls[0]!.finish();
    await waitFor(() => getInFlightDesktopSessions().length === 0);
    expect(listDesktopLanes().map((l) => l.sessionId)).toEqual(['lane-idle']);

    submitHuman('lane-busy');
    await waitFor(() => execCalls.length === 2);

    stopCurrentQuery();
    const ids = listDesktopLanes().map((l) => l.sessionId);
    expect(ids).not.toContain('lane-idle');
    expect(ids).toContain('lane-busy');

    await waitFor(() => getInFlightDesktopSessions().length === 0);
    expect(pruneIdleDesktopLanes()).toEqual(['lane-busy']);
    expect(listDesktopLanes()).toHaveLength(0);
  });

  it('pruneIdleDesktopLane recusa remover lane com item na fila', async () => {
    submitHuman('lane-a');
    submitHuman('lane-a', 'segunda');
    await waitFor(() => execCalls.length === 1);
    expect(pruneIdleDesktopLane('lane-a')).toBe(false);
    execCalls[0]!.finish();
    await waitFor(() => execCalls.length === 2);
    execCalls[1]!.finish();
    await waitFor(() => getInFlightDesktopSessions().length === 0);
    expect(pruneIdleDesktopLane('lane-a')).toBe(true);
    expect(pruneIdleDesktopLane('lane-a')).toBe(false);
  });
});

describe('8.2: submitMessage exige sessionId', () => {
  it('sem sessionId lanca session_required e nada e enfileirado', () => {
    expect(() => submitMessage('oi', { silent: true }, noopGetWindow)).toThrow(/session_required/);
    expect(listDesktopLanes()).toHaveLength(0);
  });
});

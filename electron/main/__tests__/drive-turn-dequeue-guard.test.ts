
import { describe, it, expect, beforeEach, vi } from 'vitest';


vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  rootLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('../orchestrator-selection', () => ({
  resolveOrchestratorSelection: vi.fn(),
  InvalidOrchestratorSelectionError: class extends Error {},
}));

vi.mock('../claude-compat-sdk', () => ({
  executeClaudeCompatSdkQuery: vi.fn(async () => undefined),
  isClaudeCompatQueryActive: vi.fn(() => false),
  resetClaudeCompatSdkSessionState: vi.fn(),
  stopClaudeCompatQuery: vi.fn(),
}));

vi.mock('../codex-sdk', () => ({
  executeCodexSdkQuery: vi.fn(async () => undefined),
  isCodexSdkQueryActive: vi.fn(() => false),
  resetCodexSdkSessionState: vi.fn(),
  stopCodexSdkQuery: vi.fn(),
}));

vi.mock('../lion-sdk', () => ({
  executeLionSdkQuery: vi.fn(async () => undefined),
  isLionSdkQueryActive: vi.fn(() => false),
  resetLionSdkSessionState: vi.fn(),
  stopLionSdkQuery: vi.fn(),
}));

const getHarnessProjectMock = vi.fn<(id: string) => Record<string, unknown> | null>();

vi.mock('../db', () => ({
  getAllAgents: () => [],
  getAgent: () => undefined,
  insertMessage: vi.fn(),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(() => 'session-1'),
  getSetting: vi.fn(),
  updateSessionTokens: vi.fn(),
  getActiveSession: vi.fn(),
  getActiveChatSession: vi.fn(),
  getSession: vi.fn(),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  insertTaskExecution: vi.fn(),
  getTurnIndexForUserMessage: vi.fn(() => 0),
  getLatestUserTurnIndex: vi.fn(() => 0),
  getHarnessProject: (id: string) => getHarnessProjectMock(id),
}));

vi.mock('../knowledge-state', () => ({ setActiveAgentId: vi.fn() }));
vi.mock('../onboarding', () => ({ extractAndProcessOnboardingData: vi.fn() }));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));
vi.mock('../secrets-vault', () => ({
  getApiKey: async () => null,
  getSecret: async () => null,
}));
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(),
  GUARD_GATED_TOOLS: [],
}));
vi.mock('../mcp-manager', () => ({ getMCPConfigForAgent: async () => ({}) }));
vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: async () => ({
    allowedTools: [],
    systemPrompt: '',
    mcpServers: [],
    maxTurns: 0,
  }),
  mergeRepoGraphAllowlist: (tools: string[]) => tools,
  buildRepoGraphMcpSpec: () => ({}),
  REPO_GRAPH_MCP_SERVER_ID: 'repo-graph',
}));
vi.mock('../mcp-discovery', () => ({ getDisabledSDKMcps: () => [] }));
vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(),
  captureToolResult: vi.fn(),
  resetArtifactDetector: vi.fn(),
}));
vi.mock('../prompt-builder', () => ({ buildSystemPrompt: async () => '' }));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/tmp',
  getBackgroundCwd: () => '/tmp',
  getLionClawHome: () => '/tmp',
}));
vi.mock('../codex-agents-mcp', () => ({ getCodexAgentsServer: () => undefined }));
vi.mock('../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(),
}));


import { resolveOrchestratorSelection } from '../orchestrator-selection';
import {
  shouldDiscardStaleDriveTurn,
  submitMessage,
  executeQuery,
  stopCurrentQuery,
} from '../orchestrator';
import type { QueryOptions } from '../orchestrator';
import { messageQueue } from '../message-queue';
import { onDriveTurnComplete } from '../drive-usage-sink';

const mockResolve = vi.mocked(resolveOrchestratorSelection);
const fakeGetWindow = () => null;

function project(phase: number | null): Record<string, unknown> {
  return {
    id: 'proj_a',
    name: 'Demo',
    pipelineType: 'development-v2',
    status: 'running',
    pipelineCurrentPhase: phase,
  };
}

async function waitQueueDrained(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!messageQueue.isProcessing && messageQueue.length === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('fila nao drenou a tempo');
}

beforeEach(() => {
  vi.clearAllMocks();
  messageQueue.clear();
  mockResolve.mockResolvedValue({
    runtime: 'claude-sdk',
    provider: 'anthropic',
    model: 'claude-test',
    source: 'settings',
  } as never);
});


describe('shouldDiscardStaleDriveTurn (F7)', () => {
  it('F7-AC1: drivePhase MENOR que a fase real -> descarta (true)', () => {
    getHarnessProjectMock.mockReturnValue(project(5));
    const opts: QueryOptions = {
      sessionId: 's1',
      origin: 'system-event',
      driveProjectId: 'proj_a',
      drivePhase: 2,
    };
    expect(shouldDiscardStaleDriveTurn(opts)).toBe(true);
  });

  it('F7-AC2: drivePhase IGUAL a fase real -> passa (false)', () => {
    getHarnessProjectMock.mockReturnValue(project(5));
    const opts: QueryOptions = {
      sessionId: 's1',
      origin: 'system-event',
      driveProjectId: 'proj_a',
      drivePhase: 5,
    };
    expect(shouldDiscardStaleDriveTurn(opts)).toBe(false);
  });

  it('borda do reset (documentada): drivePhase MAIOR que a fase real (recuo pos-reset) -> passa', () => {
    getHarnessProjectMock.mockReturnValue(project(3));
    const opts: QueryOptions = {
      sessionId: 's1',
      origin: 'system-event',
      driveProjectId: 'proj_a',
      drivePhase: 7,
    };
    expect(shouldDiscardStaleDriveTurn(opts)).toBe(false);
  });

  it('F7-AC3: mensagem de usuario (sem origin) nunca entra no guard', () => {
    expect(shouldDiscardStaleDriveTurn({ sessionId: 's1' })).toBe(false);
    expect(getHarnessProjectMock).not.toHaveBeenCalled();
  });

  it('F7-AC3: origin system-event SEM driveProjectId (Telegram/scheduler) nao entra no guard', () => {
    expect(shouldDiscardStaleDriveTurn({ sessionId: 's1', origin: 'system-event' })).toBe(false);
    expect(getHarnessProjectMock).not.toHaveBeenCalled();
  });

  it('origin user COM driveProjectId (nao acontece em producao): guard nao age', () => {
    expect(
      shouldDiscardStaleDriveTurn({
        sessionId: 's1',
        origin: 'user',
        driveProjectId: 'proj_a',
        drivePhase: 1,
      }),
    ).toBe(false);
    expect(getHarnessProjectMock).not.toHaveBeenCalled();
  });

  it('fail-open: projeto inexistente -> passa', () => {
    getHarnessProjectMock.mockReturnValue(null);
    expect(
      shouldDiscardStaleDriveTurn({
        sessionId: 's1',
        origin: 'system-event',
        driveProjectId: 'proj_x',
        drivePhase: 1,
      }),
    ).toBe(false);
  });

  it('fail-open: pipelineCurrentPhase null -> passa', () => {
    getHarnessProjectMock.mockReturnValue(project(null));
    expect(
      shouldDiscardStaleDriveTurn({
        sessionId: 's1',
        origin: 'system-event',
        driveProjectId: 'proj_a',
        drivePhase: 1,
      }),
    ).toBe(false);
  });

  it('fail-open: getHarnessProject LANCA -> passa (nunca bloqueia o chat)', () => {
    getHarnessProjectMock.mockImplementation(() => {
      throw new Error('db indisponivel');
    });
    expect(
      shouldDiscardStaleDriveTurn({
        sessionId: 's1',
        origin: 'system-event',
        driveProjectId: 'proj_a',
        drivePhase: 1,
      }),
    ).toBe(false);
  });
});


const EPOCA_A = '2026-07-30T16:34:36.828Z';
const EPOCA_B = '2026-07-30T18:20:00.000Z';

function projectWithDrive(
  phase: number | null,
  drive: { status: string; startedAt?: string; driver?: string },
): Record<string, unknown> {
  return {
    ...project(phase),
    config: {
      drive: {
        driver: drive.driver ?? 'orchestrator',
        status: drive.status,
        handoff: 'none',
        mode: 'full',
        requiresHumanPhases: [],
        startedAt: drive.startedAt,
      },
    },
  };
}

describe('shouldDiscardStaleDriveTurn — epoca do drive (Passo 1)', () => {
  it('epoca IGUAL a do drive corrente -> passa', () => {
    getHarnessProjectMock.mockReturnValue(
      projectWithDrive(5, { status: 'driving', startedAt: EPOCA_A }),
    );
    expect(
      shouldDiscardStaleDriveTurn({
        sessionId: 's1',
        origin: 'system-event',
        driveProjectId: 'proj_a',
        drivePhase: 5,
        driveEpoch: EPOCA_A,
      }),
    ).toBe(false);
  });

  it('epoca DIFERENTE (parar + retomar) -> descarta, mesmo com a fase igual a real', () => {
    getHarnessProjectMock.mockReturnValue(
      projectWithDrive(5, { status: 'driving', startedAt: EPOCA_B }),
    );
    expect(
      shouldDiscardStaleDriveTurn({
        sessionId: 's1',
        origin: 'system-event',
        driveProjectId: 'proj_a',
        drivePhase: 5,
        driveEpoch: EPOCA_A,
      }),
    ).toBe(true);
  });

  it('pipeline CONCLUIDO (fase real null) + drive parado -> descarta (o caso do incidente)', () => {
    getHarnessProjectMock.mockReturnValue(
      projectWithDrive(null, { status: 'stopped', startedAt: EPOCA_A }),
    );
    expect(
      shouldDiscardStaleDriveTurn({
        sessionId: 's1',
        origin: 'system-event',
        driveProjectId: 'proj_a',
        drivePhase: 1,
        driveEpoch: EPOCA_A,
      }),
    ).toBe(true);
  });

  it('drive em awaiting-human (escalacao do semi) -> NAO descarta: o motorista ainda conduz', () => {
    getHarnessProjectMock.mockReturnValue(
      projectWithDrive(5, { status: 'awaiting-human', startedAt: EPOCA_A }),
    );
    expect(
      shouldDiscardStaleDriveTurn({
        sessionId: 's1',
        origin: 'system-event',
        driveProjectId: 'proj_a',
        drivePhase: 5,
        driveEpoch: EPOCA_A,
      }),
    ).toBe(false);
  });

  it('turno de RESUMO DE ENTREGA (drivePhase 0) passa mesmo com o drive parado', () => {
    getHarnessProjectMock.mockReturnValue(
      projectWithDrive(null, { status: 'stopped', startedAt: EPOCA_A }),
    );
    expect(
      shouldDiscardStaleDriveTurn({
        sessionId: 's1',
        origin: 'system-event',
        driveProjectId: 'proj_a',
        drivePhase: 0,
      }),
    ).toBe(false);
  });

  it('wake de Dynamic Workflow (sem drivePhase) passa e NEM consulta o projeto', () => {
    expect(
      shouldDiscardStaleDriveTurn({
        sessionId: 's1',
        origin: 'system-event',
        driveProjectId: 'run_workflow_123',
        driveTurnId: 'run_workflow_123:1',
      }),
    ).toBe(false);
    expect(getHarnessProjectMock).not.toHaveBeenCalled();
  });

  it('turno SEM driveEpoch (enfileirado antes do upgrade) passa enquanto o drive vive', () => {
    getHarnessProjectMock.mockReturnValue(
      projectWithDrive(5, { status: 'driving', startedAt: EPOCA_A }),
    );
    expect(
      shouldDiscardStaleDriveTurn({
        sessionId: 's1',
        origin: 'system-event',
        driveProjectId: 'proj_a',
        drivePhase: 5,
      }),
    ).toBe(false);
  });

  it('projeto SEM config.drive -> fail-open (passa)', () => {
    getHarnessProjectMock.mockReturnValue(project(5));
    expect(
      shouldDiscardStaleDriveTurn({
        sessionId: 's1',
        origin: 'system-event',
        driveProjectId: 'proj_a',
        drivePhase: 5,
        driveEpoch: EPOCA_A,
      }),
    ).toBe(false);
  });
});


describe('Passo 0: clear da fila sinaliza os turnos de drive descartados', () => {
  it('stopCurrentQuery emite complete de cada turno system-event, preservando o driveTurnId', () => {
    const vistos: Array<{ projectId: string; driveTurnId?: string }> = [];
    const off = onDriveTurnComplete((c) => vistos.push({ ...c }));
    const enqueuedAt = 1;
    messageQueue.enqueue({
      message: '[DRIVE DE PIPELINE] turno 1',
      options: {
        sessionId: 's1',
        origin: 'system-event',
        driveProjectId: 'proj_a',
        drivePhase: 3,
        driveTurnId: 'proj_a:1',
      },
      enqueuedAt,
    });
    messageQueue.enqueue({
      message: 'mensagem do humano (nao e turno de drive)',
      options: { sessionId: 's1' },
      enqueuedAt,
    });
    messageQueue.enqueue({
      message: '[DRIVE DE PIPELINE] turno 2',
      options: {
        sessionId: 's1',
        origin: 'system-event',
        driveProjectId: 'proj_a',
        drivePhase: 4,
        driveTurnId: 'proj_a:2',
      },
      enqueuedAt,
    });

    stopCurrentQuery();
    off();

    expect(messageQueue.length).toBe(0);
    expect(vistos).toEqual([
      { projectId: 'proj_a', driveTurnId: 'proj_a:1', outcome: 'discarded' },
      { projectId: 'proj_a', driveTurnId: 'proj_a:2', outcome: 'discarded' },
    ]);
  });
});


describe('processQueue + guard (integracao com a fila real)', () => {
  it('F7-AC1: turno de drive DEFASADO e descartado SEM executeQuery (resolver nunca roda)', async () => {
    getHarnessProjectMock.mockReturnValue(project(9));
    submitMessage(
      '[DRIVE DE PIPELINE] prompt defasado (fase 2)',
      { sessionId: 's1', origin: 'system-event', driveProjectId: 'proj_a', drivePhase: 2 },
      fakeGetWindow,
    );
    await waitQueueDrained();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('F7-AC2/AC4: turno de drive FRESCO executa (resolver roda; campos novos ignorados pelo executor)', async () => {
    getHarnessProjectMock.mockReturnValue(project(9));
    submitMessage(
      '[DRIVE DE PIPELINE] prompt fresco (fase 9)',
      { sessionId: 's1', origin: 'system-event', driveProjectId: 'proj_a', drivePhase: 9 },
      fakeGetWindow,
    );
    await waitQueueDrained();
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  it('F7-AC3: mensagem de usuario na fila nunca consulta o projeto e executa normal', async () => {
    submitMessage('oi, tudo bem?', { sessionId: 's1' }, fakeGetWindow);
    await waitQueueDrained();
    expect(getHarnessProjectMock).not.toHaveBeenCalled();
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  it('F7-AC4: executeQuery chamado direto com os campos novos resolve sem efeito colateral', async () => {
    await expect(
      executeQuery(
        'turno qualquer',
        { sessionId: 's1', origin: 'system-event', driveProjectId: 'proj_a', drivePhase: 3 },
        fakeGetWindow,
      ),
    ).resolves.toBeUndefined();
  });
});


describe('W4-AC3: descarte do turno defasado da fase ODS pos-lock (guard real)', () => {
  const ODS_PHASE = 5; // dev-v2 Open Design Studio (onde o lock acontece)
  const FIRST_ACTIONABLE_AFTER_LOCK = 8; // dev-v2 Database (1o ponto acionavel)

  it('turno da ODS (drivePhase=5) com a fase real ja em 8 (pos-lock) e DESCARTADO', () => {
    getHarnessProjectMock.mockReturnValue(project(FIRST_ACTIONABLE_AFTER_LOCK));
    const staleOdsTurn: QueryOptions = {
      sessionId: 's1',
      origin: 'system-event',
      driveProjectId: 'proj_a',
      drivePhase: ODS_PHASE,
    };
    expect(shouldDiscardStaleDriveTurn(staleOdsTurn)).toBe(true);
  });

  it('nenhum turno semeado durante o encadeamento auto do lock executa: 5/6/7 descartados, 8 passa', () => {
    getHarnessProjectMock.mockReturnValue(project(FIRST_ACTIONABLE_AFTER_LOCK));
    for (const stalePhase of [ODS_PHASE, 6, 7]) {
      expect(
        shouldDiscardStaleDriveTurn({
          sessionId: 's1',
          origin: 'system-event',
          driveProjectId: 'proj_a',
          drivePhase: stalePhase,
        }),
      ).toBe(true);
    }
    expect(
      shouldDiscardStaleDriveTurn({
        sessionId: 's1',
        origin: 'system-event',
        driveProjectId: 'proj_a',
        drivePhase: FIRST_ACTIONABLE_AFTER_LOCK,
      }),
    ).toBe(false);
  });

  it('integracao na fila: turno DEFASADO da ODS e descartado SEM executeQuery (resolver nunca roda)', async () => {
    getHarnessProjectMock.mockReturnValue(project(FIRST_ACTIONABLE_AFTER_LOCK));
    submitMessage(
      '[DRIVE DE PIPELINE] turno defasado da fase ODS (5), emitido no lock',
      { sessionId: 's1', origin: 'system-event', driveProjectId: 'proj_a', drivePhase: ODS_PHASE },
      fakeGetWindow,
    );
    await waitQueueDrained();
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

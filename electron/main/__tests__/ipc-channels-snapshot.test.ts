import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveState, DriveStateChangedEvent, LionClawAPI } from '../../../src/types';
import type { OpenDesktopSessionRow } from '../db';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const lane = vi.hoisted(() => ({
  driveSessionId: null as string | null,
  openLane: null as OpenDesktopSessionRow | null,
  projects: [] as Array<Record<string, unknown>>,
}));

vi.mock('../db', () => ({
  getHarnessProject: vi.fn((id: string) => lane.projects.find((p) => p['id'] === id)),
  listHarnessProjects: vi.fn(() => lane.projects),
  getSecurityAgentStatuses: vi.fn(() => []),
  getAuditAgentsState: vi.fn(() => null),
  deleteHarnessProject: vi.fn(),
  getHarnessSprints: vi.fn(() => []),
  getHarnessSprintAggregateMetrics: vi.fn(() => ({})),
  getHarnessSprintByIndex: vi.fn(() => undefined),
  getPipelinePhaseMessages: vi.fn(() => []),
  listPipelineMessagesForSprint: vi.fn(() => []),
  getPipelineMetrics: vi.fn(() => ({})),
  getSecuritySummaryJson: vi.fn(() => null),
  getBugAnalysisAgentsState: vi.fn(() => null),
  isDriveEngaged: vi.fn(() => false),
  getDriveSessionId: vi.fn(() => lane.driveSessionId),
  getOpenLaneSessionById: vi.fn((id: string) => (lane.openLane && lane.openLane.id === id ? lane.openLane : null)),
  getDriveState: vi.fn(() => null),
  setDriveState: vi.fn(),
}));

const emitted = vi.hoisted(() => ({ driveEvents: [] as DriveStateChangedEvent[] }));
vi.mock('../pipeline-shared/ipc-emitter', () => ({
  emitIPC: (channel: string, payload: DriveStateChangedEvent) => {
    if (channel === 'drive:state-changed') emitted.driveEvents.push(payload);
  },
}));

vi.mock('../pipeline-event-bus', () => ({
  pipelineEventBus: { emit: vi.fn(), on: vi.fn(() => () => {}) },
}));
vi.mock('../pipeline-shared/lock', () => ({
  acquireProjectLock: vi.fn(() => true),
  ensureProjectLock: vi.fn(),
  releaseProjectLock: vi.fn(),
}));
vi.mock('../pipeline-create', () => ({ createPipelineProject: vi.fn() }));

const driveCoordinator = vi.hoisted(() => ({ stopDrive: vi.fn() }));
vi.mock('../pipeline-drive-coordinator', () => ({
  getPipelineDriveCoordinator: () => driveCoordinator,
}));

const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { buildDriveStateChangedEvent } from '../drive-state-event';
import { registerPipelineHandlers } from '../ipc/pipeline';
import type { IpcContext } from '../ipc/context';

describe('IPC channel payload snapshots', () => {
  describe('chat:stream', () => {
    it('text chunk with sessionId', () => {
      const payload = {
        type: 'text',
        content: 'Olá, como posso ajudar?',
        sessionId: 'sess_abc123',
      };
      expect(payload).toMatchSnapshot();
    });

    it('tool_call chunk', () => {
      const payload = {
        type: 'tool_call',
        tool: 'Read',
        input: { file_path: '/Users/example/file.ts' },
        sessionId: 'sess_abc123',
      };
      expect(payload).toMatchSnapshot();
    });

    it('artifact chunk (html) with filePath, size and sha256', () => {
      const payload = {
        type: 'artifact',
        sessionId: 'sess_abc123',
        artifact: {
          id: 'art_html_1',
          type: 'html',
          title: 'Artefatos HTML',
          toolName: 'file-output',
          data: {
            filePath: 'C:\\Users\\example\\.lionclaw\\artifacts\\revisao-20260908-1400.html',
            fileName: 'revisao-20260908-1400.html',
            size: 39855,
            sha256: 'a'.repeat(64),
          },
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('done chunk with queueRemaining', () => {
      const payload = {
        type: 'done',
        sessionId: 'sess_abc123',
        queueRemaining: 2,
      };
      expect(payload).toMatchSnapshot();
    });

    it('session chunk (sessionId broadcast)', () => {
      const payload = {
        type: 'session',
        content: 'sess_abc123',
      };
      expect(payload).toMatchSnapshot();
    });

    it('ask_question chunk (from ask-question.ts)', () => {
      const payload = {
        type: 'ask_question',
        askRequest: {
          id: 'ask_xyz789',
          questions: [
            {
              question: 'Qual ambiente?',
              header: 'Selecione',
              options: [
                { label: 'dev', description: 'Desenvolvimento' },
                { label: 'prod', description: 'Producao' },
              ],
            },
          ],
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('error chunk', () => {
      const payload = {
        type: 'error',
        error: 'API key nao configurada. Va em Settings.',
      };
      expect(payload).toMatchSnapshot();
    });

    it('error chunk tipado (code do resolver)', () => {
      const payload = {
        type: 'error',
        code: 'orchestrator_unconfigured',
        error: 'Orquestrador nao configurado: runtime ausente nos settings. Abra Configuracoes no app.',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('chat:stream — activity (SPEC K2)', () => {
    it('activity chunk — subagent start', () => {
      const payload = {
        type: 'activity',
        activity: {
          id: 'toolu_sub_01',
          kind: 'subagent',
          phase: 'start',
          label: 'Explore',
          status: 'running',
          agentId: 'explore',
          startedAt: '2026-06-08T10:00:00.000Z',
        },
        sessionId: 'sess_abc123',
      };
      expect(payload).toMatchSnapshot();
    });

    it('activity chunk — subagent end (tokens + cost + duration)', () => {
      const payload = {
        type: 'activity',
        activity: {
          id: 'toolu_sub_01',
          kind: 'subagent',
          phase: 'end',
          label: 'Explore',
          status: 'done',
          agentId: 'explore',
          model: 'claude-sonnet-4-6',
          tokens: { input: 12_345, output: 678, cacheRead: 9_876, cacheCreation: 200 },
          costUsd: 0.0432,
          durationMs: 8_400,
          summary: 'Encontrou 3 arquivos relevantes.',
          endedAt: '2026-06-08T10:00:08.400Z',
        },
        sessionId: 'sess_abc123',
      };
      expect(payload).toMatchSnapshot();
    });

    it('activity chunk — tool start (nested via parentId)', () => {
      const payload = {
        type: 'activity',
        activity: {
          id: 'toolu_read_02',
          parentId: 'toolu_sub_01',
          kind: 'tool',
          phase: 'start',
          label: 'Read',
          status: 'running',
          toolName: 'Read',
          startedAt: '2026-06-08T10:00:01.000Z',
        },
        sessionId: 'sess_abc123',
      };
      expect(payload).toMatchSnapshot();
    });

    it('activity chunk — tool end (best-effort, fim de geracao)', () => {
      const payload = {
        type: 'activity',
        activity: {
          id: 'toolu_read_02',
          kind: 'tool',
          phase: 'end',
          label: '',
          status: 'done',
          endedAt: '2026-06-08T10:00:01.500Z',
        },
        sessionId: 'sess_abc123',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('chat:stream — activity v2 (SPEC K2 v2)', () => {
    it('activity chunk — subagent start (description + turnIndex)', () => {
      const payload = {
        type: 'activity',
        activity: {
          id: 'toolu_sub_01',
          kind: 'subagent',
          phase: 'start',
          label: 'Explore',
          status: 'running',
          agentId: 'explore',
          description: 'Mapear arquivos de auth',
          turnIndex: 1,
          startedAt: '2026-06-08T10:00:00.000Z',
        },
        sessionId: 'sess_abc123',
      };
      expect(payload).toMatchSnapshot();
    });

    it('activity chunk — subagent end (toolUses + turnIndex)', () => {
      const payload = {
        type: 'activity',
        activity: {
          id: 'toolu_sub_01',
          kind: 'subagent',
          phase: 'end',
          label: 'Explore',
          status: 'done',
          agentId: 'explore',
          model: 'claude-sonnet-4-6',
          description: 'Mapear arquivos de auth',
          toolUses: 2,
          tokens: { input: 12_345, output: 678, cacheRead: 9_876, cacheCreation: 200 },
          costUsd: 0.0432,
          durationMs: 8_400,
          summary: 'Encontrou 3 arquivos relevantes.',
          turnIndex: 1,
          endedAt: '2026-06-08T10:00:08.400Z',
        },
        sessionId: 'sess_abc123',
      };
      expect(payload).toMatchSnapshot();
    });

    it('activity chunk — tool update (file detail, changed)', () => {
      const payload = {
        type: 'activity',
        activity: {
          id: 'toolu_edit_02',
          parentId: 'toolu_sub_01',
          kind: 'tool',
          phase: 'update',
          label: 'Edit',
          status: 'done',
          toolName: 'Edit',
          file: '/Users/example/auth.ts',
          changed: true,
          turnIndex: 1,
        },
        sessionId: 'sess_abc123',
      };
      expect(payload).toMatchSnapshot();
    });

    it('activity chunk — tool update Bash (command + exitCode)', () => {
      const payload = {
        type: 'activity',
        activity: {
          id: 'toolu_bash_03',
          parentId: 'toolu_sub_01',
          kind: 'tool',
          phase: 'update',
          label: 'Bash',
          status: 'done',
          toolName: 'Bash',
          command: 'npm test',
          exitCode: 0,
          changed: false,
          turnIndex: 1,
        },
        sessionId: 'sess_abc123',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('chat:ensure-session (SPEC handoff-orchestrator, Canal ADITIVO 1)', () => {
    it('request shape — { preferredSessionId } presente', () => {
      const payload = { preferredSessionId: 'sess_abc123' };
      expect(payload).toMatchSnapshot();
    });

    it('request shape — sem preferredSessionId (objeto vazio)', () => {
      const payload = {};
      expect(payload).toMatchSnapshot();
    });

    it('result — preferred valido: retorna o MESMO id', () => {
      const payload = { sessionId: 'sess_abc123' };
      expect(payload).toMatchSnapshot();
    });

    it('result — sem ativa: cria nova e retorna novo id', () => {
      const payload = { sessionId: 'b3b1d2c4-5e6f-4a7b-8c9d-0e1f2a3b4c5d' };
      expect(payload).toMatchSnapshot();
    });

    it('erro em fluxo normal: { error } sem throw (convencao IPC secao 9)', () => {
      const payload = { error: 'no such table: sessions' };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('chat:get-context-usage (SPEC robustez-chat SA-2, Canal ADITIVO UX-CTX)', () => {
    it('request shape — sessionId', () => {
      const payload = 'sess_abc123';
      expect(payload).toMatchSnapshot();
    });

    it('result — contextUsage hidratado (source estimate, shape do chunk context_usage)', () => {
      const payload = {
        contextTokens: 123_456,
        contextWindowTokens: 1_000_000,
        compactionThresholdPercent: 80,
        source: 'estimate',
      };
      expect(payload).toMatchSnapshot();
    });

    it('result — null (janela desconhecida / sessao sem tokens / erro): D5, sem barra', () => {
      const payload = null;
      expect(payload).toMatchSnapshot();
    });
  });

  describe('chat feature toggles (SPEC chat-context-reduction A.3, Canais ADITIVOS S2)', () => {
    it('chat:send options — campo aditivo featureToggles (snapshot do turno)', () => {
      const payload = {
        sessionId: 'sess_abc123',
        featureToggles: { pipelineControl: false, dynamicWorkflows: true },
      };
      expect(payload).toMatchSnapshot();
    });

    it('chat:get-feature-toggles request shape — sessionId', () => {
      const payload = 'sess_abc123';
      expect(payload).toMatchSnapshot();
    });

    it('chat:get-feature-toggles result ok — toggles persistidos (ou default OFF sem linha)', () => {
      const payload = {
        ok: true,
        toggles: { pipelineControl: true, dynamicWorkflows: true },
      };
      expect(payload).toMatchSnapshot();
    });

    it('chat:set-feature-toggles request shape — patch parcial', () => {
      const payload = { pipelineControl: true };
      expect(payload).toMatchSnapshot();
    });

    it('chat:set-feature-toggles result ok — toggles resultantes do merge', () => {
      const payload = {
        ok: true,
        toggles: { pipelineControl: true, dynamicWorkflows: false },
      };
      expect(payload).toMatchSnapshot();
    });

    it('erro estruturado — sessao inexistente', () => {
      const payload = {
        ok: false,
        code: 'session_not_found',
        error: 'Sessao nao encontrada.',
      };
      expect(payload).toMatchSnapshot();
    });

    it('erro estruturado — type nao-desktop (telegram/scheduled)', () => {
      const payload = {
        ok: false,
        code: 'session_not_desktop',
        error: 'Toggles de capability so existem em sessoes de chat do desktop (chat/manual).',
      };
      expect(payload).toMatchSnapshot();
    });

    it('erro estruturado — status != active', () => {
      const payload = {
        ok: false,
        code: 'session_not_active',
        error: 'A sessao nao esta ativa; toggles so podem ser alterados em sessao ativa.',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('dynamic-workflow:get-run (SPEC handoff-orchestrator, Canal ADITIVO 2 — D8)', () => {
    const baseRun = {
      id: 'run-1',
      definitionId: 'def-1',
      chatSessionId: 'sess_abc123',
      status: 'delivered',
      currentPhaseId: 'Entrega',
      currentNodeId: 'gate-delivery-human',
      workspaceMode: 'run-worktree',
      baseBranch: 'main',
      baseCommitSha: 'abc1234567',
      baseWorktreeHash: null,
      worktreePath: '/tmp/run-1',
      worktreeBranch: 'dynworkflow/run-1',
      deliveredAt: '2026-06-18T10:05:00.000Z',
      finalizedAt: null,
      closerSessionId: null,
      closerStatus: null,
      inputJson: '{"name":"demo","defaultGateMode":"manual","autonomy":"semi","pendingStart":false}',
      outputJson: null,
      checkpointJson: '{}',
      error: null,
      totalCostUsd: 0.42,
      totalDurationMs: 12_000,
      createdBy: 'manual',
      startedAt: '2026-06-18T10:00:00.000Z',
      updatedAt: '2026-06-18T10:05:00.000Z',
      completedAt: null,
    };

    it('request shape — runId', () => {
      const payload = { runId: 'run-1' };
      expect(payload).toMatchSnapshot();
    });

    it('response shape — definition com project_path (projectPath persistente, D6dec)', () => {
      const payload = { ...baseRun, projectPath: '/srv/persistent' };
      expect(payload).toMatchSnapshot();
    });

    it('response shape — definition ausente / project_path vazio (projectPath null, NUNCA "")', () => {
      const payload = { ...baseRun, projectPath: null };
      expect(payload).toMatchSnapshot();
    });

    it('response shape — run ausente (null)', () => {
      const payload: unknown = null;
      expect(payload).toMatchSnapshot();
    });
  });

  describe('dynamic-workflow:get-run-bundle / open-run-dir (SPEC orquestrador-driver S4, D25c)', () => {
    it('get-run-bundle request shape — runId', () => {
      const payload = { runId: 'run-1' };
      expect(payload).toMatchSnapshot();
    });

    it('get-run-bundle response shape — RunBundleEntry[] (lista fechada, ordem estavel)', () => {
      const payload = [
        {
          name: 'workflow.js',
          relativePath: 'workflow.js',
          sizeBytes: 2048,
          mtime: '2026-09-02T10:00:00.000Z',
        },
        {
          name: 'workflow.manifest.json',
          relativePath: 'workflow.manifest.json',
          sizeBytes: 512,
          mtime: '2026-09-02T10:00:00.000Z',
        },
        {
          name: 'events.jsonl',
          relativePath: 'logs/events.jsonl',
          sizeBytes: 90_112,
          mtime: '2026-09-02T10:05:00.000Z',
        },
        {
          name: 'relatorio.md',
          relativePath: 'artifacts/sub/relatorio.md',
          sizeBytes: 1_024,
          mtime: '2026-09-02T10:04:00.000Z',
        },
      ];
      expect(payload).toMatchSnapshot();
    });

    it('get-run-bundle response shape — erro (run ausente / sem projectPath / pasta inexistente)', () => {
      const payload = { error: 'run nao encontrado: run-x' };
      expect(payload).toMatchSnapshot();
    });

    it('open-run-dir request shape — runId', () => {
      const payload = { runId: 'run-1' };
      expect(payload).toMatchSnapshot();
    });

    it('open-run-dir response shape — ok', () => {
      const payload = { ok: true };
      expect(payload).toMatchSnapshot();
    });

    it('open-run-dir response shape — erro (shell.openPath devolveu mensagem)', () => {
      const payload = { error: 'Failed to open path' };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('activity:get-blocks (SPEC K2 v2)', () => {
    it('request shape — sessionId', () => {
      const payload = { sessionId: 'sess_abc123' };
      expect(payload).toMatchSnapshot();
    });

    it('response shape — bloco por turno (subagent + tools, com totais)', () => {
      const payload: unknown = [
        {
          turnIndex: 1,
          sessionId: 'sess_abc123',
          items: [
            {
              id: 'toolu_sub_01',
              kind: 'subagent',
              label: 'Explore',
              status: 'done',
              agentId: 'explore',
              description: 'Mapear arquivos de auth',
              toolUses: 2,
              tokens: { input: 12_345, output: 678, cacheRead: 9_876, cacheCreation: 200 },
              costUsd: 0.0432,
              durationMs: 8_400,
              summary: 'Encontrou 3 arquivos relevantes.',
              turnIndex: 1,
              startedAt: '2026-06-08T10:00:00.000Z',
              endedAt: '2026-06-08T10:00:08.400Z',
            },
            {
              id: 'toolu_read_02',
              parentId: 'toolu_sub_01',
              kind: 'tool',
              label: 'Read',
              status: 'done',
              file: '/Users/example/auth.ts',
              changed: false,
              turnIndex: 1,
              startedAt: '2026-06-08T10:00:01.000Z',
              endedAt: '2026-06-08T10:00:01.500Z',
            },
            {
              id: 'toolu_bash_03',
              parentId: 'toolu_sub_01',
              kind: 'tool',
              label: 'Bash',
              status: 'done',
              command: 'npm test',
              exitCode: 0,
              changed: false,
              turnIndex: 1,
              startedAt: '2026-06-08T10:00:02.000Z',
              endedAt: '2026-06-08T10:00:05.000Z',
            },
          ],
          startedAt: '2026-06-08T10:00:00.000Z',
          endedAt: '2026-06-08T10:00:08.400Z',
          totals: { tokens: 13_023, costUsd: 0.0432, subagents: 1, tools: 2 },
          status: 'done',
        },
      ];
      expect(payload).toMatchSnapshot();
    });

    it('response shape — sessao sem atividade (vazio)', () => {
      const payload: unknown = [];
      expect(payload).toMatchSnapshot();
    });
  });

  describe('drive:* (SPEC orchestrator-pipeline-control S8)', () => {
    it('get-state request shape — projectId', () => {
      const payload = { projectId: 'proj_456' };
      expect(payload).toMatchSnapshot();
    });

    it('get-state response shape — DriveState (orchestrator driving, semi)', () => {
      const payload = {
        driver: 'orchestrator',
        status: 'driving',
        handoff: 'none',
        mode: 'semi',
        sessionId: 'sess_abc123',
        requiresHumanPhases: [4, 5],
      };
      expect(payload).toMatchSnapshot();
    });

    it('get-state response shape — null (sem drive)', () => {
      const payload: unknown = null;
      expect(payload).toMatchSnapshot();
    });

    it('start request shape — projectId + mode', () => {
      const payload = { projectId: 'proj_456', mode: 'full' };
      expect(payload).toMatchSnapshot();
    });

    it('start/assumir/resume/set-mode ok response shape (ok + drive)', () => {
      const payload = {
        ok: true,
        drive: {
          driver: 'orchestrator',
          status: 'driving',
          handoff: 'none',
          mode: 'full',
          sessionId: 'sess_abc123',
          requiresHumanPhases: [],
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('assumir ok response shape (handoff permanent, driver human)', () => {
      const payload = {
        ok: true,
        drive: {
          driver: 'human',
          status: 'stopped',
          handoff: 'permanent',
          mode: 'semi',
          sessionId: 'sess_abc123',
          requiresHumanPhases: [],
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('stop ok response shape (ok only)', () => {
      const payload = { ok: true };
      expect(payload).toMatchSnapshot();
    });

    it('error response shape (lock global ja ativo)', () => {
      const payload = {
        error: 'ja existe um drive ativo no projeto "proj_999". Pare-o (ou Assumir) antes de iniciar outro.',
      };
      expect(payload).toMatchSnapshot();
    });

    it('drive:state-changed event shape (drive presente)', () => {
      const payload = {
        projectId: 'proj_456',
        drive: {
          driver: 'orchestrator',
          status: 'awaiting-human',
          handoff: 'temporary',
          mode: 'semi',
          sessionId: 'sess_abc123',
          requiresHumanPhases: [4, 5],
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('drive:state-changed event shape (drive encerrado, drive=null)', () => {
      const payload = { projectId: 'proj_456', drive: null };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('compaction:active', () => {
    it('active with optimistic label (source lionclaw)', () => {
      const payload = { isActive: true, modelLabel: 'GLM-4.6', source: 'lionclaw' };
      expect(payload).toMatchSnapshot();
    });

    it('active re-emit with the configured provider label (onModelLabel)', () => {
      const payload = { isActive: true, modelLabel: 'GLM-4.6', source: 'lionclaw' };
      expect(payload).toMatchSnapshot();
    });

    it('inactive (compaction ended — success or failure)', () => {
      const payload = { isActive: false };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('harness:agent-stream', () => {
    it('NESTED shape — planner text event', () => {
      const payload = {
        projectId: 'proj_123',
        agent: 'planner',
        event: { type: 'text', content: 'Vou começar planejando...' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('NESTED shape — planner thinking event', () => {
      const payload = {
        projectId: 'proj_123',
        agent: 'planner',
        event: { type: 'thinking', content: 'Considerando arquitetura...' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('NESTED shape — planner tool_use event', () => {
      const payload = {
        projectId: 'proj_123',
        agent: 'planner',
        event: { type: 'tool_use', tool: 'Glob' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('NESTED shape — coder text event with sprintId/round', () => {
      const payload = {
        projectId: 'proj_123',
        sprintId: 'sprint_1',
        round: 2,
        agent: 'coder',
        event: { type: 'text', content: 'Implementando feature...' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('NESTED shape — coder tool_call event', () => {
      const payload = {
        projectId: 'proj_123',
        sprintId: 'sprint_1',
        round: 2,
        agent: 'coder',
        event: { type: 'tool_call', tool: 'Edit' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('NESTED shape — coder text_delta (external API streaming)', () => {
      const payload = {
        projectId: 'proj_123',
        sprintId: 'sprint_1',
        round: 2,
        agent: 'coder',
        event: { type: 'text_delta', content: 'partial chunk' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('NESTED shape — evaluator text event', () => {
      const payload = {
        projectId: 'proj_123',
        sprintId: 'sprint_1',
        round: 2,
        agent: 'evaluator',
        event: { type: 'text', content: 'Avaliando criterios...' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('FLAT shape — planner local runtime (no event wrapper)', () => {
      const payload = {
        projectId: 'proj_123',
        agent: 'planner',
        type: 'text',
        content: 'Planner local rodando...',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('enrich:stream', () => {
    it('text chunk', () => {
      const payload = {
        type: 'text',
        content: 'Validando SPEC...',
        sessionId: 'enrich_sess_42',
        phase: 'validator',
      };
      expect(payload).toMatchSnapshot();
    });

    it('tool_call chunk', () => {
      const payload = {
        type: 'tool_call',
        tool: 'Read',
        sessionId: 'enrich_sess_42',
        phase: 'validator',
      };
      expect(payload).toMatchSnapshot();
    });

    it('done chunk with output content', () => {
      const payload = {
        type: 'done',
        content: 'Análise concluída. 3 gaps encontrados.',
        sessionId: 'enrich_sess_42',
        phase: 'enricher',
      };
      expect(payload).toMatchSnapshot();
    });

    it('done chunk without content', () => {
      const payload = {
        type: 'done',
        sessionId: 'enrich_sess_42',
        phase: 'enricher',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('enrich:metrics', () => {
    it('validator metrics', () => {
      const payload = {
        sessionId: 'enrich_sess_42',
        phase: 'validator',
        metrics: {
          inputTokens: 12_345,
          outputTokens: 678,
          cacheReadTokens: 9_876,
          cacheCreationTokens: 200,
          costUsd: 0.0432,
          durationMs: 8_400,
          toolUses: 3,
          apiRequests: 1,
          messages: 1,
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('enricher metrics', () => {
      const payload = {
        sessionId: 'enrich_sess_42',
        phase: 'enricher',
        metrics: {
          inputTokens: 5_000,
          outputTokens: 1_200,
          cacheReadTokens: 2_000,
          cacheCreationTokens: 0,
          costUsd: 0.0123,
          durationMs: 4_100,
          toolUses: 2,
          apiRequests: 1,
          messages: 1,
        },
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('enrich:status', () => {
    it('validator running', () => {
      const payload = {
        sessionId: 'enrich_sess_42',
        phase: 'validator',
        status: 'running',
      };
      expect(payload).toMatchSnapshot();
    });

    it('validator waiting', () => {
      const payload = {
        sessionId: 'enrich_sess_42',
        phase: 'validator',
        status: 'waiting',
      };
      expect(payload).toMatchSnapshot();
    });

    it('enricher idle (terminal)', () => {
      const payload = {
        sessionId: 'enrich_sess_42',
        phase: 'enricher',
        status: 'idle',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('pipeline:stream', () => {
    it('text chunk (regular phase)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 2,
        type: 'text',
        content: 'Gerando stories...',
      };
      expect(payload).toMatchSnapshot();
    });

    it('tool_call chunk', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 4,
        type: 'tool_call',
        tool: 'Write',
      };
      expect(payload).toMatchSnapshot();
    });

    it('done chunk', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 4,
        type: 'done',
      };
      expect(payload).toMatchSnapshot();
    });

    it('text chunk from security audit (with auditAgentId/auditAgentSlug)', () => {
      const payload = {
        type: 'text',
        projectId: 'proj_456',
        phase: 11,
        content: 'Analisando vulnerabilidades...',
        auditAgentId: 'audit-secrets',
        auditAgentSlug: 'secrets',
      };
      expect(payload).toMatchSnapshot();
    });

    it('tool_call chunk from security audit', () => {
      const payload = {
        type: 'tool_call',
        projectId: 'proj_456',
        phase: 11,
        tool: 'Grep',
        auditAgentId: 'audit-secrets',
        auditAgentSlug: 'secrets',
      };
      expect(payload).toMatchSnapshot();
    });

    it('thinking chunk (bridged from harness:agent-stream phase 11)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 11,
        type: 'thinking',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('pipeline:phase-changed', () => {
    it('started (with currentModel)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 1,
        phaseName: 'Discovery',
        status: 'started',
        awaitingUser: true,
        currentModel: 'claude-sonnet-4-5',
      };
      expect(payload).toMatchSnapshot();
    });

    it('completed (auto phase)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 2,
        phaseName: 'Stories Generator',
        status: 'completed',
        awaitingUser: false,
      };
      expect(payload).toMatchSnapshot();
    });

    it('loop-ready (loop phase)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 13,
        phaseName: 'Coder',
        status: 'loop-ready',
        awaitingUser: false,
        currentModel: 'claude-sonnet-4-5',
      };
      expect(payload).toMatchSnapshot();
    });

    it('running (loop phase, round > 1)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 13,
        phaseName: 'Coder',
        status: 'running',
        awaitingUser: false,
        currentModel: 'claude-sonnet-4-5',
      };
      expect(payload).toMatchSnapshot();
    });

    it('completed (pipeline final, phase=null)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: null,
        status: 'completed',
        awaitingUser: false,
      };
      expect(payload).toMatchSnapshot();
    });

    it('interrupted (recovery on boot)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: null,
        status: 'interrupted',
        awaitingUser: true,
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('pipeline:messages-updated (SPEC drive-ux-pack I1)', () => {
    it('event shape — projectId + phase', () => {
      const payload = { projectId: 'proj_456', phase: 3 };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('preview_open (SPEC drive-ux-pack I8)', () => {
    it('request shape — target arquivo .html', () => {
      const payload = {
        target:
          '/Users/user/proj/.lionclaw/pipelines/development-v2/20260609_120000-abc123/open-design/snapshots/latest/artifact/index.html',
      };
      expect(payload).toMatchSnapshot();
    });

    it('request shape — target url local', () => {
      const payload = { target: 'http://localhost:5173/' };
      expect(payload).toMatchSnapshot();
    });

    it('ok result shape — arquivo aberto', () => {
      const payload = { opened: true, kind: 'file', target: '/Users/user/proj/dist/index.html' };
      expect(payload).toMatchSnapshot();
    });

    it('ok result shape — url local aberta', () => {
      const payload = { opened: true, kind: 'url', target: 'http://localhost:5173/' };
      expect(payload).toMatchSnapshot();
    });

    it('error shape — alvo fora das raizes permitidas', () => {
      const payload = {
        error:
          'preview_open: caminho fora das raizes permitidas (project paths dos pipelines e a pasta de dados do LionClaw).',
      };
      expect(payload).toMatchSnapshot();
    });

    it('lista de tools do subprocess lionclaw-pipeline-control (inclui preview_open)', () => {
      const tools = [
        'pipeline_list',
        'pipeline_inspect',
        'pipeline_create',
        'pipeline_drive',
        'pipeline_reply',
        'pipeline_approve',
        'pipeline_escalate',
        'pipeline_abort',
        'pipeline_pause',
        'preview_open',
        'design_session_config',
        'telegram_notify',
      ];
      expect(tools).toMatchSnapshot();
    });
  });

  describe('pipeline:project-updated', () => {
    it('status + currentPhase patch', () => {
      const payload = {
        projectId: 'proj_456',
        patch: {
          status: 'running',
          currentPhase: 3,
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('status only patch', () => {
      const payload = {
        projectId: 'proj_456',
        patch: {
          status: 'done',
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('currentPhase null (pipeline finished)', () => {
      const payload = {
        projectId: 'proj_456',
        patch: {
          currentPhase: null,
        },
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('pipeline:security-agent-status', () => {
    it('running', () => {
      const payload = {
        projectId: 'proj_456',
        agentId: 'audit-secrets',
        agentName: 'Secrets Hunter',
        status: 'running',
      };
      expect(payload).toMatchSnapshot();
    });

    it('completed (with findings)', () => {
      const payload = {
        projectId: 'proj_456',
        agentId: 'audit-secrets',
        agentName: 'Secrets Hunter',
        status: 'completed',
        findingsCount: 3,
        outputFile: 'Security-scan_001-01-secrets.md',
      };
      expect(payload).toMatchSnapshot();
    });

    it('failed (with error)', () => {
      const payload = {
        projectId: 'proj_456',
        agentId: 'audit-secrets',
        agentName: 'Secrets Hunter',
        status: 'failed',
        error: 'Timeout exceeded',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('open-design channels (registry)', () => {
    it('preflight result shape (vendor-missing)', () => {
      const payload = {
        ok: false,
        vendorRoot: '/app/vendor/open-design',
        status: 'vendor-missing',
        reason: 'vendor/open-design ausente em /app/vendor/open-design. Rode `git status` e recupere o vendor.',
      };
      expect(payload).toMatchSnapshot();
    });

    it('preflight result shape (deps-missing)', () => {
      const payload = {
        ok: false,
        vendorRoot: '/app/vendor/open-design',
        status: 'deps-missing',
        reason: 'node_modules ausente no vendor. boot-installer cuida disso em background.',
      };
      expect(payload).toMatchSnapshot();
    });

    it('preflight result shape (ready)', () => {
      const payload = {
        ok: true,
        vendorRoot: '/app/vendor/open-design',
        status: 'ready',
      };
      expect(payload).toMatchSnapshot();
    });

    it('boot install status shape (installing)', () => {
      const payload = { kind: 'installing', runner: 'corepack', startedAt: '2026-05-11T10:00:00.000Z' };
      expect(payload).toMatchSnapshot();
    });

    it('boot install status shape (ready)', () => {
      const payload = { kind: 'ready', finishedAt: '2026-05-11T10:05:00.000Z' };
      expect(payload).toMatchSnapshot();
    });

    it('boot install status shape (failed)', () => {
      const payload = {
        kind: 'failed',
        error: 'pnpm install exited with code 1',
        failedAt: '2026-05-11T10:05:00.000Z',
      };
      expect(payload).toMatchSnapshot();
    });

    it('boot install stream event shapes', () => {
      const events = [
        { kind: 'start', runner: 'corepack' },
        { kind: 'stdout', chunk: 'Progress: resolved 1234/2000\n' },
        { kind: 'stderr', chunk: ' WARN deprecated\n' },
        { kind: 'exit', code: 0, signal: null },
        { kind: 'error', message: 'spawn ENOENT' },
      ];
      expect(events).toMatchSnapshot();
    });

    it('session config shape (Sprint 2)', () => {
      const payload = {
        agentId: 'claude',
        model: 'claude-opus-4-7',
        reasoning: 'high',
        designSystemId: 'lc-default',
        memoryEnabled: false,
        mcpServerIds: [],
        locale: 'pt-BR',
        configuredAt: '2026-05-11T00:00:00.000Z',
      };
      expect(payload).toMatchSnapshot();
    });

    it('set-session-config ok response shape (Sprint 2)', () => {
      const payload = { ok: true };
      expect(payload).toMatchSnapshot();
    });

    it('set-session-config error response shape (Sprint 2 — secret policy)', () => {
      const payload = {
        error:
          'OpenDesignSessionConfig: chave proibida em "apiKey". Nomes contendo "token"/"apiKey" ou terminando em "key" sao bloqueados (use o Vault do LionClaw ou .od/media-config.json para credenciais).',
      };
      expect(payload).toMatchSnapshot();
    });

    it('ensure-session ok response shape (Sprint 2 — BootstrapResult)', () => {
      const payload = {
        openDesignProjectId: 'lionclaw-runabc',
        conversationId: 'conv_xyz',
        webUrl: 'http://127.0.0.1:5175/projects/lionclaw-runabc?host=lionclaw&locale=pt-BR',
        initialPromptHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        initialPromptSentAt: '2026-05-11T10:00:00.000Z',
        bootstrappedAt: '2026-05-11T10:00:00.000Z',
      };
      expect(payload).toMatchSnapshot();
    });

    it('ensure-session error response shape (Sprint 2)', () => {
      const payload = {
        error: 'boot install not ready (kind=installing); aguarde o motor de design concluir a preparacao',
      };
      expect(payload).toMatchSnapshot();
    });

    it('get-start-status response shape (A2 - drive engajado, GO pendente)', () => {
      const payload = { driveEngaged: true, startPending: true };
      expect(payload).toMatchSnapshot();
    });

    it('get-start-status response shape (A2 - fora de drive)', () => {
      const payload = { driveEngaged: false, startPending: false };
      expect(payload).toMatchSnapshot();
    });

    it('start result shape (ok)', () => {
      const payload = { ok: true, daemonUrl: 'http://127.0.0.1:7457', webUrl: 'http://127.0.0.1:5175' };
      expect(payload).toMatchSnapshot();
    });

    it('start result shape (error)', () => {
      const payload = { error: 'Open Design daemon did not become healthy in time' };
      expect(payload).toMatchSnapshot();
    });

    it('status result shape (running)', () => {
      const payload = {
        running: true,
        daemonUrl: 'http://127.0.0.1:7457',
        webUrl: 'http://127.0.0.1:5175',
        daemonPort: 7457,
        webPort: 5175,
      };
      expect(payload).toMatchSnapshot();
    });

    it('status result shape (stopped)', () => {
      const payload = { running: false, daemonUrl: null, webUrl: null, daemonPort: null, webPort: null };
      expect(payload).toMatchSnapshot();
    });

    it('lock ok response shape (Sprint 4 — internal lock(), now with 6 paths)', () => {
      const payload = {
        ok: true,
        snapshotDir: '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/latest',
        manifestPath:
          '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/latest/manifest.json',
        contractPath:
          '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/latest/design-contract.json',
        briefPath:
          '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/latest/design-brief.md',
        reportPath:
          '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/latest/design-lock-report.md',
        lockReportPath:
          '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/latest/design-lock-report.md',
        artifactHtmlPath:
          '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/latest/artifact/index.html',
        lockedAt: '2026-05-10T00:00:00.000Z',
      };
      expect(payload).toMatchSnapshot();
    });

    it('lock rejected response shape (Sprint 4 — internal lock())', () => {
      const payload = {
        ok: false,
        reportPath:
          '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/latest/design-lock-report.md',
        lockReportPath:
          '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/latest/design-lock-report.md',
        report: {
          ok: false,
          problems: [
            {
              rule: '10.2.3',
              item: 'Tela "Relatorios" (screen-reports)',
              hint: 'O design tentou criar/exigir "nova tela", que viola a regra pos-lock. Remova no Open Design ou cancele este run.',
            },
          ],
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('lock error response shape (Sprint 5)', () => {
      const payload = { error: 'snapshot failed: Could not obtain artifact' };
      expect(payload).toMatchSnapshot();
    });

    it('open-design:lock public IPC handler returns fixed error (Sprint 4)', () => {
      const payload = {
        error: 'Use pipeline:approve na fase 4; open-design:lock e interno do PipelineEngine',
      };
      expect(payload).toMatchSnapshot();
    });

    it('get-locked-snapshot ok response shape (Sprint 5)', () => {
      const payload = {
        ok: true,
        paths: {
          snapshotDir: '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/latest',
          manifestPath:
            '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/latest/manifest.json',
          contractPath:
            '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/latest/design-contract.json',
          artifactHtmlPath:
            '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/latest/artifact/index.html',
        },
        lockedAt: '2026-05-10T00:00:00.000Z',
      };
      expect(payload).toMatchSnapshot();
    });

    it('get-locked-snapshot not-locked error shape (Sprint 5)', () => {
      const payload = { error: 'not-locked' };
      expect(payload).toMatchSnapshot();
    });

    it('destructive-unlock ok response shape (Sprint 5 — 16th channel)', () => {
      const payload = {
        ok: true,
        designRevisionId: 'rev-1715000000000-abc123',
        archivePath:
          '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/revisions/rev-1715000000000-abc123',
      };
      expect(payload).toMatchSnapshot();
    });

    it('destructive-unlock invalid confirmation error shape (Sprint 5)', () => {
      const payload = { error: 'invalid-confirmation' };
      expect(payload).toMatchSnapshot();
    });

    it('pipeline:phase-changed lock rejected payload shape (Sprint 5)', () => {
      const payload = {
        projectId: 'proj_dev_v2',
        phase: 4,
        phaseName: 'Open Design Studio',
        status: 'running',
        awaitingUser: true,
        metadata: {
          openDesignLockRejected: true,
          rejectedLockPhase: 5,
          reportPath:
            '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/latest/design-lock-report.md',
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('pipeline:phase-changed destructive-unlock restarted payload shape (Sprint 5)', () => {
      const payload = {
        projectId: 'proj_dev_v2',
        phase: 4,
        phaseName: 'Open Design Studio',
        status: 'running',
        awaitingUser: true,
        metadata: {
          designRevisionRestarted: true,
          designRevisionId: 'rev-1715000000000-abc123',
          archivePath:
            '/projects/demo/.lionclaw/pipelines/development-v2/run-abc/open-design/snapshots/revisions/rev-1715000000000-abc123',
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('build-initial-prompt ok response shape', () => {
      const payload = {
        ok: true,
        promptPath: '/projects/demo/.lionclaw/runs/run-abc/open-design/input/open-design-initial-prompt.md',
        prompt: '## Prompt\n...',
      };
      expect(payload).toMatchSnapshot();
    });

    it('build-initial-prompt error response shape', () => {
      const payload = { error: 'Discovery file not found: /path/discovery.md' };
      expect(payload).toMatchSnapshot();
    });

    it('inject-initial-prompt clipboard mode response shape', () => {
      const payload = { ok: true, mode: 'clipboard', prompt: '## Prompt\n...' };
      expect(payload).toMatchSnapshot();
    });

    it('snapshot ok response shape', () => {
      const payload = {
        ok: true,
        paths: {
          snapshotDir: '/projects/demo/.lionclaw/runs/run-abc/open-design/snapshots/latest',
          manifestPath: '/projects/demo/.lionclaw/runs/run-abc/open-design/snapshots/latest/manifest.json',
          contractPath: '/projects/demo/.lionclaw/runs/run-abc/open-design/snapshots/latest/design-contract.json',
          artifactHtmlPath: '/projects/demo/.lionclaw/runs/run-abc/open-design/snapshots/latest/artifact/index.html',
        },
        hashes: {
          htmlSha256: 'abc123deadbeef',
          contractSha256: 'def456cafebabe',
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('snapshot error response shape', () => {
      const payload = { error: 'Could not obtain artifact: OD daemon unavailable and no filesystem artifact found' };
      expect(payload).toMatchSnapshot();
    });

    it('open-artifact ok response shape', () => {
      const payload = {
        ok: true,
        htmlPath: '/projects/demo/.lionclaw/runs/run-abc/open-design/snapshots/latest/artifact/index.html',
      };
      expect(payload).toMatchSnapshot();
    });

    it('open-artifact not-locked error shape', () => {
      const payload = { error: 'not-locked' };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('open-design view bridge', () => {
    it('set-view-bounds ok response', () => {
      const payload = { ok: true };
      expect(payload).toMatchSnapshot();
    });

    it('set-view-bounds error response', () => {
      const payload = { error: 'Error: webview module not loaded' };
      expect(payload).toMatchSnapshot();
    });

    it('show-view request shape (url + bounds)', () => {
      const payload = {
        url: 'http://127.0.0.1:5175',
        bounds: { x: 240, y: 48, width: 1200, height: 800 },
      };
      expect(payload).toMatchSnapshot();
    });

    it('show-view ok response', () => {
      const payload = { ok: true };
      expect(payload).toMatchSnapshot();
    });

    it('show-view error response (no-main-window)', () => {
      const payload = { error: 'no-main-window' };
      expect(payload).toMatchSnapshot();
    });

    it('show-view error response (module error)', () => {
      const payload = { error: 'Error: webview module not loaded' };
      expect(payload).toMatchSnapshot();
    });

    it('set-view-bounds request shape (bounds only)', () => {
      const payload = { x: 240, y: 48, width: 1200, height: 800 };
      expect(payload).toMatchSnapshot();
    });

    it('hide-view ok response', () => {
      const payload = { ok: true };
      expect(payload).toMatchSnapshot();
    });

    it('hide-view error response', () => {
      const payload = { error: 'Error: webview module not loaded' };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('pricing:calculate', () => {
    it('request shape — claude sonnet', () => {
      const payload = {
        runtime: 'claude-sdk',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        inputTokens: 12_500,
        outputTokens: 3_200,
        cacheReadTokens: 800,
        cacheCreationTokens: 0,
      };
      expect(payload).toMatchSnapshot();
    });

    it('response shape — custo positivo', () => {
      const payload = { costUsd: 0.01234 };
      expect(payload).toMatchSnapshot();
    });

    it('response shape — local provider (costUsd 0)', () => {
      const payload = { costUsd: 0 };
      expect(payload).toMatchSnapshot();
    });

    it('response shape — custom sem pricing (costUsd null)', () => {
      const payload = { costUsd: null };
      expect(payload).toMatchSnapshot();
    });

    it('request shape — local ollama', () => {
      const payload = {
        runtime: 'lion-sdk',
        provider: 'ollama',
        model: 'llama3:8b',
        inputTokens: 5_000,
        outputTokens: 800,
      };
      expect(payload).toMatchSnapshot();
    });

    it('request shape — openai-compat preset kimi', () => {
      const payload = {
        runtime: 'lion-sdk',
        provider: 'openai-compatible',
        model: 'moonshot-v1-32k',
        presetId: 'kimi',
        inputTokens: 8_000,
        outputTokens: 1_500,
      };
      expect(payload).toMatchSnapshot();
    });

    it('request shape — openai-compat custom (sem pricing)', () => {
      const payload = {
        runtime: 'lion-sdk',
        provider: 'openai-compatible',
        model: 'my-private-model',
        presetId: 'custom',
        inputTokens: 8_000,
        outputTokens: 1_500,
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('pipeline:audit-agent-progress', () => {
    it('running progress', () => {
      const payload = {
        projectId: 'proj_456',
        agentId: 'audit-secrets',
        slug: 'secrets',
        agentName: 'Secrets Hunter',
        status: 'running',
        filesAnalyzed: 42,
        additionalFilesAfterStart: 3,
        toolCallsCount: 11,
        costUsd: 0,
        durationMs: 12_500,
        findingsCount: undefined,
        model: 'claude-sonnet-4-5',
        runtime: 'cloud',
      };
      expect(payload).toMatchSnapshot();
    });

    it('completed progress (with findings)', () => {
      const payload = {
        projectId: 'proj_456',
        agentId: 'audit-secrets',
        slug: 'secrets',
        agentName: 'Secrets Hunter',
        status: 'completed',
        filesAnalyzed: 42,
        additionalFilesAfterStart: 5,
        toolCallsCount: 18,
        costUsd: 0.0245,
        durationMs: 47_300,
        findingsCount: 3,
        model: 'claude-sonnet-4-5',
        runtime: 'cloud',
      };
      expect(payload).toMatchSnapshot();
    });

    it('failed progress', () => {
      const payload = {
        projectId: 'proj_456',
        agentId: 'audit-secrets',
        slug: 'secrets',
        agentName: 'Secrets Hunter',
        status: 'failed',
        filesAnalyzed: 42,
        additionalFilesAfterStart: 0,
        toolCallsCount: 2,
        costUsd: 0,
        durationMs: 1_200,
        findingsCount: undefined,
        model: 'claude-sonnet-4-5',
        runtime: 'cloud',
      };
      expect(payload).toMatchSnapshot();
    });

    it('bug pipe: running progress do root-cause analyst', () => {
      const payload = {
        projectId: 'proj_bug_1',
        agentId: 'bug-root-cause-analyst',
        slug: 'root-cause',
        agentName: 'Bug Root Cause Analyst',
        status: 'running',
        filesAnalyzed: 0,
        additionalFilesAfterStart: 7,
        toolCallsCount: 9,
        costUsd: 0,
        durationMs: 18_400,
        findingsCount: undefined,
        model: 'claude-opus-5',
        runtime: 'cloud',
      };
      expect(payload).toMatchSnapshot();
    });

    it('bug pipe: completed progress do context historian', () => {
      const payload = {
        projectId: 'proj_bug_1',
        agentId: 'bug-context-historian',
        slug: 'historian',
        agentName: 'Bug Context Historian',
        status: 'completed',
        filesAnalyzed: 0,
        additionalFilesAfterStart: 12,
        toolCallsCount: 21,
        costUsd: 0.1832,
        durationMs: 96_100,
        findingsCount: undefined,
        model: 'claude-opus-5',
        runtime: 'cloud',
      };
      expect(payload).toMatchSnapshot();
    });

    it('bug pipe: failed progress do hypothesis refuter', () => {
      const payload = {
        projectId: 'proj_bug_1',
        agentId: 'bug-hypothesis-refuter',
        slug: 'refuter',
        agentName: 'Bug Hypothesis Refuter',
        status: 'failed',
        filesAnalyzed: 0,
        additionalFilesAfterStart: 1,
        toolCallsCount: 2,
        costUsd: 0,
        durationMs: 3_050,
        findingsCount: undefined,
        model: 'claude-opus-5',
        runtime: 'cloud',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('repo-graph:on-status (broadcast)', () => {
    it('building com progresso (chunk UI-only, Z3)', () => {
      const payload = {
        repositoryId: 'repo_abc123',
        sessionId: 'sess_abc123',
        status: 'building',
        runId: 'run_xyz789',
        runStatus: 'running',
        kind: 'build',
        buildProgress: '● 1.234 nodes, 5.678 edges in 42s',
      };
      expect(payload).toMatchSnapshot();
    });

    it('build concluido (ready)', () => {
      const payload = {
        repositoryId: 'repo_abc123',
        sessionId: null,
        status: 'ready',
        runId: 'run_xyz789',
        runStatus: 'done',
        kind: 'build',
      };
      expect(payload).toMatchSnapshot();
    });

    it('build com erro (CTA de retry)', () => {
      const payload = {
        repositoryId: 'repo_abc123',
        sessionId: 'sess_abc123',
        status: 'error',
        runId: 'run_xyz789',
        runStatus: 'error',
        kind: 'build',
        error: 'codegraph init --index: timeout apos 600000ms',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('repo-graph:get-session-state', () => {
    it('sessao com repo ativo e graph pronto', () => {
      const payload = {
        sessionId: 'sess_abc123',
        repository: {
          id: 'repo_abc123',
          name: 'LionClaw',
          rootPath: '/Users/example/Desktop/LionClaw',
          canonicalRootPath: '/Users/example/Desktop/LionClaw',
          gitRoot: '/Users/example/Desktop/LionClaw',
          provider: 'codegraph',
          graphPath: '/Users/example/Desktop/LionClaw/.codegraph/codegraph.db',
          status: 'ready',
          indexedCommit: '96ea78f0aa11bb22cc33dd44ee55ff6677889900',
          indexedWorktreeHash: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
          lastIndexedAt: '2026-06-10T10:00:00.000Z',
          statsJson: '{"files":1200,"nodes":54000,"edges":98000}',
          graphPromptSuppressedGlobal: false,
          settingsJson: '{}',
          createdAt: '2026-06-10 09:00:00',
          updatedAt: '2026-06-10 10:00:00',
        },
        attach: {
          sessionId: 'sess_abc123',
          repositoryId: 'repo_abc123',
          graphPromptSuppressed: false,
          attachedAt: '2026-06-10 09:30:00',
          updatedAt: '2026-06-10 09:30:00',
        },
        staleness: { stale: false },
        activeRun: null,
      };
      expect(payload).toMatchSnapshot();
    });

    it('sessao sem repo ativo', () => {
      const payload = {
        sessionId: 'sess_abc123',
        repository: null,
        attach: null,
        staleness: null,
        activeRun: null,
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('repo-graph:build / repo-graph:update', () => {
    it('aceito: retorna runId na hora (progresso vem pelo on-status)', () => {
      const payload = { runId: 'run_xyz789' };
      expect(payload).toMatchSnapshot();
    });

    it('erro em fluxo normal: { error } sem throw (convencao IPC secao 9)', () => {
      const payload = {
        error: 'ja existe um build/update em andamento para este repositorio',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('repo-graph:metrics (Sprint A4, D-5)', () => {
    it('janela atingida: medias por grupo + percentuais de economia', () => {
      const payload = {
        withRepo: { turns: 64, avgToolCalls: 3.2, avgTokens: 18450.5 },
        withoutRepo: { turns: 112, avgToolCalls: 7.6, avgTokens: 34210.9 },
        toolCallsSavingsPct: 57.9,
        tokensSavingsPct: 46.1,
        minTurnsWindow: 50,
        windowMet: true,
      };
      expect(payload).toMatchSnapshot();
    });

    it('janela NAO atingida: medias parciais, percentuais null', () => {
      const payload = {
        withRepo: { turns: 12, avgToolCalls: 2.8, avgTokens: 15200.3 },
        withoutRepo: { turns: 112, avgToolCalls: 7.6, avgTokens: 34210.9 },
        toolCallsSavingsPct: null,
        tokensSavingsPct: null,
        minTurnsWindow: 50,
        windowMet: false,
      };
      expect(payload).toMatchSnapshot();
    });

    it('erro em fluxo normal: { error } sem throw (convencao IPC secao 9)', () => {
      const payload = { error: 'no such table: activity_log' };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('chat:stream — repo_graph (Sprint A2)', () => {
    it('uso de tool em turno (orchestrator-mcp, used=1 com metricas)', () => {
      const payload = {
        type: 'repo_graph',
        sessionId: 'sess_abc123',
        repoGraph: {
          sessionId: 'sess_abc123',
          turnIndex: 7,
          repositoryId: 'repo_abc123',
          status: 'ready',
          used: true,
          source: 'orchestrator-mcp',
          runtime: 'claude-sdk',
          toolName: 'repo_graph_search',
          resultCount: 12,
          bytesReturned: 4096,
          durationMs: 230,
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('uso por subagente herdando o contexto do turno (subagent-mcp)', () => {
      const payload = {
        type: 'repo_graph',
        sessionId: 'sess_abc123',
        repoGraph: {
          sessionId: 'sess_abc123',
          turnIndex: 7,
          repositoryId: 'repo_abc123',
          status: 'stale',
          used: true,
          source: 'subagent-mcp',
          runtime: 'codex-sdk',
          toolName: 'repo_graph_minimal_context',
          resultCount: 18,
          bytesReturned: 8192,
          durationMs: 410,
        },
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('kimi:* (SPEC-011 S4/S10)', () => {
    it('kimi:status result - instalado + autenticado por assinatura', () => {
      const payload = {
        installed: true,
        version: '0.1.8',
        authenticated: true,
        authMode: 'subscription',
      };
      expect(payload).toMatchSnapshot();
    });

    it('kimi:status result - instalado mas sem login de assinatura (sem fallback api-key)', () => {
      const payload = {
        installed: true,
        version: '0.1.8',
        authenticated: false,
        authMode: 'none',
      };
      expect(payload).toMatchSnapshot();
    });

    it('kimi:status result - nao instalado', () => {
      const payload = {
        installed: false,
        version: null,
        authenticated: false,
        authMode: 'none',
      };
      expect(payload).toMatchSnapshot();
    });

    it('kimi:test result - ok', () => {
      const payload = { ok: true, message: 'kimi CLI disponivel' };
      expect(payload).toMatchSnapshot();
    });

    it('kimi:test result - falha', () => {
      const payload = { ok: false, message: 'Timeout: kimi nao respondeu' };
      expect(payload).toMatchSnapshot();
    });

    it('kimi:open-login result - ok (sem url capturada)', () => {
      const payload = { ok: true };
      expect(payload).toMatchSnapshot();
    });

    it('kimi:open-login result - ok com url de device-auth', () => {
      const payload = { ok: true, url: 'https://kimi.moonshot.cn/device' };
      expect(payload).toMatchSnapshot();
    });

    it('kimi:set-binary-path request - { path }', () => {
      const payload = { path: '/usr/local/bin/kimi' };
      expect(payload).toMatchSnapshot();
    });

    it('kimi:set-binary-path result - { ok }', () => {
      const payload = { ok: true };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('kanban:changed (SPEC kanban-nativo F3)', () => {
    it('event shape — { boardId }', () => {
      const payload = { boardId: 'b3b1d2c4-5e6f-4a7b-8c9d-0e1f2a3b4c5d' };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('terminal:* (terminal integrado no chat)', () => {
    it('terminal:data event - { sessionId, chunk }', () => {
      const payload = { sessionId: 'tab-uuid-1', chunk: 'saida ansi \u001b[32mok\u001b[0m' };
      expect(payload).toMatchSnapshot();
    });

    it('terminal:exit event - { sessionId, exitCode }', () => {
      const payload = { sessionId: 'tab-uuid-1', exitCode: 0 };
      expect(payload).toMatchSnapshot();
    });

    it('terminal:open result - ok', () => {
      const payload = { ok: true };
      expect(payload).toMatchSnapshot();
    });

    it('terminal:open result - erro (ABI/teto/colisao)', () => {
      const payload = { ok: false, error: 'limite de 8 terminais simultaneos atingido' };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('lanes (SPEC conversas-paralelas 11, Sprint 1a) - canais ADITIVOS e aliases', () => {
    it('chat:create-session result ok - OpenChatSession com badge e orquestrador pre-selecionado', () => {
      const payload = {
        session: {
          id: 'b3b1d2c4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
          laneBadge: 1,
          title: '',
          orchestrator: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-4-7', effort: 'high' },
          messageCount: 0,
          lastUserMessageAt: null,
          createdAt: '2026-09-08 10:00:00',
          updatedAt: '2026-09-08 10:00:00',
          state: 'idle',
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('chat:create-session erro tipado lanes_full', () => {
      const payload = {
        error: 'Todas as lanes estao ocupadas. De Clear numa lane para abrir outra conversa.',
        code: 'lanes_full',
      };
      expect(payload).toMatchSnapshot();
    });

    it('chat:list-open-sessions result - N lanes ordenadas por badge com state', () => {
      const payload = [
        {
          id: 'sess_a',
          laneBadge: 1,
          title: 'Lane A',
          orchestrator: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-4-7' },
          messageCount: 4,
          lastUserMessageAt: '2026-09-08 09:58:00',
          createdAt: '2026-09-08 09:00:00',
          updatedAt: '2026-09-08 09:58:30',
          state: 'streaming',
        },
        {
          id: 'sess_b',
          laneBadge: 2,
          title: '',
          orchestrator: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-5.5' },
          messageCount: 0,
          lastUserMessageAt: null,
          createdAt: '2026-09-08 09:30:00',
          updatedAt: '2026-09-08 09:30:00',
          state: 'idle',
        },
      ];
      expect(payload).toMatchSnapshot();
    });

    it('chat:list-open-sessions result em falha - { error } (RM7: nunca [])', () => {
      const payload = { error: 'SQLITE_BUSY: database is locked' };
      expect(payload).toMatchSnapshot();
    });

    it('chat:set-session-orchestrator request shape - sessionId + selection', () => {
      const payload = {
        sessionId: 'sess_b',
        selection: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-5.5', effort: 'xhigh' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('chat:set-session-orchestrator result ok e erro provider_locked', () => {
      const ok = {
        ok: true,
        orchestrator: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-5.5', effort: 'xhigh' },
      };
      const locked = {
        error: 'A lane ja tem mensagens ou um turno pendente: o provider esta travado. De Clear para trocar.',
        code: 'provider_locked',
      };
      expect({ ok, locked }).toMatchSnapshot();
    });

    it('chat:session-updated event shape (coexiste com chat:sessions-updated sem payload)', () => {
      const payload = {
        sessionId: 'sess_b',
        laneBadge: 2,
        orchestrator: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-5.5' },
        messageCount: 0,
        state: 'idle',
      };
      expect(payload).toMatchSnapshot();
    });

    it('chat:send recusas tipadas - session_required e lane_required (accepted:false + code)', () => {
      const payload = {
        sessionRequired: {
          accepted: false,
          code: 'session_required',
          error: 'sessionId obrigatorio: toda mensagem do desktop pertence a uma lane.',
        },
        laneRequired: {
          accepted: false,
          code: 'lane_required',
          error: 'Esta conversa esta aberta sem lane: de Clear nela ou escolha uma lane.',
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('chat:stop request shape - sessionId opcional (sem argumento = alias antigo)', () => {
      expect({ withSession: 'sess_a', legacy: undefined }).toMatchSnapshot();
    });

    it('drive:start / drive:resume request shape com sessionId obrigatorio (V9) e recusa session_required', () => {
      const payload = {
        start: { projectId: 'proj_456', mode: 'semi', sessionId: 'sess_a' },
        resume: { projectId: 'proj_456', sessionId: 'sess_a' },
        refused: {
          error: 'session_required: escolha a lane (conversa aberta) que vai dirigir o pipeline.',
          code: 'session_required',
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('compaction:active ganha sessionId (payload aditivo)', () => {
      const payload = { isActive: true, sessionId: 'sess_a', modelLabel: 'GLM-4.6', source: 'lionclaw' };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('Clear por lane (SPEC conversas-paralelas 6 e 11, Sprint 1b) - canais ADITIVOS', () => {
    it('chat:clear request shape - sessionId obrigatorio + force opcional', () => {
      expect({ sessionId: 'sess_a', opts: { force: true } }).toMatchSnapshot();
    });

    it('chat:clear result ok - compacted, conversa nova no mesmo badge, warnings por passo', () => {
      const payload = {
        ok: true,
        sessionId: 'sess_a',
        newSessionId: 'c0ffee00-1111-4222-8333-444455556666',
        warnings: [
          {
            step: 'embeddings',
            detail: 'configure um provedor de embeddings em Settings (3 de 3 chunks nao gravados)',
          },
          { step: 'transcript', detail: 'EACCES: permission denied' },
        ],
        pausedDriveProjectIds: [],
      };
      expect(payload).toMatchSnapshot();
    });

    it('chat:clear recusas tipadas (6.1, 6.2, V6, D3)', () => {
      const payload = {
        busy: {
          ok: false,
          code: 'session_busy',
          error: 'A lane esta ocupada (turno em voo, item na fila ou Compactacao em andamento).',
        },
        clearing: { ok: false, code: 'session_clearing', error: 'Esta lane ja esta em Clear.' },
        drive: {
          ok: false,
          code: 'drive_active',
          error: 'Ha um drive de pipeline ativo nesta lane; pare o drive antes do Clear.',
        },
        empty: { ok: false, code: 'empty_session', error: 'Conversa vazia nao tem Clear.' },
        notSettled: {
          ok: false,
          code: 'turn_did_not_settle',
          error: 'O turno em voo nao assentou no prazo; nada foi arquivado. Tente de novo.',
        },
        summary: { ok: false, code: 'COMPACT-SUMMARY-FAILED', error: 'Sumarizador falhou: provider 529 overloaded' },
        memory: {
          ok: false,
          code: 'COMPACT-MEMORY-FAILED',
          error: 'Gate de memoria / MEMORY.md / USER.md falhou: EACCES',
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('chat:clear-cancel result ok e clear_not_queued', () => {
      const payload = {
        ok: { ok: true, sessionId: 'sess_b' },
        notQueued: { ok: false, code: 'clear_not_queued', error: 'Nao ha Clear na fila para esta lane.' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('chat:send recusa session_clearing (6.1 / 6.10)', () => {
      const payload = {
        accepted: false,
        code: 'session_clearing',
        error: 'Esta lane esta em Clear; aguarde o Clear terminar ou refaca o Clear.',
      };
      expect(payload).toMatchSnapshot();
    });

    it('compaction:active com phase queued/running, modelLabel e title (6.9, AC-9)', () => {
      const payload = {
        queued: {
          isActive: true,
          sessionId: 'sess_b',
          phase: 'queued',
          modelLabel: 'Claude Sonnet 4.6',
          title: 'Conversa B',
          source: 'lionclaw',
        },
        running: {
          isActive: true,
          sessionId: 'sess_a',
          phase: 'running',
          modelLabel: 'Claude Sonnet 4.6',
          title: 'Conversa A',
          source: 'lionclaw',
        },
        done: { isActive: false, sessionId: 'sess_a', source: 'lionclaw' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('chat:confirm-request e ask_question carregam sessionId e title (10.1 fase 1)', () => {
      const payload = {
        confirm: {
          id: 'confirm_1',
          tool: 'Bash',
          description: 'rm -rf build',
          input: { command: 'rm -rf build' },
          risk: 'high',
          sessionId: 'sess_a',
          title: 'Conversa A',
        },
        ask: {
          type: 'ask_question',
          sessionId: 'sess_a',
          askRequest: { id: 'ask_1', sessionId: 'sess_a', title: 'Conversa A', questions: [] },
        },
        dreaming: { type: 'dreaming_status', isDreaming: true, sessionId: 'sess_a' },
        session: { type: 'session', content: 'sess_a', sessionId: 'sess_a' },
      };
      expect(payload).toMatchSnapshot();
    });
  });

  describe('orquestrador por lane (SPEC conversas-paralelas 7.2/7.3/7.6/7.7, Sprint 3a) - payloads ADITIVOS', () => {
    it('chat:send options - campos aditivos model e effort (validados contra o provider da lane, persistidos nas colunas)', () => {
      const payload = {
        message: 'Continue a implementacao',
        options: { sessionId: 'sess_a', model: 'claude-sonnet-5', effort: 'max' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('chat:send recusas tipadas - model_not_in_provider e effort_not_supported', () => {
      const payload = {
        modelNotInProvider: {
          accepted: false,
          code: 'model_not_in_provider',
          error: 'Modelo "gpt-5.5" nao pertence ao provider "anthropic" do runtime "claude-sdk".',
        },
        effortNotSupported: {
          accepted: false,
          code: 'effort_not_supported',
          error: 'Effort "ultra" nao e suportado por "claude-sonnet-5" (anthropic); opcoes: low, medium, high, max.',
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('chat:session-updated carrega o orquestrador COMPLETO com effort (10.6)', () => {
      const payload = {
        sessionId: 'sess_a',
        laneBadge: 1,
        orchestrator: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-sonnet-5', effort: 'max' },
        messageCount: 3,
        state: 'idle',
      };
      expect(payload).toMatchSnapshot();
    });

    it('provider:list-statuses request { refresh } e entrada ESTENDIDA (available + models com reasoningOptions/defaultReasoning/contextWindow)', () => {
      const payload = {
        request: { refresh: true },
        entry: {
          runtime: 'claude-sdk',
          provider: 'anthropic',
          connected: false,
          available: false,
          reason: 'Engine Claude Code nao encontrado.',
          models: [
            {
              id: 'claude-sonnet-5',
              displayName: 'Claude Sonnet 5',
              label: 'Claude Sonnet 5',
              reasoningOptions: ['low', 'medium', 'high', 'max'],
              defaultReasoning: 'high',
              contextWindow: 1_000_000,
            },
          ],
        },
        dynamicEntry: {
          runtime: 'lion-sdk',
          provider: 'ollama',
          connected: true,
          available: true,
          models: [
            {
              id: 'llama3.1:8b',
              displayName: 'llama3.1:8b',
              label: 'llama3.1:8b',
              reasoningOptions: [],
              defaultReasoning: null,
              contextWindow: 131_072,
            },
          ],
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('chat:confirm-request e ask_question carregam laneBadge (10.4 fase 3, popup rotulado "Lane N: <titulo>")', () => {
      const payload = {
        confirm: {
          id: 'confirm_2',
          tool: 'mcp__google-gmail__send_email',
          description: 'Acao MCP destrutiva: send_email',
          input: { to: 'x@y.z' },
          risk: 'high',
          sessionId: 'sess_b',
          title: 'Conversa B',
          laneBadge: 2,
        },
        ask: {
          type: 'ask_question',
          sessionId: 'sess_b',
          askRequest: { id: 'ask_2', sessionId: 'sess_b', title: 'Conversa B', laneBadge: 2, questions: [] },
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('mcp:dist-stale (broadcast) e mcp:get-dist-stale (pull) - helpers MCP com dist mais antigo que o src (9.2 rollout, RM4)', () => {
      const payload = {
        event: { servers: ['gateway', 'lionclaw-kanban'], command: 'npm run build:mcps' },
        pullFresh: null,
      };
      expect(payload).toMatchSnapshot();
    });

    it('agents:sync-to-orchestrator request com selection obrigatoria (dryRun e real) e response.orchestrator ecoando a selecao com effort', () => {
      const payload = {
        request: {
          dryRun: true,
          mode: 'manual-button',
          selection: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-5.5', effort: 'xhigh' },
        },
        response: {
          blocked: false,
          orchestrator: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-5.5', effort: 'xhigh' },
          results: [],
          summary: { updated: 0, skipped: 0, failed: 0 },
        },
      };
      expect(payload).toMatchSnapshot();
    });
  });
});

describe('Swarm V1 IPC payload snapshots', () => {
  it('stream identifica sessão, run e revisão sem conteúdo nem credenciais', () => {
    expect({ runId: 'swarm-20260913_120000-abc123', chatSessionId: 'chat-1', revision: 3 }).toMatchSnapshot();
  });
  it('start retorna identidade assíncrona e settings usam milissegundos', () => {
    expect({ runId: 'swarm-20260913_120000-abc123', status: 'queued' }).toMatchSnapshot();
    expect({ concurrencyCap: 5, maxAttempts: 2, idleTimeoutMs: 1200000, hardTimeoutMs: 7200000 }).toMatchSnapshot();
  });
});

type ListProjects = Awaited<ReturnType<LionClawAPI['pipeline']['listProjects']>>;

function laneRow(id: string, laneBadge: number, title: string): OpenDesktopSessionRow {
  return {
    id,
    laneBadge,
    title,
    orchestrator: null,
    messageCount: 7,
    lastUserMessageAt: '2026-09-17 10:00:00',
    createdAt: '2026-09-17 09:00:00',
    updatedAt: '2026-09-17 10:00:00',
    dreamingStartedAt: null,
  };
}

function driveOf(over: Partial<DriveState> = {}): DriveState {
  return {
    driver: 'orchestrator',
    status: 'driving',
    handoff: 'none',
    mode: 'semi',
    requiresHumanPhases: [],
    ...over,
  };
}

function pipelineProject(id: string): Record<string, unknown> {
  return {
    id,
    name: 'Pipeline ' + id,
    projectPath: 'C:/repo',
    specPath: 'C:/repo/spec.md',
    status: 'running',
    pipelineType: 'development',
    pipelineCurrentPhase: 3,
    pipelineStartPhase: 1,
    pipelineSprintIndex: null,
    totalSprints: 0,
    totalFeatures: 0,
    createdAt: '2026-09-17 09:00:00',
    updatedAt: '2026-09-17 10:00:00',
    config: {},
  };
}

function invokePipeline(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipcHandlers.get(channel);
  expect(handler, 'handler ' + channel).toBeDefined();
  return Promise.resolve(handler!({}, ...args));
}

async function invokeListProjects(): Promise<ListProjects> {
  const result = await invokePipeline('pipeline:list-projects');
  if (!Array.isArray(result)) throw new Error('pipeline:list-projects nao devolveu lista');
  return result;
}

async function invokeGetProject(projectId: string): Promise<{ metadata?: Record<string, unknown> }> {
  const result = await invokePipeline('pipeline:get-project', projectId);
  if (result === null || typeof result !== 'object') {
    throw new Error('pipeline:get-project nao devolveu objeto');
  }
  return result;
}

function lastDriveEvent(): DriveStateChangedEvent {
  const event = emitted.driveEvents.at(-1);
  expect(event, 'evento drive:state-changed').toBeDefined();
  return event!;
}

describe('SPEC pipeline-por-lane 10: payloads ADITIVOS de lane (eventos e retornos REAIS)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    emitted.driveEvents.length = 0;
    lane.driveSessionId = null;
    lane.openLane = null;
    lane.projects = [];
    registerPipelineHandlers({
      getMainWindow: () => null,
      getHarnessEngine: () => null,
      getPipelineEngine: () => null,
    } as unknown as IpcContext);
  });

  it('drive:state-changed leva sessionId da coluna e laneBadge da lane, mesmo com a lane em streaming', () => {
    lane.driveSessionId = 'sess_A';
    lane.openLane = laneRow('sess_A', 2, 'Lane 2');

    const event: DriveStateChangedEvent = buildDriveStateChangedEvent(
      'proj_456',
      driveOf({ status: 'driving', sessionId: 'sess_A' }),
    );

    expect(event).toEqual({
      projectId: 'proj_456',
      drive: driveOf({ status: 'driving', sessionId: 'sess_A' }),
      sessionId: 'sess_A',
      laneBadge: 2,
    });
  });

  it('drive:state-changed da exclusao do projeto (drive null) leva sessionId e laneBadge null', async () => {
    lane.driveSessionId = 'sess_A';
    lane.openLane = laneRow('sess_A', 2, 'Lane 2');

    await invokePipeline('pipeline:delete-project', 'proj_456');

    expect(lastDriveEvent()).toEqual({
      projectId: 'proj_456',
      drive: null,
      sessionId: null,
      laneBadge: null,
    });
  });

  it('pipeline:list-projects acrescenta metadata.driveLane quando a coluna aponta para uma conversa', async () => {
    lane.projects = [pipelineProject('proj_1')];
    lane.driveSessionId = 'sess_A';
    lane.openLane = laneRow('sess_A', 4, 'Refatorar o motor');

    const result = await invokeListProjects();

    expect(result).toHaveLength(1);
    expect(result[0].metadata).toMatchObject({
      driveLane: { sessionId: 'sess_A', laneBadge: 4, laneTitle: 'Refatorar o motor' },
    });
  });

  it('pipeline:list-projects sem session_id nao ganha o campo driveLane', async () => {
    lane.projects = [pipelineProject('proj_1')];
    lane.driveSessionId = null;

    const result = await invokeListProjects();

    expect(result[0].metadata).toBeDefined();
    expect(result[0].metadata).not.toHaveProperty('driveLane');
  });

  it('pipeline:get-project traz driveLane com badge e titulo null quando a conversa nao e mais lane aberta', async () => {
    lane.projects = [pipelineProject('proj_1')];
    lane.driveSessionId = 'sess_compacted';
    lane.openLane = null;

    const result = await invokeGetProject('proj_1');

    expect(result.metadata?.['driveLane']).toEqual({
      sessionId: 'sess_compacted',
      laneBadge: null,
      laneTitle: null,
    });
  });
});

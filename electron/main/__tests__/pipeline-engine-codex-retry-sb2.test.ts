
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const capturedEvents: Array<{ channel: string; data: unknown }> = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{
      isDestroyed: () => false,
      webContents: { send: (channel: string, data: unknown) => capturedEvents.push({ channel, data }) },
    }]),
  },
  app: { on: vi.fn() },
}));

vi.mock('../db', () => ({
  getHarnessProject: vi.fn(),
  getAgent: vi.fn(),
  getDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []), run: vi.fn(), get: vi.fn() })) })),
  savePipelinePhaseMetrics: vi.fn(),
  savePipelineMessage: vi.fn(),
  getPipelinePhaseMessages: vi.fn().mockReturnValue([]),
  getPipelinePhaseMessagesAsChatHistory: vi.fn().mockReturnValue([]),
  getPipelineMetrics: vi.fn().mockReturnValue({ phases: [] }),
  getHarnessSprints: vi.fn().mockReturnValue([]),
  updateHarnessProject: vi.fn(),
  updateHarnessSprint: vi.fn(),
  insertHarnessRound: vi.fn(),
  updateHarnessRound: vi.fn(),
  deletePipelineMessagesFromPhase: vi.fn(),
  deletePipelinePhaseMetricsFromPhase: vi.fn(),
  deletePipelineMessagesForSprint: vi.fn(),
  deletePipelinePhaseMetricsForSprint: vi.fn(),
  deleteHarnessRoundsForSprint: vi.fn(),
  resetHarnessSprintStatus: vi.fn(),
  deleteHarnessSprintsForProject: vi.fn(),
  getHarnessSprintByIndex: vi.fn(),
  patchSecuritySummaryJson: vi.fn(),
  getSecuritySummaryJson: vi.fn(),
  getSecurityAgentStatuses: vi.fn().mockReturnValue([]),
}));

vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => ({
    runtime: 'codex',
    model: 'gpt-5.5',
    systemPrompt: '',
  })),
}));
vi.mock('../agent-runtime/cloud-executor', () => ({ cloudExecutor: { run: vi.fn() } }));
vi.mock('../agent-runtime/local-executor', () => ({ localExecutor: { run: vi.fn() } }));
vi.mock('../agent-runtime/external-executor', () => ({ externalExecutor: { run: vi.fn() } }));
vi.mock('../agent-runtime/codex-executor', () => ({ codexExecutor: { run: vi.fn() } }));
vi.mock('../agent-runtime/zai-executor', () => ({ zaiExecutor: { run: vi.fn() } }));
vi.mock('../agent-runtime/minimax-tokenplan-executor', () => ({ minimaxTokenplanExecutor: { run: vi.fn() } }));
vi.mock('../agent-runtime/kimi-executor', () => ({ kimiExecutor: { run: vi.fn() } }));

vi.mock('../harness-engine', () => {
  const HarnessEngine = vi.fn();
  HarnessEngine.prototype.abort = vi.fn();
  HarnessEngine.prototype.runSingleSprint = vi.fn();
  return { HarnessEngine };
});
vi.mock('../security-audit-runner', () => ({ SecurityAuditRunner: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../repo-profiler', () => ({ runRepoProfiler: vi.fn() }));
vi.mock('../security-findings-parser', () => ({ parseSecurityFindings: vi.fn() }));
vi.mock('../pipeline-paths', () => ({
  generatePipelineDocsId: vi.fn(() => 'docs-id'),
  getPipelineDocsContext: vi.fn(() => null),
  migrateLegacyDocsToFolder: vi.fn(),
  findConsolidatedSecurityReport: vi.fn(),
}));
vi.mock('../pipeline-report', () => ({ generatePipelineReport: vi.fn(), exportPipelineReport: vi.fn() }));
vi.mock('../pipeline-metrics-report', () => ({}));

import { PipelineEngine } from '../pipeline-engine';
import { executeAgent } from '../agent-runtime';
import { codexExecutor } from '../agent-runtime/codex-executor';
import { TypedProviderError } from '../agent-runtime/llm-error';
import { PERM_BYPASS_NO_GUARD } from '../agent-runtime/permission-profiles';
import { CodexAuthError, CodexUnavailableError } from '../codex-runtime/errors';
import { HarnessEngine } from '../harness-engine';
import type { AgentExecutionResult } from '../agent-runtime/types';
import type { CodexSession } from '../codex-runtime/types';
import { flushCoalescedStreams } from '../pipeline-shared/ipc-emitter';

const codexRun = codexExecutor.run as Mock;

function makeEngine() {
  const MockedHarness = HarnessEngine as unknown as new (...args: never[]) => HarnessEngine;
  const harnessInstance = new MockedHarness({} as never, {} as never);
  return new PipelineEngine(() => null, harnessInstance as never);
}

function makeSuccessResult(): AgentExecutionResult {
  return {
    output: 'done',
    metrics: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      toolUses: 2,
      apiRequests: 1,
      costUsd: 0.001,
      durationMs: 500,
    },
    model: 'gpt-5.5',
    runtime: 'codex',
    provider: 'openai-codex',
  };
}

function seedCachedSession(engine: PipelineEngine, projectId = 'proj-test') {
  const state = (
    engine as unknown as {
      getState: (id: string) => { codexSessions: Map<string, CodexSession> };
    }
  ).getState(projectId);
  const session: CodexSession = {
    threadId: 'th-old',
    send: vi.fn(),
    reply: vi.fn(),
    close: vi.fn(),
  };
  state.codexSessions.set('my-codex-agent:2', session);
  return { state, session };
}

const TRANSIENT_MSG = 'codex app-server exited (code=null)';

describe('AC-C9 — Pilar C + SB-2 JUNTOS (executeAgent REAL, allowlist ativa)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEvents.length = 0;
  });

  it('AC-C9: CodexUnavailableError atravessa o catch do SB-2 CRU (instanceof preservado no boundary)', async () => {
    codexRun.mockRejectedValue(new CodexUnavailableError(TRANSIENT_MSG));

    let caught: unknown;
    try {
      await executeAgent({
        agentId: 'my-codex-agent',
        prompt: 'oi',
        cwd: '/tmp/project',
        abortController: new AbortController(),
        permission: PERM_BYPASS_NO_GUARD,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CodexUnavailableError);
    expect(caught).not.toBeInstanceOf(TypedProviderError);
  });

  it('AC-C9: CodexAuthError tambem atravessa CRU (allowlist), enquanto erro cru de provider vira TypedProviderError', async () => {
    codexRun.mockRejectedValueOnce(new CodexAuthError('Codex OAuth expirado.'));
    await expect(
      executeAgent({
        agentId: 'my-codex-agent',
        prompt: 'oi',
        cwd: '/tmp/project',
        abortController: new AbortController(),
        permission: PERM_BYPASS_NO_GUARD,
      }),
    ).rejects.toBeInstanceOf(CodexAuthError);

    codexRun.mockRejectedValueOnce(new Error('HTTP 429 too many requests'));
    let caught: unknown;
    try {
      await executeAgent({
        agentId: 'my-codex-agent',
        prompt: 'oi',
        cwd: '/tmp/project',
        abortController: new AbortController(),
        permission: PERM_BYPASS_NO_GUARD,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TypedProviderError);
  });

  it('AC-C9 (fluxo completo C+B): retry do spawnAgent dispara e conclui com o execute.ts REAL no meio', async () => {
    codexRun
      .mockRejectedValueOnce(new CodexUnavailableError(TRANSIENT_MSG))
      .mockResolvedValueOnce(makeSuccessResult());

    const engine = makeEngine();
    const { state, session } = seedCachedSession(engine);

    const rebuildPromptOnRetry = vi.fn(
      () => 'PREAMBULO\nDocs: /tmp/project/docs/PRD.md\n## Mensagem do usuario\nsegue',
    );

    const result = await engine.spawnAgent('my-codex-agent', 'segue', {
      projectId: 'proj-test',
      phaseNumber: 2,
      cwd: '/tmp/project',
      abortController: new AbortController(),
      continueSession: true,
      rebuildPromptOnRetry,
    });

    expect(result.output).toBe('done');
    expect(codexRun).toHaveBeenCalledTimes(2);
    expect(rebuildPromptOnRetry).toHaveBeenCalledTimes(1);
    expect([...state.codexSessions.values()]).not.toContain(session);
    const retryReq = codexRun.mock.calls[1][0] as { codexSession?: CodexSession; prompt: string };
    expect(retryReq.codexSession).toBeUndefined();
    expect(retryReq.prompt).toContain('/tmp/project/docs/PRD.md');
    flushCoalescedStreams();
    expect(capturedEvents.find((e) => e.channel === 'pipeline:error')).toBeUndefined();
    expect(
      capturedEvents.find(
        (e) =>
          e.channel === 'pipeline:stream' &&
          String((e.data as { content?: string }).content ?? '').includes('Reconectando o Codex'),
      ),
    ).toBeDefined();
  });

  it('AC-C9 + AC-C5: falha permanente pos-retry com execute.ts REAL ainda surfaca pipeline:error e lanca CRU', async () => {
    codexRun.mockRejectedValue(new CodexUnavailableError(TRANSIENT_MSG));

    const engine = makeEngine();
    seedCachedSession(engine);

    await expect(
      engine.spawnAgent('my-codex-agent', 'segue', {
        projectId: 'proj-test',
        phaseNumber: 2,
        cwd: '/tmp/project',
        abortController: new AbortController(),
        continueSession: true,
        rebuildPromptOnRetry: () => 'PREAMBULO\n## Mensagem do usuario\nsegue',
      }),
    ).rejects.toBeInstanceOf(CodexUnavailableError);

    expect(codexRun).toHaveBeenCalledTimes(2);
    const errorEvent = capturedEvents.find((e) => e.channel === 'pipeline:error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { title: string }).title).toBe('CODEX FALHOU');
  });
});

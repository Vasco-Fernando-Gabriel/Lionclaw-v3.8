
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

const loggerSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../logger', () => ({
  createLogger: () => loggerSpies,
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

vi.mock('fs', () => ({ default: { existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn().mockReturnValue('') }, existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn().mockReturnValue('') }));
vi.mock('path', () => ({ default: { join: (...args: string[]) => args.join('/') }, join: (...args: string[]) => args.join('/') }));
vi.mock('os', () => ({ default: { homedir: () => '/home/user' }, homedir: () => '/home/user' }));

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

vi.mock('../agent-runtime', () => ({
  executeAgent: vi.fn(),
}));

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
import { flushCoalescedStreams } from '../pipeline-shared/ipc-emitter';
import { CodexAuthError, CodexUnavailableError } from '../codex-runtime/errors';
import { KimiAuthError } from '../agent-runtime/kimi-availability';
import { HarnessEngine } from '../harness-engine';
import type { AgentExecutionResult } from '../agent-runtime/types';
import type { CodexSession } from '../codex-runtime/types';


function makeEngine() {
  const harnessInstance = new HarnessEngine({} as never);
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

function makeSpawnOpts(projectId = 'proj-test') {
  return {
    projectId,
    phaseNumber: 2,
    cwd: '/tmp/project',
    abortController: new AbortController(),
  };
}


describe('PipelineEngine.spawnAgent — Codex error handling (Sprint 9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEvents.length = 0;
  });

  it('1. CodexAuthError: pipeline is paused, pipeline:auth-required emitted, PipelinePausedError thrown', async () => {
    const { PipelinePausedError } = await import('../agent-runtime/types');

    const authErr = new CodexAuthError('Codex OAuth expirado. Rode `codex login`.');
    (executeAgent as Mock).mockRejectedValue(authErr);

    const { getHarnessProject } = await import('../db');
    (getHarnessProject as Mock).mockReturnValue({
      id: 'proj-test',
      status: 'running',
      pipelineCurrentPhase: 2,
      pipelineType: 'dev',
    });

    const engine = makeEngine();
    const opts = makeSpawnOpts();

    let caught: unknown;
    try {
      await engine.spawnAgent('my-codex-agent', 'do stuff', opts);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelinePausedError);
    expect((caught as InstanceType<typeof PipelinePausedError>).reason).toBe('codex-auth');

    const authEvent = capturedEvents.find((e) => e.channel === 'pipeline:auth-required');
    expect(authEvent).toBeDefined();
    expect((authEvent!.data as { projectId: string }).projectId).toBe('proj-test');
    expect((authEvent!.data as { phaseNumber: number }).phaseNumber).toBe(2);
    expect((authEvent!.data as { message: string }).message).toContain('expirado');

    const updateEvent = capturedEvents.find((e) => e.channel === 'pipeline:project-updated');
    expect(updateEvent).toBeDefined();
    expect((updateEvent!.data as { patch: { status: string } }).patch.status).toBe('paused');
  });

  it('2. CodexUnavailableError: pipeline:error emitted with title CODEX FALHOU, error rethrown', async () => {
    const unavailErr = new CodexUnavailableError('codex binary not found.');
    (executeAgent as Mock).mockRejectedValue(unavailErr);

    const { getHarnessProject } = await import('../db');
    (getHarnessProject as Mock).mockReturnValue({
      id: 'proj-test',
      status: 'running',
      pipelineCurrentPhase: 3,
      pipelineType: 'dev',
    });

    const engine = makeEngine();
    const opts = makeSpawnOpts();

    await expect(
      engine.spawnAgent('my-codex-agent', 'do stuff', opts),
    ).rejects.toThrow(CodexUnavailableError);

    const errorEvent = capturedEvents.find((e) => e.channel === 'pipeline:error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { title: string }).title).toBe('CODEX FALHOU');
    expect((errorEvent!.data as { detail: string }).detail).toContain('not found');
  });

  it('KimiAuthError pausa a pipeline com payload e reason provider-aware', async () => {
    (executeAgent as Mock).mockRejectedValue(new KimiAuthError('Kimi OAuth expirado'));
    const { getHarnessProject } = await import('../db');
    (getHarnessProject as Mock).mockReturnValue({
      id: 'proj-test',
      status: 'running',
      pipelineCurrentPhase: 2,
      pipelineType: 'dev',
    });

    const engine = makeEngine();
    await expect(engine.spawnAgent('my-kimi-agent', 'do stuff', makeSpawnOpts()))
      .rejects.toMatchObject({ name: 'PipelinePausedError', reason: 'kimi-auth' });

    expect(capturedEvents).toContainEqual({
      channel: 'pipeline:auth-required',
      data: expect.objectContaining({ provider: 'kimi', runtime: 'kimi', projectId: 'proj-test' }),
    });
  });

  it('3. Non-codex errors propagate without special handling', async () => {
    const genericErr = new Error('Some generic error');
    (executeAgent as Mock).mockRejectedValue(genericErr);

    const engine = makeEngine();
    const opts = makeSpawnOpts();

    await expect(
      engine.spawnAgent('my-cloud-agent', 'do stuff', opts),
    ).rejects.toThrow('Some generic error');

    expect(capturedEvents.find((e) => e.channel === 'pipeline:auth-required')).toBeUndefined();
  });

  it('3b. injeta contexto root estrutural do pipeline no executeAgent', async () => {
    (executeAgent as Mock).mockResolvedValue(makeSuccessResult());
    const engine = makeEngine();
    const opts = makeSpawnOpts('proj-context');

    await engine.spawnAgent('my-agent', 'do stuff', opts);

    const req = (executeAgent as Mock).mock.calls[0][0] as {
      executionContext?: {
        ownerKind: string;
        ownerId: string;
        lane: string;
        rootExecutionId: string;
        parentExecutionId: string;
        workspace: { cwd: string; projectId?: string; readRoots: string[]; writeRoots: string[] };
      };
    };
    expect(req.executionContext).toMatchObject({
      ownerKind: 'pipeline',
      ownerId: 'proj-context',
      lane: 'pipeline',
      workspace: {
        cwd: '/tmp/project',
        projectId: 'proj-context',
        readRoots: ['/tmp/project'],
        writeRoots: ['/tmp/project'],
      },
    });
    expect(req.executionContext?.rootExecutionId).toBe(req.executionContext?.parentExecutionId);
  });

  it('4. codexSessions map is populated when onCodexSessionCreated is invoked', async () => {
    let createdSession: CodexSession | undefined;

    (executeAgent as Mock).mockImplementation(async (req) => {
      if (req.onCodexSessionCreated) {
        const fakeSession: CodexSession = { threadId: 'thread-new', send: vi.fn(), reply: vi.fn(), close: vi.fn() };
        req.onCodexSessionCreated(fakeSession);
        createdSession = fakeSession;
      }
      return makeSuccessResult();
    });

    const engine = makeEngine();
    const getStateInternal = (engine as unknown as { getState: (id: string) => { codexSessions: Map<string, CodexSession> } }).getState.bind(engine);
    const state = getStateInternal('proj-test');

    const opts = makeSpawnOpts();
    await engine.spawnAgent('my-codex-agent', 'first turn', opts);

    expect(state).toBeDefined();
    expect(state.codexSessions.size).toBe(1);
    expect(createdSession).toBeDefined();
    expect(state.codexSessions.get('my-codex-agent:2')).toBe(createdSession);
  });

  it('5. closeCodexSessions closes all sessions and clears the map', async () => {
    const session1: CodexSession = { threadId: 'th1', send: vi.fn(), reply: vi.fn(), close: vi.fn() };
    const session2: CodexSession = { threadId: 'th2', send: vi.fn(), reply: vi.fn(), close: vi.fn() };

    const engine = makeEngine();
    const getStateInternal = (engine as unknown as { getState: (id: string) => { codexSessions: Map<string, CodexSession> } }).getState.bind(engine);
    const state = getStateInternal('proj-test');
    state.codexSessions.set('agent-a:3', session1);
    state.codexSessions.set('agent-b:3', session2);

    (engine as unknown as { closeCodexSessions: (s: typeof state) => void }).closeCodexSessions(state);

    expect(session1.close).toHaveBeenCalledOnce();
    expect(session2.close).toHaveBeenCalledOnce();
    expect(state.codexSessions.size).toBe(0);
  });
});


function getEngineState(engine: PipelineEngine, projectId: string) {
  return (
    engine as unknown as {
      getState: (id: string) => { codexSessions: Map<string, CodexSession> };
    }
  ).getState(projectId);
}

function seedCachedSession(engine: PipelineEngine, projectId = 'proj-test') {
  const state = getEngineState(engine, projectId);
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

function makeRetryOpts(projectId = 'proj-test') {
  return {
    ...makeSpawnOpts(projectId),
    continueSession: true,
    rebuildPromptOnRetry: vi.fn(
      () =>
        'PREAMBULO DA FASE\nDocs: /tmp/project/docs/PRD.md\n' +
        '## Historico da conversa desta fase (ordem cronologica)\n[usuario]: oi\n' +
        '## Mensagem do usuario\nsegue o ajuste',
    ),
  };
}

describe('SC-1 — PipelineEngine.spawnAgent codex session recovery (Pilar C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEvents.length = 0;
  });

  it('AC-C1: sessao cacheada viva e reusada normalmente (caminho feliz sem retry)', async () => {
    (executeAgent as Mock).mockResolvedValue(makeSuccessResult());

    const engine = makeEngine();
    const { session } = seedCachedSession(engine);
    const opts = makeRetryOpts();

    const result = await engine.spawnAgent('my-codex-agent', 'follow-up', opts);

    expect(result.output).toBe('done');
    expect(executeAgent).toHaveBeenCalledTimes(1);
    const req = (executeAgent as Mock).mock.calls[0][0] as { codexSession?: CodexSession };
    expect(req.codexSession).toBe(session);
    expect(opts.rebuildPromptOnRetry).not.toHaveBeenCalled();
    expect(
      capturedEvents.find(
        (e) =>
          e.channel === 'pipeline:stream' &&
          String((e.data as { content?: string }).content ?? '').includes('Reconectando'),
      ),
    ).toBeUndefined();
  });

  it('AC-C2: CodexUnavailableError transiente na sessao cacheada -> remove do map, retenta 1x com sessao nova e conclui', async () => {
    (executeAgent as Mock)
      .mockRejectedValueOnce(new CodexUnavailableError(TRANSIENT_MSG))
      .mockResolvedValueOnce(makeSuccessResult());

    const engine = makeEngine();
    const { state, session } = seedCachedSession(engine);
    const opts = makeRetryOpts();

    const result = await engine.spawnAgent('my-codex-agent', 'follow-up', opts);

    expect(result.output).toBe('done');
    expect(executeAgent).toHaveBeenCalledTimes(2);
    expect([...state.codexSessions.values()]).not.toContain(session);
    const retryReq = (executeAgent as Mock).mock.calls[1][0] as {
      codexSession?: CodexSession;
      continueSession?: boolean;
    };
    expect(retryReq.codexSession).toBeUndefined();
    expect(capturedEvents.find((e) => e.channel === 'pipeline:error')).toBeUndefined();
  });

  it('AC-C3: o retry usa req.prompt COMPLETO (contexto da fase embutido no texto), nao a msg crua nem priorMessages', async () => {
    (executeAgent as Mock)
      .mockRejectedValueOnce(new CodexUnavailableError(TRANSIENT_MSG))
      .mockResolvedValueOnce(makeSuccessResult());

    const engine = makeEngine();
    seedCachedSession(engine);
    const opts = makeRetryOpts();

    await engine.spawnAgent('my-codex-agent', 'segue o ajuste', opts);

    expect(opts.rebuildPromptOnRetry).toHaveBeenCalledTimes(1);
    const retryReq = (executeAgent as Mock).mock.calls[1][0] as {
      prompt: string;
      priorMessages?: unknown;
    };
    expect(retryReq.prompt).toContain('/tmp/project/docs/PRD.md');
    expect(retryReq.prompt).toContain('## Historico da conversa desta fase');
    expect(retryReq.prompt).toContain('segue o ajuste');
    expect(retryReq.prompt).not.toBe('segue o ajuste');
    expect(retryReq.priorMessages).toBeUndefined();
  });

  it('AC-C4: a msg do usuario NAO e re-persistida no retry (nenhum persist roda em spawnAgent)', async () => {
    (executeAgent as Mock)
      .mockRejectedValueOnce(new CodexUnavailableError(TRANSIENT_MSG))
      .mockResolvedValueOnce(makeSuccessResult());

    const engine = makeEngine();
    seedCachedSession(engine);

    await engine.spawnAgent('my-codex-agent', 'follow-up', makeRetryOpts());

    const { savePipelineMessage, insertHarnessRound } = await import('../db');
    expect(savePipelineMessage as Mock).not.toHaveBeenCalled();
    expect(insertHarnessRound as Mock).not.toHaveBeenCalled();
  });

  it('AC-C5: segundo CodexUnavailableError apos o retry surfaca pipeline:error e lanca (sem loop; exatamente 2 tentativas)', async () => {
    (executeAgent as Mock).mockRejectedValue(new CodexUnavailableError(TRANSIENT_MSG));

    const engine = makeEngine();
    seedCachedSession(engine);

    await expect(
      engine.spawnAgent('my-codex-agent', 'follow-up', makeRetryOpts()),
    ).rejects.toThrow(CodexUnavailableError);

    expect(executeAgent).toHaveBeenCalledTimes(2);
    const errorEvent = capturedEvents.find((e) => e.channel === 'pipeline:error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { title: string }).title).toBe('CODEX FALHOU');
  });

  it('AC-C5: CodexUnavailableError NAO-transiente (binario ausente) nao retenta (fail-closed, 1 tentativa)', async () => {
    (executeAgent as Mock).mockRejectedValue(new CodexUnavailableError('codex binary not found.'));

    const engine = makeEngine();
    seedCachedSession(engine);
    const opts = makeRetryOpts();

    await expect(
      engine.spawnAgent('my-codex-agent', 'follow-up', opts),
    ).rejects.toThrow(CodexUnavailableError);

    expect(executeAgent).toHaveBeenCalledTimes(1);
    expect(opts.rebuildPromptOnRetry).not.toHaveBeenCalled();
    expect(capturedEvents.find((e) => e.channel === 'pipeline:error')).toBeDefined();
  });

  it('AC-C5: handler que NAO passa rebuildPromptOnRetry nao tem retry (fail-closed)', async () => {
    (executeAgent as Mock).mockRejectedValue(new CodexUnavailableError(TRANSIENT_MSG));

    const engine = makeEngine();
    seedCachedSession(engine);

    await expect(
      engine.spawnAgent('my-codex-agent', 'follow-up', {
        ...makeSpawnOpts(),
        continueSession: true,
      }),
    ).rejects.toThrow(CodexUnavailableError);

    expect(executeAgent).toHaveBeenCalledTimes(1);
  });

  it('AC-C6: CodexAuthError continua virando PipelinePausedError (NAO capturado pelo retry)', async () => {
    const { PipelinePausedError } = await import('../agent-runtime/types');
    (executeAgent as Mock).mockRejectedValue(new CodexAuthError('Codex OAuth expirado.'));

    const { getHarnessProject } = await import('../db');
    (getHarnessProject as Mock).mockReturnValue({
      id: 'proj-test',
      status: 'running',
      pipelineCurrentPhase: 2,
      pipelineType: 'dev',
    });

    const engine = makeEngine();
    seedCachedSession(engine);
    const opts = makeRetryOpts();

    await expect(
      engine.spawnAgent('my-codex-agent', 'follow-up', opts),
    ).rejects.toBeInstanceOf(PipelinePausedError);

    expect(executeAgent).toHaveBeenCalledTimes(1);
    expect(opts.rebuildPromptOnRetry).not.toHaveBeenCalled();
  });

  it('AC-C7: retry emite stream [Reconectando...] + log estruturado, e conclui normal no sucesso', async () => {
    (executeAgent as Mock)
      .mockRejectedValueOnce(new CodexUnavailableError(TRANSIENT_MSG))
      .mockResolvedValueOnce(makeSuccessResult());

    const engine = makeEngine();
    seedCachedSession(engine);

    const result = await engine.spawnAgent('my-codex-agent', 'follow-up', makeRetryOpts());

    flushCoalescedStreams();

    const streamEvent = capturedEvents.find(
      (e) =>
        e.channel === 'pipeline:stream' &&
        String((e.data as { content?: string }).content ?? '').includes(
          'Reconectando o Codex e retomando de onde parou',
        ),
    );
    expect(streamEvent).toBeDefined();
    const warnCall = loggerSpies.warn.mock.calls.find(
      (c) => c[1] === 'codex continuation session unavailable; recreating',
    );
    expect(warnCall).toBeDefined();
    expect(warnCall![0]).toMatchObject({
      projectId: 'proj-test',
      agentId: 'my-codex-agent',
      phaseNumber: 2,
      message: TRANSIENT_MSG,
      attempt: 1,
    });
    expect(result.output).toBe('done');
    expect(capturedEvents.find((e) => e.channel === 'pipeline:error')).toBeUndefined();
  });

});


describe('SC-1 — isTransientCodexSessionError / buildCodexResumePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AC-C2/AC-C5: isTransientCodexSessionError casa os padroes transientes e rejeita os permanentes', async () => {
    const { isTransientCodexSessionError } = await import('../pipeline-engine/codex-sessions');

    expect(isTransientCodexSessionError('codex app-server exited (code=null)')).toBe(true);
    expect(isTransientCodexSessionError('app-server transport closed')).toBe(true);
    expect(isTransientCodexSessionError('CodexSession is already closed')).toBe(true);
    expect(isTransientCodexSessionError('Cannot reply: no active threadId')).toBe(true);
    expect(isTransientCodexSessionError('turn/start failed: app-server transport closed')).toBe(true);

    expect(isTransientCodexSessionError('codex binary not found.')).toBe(false);
    expect(isTransientCodexSessionError('codex app-server handshake failed during install')).toBe(false);
    expect(isTransientCodexSessionError('')).toBe(false);
  });

  it('AC-C3: buildCodexResumePrompt embute preambulo (caminhos de doc) + historico da fase + msg do usuario, nessa ordem', async () => {
    const { getPipelinePhaseMessages } = await import('../db');
    (getPipelinePhaseMessages as Mock).mockReturnValue([
      { role: 'user', content: 'primeira pergunta' },
      { role: 'assistant', content: 'primeira resposta' },
    ]);
    const { buildCodexResumePrompt } = await import('../pipeline-engine/codex-sessions');

    const prompt = buildCodexResumePrompt({
      projectId: 'proj-test',
      phaseNumber: 3,
      preamble: '## Discovery Notes\nCaminho: /tmp/project/docs/discovery.md',
      userMessage: 'ajusta a story 4',
    });

    expect(getPipelinePhaseMessages).toHaveBeenCalledWith('proj-test', 3);
    expect(prompt).toContain('/tmp/project/docs/discovery.md');
    expect(prompt).toContain('[usuario]: primeira pergunta');
    expect(prompt).toContain('[assistente]: primeira resposta');
    expect(prompt).toContain('## Mensagem do usuario\najusta a story 4');
    const iPreamble = prompt.indexOf('/tmp/project/docs/discovery.md');
    const iHistory = prompt.indexOf('[usuario]: primeira pergunta');
    const iMessage = prompt.indexOf('## Mensagem do usuario');
    expect(iPreamble).toBeGreaterThan(-1);
    expect(iHistory).toBeGreaterThan(iPreamble);
    expect(iMessage).toBeGreaterThan(iHistory);
  });

  it('AC-C3: historico vazio nao quebra (placeholder) e erro de leitura e best-effort', async () => {
    const { getPipelinePhaseMessages } = await import('../db');
    const { buildCodexResumePrompt } = await import('../pipeline-engine/codex-sessions');

    (getPipelinePhaseMessages as Mock).mockReturnValue([]);
    const emptyPrompt = buildCodexResumePrompt({
      projectId: 'proj-test',
      phaseNumber: 1,
      preamble: 'Notas: /tmp/notes.md',
      userMessage: 'oi',
    });
    expect(emptyPrompt).toContain('(sem historico persistido nesta fase)');
    expect(emptyPrompt).toContain('## Mensagem do usuario\noi');

    (getPipelinePhaseMessages as Mock).mockImplementation(() => {
      throw new Error('db unavailable');
    });
    const degradedPrompt = buildCodexResumePrompt({
      projectId: 'proj-test',
      phaseNumber: 1,
      preamble: 'Notas: /tmp/notes.md',
      userMessage: 'oi',
    });
    expect(degradedPrompt).toContain('Notas: /tmp/notes.md');
    expect(degradedPrompt).toContain('## Mensagem do usuario\noi');
  });

  it('AC-C3: historico gigante e truncado priorizando as mensagens mais RECENTES', async () => {
    const { getPipelinePhaseMessages } = await import('../db');
    (getPipelinePhaseMessages as Mock).mockReturnValue([
      { role: 'user', content: 'MENSAGEM-ANTIGA ' + 'x'.repeat(59_000) },
      { role: 'assistant', content: 'MENSAGEM-RECENTE ' + 'y'.repeat(30_000) },
    ]);
    const { buildCodexResumePrompt } = await import('../pipeline-engine/codex-sessions');

    const prompt = buildCodexResumePrompt({
      projectId: 'proj-test',
      phaseNumber: 5,
      preamble: 'PRD: /tmp/PRD.md',
      userMessage: 'continua',
    });

    expect(prompt).toContain('MENSAGEM-RECENTE');
    expect(prompt).not.toContain('MENSAGEM-ANTIGA');
  });
});

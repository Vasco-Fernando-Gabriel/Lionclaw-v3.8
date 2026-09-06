
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

const ipc = vi.hoisted(() => ({
  events: [] as Array<{ channel: string; payload: unknown }>,
}));
vi.mock('../pipeline-shared/ipc-emitter', () => ({
  emitIPC: (channel: string, payload: unknown) => ipc.events.push({ channel, payload }),
  flushCoalescedStreams: vi.fn(),
}));

const persistSpies = vi.hoisted(() => ({
  persistMessage: vi.fn(),
  persistHarnessRound: { insert: vi.fn(() => ({ id: 1 })), update: vi.fn() },
}));
vi.mock('../pipeline-shared/persist', () => persistSpies);

const routerMock = vi.hoisted(() => ({
  dispatchConversationMessage: vi.fn(),
  isPureConversationPhase: vi.fn(() => true),
}));
vi.mock('../pipeline-engine/message-router', () => routerMock);

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  app: { on: vi.fn() },
}));

vi.mock('fs', () => ({ default: { existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn().mockReturnValue('') }, existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn().mockReturnValue('') }));
vi.mock('path', () => ({ default: { join: (...args: string[]) => args.join('/') }, join: (...args: string[]) => args.join('/') }));
vi.mock('os', () => ({ default: { homedir: () => '/home/user', tmpdir: () => '/tmp' }, homedir: () => '/home/user', tmpdir: () => '/tmp' }));

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
  updateHarnessProjectPipelineColumns: vi.fn(),
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
  PIPELINE_GREETING_AGENT_ID: 'pipeline-greeting',
}));

vi.mock('../agent-runtime', () => ({
  executeAgent: vi.fn(),
}));
vi.mock('../codex-runtime/binary', () => ({
  isCodexAvailable: vi.fn().mockResolvedValue({ authenticated: true, appServerSupported: true }),
}));
vi.mock('../codex-sdk', () => ({ closeAllCachedChatCodexSessions: vi.fn() }));
vi.mock('../agent-runtime/codex-session-factory', () => ({
  closeAllOfficialRuns: vi.fn(),
  resetOfficialProjectRunsNow: vi.fn(),
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
import { getHarnessProject } from '../db';
import { HarnessEngine } from '../harness-engine';


function makeEngine() {
  const harnessInstance = new HarnessEngine({} as never);
  return new PipelineEngine(() => null, harnessInstance as never);
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stubProject(id: string) {
  return { id, status: 'running', pipelineCurrentPhase: 1, pipelineType: 'dev' };
}

function errorStreams() {
  return ipc.events.filter(
    (e) => e.channel === 'pipeline:stream' && (e.payload as { type?: string }).type === 'error',
  );
}

const TOKEN_ERROR = { error: 'turno da fase em andamento' };

describe('BUG 4 - token one-in-flight por fase no sendMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.events.length = 0;
    routerMock.isPureConversationPhase.mockReturnValue(true);
    (getHarnessProject as Mock).mockImplementation((id: string) => stubProject(id));
  });

  it('(1) fase streamando -> { error } com ZERO efeitos colaterais; (2) apos fechar, passa', async () => {
    const engine = makeEngine();
    const d1 = deferred<'routed'>();
    routerMock.dispatchConversationMessage.mockReturnValueOnce(d1.promise);

    const p1 = engine.sendMessage('proj-1', 'primeira mensagem');

    const res2 = await engine.sendMessage('proj-1', 'segunda mensagem');
    expect(res2).toEqual(TOKEN_ERROR);

    expect(persistSpies.persistMessage).toHaveBeenCalledTimes(1);
    expect(errorStreams()).toHaveLength(0);
    expect(routerMock.dispatchConversationMessage).toHaveBeenCalledTimes(1);

    d1.resolve('routed');
    await p1;
    routerMock.dispatchConversationMessage.mockResolvedValueOnce('routed');
    const res3 = await engine.sendMessage('proj-1', 'terceira mensagem');
    expect(res3).toBeUndefined();
    expect(routerMock.dispatchConversationMessage).toHaveBeenCalledTimes(2);
    expect(persistSpies.persistMessage).toHaveBeenCalledTimes(2);
  });

  it('(3) compare-and-clear: finally de turno ANTIGO nao libera o token de turno NOVO', async () => {
    const engine = makeEngine();
    const d1 = deferred<'routed'>();
    routerMock.dispatchConversationMessage.mockReturnValueOnce(d1.promise);
    const p1 = engine.sendMessage('proj-1', 'turno antigo');

    const internals = engine as unknown as { inFlightSendTokens: Map<string, unknown> };
    internals.inFlightSendTokens.clear();

    const d2 = deferred<'routed'>();
    routerMock.dispatchConversationMessage.mockReturnValueOnce(d2.promise);
    const p2 = engine.sendMessage('proj-1', 'turno novo');

    d1.resolve('routed');
    await p1;
    const res3 = await engine.sendMessage('proj-1', 'terceiro');
    expect(res3).toEqual(TOKEN_ERROR);

    d2.resolve('routed');
    await p2;
    routerMock.dispatchConversationMessage.mockResolvedValueOnce('routed');
    await expect(engine.sendMessage('proj-1', 'quarto')).resolves.toBeUndefined();
  });

  it('(4) anti-deadlock: abort (pause) nao prende o token — o finally dono libera ao assentar', async () => {
    const engine = makeEngine();
    const d1 = deferred<'routed'>();
    routerMock.dispatchConversationMessage.mockReturnValueOnce(d1.promise);
    const p1 = engine.sendMessage('proj-1', 'vai ser pausado');

    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    d1.reject(abortErr);
    await p1;

    const doneStreams = ipc.events.filter(
      (e) => e.channel === 'pipeline:stream' && (e.payload as { type?: string }).type === 'done',
    );
    expect(doneStreams.length).toBeGreaterThan(0);
    routerMock.dispatchConversationMessage.mockResolvedValueOnce('routed');
    await expect(engine.sendMessage('proj-1', 'depois do pause')).resolves.toBeUndefined();
  });

  it('(5) paralelismo legitimo: fase de OUTRO projeto nao e bloqueada', async () => {
    const engine = makeEngine();
    const d1 = deferred<'routed'>();
    routerMock.dispatchConversationMessage.mockReturnValueOnce(d1.promise);
    const p1 = engine.sendMessage('proj-1', 'turno em voo no projeto 1');

    routerMock.dispatchConversationMessage.mockResolvedValueOnce('routed');
    await expect(engine.sendMessage('proj-2', 'projeto 2 segue livre')).resolves.toBeUndefined();

    d1.resolve('routed');
    await p1;
  });

  it('(6) greeting adquire o token normalmente (bloqueia concorrente ate assentar)', async () => {
    const engine = makeEngine();
    const d1 = deferred<'routed'>();
    routerMock.dispatchConversationMessage.mockReturnValueOnce(d1.promise);
    const p1 = engine.sendMessage('proj-1', 'briefing da fase', undefined, { isGreeting: true });

    const res2 = await engine.sendMessage('proj-1', 'mensagem durante o greeting');
    expect(res2).toEqual(TOKEN_ERROR);

    d1.resolve('routed');
    await p1;
    routerMock.dispatchConversationMessage.mockResolvedValueOnce('routed');
    await expect(engine.sendMessage('proj-1', 'depois do greeting')).resolves.toBeUndefined();
  });

  it('retoma o mesmo turno apos auth sem persistir a mensagem do usuario duas vezes', async () => {
    const { PipelinePausedError } = await import('../agent-runtime/types');
    const engine = makeEngine();
    routerMock.dispatchConversationMessage.mockRejectedValueOnce(
      new PipelinePausedError('login necessario', 'codex-auth'),
    );

    await engine.sendMessage('proj-1', 'mensagem original');
    expect(persistSpies.persistMessage).toHaveBeenCalledTimes(1);

    routerMock.dispatchConversationMessage.mockResolvedValueOnce('routed');
    await expect(engine.resumeAfterAuth('proj-1', 'codex')).resolves.toEqual({ ok: true });

    expect(routerMock.dispatchConversationMessage).toHaveBeenCalledTimes(2);
    expect(routerMock.dispatchConversationMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'mensagem original' }),
      1,
    );
    expect(persistSpies.persistMessage).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mocks = vi.hoisted(() => ({
  getHarnessProject: vi.fn(),
  getPipelinePhaseMetricsRows: vi.fn(),
  mergePipelinePhaseMetricsMetadata: vi.fn(),
}));

vi.mock('../db', () => ({
  getHarnessProject: mocks.getHarnessProject,
  getPipelinePhaseMetricsRows: mocks.getPipelinePhaseMetricsRows,
  mergePipelinePhaseMetricsMetadata: mocks.mergePipelinePhaseMetricsMetadata,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { runUsageSanityCheck, slugifyCwd } from '../pipeline-engine/usage-sanity';

const PROJECT_ID = 'proj-f6';
const CWD = '/home/user/NeonChat';
const SLUG = slugifyCwd(CWD); // -home-user-NeonChat

let root: string;

function writeTranscript(relPath: string, lines: Array<Record<string, unknown>>): void {
  const file = path.join(root, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

function usageLine(
  id: string,
  usage: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number },
): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      id,
      usage: {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheCreation ?? 0,
      },
    },
  };
}

function metricsRow(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: 1,
    projectId: PROJECT_ID,
    phaseNumber: 13,
    sprintIndex: 0,
    phaseName: 'Coder',
    agentId: 'harness-coder',
    status: 'completed',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 0,
    toolUses: 0,
    apiRequests: 0,
    messagesCount: 0,
    model: 'claude-sonnet-4-5',
    runtime: 'cloud',
    startedAt: null,
    completedAt: null,
    metadata: {},
    createdAt: '2026-07-10T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-sanity-'));
  mocks.getHarnessProject.mockReturnValue({ id: PROJECT_ID, projectPath: CWD });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('BUG 3 F6 — invariante de sanidade de usage', () => {
  it('slugifyCwd converte todo nao-alfanumerico em hifen', () => {
    expect(slugifyCwd('/home/user/Neon_Chat v2')).toBe(
      '-home-user-Neon-Chat-v2',
    );
  });

  it('fase sem sessionIds capturado e ignorada (codex/kimi nunca disparam)', async () => {
    mocks.getPipelinePhaseMetricsRows.mockReturnValue([
      metricsRow({ runtime: 'codex', inputTokens: 100, outputTokens: 50, metadata: {} }),
    ]);
    const warnings = await runUsageSanityCheck(PROJECT_ID, { claudeProjectsRoot: root });
    expect(warnings).toEqual([]);
    expect(mocks.mergePipelinePhaseMetricsMetadata).not.toHaveBeenCalled();
  });

  it('divergencia >10% (sessao descartada preservada) grava warning no metadata', async () => {
    writeTranscript(`${SLUG}/sess-a.jsonl`, [
      usageLine('msg_a1', { input: 3000, output: 1000 }),
    ]);
    writeTranscript(`${SLUG}/sess-b.jsonl`, [
      usageLine('msg_b1', { input: 1000, output: 500 }),
    ]);
    mocks.getPipelinePhaseMetricsRows.mockReturnValue([
      metricsRow({
        inputTokens: 1000,
        outputTokens: 500,
        metadata: { sessionIds: ['sess-a', 'sess-b'] },
      }),
    ]);

    const warnings = await runUsageSanityCheck(PROJECT_ID, { claudeProjectsRoot: root });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      phaseNumber: 13,
      sprintIndex: 0,
      dbTokens: 1500,
      transcriptTokens: 5500,
    });
    expect(mocks.mergePipelinePhaseMetricsMetadata).toHaveBeenCalledTimes(1);
    const [pid, phase, sprint, patch] = mocks.mergePipelinePhaseMetricsMetadata.mock.calls[0];
    expect(pid).toBe(PROJECT_ID);
    expect(phase).toBe(13);
    expect(sprint).toBe(0);
    expect(patch.usageSanityWarning).toMatchObject({
      dbTokens: 1500,
      transcriptTokens: 5500,
      sessionCount: 2,
    });
  });

  it('dedupe por message.id: linhas repetidas por content block contam UMA vez (MAX)', async () => {
    writeTranscript(`${SLUG}/sess-a.jsonl`, [
      usageLine('msg_1', { input: 1000, output: 100 }),
      usageLine('msg_1', { input: 1000, output: 300 }),
      usageLine('msg_1', { input: 1000, output: 500 }),
    ]);
    mocks.getPipelinePhaseMetricsRows.mockReturnValue([
      metricsRow({
        inputTokens: 1000,
        outputTokens: 500,
        metadata: { sessionIds: ['sess-a'] },
      }),
    ]);

    const warnings = await runUsageSanityCheck(PROJECT_ID, { claudeProjectsRoot: root });

    expect(warnings).toEqual([]);
    expect(mocks.mergePipelinePhaseMetricsMetadata).not.toHaveBeenCalled();
  });

  it('subagents/*.jsonl entram na uniao da sessao', async () => {
    writeTranscript(`${SLUG}/sess-a.jsonl`, [usageLine('msg_1', { input: 500, output: 100 })]);
    writeTranscript(`${SLUG}/sess-a/subagents/agent-1.jsonl`, [
      usageLine('msg_sub1', { input: 2000, output: 400 }),
    ]);
    mocks.getPipelinePhaseMetricsRows.mockReturnValue([
      metricsRow({
        inputTokens: 500,
        outputTokens: 100,
        metadata: { sessionIds: ['sess-a'] },
      }),
    ]);

    const warnings = await runUsageSanityCheck(PROJECT_ID, { claudeProjectsRoot: root });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].transcriptTokens).toBe(3000); // 600 main + 2400 subagent
  });

  it('arquivo/slug ausente nao explode e nao gera warning', async () => {
    mocks.getPipelinePhaseMetricsRows.mockReturnValue([
      metricsRow({
        inputTokens: 1000,
        outputTokens: 500,
        metadata: { sessionIds: ['sess-inexistente'] },
      }),
    ]);
    await expect(
      runUsageSanityCheck(PROJECT_ID, { claudeProjectsRoot: root }),
    ).resolves.toEqual([]);
    expect(mocks.mergePipelinePhaseMetricsMetadata).not.toHaveBeenCalled();
  });

  it('divergencia dentro de 10% fica em silencio', async () => {
    writeTranscript(`${SLUG}/sess-a.jsonl`, [
      usageLine('msg_1', { input: 1000, output: 550 }), // real 1550 vs banco 1500 (~3%)
    ]);
    mocks.getPipelinePhaseMetricsRows.mockReturnValue([
      metricsRow({
        inputTokens: 1000,
        outputTokens: 500,
        metadata: { sessionIds: ['sess-a'] },
      }),
    ]);
    const warnings = await runUsageSanityCheck(PROJECT_ID, { claudeProjectsRoot: root });
    expect(warnings).toEqual([]);
    expect(mocks.mergePipelinePhaseMetricsMetadata).not.toHaveBeenCalled();
  });

  it('transcript < banco com sessao faltando = leitura parcial, silencio', async () => {
    writeTranscript(`${SLUG}/sess-a.jsonl`, [usageLine('msg_1', { input: 100, output: 50 })]);
    mocks.getPipelinePhaseMetricsRows.mockReturnValue([
      metricsRow({
        inputTokens: 1000,
        outputTokens: 500,
        metadata: { sessionIds: ['sess-a', 'sess-b'] },
      }),
    ]);
    const warnings = await runUsageSanityCheck(PROJECT_ID, { claudeProjectsRoot: root });
    expect(warnings).toEqual([]);
    expect(mocks.mergePipelinePhaseMetricsMetadata).not.toHaveBeenCalled();
  });

  it('linha invalida (JSON quebrado / sem usage) e ignorada sem throw', async () => {
    const file = path.join(root, SLUG, 'sess-a.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      '{nao-e-json}\n' +
        JSON.stringify({ type: 'system', subtype: 'init' }) +
        '\n' +
        JSON.stringify(usageLine('msg_1', { input: 2000, output: 500 })) +
        '\n',
      'utf-8',
    );
    mocks.getPipelinePhaseMetricsRows.mockReturnValue([
      metricsRow({
        inputTokens: 1000,
        outputTokens: 500,
        metadata: { sessionIds: ['sess-a'] },
      }),
    ]);
    const warnings = await runUsageSanityCheck(PROJECT_ID, { claudeProjectsRoot: root });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].transcriptTokens).toBe(2500);
  });

  it('nao roda NADA sincrono antes do primeiro tick (fire-and-forget de verdade)', async () => {
    const promise = runUsageSanityCheck(PROJECT_ID, { claudeProjectsRoot: root });
    expect(mocks.getHarnessProject).not.toHaveBeenCalled();
    await promise;
    expect(mocks.getHarnessProject).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('projeto inexistente ou erro nas deps nunca lanca', async () => {
    mocks.getHarnessProject.mockReturnValue(undefined);
    await expect(runUsageSanityCheck(PROJECT_ID)).resolves.toEqual([]);

    mocks.getHarnessProject.mockImplementation(() => {
      throw new Error('db off');
    });
    await expect(runUsageSanityCheck(PROJECT_ID)).resolves.toEqual([]);
  });
});


describe('BUG 3 F6 — contratos de fonte (reset preservation + wiring)', () => {
  const MAIN = path.join(__dirname, '..');

  it('db.ts: deletePipelinePhaseMetricsForSprint preserva sessionIds (carry) em vez de deletar', () => {
    const src = fs.readFileSync(path.join(MAIN, 'db.ts'), 'utf-8');
    const fnStart = src.indexOf('export function deletePipelinePhaseMetricsForSprint');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBlock = src.slice(fnStart, fnStart + 2500);
    expect(fnBlock).toContain("JSON.stringify({ sessionIds })");
    expect(fnBlock).toContain("status = 'pending'");
    expect(fnBlock).toContain('DELETE FROM pipeline_phase_metrics WHERE id = ?');
  });

  it('db.ts: carryHarnessRoundSessionIdsForSprint colhe session ids de harness_rounds e semeia pipeline_phase_metrics', () => {
    const src = fs.readFileSync(path.join(MAIN, 'db.ts'), 'utf-8');
    const fnStart = src.indexOf('export function carryHarnessRoundSessionIdsForSprint');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBlock = src.slice(fnStart, fnStart + 3500);
    expect(fnBlock).toContain('SELECT coder_session_id, evaluator_session_id FROM harness_rounds WHERE sprint_id = ?');
    expect(fnBlock).toContain('UPDATE pipeline_phase_metrics SET metadata = ? WHERE id = ?');
    expect(fnBlock).toContain('INSERT INTO pipeline_phase_metrics');
    expect(fnBlock).toContain("'pending'");
  });

  it('lifecycle.ts: completePipeline dispara runUsageSanityCheck fire-and-forget', () => {
    const src = fs.readFileSync(
      path.join(MAIN, 'pipeline-engine', 'lifecycle.ts'),
      'utf-8',
    );
    expect(src).toContain("import { runUsageSanityCheck } from './usage-sanity'");
    const fnStart = src.indexOf('export function completePipeline');
    const fnBlock = src.slice(fnStart, src.indexOf('failPhase', fnStart));
    expect(fnBlock).toContain('void runUsageSanityCheck(projectId)');
  });

  it('stream-processor.ts: session_id capturado do system:init (cobre abort, pre-step §6)', () => {
    const src = fs.readFileSync(path.join(MAIN, 'stream-processor.ts'), 'utf-8');
    expect(src).toContain("if (rec['subtype'] === 'init') captureSessionId(rec['session_id'])");
  });
});

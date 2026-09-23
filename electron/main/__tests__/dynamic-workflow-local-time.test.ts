import { describe, it, expect } from 'vitest';
import { parseUtcTimestamp, formatLocalShort, toLocalShort } from '../dynamic-workflows/local-time';
import { buildSnapshot, type SnapshotDeps } from '../dynamic-workflows/workflow-snapshot';
import { deriveOutcome, buildWakePrompt } from '../dynamic-workflows/workflow-outcome';
import type { DynamicWorkflowRun, DynamicWorkflowEvent } from '../dynamic-workflows/types';

describe('local-time (L1.10)', () => {
  it('parseia SQLite `YYYY-MM-DD HH:MM:SS` como UTC e ISO com Z; ilegivel => null', () => {
    expect(parseUtcTimestamp('2026-09-02 04:42:52')?.toISOString()).toBe('2026-09-02T04:42:52.000Z');
    expect(parseUtcTimestamp('2026-09-02T04:42:52.000Z')?.toISOString()).toBe('2026-09-02T04:42:52.000Z');
    expect(parseUtcTimestamp('lixo')).toBeNull();
    expect(parseUtcTimestamp(undefined)).toBeNull();
    expect(parseUtcTimestamp('')).toBeNull();
  });

  it('formata dd/MM HH:mm no fuso pedido (America/Sao_Paulo = UTC-3)', () => {
    const d = parseUtcTimestamp('2026-09-02 04:42:52')!;
    expect(formatLocalShort(d, 'America/Sao_Paulo')).toBe('02/09 01:42');
    expect(formatLocalShort(d, 'UTC')).toBe('02/09 04:42');
    expect(toLocalShort('2026-09-02 04:42:52', 'Asia/Tokyo')).toBe('02/09 13:42');
    expect(toLocalShort('x')).toBeUndefined();
  });

  it('sem timeZone usa o fuso do host e devolve o formato dd/MM HH:mm', () => {
    expect(toLocalShort('2026-09-02 04:42:52')).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });
});

describe('snapshot e digest carregam atLocal (L1.10)', () => {
  const run: DynamicWorkflowRun = {
    id: 'run-1',
    definitionId: 'def-1',
    chatSessionId: null,
    status: 'running',
    currentPhaseId: null,
    currentNodeId: null,
    workspaceMode: null,
    baseBranch: null,
    baseCommitSha: null,
    baseWorktreeHash: null,
    worktreePath: null,
    worktreeBranch: null,
    deliveredAt: null,
    finalizedAt: null,
    closerSessionId: null,
    closerStatus: null,
    inputJson: '{}',
    outputJson: null,
    checkpointJson: JSON.stringify({ nodes: { a: { savedAt: '2026-09-02T04:42:52.000Z' } } }),
    error: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
    createdBy: 'manual',
    startedAt: null,
    updatedAt: 'x',
    completedAt: null,
  };
  const ev: DynamicWorkflowEvent = {
    id: 1,
    runId: 'run-1',
    nodeId: 'a',
    phaseId: null,
    seq: 1,
    type: 'node-completed',
    payloadJson: JSON.stringify({ agentId: 'scout', costUsd: 0.1 }),
    createdAt: '2026-09-02 04:42:52',
  };
  const deps: SnapshotDeps = {
    getRun: () => run,
    recentEvents: () => [ev],
    costAggregate: () => ({
      runId: 'run-1',
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalDurationMs: 0,
      nodeRunCount: 0,
      unknownCostNodeRuns: 0,
    }),
    listEventsSince: () => [ev],
  };

  it('recentEvents[].atLocal, lastCheckpointAtLocal e lastOutcomes[].atLocal presentes; `at` continua UTC', () => {
    const snap = buildSnapshot('run-1', '/p', deps)!;
    expect(snap.recentEvents[0]!.at).toBe('2026-09-02 04:42:52');
    expect(snap.recentEvents[0]!.atLocal).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(snap.lastCheckpointAt).toBe('2026-09-02T04:42:52.000Z');
    expect(snap.lastCheckpointAtLocal).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(snap.lastOutcomes?.[0]?.atLocal).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it('deriveOutcome preenche atLocal e o prompt do wake mostra a hora local na linha do desfecho', () => {
    const o = deriveOutcome(ev)!;
    expect(o.at).toBe('2026-09-02 04:42:52');
    expect(o.atLocal).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
    const prompt = buildWakePrompt({
      runId: 'run-1',
      reason: 'boundary',
      semaphore: 'VERDE',
      since: { nodes: 1, green: 1, attention: 0, pending: 0, failed: 0, costUsd: 0.1, durationMs: 0 },
      outcomes: [o],
    });
    expect(prompt).toMatch(/- \[\d{2}\/\d{2} \d{2}:\d{2}\] \[green\] node-completed scout/);
    expect(prompt).not.toContain('2026-09-02 04:42:52');
  });
});

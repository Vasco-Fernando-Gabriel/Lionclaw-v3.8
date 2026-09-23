import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('../paths', () => ({ getLionClawHome: () => state.root }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  finalizeTaskExecutionOnce,
  getDb,
  insertHarnessRound,
  insertHarnessSprint,
  getPipelineMetrics,
  initDatabase,
  savePipelinePhaseMetrics,
  startTaskExecution,
  updateHarnessRound,
} from '../db';
import { generatePipelineReport } from '../pipeline-report';

function createProject(id: string, pipelineType = 'development'): void {
  const projectPath = path.join(state.root, id);
  fs.mkdirSync(projectPath, { recursive: true });
  getDb()
    .prepare(
      `
    INSERT INTO harness_projects (id, name, project_path, spec_path, status, config, pipeline_type)
    VALUES (?, ?, ?, ?, 'running', '{}', ?)
  `,
    )
    .run(id, id, projectPath, path.join(projectPath, 'SPEC.md'), pipelineType);
}

function addPhase(projectId: string, phaseNumber: number, runtime: 'cloud' | 'grok', costUsd: number): void {
  savePipelinePhaseMetrics({
    projectId,
    phaseNumber,
    phaseName: runtime === 'grok' ? 'Grok phase' : 'Cloud phase',
    status: 'completed',
    model: runtime === 'grok' ? 'grok-4.5' : 'claude-sonnet-4-6',
    runtime,
    costUsd,
    metadata:
      runtime === 'grok'
        ? {
            provider: 'grok',
            costStatus: 'known',
            costEstimationKind: 'subscription-equivalent-payg',
          }
        : { provider: 'anthropic', costStatus: 'known' },
  });
}

function addGrokSubagent(projectId: string, costUsd: number): void {
  const rootExecutionId = `root-${projectId}`;
  const childExecutionId = `child-${projectId}`;
  startTaskExecution({
    executionId: rootExecutionId,
    rootExecutionId,
    parentExecutionId: null,
    executionKind: 'root',
    ownerKind: 'pipeline',
    ownerId: projectId,
    sessionId: null,
    toolUseId: null,
    agentId: null,
    agentName: 'root',
    model: '',
    description: 'pipeline root',
    runtime: null,
    provider: null,
    metadata: { surface: 'pipeline' },
  });
  startTaskExecution({
    executionId: childExecutionId,
    rootExecutionId,
    parentExecutionId: rootExecutionId,
    executionKind: 'subagent',
    ownerKind: 'pipeline',
    ownerId: projectId,
    sessionId: null,
    toolUseId: `tool-${projectId}`,
    agentId: 'grok-subagent',
    agentName: 'Grok Subagent',
    model: 'grok-4.5',
    description: 'subagent run',
    runtime: 'grok',
    provider: 'grok',
    metadata: { depth: 1 },
  });
  finalizeTaskExecutionOnce(childExecutionId, {
    status: 'completed',
    summary: 'done',
    model: 'grok-4.5',
    runtime: 'grok',
    provider: 'grok',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd,
    apiRequests: 1,
    toolUses: 0,
    durationMs: 100,
    costStatus: 'known',
    tokenStatus: 'reported',
    costUnknownReason: null,
    metadata: { costEstimationKind: 'subscription-equivalent-payg' },
  });
}

beforeAll(() => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-pipeline-report-grok-'));
  initDatabase();
});

afterAll(() => {
  getDb().close();
  fs.rmSync(state.root, { recursive: true, force: true });
});

describe('pipeline report runtime breakdown for Grok', () => {
  it('rotula pipeline somente Grok como equivalente PAYG sem criar bucket Anthropic', () => {
    createProject('report-grok-only');
    addPhase('report-grok-only', 1, 'grok', 0.25);

    const metrics = getPipelineMetrics('report-grok-only');
    expect(metrics.costByRuntime).toEqual({ grok: 0.25 });
    expect(metrics.subscriptionEquivalentCost).toBeCloseTo(0.25);

    const report = generatePipelineReport('report-grok-only');
    expect(report).toContain('| Custo total | ~$0.2500 |');
    expect(report).toContain('| Grok Build (assinatura) | ~$0.2500 (est. PAYG) |');
    expect(report).not.toContain('| Cloud (Anthropic) |');
    expect(report).toContain('Custos de runtimes em assinatura (Grok Build (assinatura))');
  });

  it('separa Grok de Anthropic em pipeline misto', () => {
    createProject('report-grok-mixed');
    addPhase('report-grok-mixed', 1, 'cloud', 0.4);
    addPhase('report-grok-mixed', 2, 'grok', 0.2);

    const report = generatePipelineReport('report-grok-mixed');
    expect(report).toContain('| Custo total | $0.6000 (incl. ~$0.2000) |');
    expect(report).toContain('| Cloud (Anthropic) | $0.4000 |');
    expect(report).toContain('| Grok Build (assinatura) | ~$0.2000 (est. PAYG) |');
    expect(report).not.toContain('| Cloud (Anthropic) | $0.6000 |');
  });

  it('inclui custo de subagente Grok do ledger no bucket correto', () => {
    createProject('report-grok-subagent');
    addPhase('report-grok-subagent', 1, 'cloud', 0.4);
    addGrokSubagent('report-grok-subagent', 0.3);

    const metrics = getPipelineMetrics('report-grok-subagent');
    expect(metrics.costByRuntime).toEqual({ cloud: 0.4, grok: 0.3 });
    expect(metrics.totals.costUsd).toBeCloseTo(0.7);
    expect(metrics.subscriptionEquivalentCost).toBeCloseTo(0.3);

    const report = generatePipelineReport('report-grok-subagent');
    expect(report).toContain('| Custo total | $0.7000 (incl. ~$0.3000) |');
    expect(report).toContain('| Cloud (Anthropic) | $0.4000 |');
    expect(report).toContain('| Grok Build (assinatura) | ~$0.3000 (est. PAYG) |');
    expect(report).not.toContain('| Cloud (Anthropic) | $0.7000 |');
  });

  it('remove o wrapper sintetico do security sem criar Cloud/Anthropic zero', () => {
    createProject('report-grok-security', 'security');
    savePipelinePhaseMetrics({
      projectId: 'report-grok-security',
      phaseNumber: 2,
      phaseName: 'Security Audit',
      agentId: 'multi-agent',
      status: 'completed',
      runtime: 'cloud',
      durationMs: 500,
    });
    savePipelinePhaseMetrics({
      projectId: 'report-grok-security',
      phaseNumber: 2,
      phaseName: 'Security Audit',
      agentId: 'security-auth-auditor',
      status: 'completed',
      runtime: 'grok',
      model: 'grok-4.5',
      costUsd: 0.12,
      durationMs: 100,
      sprintIndex: 1,
      metadata: {
        auditAgent: true,
        provider: 'grok',
        costStatus: 'known',
        costEstimationKind: 'subscription-equivalent-payg',
      },
    });

    const metrics = getPipelineMetrics('report-grok-security');
    expect(metrics.costByRuntime).toEqual({ grok: 0.12 });
    expect(metrics.totals.durationMs).toBe(100);
    expect(metrics.phases.map((phase) => phase.agentId)).toEqual(['security-auth-auditor']);

    const report = generatePipelineReport('report-grok-security');
    expect(report).toContain('| Custo total | ~$0.1200 |');
    expect(report).not.toContain('Cloud (Anthropic)');
    expect(report).not.toContain('| multi-agent |');
  });

  it('mantem custo desconhecido honesto no resumo Markdown', () => {
    createProject('report-grok-unknown');
    savePipelinePhaseMetrics({
      projectId: 'report-grok-unknown',
      phaseNumber: 1,
      phaseName: 'Grok unknown',
      agentId: 'grok-agent',
      status: 'completed',
      runtime: 'grok',
      model: 'grok-4.5',
      metadata: {
        provider: 'grok',
        costStatus: 'unknown',
        tokenStatus: 'not_reported',
        costUnknownReason: 'no-usage-reported',
      },
      unknownCostCount: 1,
    });

    const metrics = getPipelineMetrics('report-grok-unknown');
    expect(metrics.costStatusByRuntime).toEqual({ grok: 'unknown' });

    const report = generatePipelineReport('report-grok-unknown');
    expect(report).toContain('| Custo total | nao estimado |');
    expect(report).toContain('| Grok Build (assinatura) | nao estimado |');
    expect(report).not.toContain('| Grok Build (assinatura) | ~$0.00');
  });

  it('nao converte round Grok unknown em $0 no Markdown', () => {
    createProject('report-grok-round-unknown');
    const sprint = insertHarnessSprint({
      projectId: 'report-grok-round-unknown',
      sprintIndex: 1,
      sprintJsonId: 'sprint-grok-unknown',
      name: 'Grok unknown round',
    });
    const round = insertHarnessRound({
      sprintId: sprint.id,
      roundNumber: 1,
      runtimeUsed: 'grok',
      providerUsed: 'grok',
      modelUsed: 'grok-4.5',
    });
    updateHarnessRound(round.id, {
      completedAt: new Date().toISOString(),
      unknownCostCount: 1,
      metadata: {
        coderCostStatus: 'unknown',
        coderCostUnknownReason: 'no-usage-reported',
        coderCostEstimationKind: 'subscription-equivalent-payg',
      },
    });

    const report = generatePipelineReport('report-grok-round-unknown');
    expect(report).toContain('| 1 | OK | 0 | 0 | 0 | nao estimado |');
    expect(report).not.toContain('| 1 | OK | 0 | 0 | 0 | $0.00 |');
  });

  it('mantem round Grok conhecido marcado como equivalente PAYG', () => {
    createProject('report-grok-round-known');
    const sprint = insertHarnessSprint({
      projectId: 'report-grok-round-known',
      sprintIndex: 1,
      sprintJsonId: 'sprint-grok-known',
      name: 'Grok known round',
    });
    const round = insertHarnessRound({
      sprintId: sprint.id,
      roundNumber: 1,
      runtimeUsed: 'grok',
      providerUsed: 'grok',
      modelUsed: 'grok-4.5',
    });
    updateHarnessRound(round.id, {
      coderCostUsd: 0.25,
      completedAt: new Date().toISOString(),
      metadata: {
        coderCostStatus: 'known',
        coderCostEstimationKind: 'subscription-equivalent-payg',
      },
    });

    expect(generatePipelineReport('report-grok-round-known')).toContain('| 1 | OK | 0 | 0 | 0 | ~$0.2500 |');
  });
});

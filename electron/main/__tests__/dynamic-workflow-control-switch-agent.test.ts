
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function manifestWithNode(): string {
  return JSON.stringify({
    version: 1,
    name: 'wf',
    phases: [],
    nodes: [
      {
        id: 'coder-s1',
        type: 'agent',
        phaseId: 'Implementar',
        agentId: 'a-coder',
        access: 'read-only',
        allowedTools: ['Read', 'Glob', 'Grep'],
        canResume: true,
        produces: [],
        consumes: [],
      },
    ],
    parallelism: { maxConcurrentAgents: 1, parallelWritersAllowed: false },
    gates: [],
    estimate: { minUsd: 0, maxUsd: 0, unknownCostNodes: [] },
  });
}

const runStatus = { value: 'running' };
const getDynamicWorkflowRunMock = vi.fn<(id: string) => unknown>(() => ({
  id: 'run-1',
  definitionId: 'def-1',
  status: runStatus.value,
  currentPhaseId: null,
  currentNodeId: 'coder-s1',
  totalCostUsd: 0,
}));
const getDynamicWorkflowDefinitionMock = vi.fn<(id: string) => unknown>(() => ({
  id: 'def-1',
  manifestJson: manifestWithNode(),
}));

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => [
    { id: 'a-coder', isActive: true },
    { id: 'a-especialista', isActive: true },
  ]),
  getActiveChatSession: vi.fn(() => ({ id: 'chat-1' })),
  getDynamicWorkflowRun: (id: string) => getDynamicWorkflowRunMock(id),
  listDynamicWorkflowRuns: vi.fn(() => []),
  getDynamicWorkflowDefinition: (id: string) => getDynamicWorkflowDefinitionMock(id),
  createDynamicWorkflowDefinition: vi.fn(),
  updateDynamicWorkflowDefinition: vi.fn(),
  createDynamicWorkflowRun: vi.fn(),
  createDynamicWorkflowNode: vi.fn(() => ({})),
}));

const switchAgentMock = vi.fn(async () => ({ ok: true }));
const interveneMock = vi.fn(async () => ({ ok: true }));
const getSnapshotMock = vi.fn<(id: string) => unknown>(() => ({
  runId: 'run-1',
  repoPath: '/tmp',
  status: 'running',
  currentNodeId: 'coder-s1',
  recentEvents: [],
  cost: { actualUsd: 0 },
}));
vi.mock('../dynamic-workflows/workflow-runner', () => ({
  getWorkflowRunner: () => ({
    switchAgent: (...args: unknown[]) => switchAgentMock(...(args as [])),
    intervene: interveneMock,
    getSnapshot: (id: string) => getSnapshotMock(id),
  }),
  recoverInterruptedRuns: vi.fn(() => ({ recovered: 0 })),
}));
vi.mock('../dynamic-workflows/workflow-runner-deps', () => ({
  createDefaultRunnerDeps: vi.fn(() => ({})),
}));
vi.mock('../dynamic-workflows/workflow-create', () => ({
  createWorkflow: vi.fn(async () => ({ ok: true, runId: 'run-1', definitionId: 'def-1' })),
}));

const resolveAgentQueryConfigMock = vi.fn(async () => ({
  allowedTools: ['Read', 'Glob', 'Grep'],
  mcpServers: [],
  runtime: 'cloud',
}));
vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: () => resolveAgentQueryConfigMock(),
}));

import {
  dynamicWorkflowInterveneCore,
  dynamicWorkflowSwitchAgentCore,
  _resetWorkflowControlStateForTesting,
} from '../dynamic-workflows/workflow-control-core';
import type { DynamicWorkflowIntervention } from '../dynamic-workflows/types';

beforeEach(() => {
  _resetWorkflowControlStateForTesting();
  switchAgentMock.mockClear();
  interveneMock.mockClear();
  resolveAgentQueryConfigMock.mockClear();
  runStatus.value = 'running';
});

describe('switch-agent via intervene (SM-21) chama runner.switchAgent COM s17Override', () => {
  it('troca equivalente: roteia para o core dedicado e completa (switched=true)', async () => {
    const intervention: DynamicWorkflowIntervention = {
      type: 'switch-agent',
      nodeId: 'coder-s1',
      newAgentId: 'a-especialista',
      reason: 'especialista de Electron pra essa sprint',
    };
    const res = await dynamicWorkflowInterveneCore('run-1', intervention);
    expect(res.ok).toBe(true);

    expect(interveneMock).not.toHaveBeenCalled();
    expect(switchAgentMock).toHaveBeenCalledTimes(1);
    const args = switchAgentMock.mock.calls[0] as unknown as [
      string,
      string,
      string,
      string,
      string,
      { validateSwitchAgent: () => unknown; persistSwitchedDefinition: unknown },
    ];
    expect(args[0]).toBe('run-1');
    expect(args[1]).toBe('coder-s1');
    expect(args[2]).toBe('a-especialista');
    expect(args[4]).toBe('orchestrator'); // source = orquestrador (Maestro)
    expect(typeof args[5].validateSwitchAgent).toBe('function');
    expect(args[5].persistSwitchedDefinition).toBeTruthy();
    const verdict = args[5].validateSwitchAgent() as {
      exists: boolean;
      preflightOk: boolean;
      expandsPermission: boolean;
    };
    expect(verdict).toMatchObject({ exists: true, preflightOk: true, expandsPermission: false });
  });

  it('node alvo inexistente no manifest e recusado (nunca por aproximacao)', async () => {
    const res = await dynamicWorkflowSwitchAgentCore('run-1', 'node-fantasma', 'a-especialista', 'x');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/nao existe no manifest/);
    expect(switchAgentMock).not.toHaveBeenCalled();
  });

  it('reason ausente e recusado (trilha auditavel)', async () => {
    const res = await dynamicWorkflowSwitchAgentCore('run-1', 'coder-s1', 'a-especialista', '   ');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/reason obrigatorio/);
    expect(switchAgentMock).not.toHaveBeenCalled();
  });

  it('run terminal recusa mas instrui a retomar (REGRA MAXIMA: recuperavel)', async () => {
    runStatus.value = 'aborted';
    const res = await dynamicWorkflowSwitchAgentCore('run-1', 'coder-s1', 'a-especialista', 'x');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/encerrado/);
      expect(res.error).toMatch(/[Rr]etome|resume/);
    }
    expect(switchAgentMock).not.toHaveBeenCalled();
  });

  it('propaga a recusa do runner (ex: ampliacao de permissao -> gate humano)', async () => {
    switchAgentMock.mockResolvedValueOnce({
      ok: false,
      error: 'troca para a-especialista amplia permissao efetiva: requer aprovacao humana (gate)',
    } as never);
    const res = await dynamicWorkflowSwitchAgentCore('run-1', 'coder-s1', 'a-especialista', 'x');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/amplia permissao efetiva/);
  });
});

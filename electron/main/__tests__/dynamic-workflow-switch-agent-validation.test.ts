
import { describe, it, expect, vi } from 'vitest';
import type {
  DynamicWorkflowDefinition,
  DynamicWorkflowManifestNode,
  DynamicWorkflowDefinitionCreateInput,
} from '../dynamic-workflows/types';
import type { SwitchAgentResolvedAgent } from '../dynamic-workflows/switch-agent-validation';
import {
  resolveSwitchAgentVerdict,
  makePersistSwitchedDefinition,
} from '../dynamic-workflows/switch-agent-validation';

function node(over: Partial<DynamicWorkflowManifestNode> = {}): DynamicWorkflowManifestNode {
  return {
    id: 'coder-s1',
    type: 'agent',
    phaseId: 'Implementar',
    agentId: 'a-coder',
    access: 'read-only',
    allowedTools: ['Read', 'Glob', 'Grep'],
    canResume: true,
    produces: [],
    consumes: [],
    ...over,
  } as DynamicWorkflowManifestNode;
}

function agent(over: Partial<SwitchAgentResolvedAgent> = {}): SwitchAgentResolvedAgent {
  return {
    allowedTools: ['Read', 'Glob', 'Grep'],
    mcpServers: [],
    runtime: 'cloud',
    ...over,
  };
}

describe('resolveSwitchAgentVerdict', () => {
  it('recusa quando o agente novo nao esta no catalogo (exists=false)', async () => {
    const verdict = await resolveSwitchAgentVerdict(node(), 'a-novo', {
      resolveAgent: async () => agent(),
      loadActiveAgentIds: () => ['a-coder', 'a-outro'],
    });
    expect(verdict.exists).toBe(false);
    expect(verdict.preflightOk).toBe(false);
    expect(verdict.reason).toMatch(/nao existe no catalogo/);
  });

  it('DENYLIST: recusa dynamic-workflow-builder na hora da intervencao, mesmo com a row orfa "ativa"', async () => {
    const resolveAgent = vi.fn(async () => agent());
    const verdict = await resolveSwitchAgentVerdict(node(), 'dynamic-workflow-builder', {
      resolveAgent,
      loadActiveAgentIds: () => ['dynamic-workflow-builder'],
    });
    expect(verdict.exists).toBe(false);
    expect(verdict.preflightOk).toBe(false);
    expect(verdict.expandsPermission).toBe(false);
    expect(verdict.reason).toMatch(/denylist/);
    expect(verdict.reason).toMatch(/dynamic-workflow-builder/);
    expect(resolveAgent).not.toHaveBeenCalled();
  });

  it('troca equivalente (mesmas tools/runtime): existe, preflight ok, NAO amplia', async () => {
    const resolveAgent = vi.fn(async () => agent({ allowedTools: ['Read', 'Glob', 'Grep'] }));
    const verdict = await resolveSwitchAgentVerdict(node(), 'a-equivalente', {
      resolveAgent,
      loadActiveAgentIds: () => ['a-equivalente'],
    });
    expect(verdict.exists).toBe(true);
    expect(verdict.preflightOk).toBe(true);
    expect(verdict.expandsPermission).toBe(false);
    expect(resolveAgent).toHaveBeenCalledTimes(2);
  });

  it('amplia permissao efetiva quando o agente novo tras tools alem das do node', async () => {
    const n = node({ access: 'workspace-write', allowedTools: ['Read', 'Write', 'Bash'], writeSet: ['src/**'] });
    const verdict = await resolveSwitchAgentVerdict(n, 'a-amplia', {
      resolveAgent: async (id) =>
        id === 'a-amplia'
          ? agent({ allowedTools: ['Read', 'Write', 'Bash'] })
          : agent({ allowedTools: ['Read'] }),
      loadActiveAgentIds: () => ['a-amplia'],
    });
    expect(verdict.exists).toBe(true);
    expect(verdict.expandsPermission).toBe(true);
  });

  it('NUNCA lanca: erro ao resolver o agente vira preflightOk=false com motivo real', async () => {
    const verdict = await resolveSwitchAgentVerdict(node(), 'a-explode', {
      resolveAgent: async () => {
        throw new Error('resolver caiu');
      },
      loadActiveAgentIds: () => ['a-explode'],
    });
    expect(verdict.exists).toBe(true);
    expect(verdict.preflightOk).toBe(false);
    expect(verdict.reason).toMatch(/resolver caiu/);
  });
});

describe('makePersistSwitchedDefinition (cadeia 22.7)', () => {
  function prevDef(): DynamicWorkflowDefinition {
    return {
      id: 'def-1',
      name: 'wf',
      definitionVersion: 1,
      authoringModel: 'manifest',
      parentDefinitionId: null,
      supersedesDefinitionId: null,
      sourceType: 'builder',
      projectPath: '/proj',
      specPath: null,
      specSha256: null,
      workflowJsPath: '/proj/.lionclaw/workflows/run-1/workflow.js',
      manifestPath: '/proj/.lionclaw/workflows/run-1/workflow.manifest.json',
      manifestJson: JSON.stringify({
        version: 1,
        name: 'wf',
        phases: [],
        nodes: [
          { id: 'coder-s1', type: 'agent', phaseId: 'P', agentId: 'a-coder', access: 'read-only', canResume: true, produces: [], consumes: [] },
          { id: 'coder-s2', type: 'agent', phaseId: 'P', agentId: 'a-other', access: 'read-only', canResume: true, produces: [], consumes: [] },
        ],
        parallelism: { maxConcurrentAgents: 1, parallelWritersAllowed: false },
        gates: [],
        estimate: { minUsd: 0, maxUsd: 0, unknownCostNodes: [] },
      }),
      manifestHash: 'mh',
      contextBundlePath: null,
      builderModel: null,
      status: 'validated',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
  }

  it('cria nova versao com o agentId do node trocado + linkagem parent/supersedes', () => {
    const created: DynamicWorkflowDefinitionCreateInput[] = [];
    const updated: Array<{ id: string; patch: { supersedesDefinitionId: string } }> = [];
    const persist = makePersistSwitchedDefinition({
      createDefinition: (input) => {
        created.push(input);
        return input;
      },
      updateDefinition: (id, patch) => {
        updated.push({ id, patch });
        return undefined;
      },
      generateDefinitionId: () => 'def-2',
    });

    const res = persist({ prevDefinition: prevDef(), nodeId: 'coder-s1', newAgentId: 'a-especialista' });
    expect(res).toEqual({ newDefinitionId: 'def-2' });

    expect(created).toHaveLength(1);
    const newDef = created[0]!;
    expect(newDef.id).toBe('def-2');
    expect(newDef.definitionVersion).toBe(2);
    expect(newDef.parentDefinitionId).toBe('def-1');
    expect(newDef.supersedesDefinitionId).toBeNull();
    const newManifest = JSON.parse(newDef.manifestJson) as { nodes: Array<{ id: string; agentId: string }> };
    expect(newManifest.nodes.find((n) => n.id === 'coder-s1')?.agentId).toBe('a-especialista');
    expect(newManifest.nodes.find((n) => n.id === 'coder-s2')?.agentId).toBe('a-other');

    expect(updated).toEqual([{ id: 'def-1', patch: { supersedesDefinitionId: 'def-2' } }]);
  });
});


import type {
  DynamicWorkflowDefinition,
  DynamicWorkflowDefinitionCreateInput,
  DynamicWorkflowManifest,
  DynamicWorkflowManifestNode,
} from './types';
import { DYNAMIC_WORKFLOW_AGENT_DENYLIST } from './types';
import { AGENT_DENYLIST_REASON } from './authored-agent-validation';
import type { SwitchAgentValidation } from './workflow-runner';
import {
  preflightNode,
  type WorkflowNodeRuntime,
} from './workflow-preflight';
import {
  deriveNodeExecutionPolicy,
  type NodePolicyGrants,
  type PolicyEnforcementMechanism,
  type ResolvedAgentPolicyConfig,
} from './workflow-policy';

export type SwitchAgentResolvedAgent = ResolvedAgentPolicyConfig;

export type PersistSwitchedDefinition = (input: {
  prevDefinition: DynamicWorkflowDefinition;
  nodeId: string;
  newAgentId: string;
}) => { newDefinitionId: string };

export interface SwitchAgentPersistCrud {
  createDefinition: (input: DynamicWorkflowDefinitionCreateInput) => unknown;
  updateDefinition: (id: string, patch: { supersedesDefinitionId: string }) => unknown;
  generateDefinitionId?: () => string;
}

export interface SwitchAgentValidationDeps {
  resolveAgent: (agentId: string) => Promise<SwitchAgentResolvedAgent>;
  loadActiveAgentIds: () => string[];
}

export function runtimeMechanism(runtime: string): PolicyEnforcementMechanism {
  if (runtime === 'codex' || runtime === 'kimi') return 'codex-sandbox';
  if (runtime === 'grok') return 'grok-cli-sandbox';
  if (runtime === 'cloud' || runtime === 'zai' || runtime === 'minimax-tp') {
    return 'canUseTool';
  }
  if (runtime === 'local' || runtime === 'external' || runtime === 'google-genai') {
    return 'motor-dispatcher';
  }
  throw new Error(`runtime sem mecanismo de enforcement: ${runtime}`);
}

export function grantsFromManifestNode(
  node: DynamicWorkflowManifestNode,
  agentId: string,
): NodePolicyGrants {
  return {
    nodeId: node.id,
    agentId,
    access: node.access,
    allowedTools: node.allowedTools,
    allowedMcpServers: node.allowedMcpServers,
    allowedMcpTools: node.allowedMcpTools,
    allowedCommands: node.allowedCommands,
    allowBash: node.allowBash,
    allowNetwork: node.allowNetwork,
    timeoutMs: node.timeoutMs,
    costCeilingUsd: node.costCeilingUsd,
  };
}

export async function switchAgentExpandsPermission(
  node: DynamicWorkflowManifestNode,
  currentAgentId: string,
  newAgentId: string,
  resolveAgent: SwitchAgentValidationDeps['resolveAgent'],
): Promise<{ expands: boolean; newRuntime: string }> {
  const [cur, next] = await Promise.all([
    resolveAgent(currentAgentId),
    resolveAgent(newAgentId),
  ]);
  const workspace = { runId: 'preflight', workspaceRoot: '/preflight', cwd: '/preflight' };
  const curPolicy = deriveNodeExecutionPolicy(
    cur,
    grantsFromManifestNode(node, currentAgentId),
    workspace,
    runtimeMechanism(cur.runtime),
  );
  const nextPolicy = deriveNodeExecutionPolicy(
    next,
    grantsFromManifestNode(node, newAgentId),
    workspace,
    runtimeMechanism(next.runtime),
  );

  const curTools = new Set(curPolicy.effectiveTools);
  const curMcp = new Set(curPolicy.effectiveMcpServers);
  const toolsExpand = nextPolicy.effectiveTools.some((t) => !curTools.has(t));
  const mcpExpand = nextPolicy.effectiveMcpServers.some((m) => !curMcp.has(m));
  const bashExpand = nextPolicy.allowBash && !curPolicy.allowBash;
  const netExpand = nextPolicy.allowNetwork && !curPolicy.allowNetwork;
  const writeExpand =
    nextPolicy.access === 'workspace-write' && curPolicy.access !== 'workspace-write';

  return {
    expands: toolsExpand || mcpExpand || bashExpand || netExpand || writeExpand,
    newRuntime: next.runtime,
  };
}

export async function resolveSwitchAgentVerdict(
  node: DynamicWorkflowManifestNode,
  newAgentId: string,
  deps: SwitchAgentValidationDeps,
): Promise<SwitchAgentValidation> {
  if ((DYNAMIC_WORKFLOW_AGENT_DENYLIST as readonly string[]).includes(newAgentId)) {
    return {
      exists: false,
      preflightOk: false,
      expandsPermission: false,
      reason:
        `agente ${newAgentId} esta na denylist de dynamic workflows e nao pode ser alvo de switch-agent: ` +
        AGENT_DENYLIST_REASON,
    };
  }

  const exists = deps.loadActiveAgentIds().includes(newAgentId);
  if (!exists) {
    return {
      exists: false,
      preflightOk: false,
      expandsPermission: false,
      reason: `agente ${newAgentId} nao existe no catalogo (ou esta inativo)`,
    };
  }

  try {
    const { expands, newRuntime } = await switchAgentExpandsPermission(
      node,
      node.agentId ?? '',
      newAgentId,
      deps.resolveAgent,
    );
    const pf = preflightNode({
      grants: grantsFromManifestNode(node, newAgentId),
      runtime: newRuntime as WorkflowNodeRuntime,
      grantsUserQuestion: (node.allowedMcpServers ?? []).includes('lionclaw-user-question'),
      role: 'node',
    });
    return {
      exists: true,
      preflightOk: pf.ok,
      expandsPermission: expands,
      ...(pf.ok ? {} : { reason: pf.message }),
    };
  } catch (err) {
    return {
      exists: true,
      preflightOk: false,
      expandsPermission: false,
      reason: `falha ao resolver/validar o agente novo: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function makePersistSwitchedDefinition(
  crud: SwitchAgentPersistCrud,
): PersistSwitchedDefinition {
  const genId =
    crud.generateDefinitionId ??
    (() => `dwfd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
  return ({ prevDefinition, nodeId, newAgentId }) => {
    let manifest: DynamicWorkflowManifest;
    try {
      manifest = JSON.parse(prevDefinition.manifestJson) as DynamicWorkflowManifest;
    } catch {
      manifest = JSON.parse(prevDefinition.manifestJson || '{}') as DynamicWorkflowManifest;
    }
    const nextManifest: DynamicWorkflowManifest = {
      ...manifest,
      nodes: (manifest.nodes ?? []).map((n) =>
        n.id === nodeId ? { ...n, agentId: newAgentId } : n,
      ),
    };

    const newDefinitionId = genId();
    const newDefInput: DynamicWorkflowDefinitionCreateInput = {
      id: newDefinitionId,
      name: prevDefinition.name,
      definitionVersion: prevDefinition.definitionVersion + 1,
      parentDefinitionId: prevDefinition.id,
      supersedesDefinitionId: null,
      sourceType: prevDefinition.sourceType,
      projectPath: prevDefinition.projectPath,
      specPath: prevDefinition.specPath,
      specSha256: prevDefinition.specSha256,
      workflowJsPath: prevDefinition.workflowJsPath,
      manifestPath: prevDefinition.manifestPath,
      manifestJson: JSON.stringify(nextManifest),
      manifestHash: prevDefinition.manifestHash,
      contextBundlePath: prevDefinition.contextBundlePath,
      builderModel: prevDefinition.builderModel,
      status: prevDefinition.status,
    };
    crud.createDefinition(newDefInput);
    crud.updateDefinition(prevDefinition.id, { supersedesDefinitionId: newDefinitionId });
    return { newDefinitionId };
  };
}

export type { SwitchAgentValidation };
export type { NodePolicyGrants, PolicyEnforcementMechanism };

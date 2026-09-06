
import { createHash } from 'crypto';
import type {
  DynamicWorkflowNodeAccess,
  WorkflowNodeExecutionPolicy,
} from '../../../src/types/dynamic-workflow';

export interface ResolvedAgentPolicyConfig {
  allowedTools: string[];
  mcpServers: Array<Record<string, unknown>>;
  runtime: string;
}

export interface NodePolicyGrants {
  nodeId: string;
  agentId?: string;
  access?: DynamicWorkflowNodeAccess;
  allowedTools?: string[];
  allowedMcpServers?: string[];
  allowedMcpTools?: string[];
  allowedCommands?: string[];
  allowBash?: boolean;
  allowNetwork?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  costCeilingUsd?: number;
}

export interface PolicyWorkspace {
  runId: string;
  workspaceRoot: string;
  cwd: string;
}

export type PolicyEnforcementMechanism =
  | 'canUseTool'
  | 'codex-sandbox'
  | 'grok-cli-sandbox'
  | 'motor-dispatcher';

export const WORKFLOW_POLICY_DEFAULTS = {
  timeoutMs: 30 * 60 * 1000,
  idleTimeoutMs: 15 * 60 * 1000,
  costCeilingUsd: 0,
} as const;

const SIDE_ROUTE_EXACT = new Set<string>(['Task', 'Agent']);
const SIDE_ROUTE_PREFIXES: readonly string[] = [
  'mcp__lionclaw-agents__',
  'dynamic_workflow_',
  'pipeline_',
];

export const GUARD_GATED_TOOL_NAMES: readonly string[] = ['Bash', 'Write', 'Edit'];

export function isSideRouteTool(toolName: string): boolean {
  if (SIDE_ROUTE_EXACT.has(toolName)) return true;
  return SIDE_ROUTE_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function extractMcpServerIds(
  entries: Array<Record<string, unknown>>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const key of Object.keys(entry)) {
      if (!seen.has(key)) {
        seen.add(key);
        ids.push(key);
      }
    }
  }
  return ids;
}

function orderedIntersection(a: string[], b: string[]): string[] {
  const allow = new Set(b);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of a) {
    if (allow.has(item) && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function computePolicyHash(input: {
  nodeId: string;
  agentId?: string;
  access: DynamicWorkflowNodeAccess;
  effectiveTools: string[];
  effectiveMcpServers: string[];
  allowedMcpTools: string[];
  allowedCommands: string[];
  allowBash: boolean;
  allowNetwork: boolean;
  mechanism: PolicyEnforcementMechanism;
  workspaceRoot: string;
}): string {
  const canonical = {
    nodeId: input.nodeId,
    agentId: input.agentId ?? null,
    access: input.access,
    effectiveTools: [...input.effectiveTools].sort(),
    effectiveMcpServers: [...input.effectiveMcpServers].sort(),
    allowedMcpTools: [...input.allowedMcpTools].sort(),
    allowedCommands: [...input.allowedCommands].sort(),
    allowBash: input.allowBash,
    allowNetwork: input.allowNetwork,
    mechanism: input.mechanism,
    workspaceRoot: input.workspaceRoot,
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

export function deriveNodeExecutionPolicy(
  resolved: ResolvedAgentPolicyConfig,
  grants: NodePolicyGrants,
  workspace: PolicyWorkspace,
  mechanism: PolicyEnforcementMechanism,
): WorkflowNodeExecutionPolicy {
  const access: DynamicWorkflowNodeAccess = grants.access ?? 'read-only';

  const resolvedTools = resolved.allowedTools.filter((t) => !isSideRouteTool(t));
  const nodeAllowedTools = (grants.allowedTools ?? []).filter(
    (t) => !isSideRouteTool(t),
  );

  const intersectedTools = orderedIntersection(resolvedTools, nodeAllowedTools);

  const effectiveTools = intersectedTools;

  const resolvedMcpIds = extractMcpServerIds(resolved.mcpServers).filter(
    (id) => !isSideRouteTool(`mcp__${id}__x`),
  );
  const nodeMcpServers = grants.allowedMcpServers ?? [];
  const effectiveMcpServers = orderedIntersection(
    resolvedMcpIds,
    nodeMcpServers,
  );

  const rawMcpTools = grants.allowedMcpTools ?? [];
  const allowedMcpTools = rawMcpTools.filter((toolName) => {
    if (isSideRouteTool(toolName)) return false;
    const match = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(toolName);
    if (!match) return false;
    return effectiveMcpServers.includes(match[1]);
  });

  const wantsBash = grants.allowBash === true && access === 'workspace-write';
  const allowBash = wantsBash && mechanism === 'canUseTool';

  const allowedCommands = allowBash ? grants.allowedCommands ?? [] : [];

  const allowNetwork = grants.allowNetwork === true;

  const guardGatedDenied = GUARD_GATED_TOOL_NAMES.filter((tool) => {
    if (access === 'read-only') return true; // read-only nega todas as guard-gated.
    if (tool === 'Bash') return !allowBash;
    return false;
  });
  const deniedTools = [...guardGatedDenied, 'Task', 'Agent'];

  const policyHash = computePolicyHash({
    nodeId: grants.nodeId,
    agentId: grants.agentId,
    access,
    effectiveTools,
    effectiveMcpServers,
    allowedMcpTools,
    allowedCommands,
    allowBash,
    allowNetwork,
    mechanism,
    workspaceRoot: workspace.workspaceRoot,
  });

  return {
    runId: workspace.runId,
    nodeId: grants.nodeId,
    agentId: grants.agentId,
    workspaceRoot: workspace.workspaceRoot,
    cwd: workspace.cwd,
    access,
    allowedTools: nodeAllowedTools,
    deniedTools,
    allowedMcpServers: nodeMcpServers,
    allowedMcpTools,
    allowedCommands,
    effectiveTools,
    effectiveMcpServers,
    policyHash,
    allowBash,
    allowNetwork,
    timeoutMs: grants.timeoutMs ?? WORKFLOW_POLICY_DEFAULTS.timeoutMs,
    idleTimeoutMs: grants.idleTimeoutMs ?? WORKFLOW_POLICY_DEFAULTS.idleTimeoutMs,
    costCeilingUsd: grants.costCeilingUsd ?? WORKFLOW_POLICY_DEFAULTS.costCeilingUsd,
  };
}

export function computeNodeGrantsHash(grants: NodePolicyGrants): string {
  const canonical = {
    nodeId: grants.nodeId,
    agentId: grants.agentId ?? null,
    access: grants.access ?? 'read-only',
    allowedTools: [...(grants.allowedTools ?? [])].sort(),
    allowedMcpServers: [...(grants.allowedMcpServers ?? [])].sort(),
    allowedMcpTools: [...(grants.allowedMcpTools ?? [])].sort(),
    allowedCommands: [...(grants.allowedCommands ?? [])].sort(),
    allowBash: grants.allowBash === true,
    allowNetwork: grants.allowNetwork === true,
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}


import type {
  DynamicWorkflowNodeAccess,
  DynamicWorkflowWorkspaceMode,
} from '../../../src/types/dynamic-workflow';
import type {
  NodePolicyGrants,
  PolicyEnforcementMechanism,
} from './workflow-policy';

export type WorkflowNodeRuntime =
  | 'cloud'
  | 'zai'
  | 'minimax-tp'
  | 'codex'
  | 'kimi'
  | 'grok'
  | 'cursor'
  | 'local'
  | 'external'
  | 'google-genai';

export type RuntimeFamily =
  | 'claude-compatible'
  | 'codex'
  | 'grok'
  | 'cursor'
  | 'local-family';

export interface RuntimeCapabilities {
  family: RuntimeFamily;
  canUseTool: boolean;
  sandboxPerNode: boolean;
  mcp: boolean;
  bashAllowlist: boolean;
  writeSetPreventive: boolean;
  abortPerNode: boolean;
  readOnlyEnforceable: boolean;
  mechanism: PolicyEnforcementMechanism;
}

export const RUNTIME_CAPABILITIES: Record<
  WorkflowNodeRuntime,
  RuntimeCapabilities
> = {
  cloud: {
    family: 'claude-compatible',
    canUseTool: true,
    sandboxPerNode: false,
    mcp: true,
    bashAllowlist: true,
    writeSetPreventive: true,
    abortPerNode: true,
    readOnlyEnforceable: true,
    mechanism: 'canUseTool',
  },
  zai: {
    family: 'claude-compatible',
    canUseTool: true,
    sandboxPerNode: false,
    mcp: true,
    bashAllowlist: true,
    writeSetPreventive: true,
    abortPerNode: true,
    readOnlyEnforceable: true,
    mechanism: 'canUseTool',
  },
  'minimax-tp': {
    family: 'claude-compatible',
    canUseTool: true,
    sandboxPerNode: false,
    mcp: true,
    bashAllowlist: true,
    writeSetPreventive: true,
    abortPerNode: true,
    readOnlyEnforceable: true,
    mechanism: 'canUseTool',
  },
  codex: {
    family: 'codex',
    canUseTool: false,
    sandboxPerNode: true,
    mcp: false,
    bashAllowlist: false,
    writeSetPreventive: false,
    abortPerNode: true,
    readOnlyEnforceable: true,
    mechanism: 'codex-sandbox',
  },
  kimi: {
    family: 'codex',
    canUseTool: false,
    sandboxPerNode: false,
    mcp: false,
    bashAllowlist: false,
    writeSetPreventive: false,
    abortPerNode: true,
    readOnlyEnforceable: false,
    mechanism: 'codex-sandbox',
  },
  grok: {
    family: 'grok',
    canUseTool: true,
    sandboxPerNode: false,
    mcp: true,
    bashAllowlist: true,
    writeSetPreventive: true,
    abortPerNode: true,
    readOnlyEnforceable: true,
    mechanism: 'grok-cli-sandbox',
  },
  cursor: {
    family: 'cursor',
    canUseTool: true,
    sandboxPerNode: false,
    mcp: false,
    bashAllowlist: true,
    writeSetPreventive: true,
    abortPerNode: true,
    readOnlyEnforceable: true,
    mechanism: 'canUseTool',
  },
  local: {
    family: 'local-family',
    canUseTool: false,
    sandboxPerNode: false,
    mcp: false,
    bashAllowlist: false,
    writeSetPreventive: true,
    abortPerNode: false,
    readOnlyEnforceable: true,
    mechanism: 'motor-dispatcher',
  },
  external: {
    family: 'local-family',
    canUseTool: false,
    sandboxPerNode: false,
    mcp: false,
    bashAllowlist: false,
    writeSetPreventive: true,
    abortPerNode: false,
    readOnlyEnforceable: true,
    mechanism: 'motor-dispatcher',
  },
  'google-genai': {
    family: 'local-family',
    canUseTool: false,
    sandboxPerNode: false,
    mcp: false,
    bashAllowlist: false,
    writeSetPreventive: true,
    abortPerNode: true,
    readOnlyEnforceable: true,
    mechanism: 'motor-dispatcher',
  },
};

export const GUARD_CAPABLE_RUNTIMES: readonly WorkflowNodeRuntime[] = [
  'cloud',
  'zai',
  'minimax-tp',
  'grok',
];

export function isGuardCapableRuntime(runtime: string): boolean {
  return (GUARD_CAPABLE_RUNTIMES as readonly string[]).includes(runtime);
}

export interface PreflightOk {
  ok: true;
  runtime: WorkflowNodeRuntime;
  mechanism: PolicyEnforcementMechanism;
  warnings: string[];
}

export interface PreflightBlock {
  ok: false;
  nodeId: string;
  agentId?: string;
  runtime: string;
  guarantee: string;
  message: string;
  suggestion: string;
}

export type PreflightResult = PreflightOk | PreflightBlock;

export interface PreflightNodeInput {
  grants: NodePolicyGrants;
  runtime: string;
  grantsUserQuestion?: boolean;
  role?: 'node' | 'closer';
}

function normalizeRuntime(runtime: string): WorkflowNodeRuntime | null {
  return runtime in RUNTIME_CAPABILITIES
    ? (runtime as WorkflowNodeRuntime)
    : null;
}

function suggestGuardCapable(): string {
  return `use um agente com runtime guard-capable (${GUARD_CAPABLE_RUNTIMES.join('/')})`;
}

export function preflightNode(input: PreflightNodeInput): PreflightResult {
  const { grants, role = 'node' } = input;
  const runtime = normalizeRuntime(input.runtime);

  if (!runtime) {
    return {
      ok: false,
      nodeId: grants.nodeId,
      agentId: grants.agentId,
      runtime: input.runtime,
      guarantee: 'runtime-suportado',
      message: `agent ${grants.agentId ?? '?'} runtime ${input.runtime} nao e um runtime de node valido para o node ${grants.nodeId}`,
      suggestion: `use um runtime suportado (${Object.keys(RUNTIME_CAPABILITIES).join('/')})`,
    };
  }

  const caps = RUNTIME_CAPABILITIES[runtime];
  const warnings: string[] = [];
  const access: DynamicWorkflowNodeAccess = grants.access ?? 'read-only';

  if (role === 'closer' && !isGuardCapableRuntime(runtime) && !caps.sandboxPerNode) {
    return {
      ok: false,
      nodeId: grants.nodeId,
      agentId: grants.agentId,
      runtime,
      guarantee: 'closer-guard',
      message: `agent ${grants.agentId ?? '?'} runtime ${runtime} nao suporta o guard proprio do closer nem sandbox por-node para o node ${grants.nodeId}`,
      suggestion: suggestGuardCapable(),
    };
  }

  if (!caps.readOnlyEnforceable) {
    return {
      ok: false,
      nodeId: grants.nodeId,
      agentId: grants.agentId,
      runtime,
      guarantee: 'read-only',
      message: `agent ${grants.agentId ?? '?'} runtime ${runtime} nao suporta read-only real para o node ${grants.nodeId}`,
      suggestion: 'use cloud/zai/minimax-tp (guard) ou codex (sandbox)',
    };
  }

  if (access === 'workspace-write' && !caps.writeSetPreventive && !caps.sandboxPerNode) {
    return {
      ok: false,
      nodeId: grants.nodeId,
      agentId: grants.agentId,
      runtime,
      guarantee: 'workspace-write',
      message: `agent ${grants.agentId ?? '?'} runtime ${runtime} nao suporta workspace-write contido para o node ${grants.nodeId}`,
      suggestion: 'use um runtime com writeSet preventivo (cloud/zai/minimax-tp) ou sandbox (codex)',
    };
  }

  if (grants.allowBash === true && !caps.bashAllowlist && !caps.sandboxPerNode) {
    return {
      ok: false,
      nodeId: grants.nodeId,
      agentId: grants.agentId,
      runtime,
      guarantee: 'bash-allowlist',
      message: `agent ${grants.agentId ?? '?'} runtime ${runtime} nao contem Bash (sem allowlist allowedCommands nem sandbox por node) para o node ${grants.nodeId}`,
      suggestion: 'use cloud/zai/minimax-tp (allowlist) ou codex (sandbox), ou remova allowBash do node',
    };
  }

  if (input.grantsUserQuestion && !caps.mcp) {
    return {
      ok: false,
      nodeId: grants.nodeId,
      agentId: grants.agentId,
      runtime,
      guarantee: 'user-question-mcp',
      message: `agent ${grants.agentId ?? '?'} runtime ${runtime} nao tem canal MCP para lionclaw-user-question no node ${grants.nodeId}`,
      suggestion: 'conceda perguntas de agente apenas a nodes cloud/zai/minimax-tp, ou remova o grant',
    };
  }

  if ((grants.allowedMcpServers?.length ?? 0) > 0 && !caps.mcp) {
    warnings.push(
      `runtime ${runtime} nao recebe MCP do Lion; allowedMcpServers do node ${grants.nodeId} sera ignorado`,
    );
  }

  if (!caps.abortPerNode) {
    warnings.push(
      `runtime ${runtime} nao cancela request em voo; timeout do node ${grants.nodeId} apenas para de esperar (request pode continuar)`,
    );
  }

  return { ok: true, runtime, mechanism: caps.mechanism, warnings };
}


export type ProjectGitState =
  | 'git-with-commits' // repo existente com codigo
  | 'git-unborn' // git init feito mas HEAD sem nenhum commit
  | 'empty-dir' // pasta vazia, sem git
  | 'code-no-git'; // pasta com codigo mas sem git

export type ProjectGitProbe = (projectPath: string) => ProjectGitState;

export interface WorkspaceModeDecision {
  mode: DynamicWorkflowWorkspaceMode;
  requiresGitInit: boolean;
  requiresBaselineCommit: boolean;
  hasMergeGate: boolean;
  state: ProjectGitState;
  rationale: string;
}

export function decideWorkspaceMode(
  projectPath: string,
  probe: ProjectGitProbe,
): WorkspaceModeDecision {
  const state = probe(projectPath);
  switch (state) {
    case 'git-with-commits':
      return {
        mode: 'run-worktree',
        requiresGitInit: false,
        requiresBaselineCommit: false,
        hasMergeGate: true,
        state,
        rationale:
          'repo existente com commits: checkout do usuario fica intocado; worktree + merge pos-gate (8.6.2)',
      };
    case 'git-unborn':
      return {
        mode: 'fresh-project',
        requiresGitInit: false,
        requiresBaselineCommit: false,
        hasMergeGate: false,
        state,
        rationale:
          'git sem commits (HEAD unborn): nada a proteger nem base pra divergir; run desenvolve direto na branch principal',
      };
    case 'empty-dir':
      return {
        mode: 'fresh-project',
        requiresGitInit: true,
        requiresBaselineCommit: false,
        hasMergeGate: false,
        state,
        rationale:
          'pasta vazia: host faz git init e o run desenvolve direto; sem worktree, sem merge gate',
      };
    case 'code-no-git':
      return {
        mode: 'run-worktree',
        requiresGitInit: true,
        requiresBaselineCommit: true,
        hasMergeGate: true,
        state,
        rationale:
          'codigo sem git: host faz git init + commit baseline e segue como repo existente (protecao de graca)',
      };
  }
}

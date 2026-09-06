
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  deriveNodeExecutionPolicy,
  computeNodeGrantsHash,
  isSideRouteTool,
  GUARD_GATED_TOOL_NAMES,
  type ResolvedAgentPolicyConfig,
  type NodePolicyGrants,
  type PolicyWorkspace,
} from '../dynamic-workflows/workflow-policy';
import { createComposedCanUseTool } from '../dynamic-workflows/workflow-agent-adapter';
import { WorkflowPathGuard } from '../dynamic-workflows/workflow-path-guard';

const WS: PolicyWorkspace = {
  runId: 'run-1',
  workspaceRoot: '/tmp/run-1/worktree',
  cwd: '/tmp/run-1/worktree',
};

function resolved(
  over: Partial<ResolvedAgentPolicyConfig> = {},
): ResolvedAgentPolicyConfig {
  return {
    allowedTools: ['Read', 'Grep', 'Glob'],
    mcpServers: [],
    runtime: 'cloud',
    ...over,
  };
}

function grants(over: Partial<NodePolicyGrants> = {}): NodePolicyGrants {
  return {
    nodeId: 'scout',
    agentId: 'dynamic-workflow-scout',
    access: 'read-only',
    ...over,
  };
}

describe('deriveNodeExecutionPolicy - intersecao de tools (8.3)', () => {
  it('effectiveTools = intersecao(config resolvida, node.allowedTools)', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved({ allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch'] }),
      grants({ allowedTools: ['Read', 'Grep'] }),
      WS,
      'canUseTool',
    );
    expect(policy.effectiveTools).toEqual(['Read', 'Grep']);
  });

  it('tool no node mas ausente da config resolvida NAO entra (intersecao real)', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved({ allowedTools: ['Read'] }),
      grants({ allowedTools: ['Read', 'Grep', 'Glob'] }),
      WS,
      'canUseTool',
    );
    expect(policy.effectiveTools).toEqual(['Read']);
  });
});

describe('deriveNodeExecutionPolicy - MCP pos-resolucao (8.3, risco 16/17)', () => {
  it('MCP auto-injetado (knowledge-base/skills) NAO vaza com allowedMcpServers []', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved({
        mcpServers: [
          { 'knowledge-base': { command: 'node', args: [] } },
          { skills: { command: 'node', args: [] } },
          { 'repo-graph': { command: 'node', args: [] } },
        ],
      }),
      grants({ allowedMcpServers: [] }),
      WS,
      'canUseTool',
    );
    expect(policy.effectiveMcpServers).toEqual([]);
  });

  it('so o servidor concedido sobrevive a intersecao por ID de chave', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved({
        mcpServers: [
          { 'knowledge-base': { command: 'node' } },
          { 'repo-graph': { command: 'node' } },
        ],
      }),
      grants({ allowedMcpServers: ['repo-graph'] }),
      WS,
      'canUseTool',
    );
    expect(policy.effectiveMcpServers).toEqual(['repo-graph']);
  });

  it('allowedMcpTools so mantem tools de servidores efetivamente concedidos', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved({ mcpServers: [{ 'repo-graph': { command: 'node' } }] }),
      grants({
        allowedMcpServers: ['repo-graph'],
        allowedMcpTools: [
          'mcp__repo-graph__repo_graph_search',
          'mcp__knowledge-base__kb_search', // servidor nao concedido -> removido
        ],
      }),
      WS,
      'canUseTool',
    );
    expect(policy.allowedMcpTools).toEqual([
      'mcp__repo-graph__repo_graph_search',
    ]);
  });

  it('allowedMcpTools vazio = todas as tools dos servidores concedidos (sem refinamento)', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved({ mcpServers: [{ 'repo-graph': { command: 'node' } }] }),
      grants({ allowedMcpServers: ['repo-graph'] }),
      WS,
      'canUseTool',
    );
    expect(policy.allowedMcpTools).toEqual([]);
    expect(policy.effectiveMcpServers).toEqual(['repo-graph']);
  });
});

describe('deriveNodeExecutionPolicy - rotas laterais sempre removidas (AC-20)', () => {
  it('Task/Agent removidos do effectiveTools mesmo que config e manifest peca', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved({ allowedTools: ['Read', 'Task', 'Agent'] }),
      grants({ allowedTools: ['Read', 'Task', 'Agent'] }),
      WS,
      'canUseTool',
    );
    expect(policy.effectiveTools).toEqual(['Read']);
    expect(policy.effectiveTools).not.toContain('Task');
    expect(policy.effectiveTools).not.toContain('Agent');
  });

  it('mcp__lionclaw-agents__call_agent removido mesmo concedido nos dois lados', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved({ allowedTools: ['Read', 'mcp__lionclaw-agents__call_agent'] }),
      grants({ allowedTools: ['Read', 'mcp__lionclaw-agents__call_agent'] }),
      WS,
      'canUseTool',
    );
    expect(policy.effectiveTools).toEqual(['Read']);
  });

  it('dynamic_workflow_* e pipeline_* nunca entram na policy efetiva', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved({
        allowedTools: ['Read', 'dynamic_workflow_create', 'pipeline_drive'],
      }),
      grants({
        allowedTools: ['Read', 'dynamic_workflow_create', 'pipeline_drive'],
      }),
      WS,
      'canUseTool',
    );
    expect(policy.effectiveTools).toEqual(['Read']);
  });

  it('servidor MCP lionclaw-agents nao sobrevive a intersecao (rota lateral)', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved({
        mcpServers: [{ 'lionclaw-agents': { command: 'node' } }],
      }),
      grants({ allowedMcpServers: ['lionclaw-agents'] }),
      WS,
      'canUseTool',
    );
    expect(policy.effectiveMcpServers).toEqual([]);
  });

  it('isSideRouteTool classifica exato e por prefixo', () => {
    expect(isSideRouteTool('Task')).toBe(true);
    expect(isSideRouteTool('Agent')).toBe(true);
    expect(isSideRouteTool('mcp__lionclaw-agents__call_agent')).toBe(true);
    expect(isSideRouteTool('dynamic_workflow_start')).toBe(true);
    expect(isSideRouteTool('pipeline_create')).toBe(true);
    expect(isSideRouteTool('Read')).toBe(false);
    expect(isSideRouteTool('mcp__repo-graph__repo_graph_search')).toBe(false);
  });
});

describe('deriveNodeExecutionPolicy - guard-gated nunca auto-aprovado (8.3, entrada S08)', () => {
  it('deniedTools sempre carrega Bash/Write/Edit + Task/Agent', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved(),
      grants(),
      WS,
      'canUseTool',
    );
    for (const t of GUARD_GATED_TOOL_NAMES) {
      expect(policy.deniedTools).toContain(t);
    }
    expect(policy.deniedTools).toContain('Task');
    expect(policy.deniedTools).toContain('Agent');
  });

  it('read-only ignora allowBash mesmo se o node pediu', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved(),
      grants({ access: 'read-only', allowBash: true, allowedCommands: ['npm test'] }),
      WS,
      'canUseTool',
    );
    expect(policy.allowBash).toBe(false);
    expect(policy.allowedCommands).toEqual([]);
  });

  it('writer com allowBash via canUseTool mantem allowedCommands', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved({ allowedTools: ['Read', 'Write', 'Edit', 'Bash'] }),
      grants({
        nodeId: 'coder',
        access: 'workspace-write',
        allowBash: true,
        allowedCommands: ['npm test', 'npm run typecheck'],
        allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
      }),
      WS,
      'canUseTool',
    );
    expect(policy.allowBash).toBe(true);
    expect(policy.allowedCommands).toEqual(['npm test', 'npm run typecheck']);
  });

  it('SM-39: writer com allowNetwork + npm install preserva rede e o comando na policy', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved({ allowedTools: ['Read', 'Write', 'Edit', 'Bash'] }),
      grants({
        nodeId: 'coder',
        access: 'workspace-write',
        allowBash: true,
        allowNetwork: true,
        allowedCommands: ['npm run typecheck', 'npm run test', 'npm install', 'npm ci'],
        allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
      }),
      WS,
      'canUseTool',
    );
    expect(policy.allowBash).toBe(true);
    expect(policy.allowNetwork).toBe(true);
    expect(policy.allowedCommands).toEqual([
      'npm run typecheck',
      'npm run test',
      'npm install',
      'npm ci',
    ]);
  });

  it('SM-39: read-only NUNCA recebe allowNetwork mesmo se o node pediu', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved(),
      grants({ access: 'read-only', allowNetwork: true }),
      WS,
      'canUseTool',
    );
    expect(policy.allowBash).toBe(false);
    expect(policy.allowedCommands).toEqual([]);
  });

  it('writer allowBash em mecanismo nao-canUseTool (codex-sandbox) zera allowBash/commands', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved({ runtime: 'codex', allowedTools: [] }),
      grants({
        nodeId: 'coder',
        access: 'workspace-write',
        allowBash: true,
        allowedCommands: ['npm test'],
      }),
      WS,
      'codex-sandbox',
    );
    expect(policy.allowBash).toBe(false);
    expect(policy.allowedCommands).toEqual([]);
  });
});

describe('policyHash inclui o mecanismo (AC-16/AC-19)', () => {
  it('mesmo grant/config com mecanismo diferente => policyHash diferente', () => {
    const r = resolved();
    const g = grants();
    const viaGuard = deriveNodeExecutionPolicy(r, g, WS, 'canUseTool');
    const viaSandbox = deriveNodeExecutionPolicy(r, g, WS, 'codex-sandbox');
    const viaDispatcher = deriveNodeExecutionPolicy(r, g, WS, 'motor-dispatcher');
    expect(viaGuard.policyHash).not.toBe(viaSandbox.policyHash);
    expect(viaGuard.policyHash).not.toBe(viaDispatcher.policyHash);
    expect(viaSandbox.policyHash).not.toBe(viaDispatcher.policyHash);
  });

  it('mesmo input => policyHash estavel (deterministico)', () => {
    const a = deriveNodeExecutionPolicy(resolved(), grants(), WS, 'canUseTool');
    const b = deriveNodeExecutionPolicy(resolved(), grants(), WS, 'canUseTool');
    expect(a.policyHash).toBe(b.policyHash);
  });

  it('mudar effectiveTools muda o hash', () => {
    const a = deriveNodeExecutionPolicy(
      resolved({ allowedTools: ['Read'] }),
      grants({ allowedTools: ['Read'] }),
      WS,
      'canUseTool',
    );
    const b = deriveNodeExecutionPolicy(
      resolved({ allowedTools: ['Read', 'Grep'] }),
      grants({ allowedTools: ['Read', 'Grep'] }),
      WS,
      'canUseTool',
    );
    expect(a.policyHash).not.toBe(b.policyHash);
  });

  it('computeNodeGrantsHash so cobre grants estaticos (sem mecanismo)', () => {
    const g = grants({ allowedTools: ['Read', 'Grep'] });
    const h1 = computeNodeGrantsHash(g);
    const h2 = computeNodeGrantsHash(grants({ allowedTools: ['Grep', 'Read'] }));
    expect(h1).toBe(h2);
  });
});

describe('defaults deny-by-default (8.3)', () => {
  it('node sem access => read-only; sem grants => listas vazias', () => {
    const policy = deriveNodeExecutionPolicy(
      resolved({ allowedTools: [], mcpServers: [] }),
      { nodeId: 'n', agentId: 'a' },
      WS,
      'canUseTool',
    );
    expect(policy.access).toBe('read-only');
    expect(policy.effectiveTools).toEqual([]);
    expect(policy.effectiveMcpServers).toEqual([]);
    expect(policy.allowBash).toBe(false);
    expect(policy.allowNetwork).toBe(false);
  });
});


const AGENT_AXES = {
  'a-writer': {
    access: 'workspace-write',
    allowBash: true,
    allowedCommands: ['npm test', 'npm run build'],
    allowNetwork: true,
    allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
  },
  'a-reader': {
    access: 'read-only',
    allowBash: false,
    allowedCommands: [] as string[],
    allowNetwork: false,
    allowedTools: ['Read', 'Grep'],
  },
} as const;

function implicitGrants(agentType: keyof typeof AGENT_AXES): NodePolicyGrants {
  const axes = AGENT_AXES[agentType];
  return {
    nodeId: `cc:Build:${agentType}:0`,
    agentId: agentType,
    access: axes.access,
    allowBash: axes.allowBash,
    allowedCommands: [...axes.allowedCommands],
    allowNetwork: axes.allowNetwork,
    allowedTools: [...axes.allowedTools],
  };
}

function resolvedFor(agentType: keyof typeof AGENT_AXES): ResolvedAgentPolicyConfig {
  return {
    allowedTools: [...AGENT_AXES[agentType].allowedTools],
    mcpServers: [],
    runtime: 'cloud',
  };
}

describe('F1e enforcement: node implicito read-only (a-reader) nega Write/Edit/Bash', () => {
  it('deriveNodeExecutionPolicy(read-only) -> allowBash false, commands [], guard-gated negadas', () => {
    const policy = deriveNodeExecutionPolicy(
      resolvedFor('a-reader'),
      implicitGrants('a-reader'),
      WS,
      'canUseTool',
    );
    expect(policy.access).toBe('read-only');
    expect(policy.allowBash).toBe(false);
    expect(policy.allowedCommands).toEqual([]);
    for (const t of GUARD_GATED_TOOL_NAMES) {
      expect(policy.deniedTools).toContain(t);
    }
  });

  it('canUseTool composto NEGA Write, Edit e Bash (incondicional, independe do prompt)', () => {
    const policy = deriveNodeExecutionPolicy(
      resolvedFor('a-reader'),
      implicitGrants('a-reader'),
      WS,
      'canUseTool',
    );
    const guard = new WorkflowPathGuard({ workspaceRoot: WS.workspaceRoot });
    const canUse = createComposedCanUseTool(policy, guard);

    expect(canUse({ toolName: 'Write', input: { file_path: `${WS.workspaceRoot}/a.ts` } }).behavior).toBe('deny');
    expect(canUse({ toolName: 'Edit', input: { file_path: `${WS.workspaceRoot}/a.ts` } }).behavior).toBe('deny');
    expect(canUse({ toolName: 'Bash', input: { command: 'npm test' } }).behavior).toBe('deny');
    expect(canUse({ toolName: 'Bash', input: { command: 'ls' } }).behavior).toBe('deny');
    expect(canUse({ toolName: 'Read', input: { file_path: `${WS.workspaceRoot}/a.ts` } }).behavior).toBe('allow');
  });
});

describe('F1e enforcement: node implicito workspace-write (a-writer) permite + filtra allowlist', () => {
  it('deriveNodeExecutionPolicy(workspace-write+bash) -> allowBash true, commands do agentType preservados', () => {
    const policy = deriveNodeExecutionPolicy(
      resolvedFor('a-writer'),
      implicitGrants('a-writer'),
      WS,
      'canUseTool',
    );
    expect(policy.access).toBe('workspace-write');
    expect(policy.allowBash).toBe(true);
    expect(policy.allowedCommands).toEqual(['npm test', 'npm run build']);
    expect(policy.deniedTools).not.toContain('Write');
    expect(policy.deniedTools).not.toContain('Edit');
    expect(policy.deniedTools).not.toContain('Bash');
  });

  it('canUseTool composto PERMITE Write/Edit dentro do path guard e NEGA fora', () => {
    const policy = deriveNodeExecutionPolicy(
      resolvedFor('a-writer'),
      implicitGrants('a-writer'),
      WS,
      'canUseTool',
    );
    const guard = new WorkflowPathGuard({ workspaceRoot: WS.workspaceRoot });
    const canUse = createComposedCanUseTool(policy, guard);

    expect(canUse({ toolName: 'Write', input: { file_path: `${WS.workspaceRoot}/src/x.ts` } }).behavior).toBe('allow');
    expect(canUse({ toolName: 'Edit', input: { file_path: `${WS.workspaceRoot}/src/y.ts` } }).behavior).toBe('allow');
    expect(canUse({ toolName: 'Write', input: { file_path: '/etc/passwd' } }).behavior).toBe('deny');
  });

  it('canUseTool composto PERMITE so os comandos Bash da allowlist do agentType e NEGA fora', () => {
    const policy = deriveNodeExecutionPolicy(
      resolvedFor('a-writer'),
      implicitGrants('a-writer'),
      WS,
      'canUseTool',
    );
    const guard = new WorkflowPathGuard({ workspaceRoot: WS.workspaceRoot });
    const canUse = createComposedCanUseTool(policy, guard);

    expect(canUse({ toolName: 'Bash', input: { command: 'npm test' } }).behavior).toBe('allow');
    expect(canUse({ toolName: 'Bash', input: { command: 'npm test -- --watch' } }).behavior).toBe('allow');
    expect(canUse({ toolName: 'Bash', input: { command: 'npm run build' } }).behavior).toBe('allow');
    expect(canUse({ toolName: 'Bash', input: { command: 'rm -rf /' } }).behavior).toBe('deny');
    expect(canUse({ toolName: 'Bash', input: { command: 'npm publish' } }).behavior).toBe('deny');
    expect(canUse({ toolName: 'Bash', input: { command: 'npm' } }).behavior).toBe('deny');
  });
});

describe('F1e enforcement: allowNetwork e audit-only, nunca enforcement (nao quebra)', () => {
  it('writer com allowNetwork: policy carrega a flag mas o canUseTool nao a consulta', () => {
    const policy = deriveNodeExecutionPolicy(
      resolvedFor('a-writer'),
      implicitGrants('a-writer'),
      WS,
      'canUseTool',
    );
    expect(policy.allowNetwork).toBe(true);
    const guard = new WorkflowPathGuard({ workspaceRoot: WS.workspaceRoot });
    const canUse = createComposedCanUseTool(policy, guard);
    expect(canUse({ toolName: 'Bash', input: { command: 'curl http://x' } }).behavior).toBe('deny');
    expect(canUse({ toolName: 'Bash', input: { command: 'npm test' } }).behavior).toBe('allow');
  });

  it('read-only com allowNetwork=true (grant anomalo): allowBash/commands seguem zerados, nada quebra', () => {
    const policy = deriveNodeExecutionPolicy(
      resolvedFor('a-reader'),
      { ...implicitGrants('a-reader'), allowNetwork: true },
      WS,
      'canUseTool',
    );
    expect(policy.allowNetwork).toBe(true);
    expect(policy.allowBash).toBe(false);
    expect(policy.allowedCommands).toEqual([]);
    const guard = new WorkflowPathGuard({ workspaceRoot: WS.workspaceRoot });
    const canUse = createComposedCanUseTool(policy, guard);
    expect(canUse({ toolName: 'Bash', input: { command: 'npm test' } }).behavior).toBe('deny');
  });
});


const tmpRoots: string[] = [];
function mkTmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-pathguard-'));
  tmpRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tmpRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('WorkflowPathGuard - containment (8.5)', () => {
  it('escrita dentro da raiz e permitida e registrada', () => {
    const root = mkTmpRoot();
    const guard = new WorkflowPathGuard({ workspaceRoot: root });
    const res = guard.checkWrite(path.join(root, 'src', 'index.ts'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.relativePath).toBe('src/index.ts');
    expect(guard.getDetectedWrites()).toContain('src/index.ts');
  });

  it('path fora da raiz e negado (outside-root) e nao registra escrita', () => {
    const root = mkTmpRoot();
    const guard = new WorkflowPathGuard({ workspaceRoot: root });
    const res = guard.checkWrite(path.join(root, '..', 'fora.ts'));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(['outside-root', 'symlink-escape']).toContain(res.reason);
    }
    expect(guard.getDetectedWrites()).toEqual([]);
  });

  it('traversal com ../ que sai da raiz e negado', () => {
    const root = mkTmpRoot();
    const guard = new WorkflowPathGuard({ workspaceRoot: root });
    const res = guard.check(path.join(root, 'a', '..', '..', 'etc', 'passwd'));
    expect(res.ok).toBe(false);
  });

  it('symlink que escapa da raiz e negado (symlink-escape)', () => {
    const root = mkTmpRoot();
    const outside = mkTmpRoot();
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'top');
    const link = path.join(root, 'escape');
    fs.symlinkSync(outside, link);
    const guard = new WorkflowPathGuard({ workspaceRoot: root });
    const res = guard.check(path.join(link, 'secret.txt'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('symlink-escape');
  });
});

describe('WorkflowPathGuard - protected paths e writeSet (8.5/8.6)', () => {
  it('escrita em path protegido e negada (protected-path)', () => {
    const root = mkTmpRoot();
    const guard = new WorkflowPathGuard({
      workspaceRoot: root,
      protectedPaths: ['electron/main/pipeline-engine/**', '*.lock'],
    });
    const res = guard.checkWrite(
      path.join(root, 'electron', 'main', 'pipeline-engine', 'index.ts'),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('protected-path');
  });

  it('protected glob de arquivo na raiz casa (package-lock.lock)', () => {
    const root = mkTmpRoot();
    const guard = new WorkflowPathGuard({
      workspaceRoot: root,
      protectedPaths: ['*.lock'],
    });
    const res = guard.checkWrite(path.join(root, 'pnpm.lock'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('protected-path');
  });

  it('escrita fora do writeSet NAO e mais negada (enforcement desligado): so audita', () => {
    const root = mkTmpRoot();
    const guard = new WorkflowPathGuard({
      workspaceRoot: root,
      writeSet: ['src/**'],
    });
    const inScope = guard.checkWrite(path.join(root, 'src', 'a.ts'));
    expect(inScope.ok).toBe(true);
    const outOfScope = guard.checkWrite(path.join(root, 'electron', 'b.ts'));
    expect(outOfScope.ok).toBe(true);
    expect(guard.validateTouchedFiles(['electron/b.ts'])).toEqual(['electron/b.ts']);
  });

  it('validateTouchedFiles retorna so os paths fora do writeSet', () => {
    const root = mkTmpRoot();
    const guard = new WorkflowPathGuard({
      workspaceRoot: root,
      writeSet: ['src/**', '*.md'],
    });
    const violations = guard.validateTouchedFiles([
      'src/index.ts',
      'README.md',
      'electron/main/db.ts',
      'src/nested/deep/x.ts',
    ]);
    expect(violations).toEqual(['electron/main/db.ts']);
  });

  it('sem writeSet definido, validateTouchedFiles nao acusa violacao', () => {
    const root = mkTmpRoot();
    const guard = new WorkflowPathGuard({ workspaceRoot: root });
    expect(guard.validateTouchedFiles(['qualquer/coisa.ts'])).toEqual([]);
  });

  it('checkWrite one-shot: writeSet NAO bloqueia mais (enforcement off)', () => {
    const root = mkTmpRoot();
    const res = new WorkflowPathGuard({ workspaceRoot: root, writeSet: ['docs/**'] }).checkWrite(
      path.join(root, 'src', 'x.ts'),
    );
    expect(res.ok).toBe(true);
  });
});

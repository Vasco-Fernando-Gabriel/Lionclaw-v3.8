import { describe, it, expect } from 'vitest';
import {
  preflightNode,
  decideWorkspaceMode,
  RUNTIME_CAPABILITIES,
  GUARD_CAPABLE_RUNTIMES,
  isGuardCapableRuntime,
  type WorkflowNodeRuntime,
  type ProjectGitState,
  type ProjectGitProbe,
} from '../dynamic-workflows/workflow-preflight';
import type { NodePolicyGrants } from '../dynamic-workflows/workflow-policy';

function grants(over: Partial<NodePolicyGrants> = {}): NodePolicyGrants {
  return { nodeId: 'n1', agentId: 'agent-x', access: 'read-only', ...over };
}

const ALL_RUNTIMES: WorkflowNodeRuntime[] = [
  'cloud',
  'zai',
  'minimax-tp',
  'codex',
  'kimi',
  'grok',
  'local',
  'external',
  'google-genai',
];

describe('preflightNode - read-only por mecanismo (AC-4 unit, 8.7.1)', () => {
  it('claude-compatible -> mecanismo canUseTool', () => {
    for (const rt of ['cloud', 'zai', 'minimax-tp']) {
      const res = preflightNode({ grants: grants(), runtime: rt });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.mechanism).toBe('canUseTool');
    }
  });

  it('codex -> mecanismo codex-sandbox', () => {
    const res = preflightNode({ grants: grants(), runtime: 'codex' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.mechanism).toBe('codex-sandbox');
  });

  it('local/external/google-genai -> mecanismo motor-dispatcher', () => {
    for (const rt of ['local', 'external', 'google-genai']) {
      const res = preflightNode({ grants: grants(), runtime: rt });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.mechanism).toBe('motor-dispatcher');
    }
  });

  it('runtime desconhecido e bloqueado com erro nomeado', () => {
    const res = preflightNode({ grants: grants(), runtime: 'lion-sdk' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.guarantee).toBe('runtime-suportado');
      expect(res.message).toContain('lion-sdk');
      expect(res.message).toContain('n1');
    }
  });
});

describe('preflightNode - allowBash bloqueado fora do canUseTool (8.7)', () => {
  it('writer com allowBash em cloud e permitido', () => {
    const res = preflightNode({
      grants: grants({ access: 'workspace-write', allowBash: true }),
      runtime: 'cloud',
    });
    expect(res.ok).toBe(true);
  });

  it('allowBash em codex e PERMITIDO (sandbox por node contem o shell)', () => {
    const res = preflightNode({
      grants: grants({ access: 'workspace-write', allowBash: true }),
      runtime: 'codex',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mechanism).toBe('codex-sandbox');
    }
  });

  it('allowBash em kimi falha fechado sem sandbox comprovado', () => {
    const res = preflightNode({
      grants: grants({ access: 'workspace-write', allowBash: true }),
      runtime: 'kimi',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.guarantee).toBe('read-only');
  });

  it('allowBash em local e external e bloqueado', () => {
    for (const rt of ['local', 'external']) {
      const res = preflightNode({
        grants: grants({ access: 'workspace-write', allowBash: true }),
        runtime: rt,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.guarantee).toBe('bash-allowlist');
    }
  });
});

describe('preflightNode - closer exige guard-capable OU sandbox-capable (8.8)', () => {
  it('closer em cloud/zai/minimax-tp e permitido', () => {
    for (const rt of GUARD_CAPABLE_RUNTIMES) {
      const res = preflightNode({ grants: grants(), runtime: rt, role: 'closer' });
      expect(res.ok).toBe(true);
    }
  });

  it('closer em codex usa sandbox; kimi falha fechado sem sandbox comprovado', () => {
    expect(preflightNode({ grants: grants(), runtime: 'codex', role: 'closer' }).ok).toBe(true);
    const kimi = preflightNode({ grants: grants(), runtime: 'kimi', role: 'closer' });
    expect(kimi.ok).toBe(false);
    if (!kimi.ok) expect(kimi.guarantee).toBe('closer-guard');
  });

  it('closer em local/external/google-genai e bloqueado (sem canUseTool E sem sandbox)', () => {
    for (const rt of ['local', 'external', 'google-genai']) {
      const res = preflightNode({ grants: grants(), runtime: rt, role: 'closer' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.guarantee).toBe('closer-guard');
    }
  });

  it('isGuardCapableRuntime espelha a lista 8.8', () => {
    expect(isGuardCapableRuntime('cloud')).toBe(true);
    expect(isGuardCapableRuntime('zai')).toBe(true);
    expect(isGuardCapableRuntime('minimax-tp')).toBe(true);
    expect(isGuardCapableRuntime('codex')).toBe(false);
    expect(isGuardCapableRuntime('local')).toBe(false);
    expect(isGuardCapableRuntime('external')).toBe(false);
    expect(isGuardCapableRuntime('google-genai')).toBe(false);
  });
});

describe('preflightNode - lionclaw-user-question exige MCP (13.3.4)', () => {
  it('user-question concedido em cloud (tem MCP) e permitido', () => {
    const res = preflightNode({
      grants: grants(),
      runtime: 'cloud',
      grantsUserQuestion: true,
    });
    expect(res.ok).toBe(true);
  });

  it('user-question em codex/local/external (sem MCP) e bloqueado', () => {
    for (const rt of ['codex', 'local', 'external', 'google-genai']) {
      const res = preflightNode({
        grants: grants(),
        runtime: rt,
        grantsUserQuestion: true,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.guarantee).toBe('user-question-mcp');
    }
  });
});

describe('preflightNode - avisos nao-bloqueantes (8.7)', () => {
  it('MCP server concedido em runtime sem MCP gera aviso, nao bloqueio', () => {
    const res = preflightNode({
      grants: grants({ allowedMcpServers: ['repo-graph'] }),
      runtime: 'codex',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warnings.some((w) => w.includes('MCP'))).toBe(true);
    }
  });

  it('local/external avisam sobre abort mid-request; google-genai nao', () => {
    const local = preflightNode({ grants: grants(), runtime: 'local' });
    const gg = preflightNode({ grants: grants(), runtime: 'google-genai' });
    expect(local.ok && local.warnings.some((w) => w.includes('cancela'))).toBe(true);
    expect(gg.ok && gg.warnings.some((w) => w.includes('cancela'))).toBe(false);
  });
});

describe('RUNTIME_CAPABILITIES espelha a matriz 8.7', () => {
  it('codex tem sandbox por node e nao tem canUseTool/MCP', () => {
    const c = RUNTIME_CAPABILITIES.codex;
    expect(c.sandboxPerNode).toBe(true);
    expect(c.canUseTool).toBe(false);
    expect(c.mcp).toBe(false);
    expect(c.bashAllowlist).toBe(false);
  });

  it('claude-compatible tem canUseTool + MCP + bash allowlist, sem sandbox', () => {
    for (const rt of ['cloud', 'zai', 'minimax-tp'] as const) {
      const c = RUNTIME_CAPABILITIES[rt];
      expect(c.canUseTool).toBe(true);
      expect(c.mcp).toBe(true);
      expect(c.bashAllowlist).toBe(true);
      expect(c.sandboxPerNode).toBe(false);
    }
  });

  it('google-genai tem abort por node; local/external nao (override da familia)', () => {
    expect(RUNTIME_CAPABILITIES['google-genai'].abortPerNode).toBe(true);
    expect(RUNTIME_CAPABILITIES.local.abortPerNode).toBe(false);
    expect(RUNTIME_CAPABILITIES.external.abortPerNode).toBe(false);
  });

  it('Kimi segue bloqueado sem enforcement; Grok passa pelo guard e profile dedicados', () => {
    expect(RUNTIME_CAPABILITIES.kimi.readOnlyEnforceable).toBe(false);
    expect(preflightNode({ grants: grants(), runtime: 'kimi' }).ok).toBe(false);

    expect(RUNTIME_CAPABILITIES.grok.canUseTool).toBe(true);
    expect(RUNTIME_CAPABILITIES.grok.mcp).toBe(true);
    expect(RUNTIME_CAPABILITIES.grok.readOnlyEnforceable).toBe(true);
    expect(preflightNode({ grants: grants(), runtime: 'grok' }).ok).toBe(true);
  });

  it('toda a familia local-family marca readOnlyEnforceable (via dispatcher S08)', () => {
    for (const rt of ['local', 'external', 'google-genai'] as const) {
      expect(RUNTIME_CAPABILITIES[rt].readOnlyEnforceable).toBe(true);
      expect(RUNTIME_CAPABILITIES[rt].mechanism).toBe('motor-dispatcher');
    }
  });
});

describe('preflightNode - cursor (SPEC cursor-runtime E6)', () => {
  it('read-only em cursor passa com mecanismo canUseTool (guard composto no main)', () => {
    const res = preflightNode({ grants: grants(), runtime: 'cursor' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.mechanism).toBe('canUseTool');
  });

  it('writer com allowBash em cursor e permitido (lion_shell consulta allowedCommands)', () => {
    const res = preflightNode({
      grants: grants({ access: 'workspace-write', allowBash: true }),
      runtime: 'cursor',
    });
    expect(res.ok).toBe(true);
  });

  it('user-question em cursor e bloqueado (MCP do Lion nao sobe na F1)', () => {
    const res = preflightNode({
      grants: grants(),
      runtime: 'cursor',
      grantsUserQuestion: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.guarantee).toBe('user-question-mcp');
  });

  it('MCP server concedido em cursor gera aviso, nao bloqueio', () => {
    const res = preflightNode({
      grants: grants({ allowedMcpServers: ['repo-graph'] }),
      runtime: 'cursor',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warnings.some((w) => w.includes('MCP'))).toBe(true);
  });

  it('closer em cursor e bloqueado (roteamento do closer nao cobre cursor)', () => {
    const res = preflightNode({ grants: grants(), runtime: 'cursor', role: 'closer' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.guarantee).toBe('closer-guard');
    expect(isGuardCapableRuntime('cursor')).toBe(false);
  });

  it('capacidades: canUseTool/bashAllowlist/writeSet/abort sim; mcp/sandbox nao', () => {
    const c = RUNTIME_CAPABILITIES.cursor;
    expect(c.family).toBe('cursor');
    expect(c.canUseTool).toBe(true);
    expect(c.bashAllowlist).toBe(true);
    expect(c.writeSetPreventive).toBe(true);
    expect(c.abortPerNode).toBe(true);
    expect(c.readOnlyEnforceable).toBe(true);
    expect(c.mcp).toBe(false);
    expect(c.sandboxPerNode).toBe(false);
  });
});

describe('DRIFT da matriz vs AgentConfig (risco 19)', () => {
  it('o union de runtimes da matriz cobre AgentConfig[runtime] (menos lion-sdk)', () => {
    const agentConfigRuntimes = ['cloud', 'local', 'external', 'codex', 'zai', 'minimax-tp', 'kimi', 'grok', 'cursor'];
    for (const rt of agentConfigRuntimes) {
      expect(Object.keys(RUNTIME_CAPABILITIES)).toContain(rt);
    }
    expect(Object.keys(RUNTIME_CAPABILITIES)).not.toContain('lion-sdk');
  });

  it('todo runtime da matriz tem mecanismo definido', () => {
    for (const rt of ALL_RUNTIMES) {
      expect(RUNTIME_CAPABILITIES[rt].mechanism).toBeDefined();
    }
  });
});

describe('preflightNode - papel refuter read-only passa em TODOS os runtimes (F2-S8, regression guard)', () => {
  const READ_ONLY_ENFORCEABLE_RUNTIMES: WorkflowNodeRuntime[] = [
    'cloud',
    'zai',
    'minimax-tp',
    'codex',
    'grok',
    'local',
    'external',
    'google-genai',
  ];

  function refuterGrants(): NodePolicyGrants {
    return {
      nodeId: 'refuter:dev-s1-r1',
      agentId: 'dynamic-workflow-refuter',
      access: 'read-only',
      allowedTools: ['Read', 'Glob', 'Grep'],
    };
  }

  it('refuter passa em runtimes com read-only comprovado', () => {
    for (const rt of READ_ONLY_ENFORCEABLE_RUNTIMES) {
      const res = preflightNode({ grants: refuterGrants(), runtime: rt });
      expect(res.ok, `refuter deveria passar em ${rt}`).toBe(true);
    }
  });

  it('refuter passa tambem com role:node explicito (sem virar papel de preflight)', () => {
    for (const rt of READ_ONLY_ENFORCEABLE_RUNTIMES) {
      const res = preflightNode({ grants: refuterGrants(), runtime: rt, role: 'node' });
      expect(res.ok, `refuter (role node) deveria passar em ${rt}`).toBe(true);
    }
  });

  it('refuter mapeia para o mecanismo de enforcement de cada familia', () => {
    const expected: Record<WorkflowNodeRuntime, string> = {
      cloud: 'canUseTool',
      zai: 'canUseTool',
      'minimax-tp': 'canUseTool',
      codex: 'codex-sandbox',
      kimi: 'codex-sandbox',
      grok: 'grok-cli-sandbox',
      cursor: 'canUseTool',
      local: 'motor-dispatcher',
      external: 'motor-dispatcher',
      'google-genai': 'motor-dispatcher',
    };
    for (const rt of READ_ONLY_ENFORCEABLE_RUNTIMES) {
      const res = preflightNode({ grants: refuterGrants(), runtime: rt });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.mechanism).toBe(expected[rt]);
    }
  });

  it('refuter Kimi falha sem enforcement e Grok executa com guard', () => {
    const kimi = preflightNode({ grants: refuterGrants(), runtime: 'kimi' });
    expect(kimi.ok).toBe(false);
    if (!kimi.ok) expect(kimi.guarantee).toBe('read-only');

    const grok = preflightNode({ grants: refuterGrants(), runtime: 'grok' });
    expect(grok.ok).toBe(true);
    if (grok.ok) expect(grok.mechanism).toBe('grok-cli-sandbox');
  });

  it('refuter NUNCA cai em closer-guard (read-only, sem role closer) nem em bash-allowlist', () => {
    for (const rt of ['local', 'external'] as WorkflowNodeRuntime[]) {
      const res = preflightNode({ grants: refuterGrants(), runtime: rt });
      expect(res.ok).toBe(true);
    }
  });
});

describe('decideWorkspaceMode - estados de projeto (8.6 tabela)', () => {
  function probeFixed(state: ProjectGitState): ProjectGitProbe {
    return () => state;
  }

  it('git com commits -> run-worktree, sem init/baseline, com merge gate', () => {
    const d = decideWorkspaceMode('/proj', probeFixed('git-with-commits'));
    expect(d.mode).toBe('run-worktree');
    expect(d.requiresGitInit).toBe(false);
    expect(d.requiresBaselineCommit).toBe(false);
    expect(d.hasMergeGate).toBe(true);
  });

  it('git unborn (HEAD sem commit) -> fresh-project, sem init/baseline/merge', () => {
    const d = decideWorkspaceMode('/proj', probeFixed('git-unborn'));
    expect(d.mode).toBe('fresh-project');
    expect(d.requiresGitInit).toBe(false);
    expect(d.requiresBaselineCommit).toBe(false);
    expect(d.hasMergeGate).toBe(false);
  });

  it('pasta vazia -> fresh-project, com init, sem baseline/merge', () => {
    const d = decideWorkspaceMode('/proj', probeFixed('empty-dir'));
    expect(d.mode).toBe('fresh-project');
    expect(d.requiresGitInit).toBe(true);
    expect(d.requiresBaselineCommit).toBe(false);
    expect(d.hasMergeGate).toBe(false);
  });

  it('codigo sem git -> run-worktree, com init + baseline, com merge gate', () => {
    const d = decideWorkspaceMode('/proj', probeFixed('code-no-git'));
    expect(d.mode).toBe('run-worktree');
    expect(d.requiresGitInit).toBe(true);
    expect(d.requiresBaselineCommit).toBe(true);
    expect(d.hasMergeGate).toBe(true);
  });

  it('o probe recebe o projectPath passado', () => {
    let seen = '';
    decideWorkspaceMode('/meu/projeto', (p) => {
      seen = p;
      return 'git-with-commits';
    });
    expect(seen).toBe('/meu/projeto');
  });
});

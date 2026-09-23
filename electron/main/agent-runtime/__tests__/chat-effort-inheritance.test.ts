import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../db', () => ({
  getSetting: vi.fn(() => undefined),
  getAgent: vi.fn(),
  insertAuditEntry: vi.fn(),
}));
vi.mock('../../paths', () => ({
  getAgentCwd: () => '/tmp',
  getLionClawHome: () => '/tmp',
}));
vi.mock('../index', () => ({ executeAgent: vi.fn() }));

import {
  claudeEffortToCodex,
  codexEffortToClaude,
  clampCodexEffortForModel,
  resolveChatInheritedEffort,
  type ChatInheritedEffort,
} from '../chat-effort-inheritance';
import { clampCodexEffortForModel as gradClamp } from '../../../../src/constants/codex-models';
import { buildClaudeQueryOptions } from '../cloud-executor';
import { PERM_BYPASS_NO_GUARD } from '../permission-profiles';
import { lionAgentDispatch } from '../../lion-sdk/tools/agent';
import type { AgentExecutionRequest, AgentExecutionResult } from '../types';
import type { AgentQueryConfig } from '../../agent-config-resolver';

const MAIN_DIR = join(__dirname, '..', '..');

describe('traducao de escala claude <-> codex', () => {
  it('claude -> codex: max vira xhigh; low/medium/high 1:1', () => {
    expect(claudeEffortToCodex('max')).toBe('max');
    expect(claudeEffortToCodex('low')).toBe('low');
    expect(claudeEffortToCodex('medium')).toBe('medium');
    expect(claudeEffortToCodex('high')).toBe('high');
  });

  it('codex -> claude: xhigh vira max; low/medium/high 1:1', () => {
    expect(codexEffortToClaude('xhigh')).toBe('max');
    expect(codexEffortToClaude('low')).toBe('low');
    expect(codexEffortToClaude('medium')).toBe('medium');
    expect(codexEffortToClaude('high')).toBe('high');
  });

  it('roundtrip max e estavel; xhigh colapsa em max (teto claude, P7)', () => {
    expect(codexEffortToClaude(claudeEffortToCodex('max'))).toBe('max');
    expect(claudeEffortToCodex(codexEffortToClaude('xhigh'))).toBe('max');
  });

  it('byte-compat FIM-A-FIM da heranca em modelos <=5.5 (P7): traducao+clamp reproduz o antigo max->xhigh', () => {
    expect(gradClamp(claudeEffortToCodex('max'), 'gpt-5.5')).toBe('xhigh');
    expect(gradClamp(claudeEffortToCodex('max'), 'gpt-5.2')).toBe('high');
    expect(gradClamp(claudeEffortToCodex('max'), 'gpt-5.6-sol')).toBe('max');
  });

  it('heranca NUNCA propaga ultra (P6): orquestrador codex em ultra herda {codex: max, claude: max}', () => {
    const r = resolveChatInheritedEffort('codex-sdk', 'ultra');
    expect(r).toEqual({ claude: 'max', codex: 'max', kimi: 'max', grok: 'high' });
  });

  it('orquestrador codex em max herda {codex: max, claude: max}', () => {
    const r = resolveChatInheritedEffort('codex-sdk', 'max');
    expect(r).toEqual({ claude: 'max', codex: 'max', kimi: 'max', grok: 'high' });
  });
});

describe('clampCodexEffortForModel', () => {
  it('mantem xhigh em modelo com suporte (slugs exatos do catalogo: gpt-5.2-codex / codex-max)', () => {
    expect(clampCodexEffortForModel('xhigh', 'gpt-5.2-codex')).toBe('xhigh');
    expect(clampCodexEffortForModel('xhigh', 'codex-max')).toBe('xhigh');
  });

  it('clamp GRADUADO canonico (spec-gpt56 P5, codex-models): desce para o maior suportado abaixo do pedido', () => {
    expect(gradClamp('ultra', 'gpt-5.6-luna')).toBe('max');
    expect(gradClamp('max', 'gpt-5.5')).toBe('xhigh');
    expect(gradClamp('max', 'gpt-5.4')).toBe('xhigh');
    expect(gradClamp('max', 'gpt-5.2')).toBe('high');
    expect(gradClamp('ultra', 'modelo-desconhecido')).toBe('high');
    expect(gradClamp('max', 'gpt-5.6-sol')).toBe('max');
    expect(gradClamp('ultra', 'gpt-5.6-terra')).toBe('ultra');
    expect(gradClamp('xhigh', 'gpt-5.2')).toBe('high');
    expect(gradClamp('xhigh', 'gpt-5.5')).toBe('xhigh');
  });

  it('clampa xhigh -> high em modelo sem suporte', () => {
    expect(clampCodexEffortForModel('xhigh', 'gpt-5.1-codex')).toBe('high');
    expect(clampCodexEffortForModel('xhigh', 'modelo-desconhecido')).toBe('high');
  });

  it('low/medium/high passam sem clamp em qualquer modelo', () => {
    expect(clampCodexEffortForModel('low', 'gpt-5.1-codex')).toBe('low');
    expect(clampCodexEffortForModel('medium', 'modelo-desconhecido')).toBe('medium');
    expect(clampCodexEffortForModel('high', 'codex-max')).toBe('high');
  });
});

describe('resolveChatInheritedEffort (pura: runtime + effort da selecao da lane, 7.6)', () => {
  it('lane claude-sdk em max -> { claude: max, codex: max }', () => {
    expect(resolveChatInheritedEffort('claude-sdk', 'max')).toEqual({
      claude: 'max',
      codex: 'max',
      kimi: 'max',
      grok: 'high',
    });
  });

  it('lane codex-sdk em xhigh -> { claude: max, codex: xhigh }', () => {
    expect(resolveChatInheritedEffort('codex-sdk', 'xhigh')).toEqual({
      claude: 'max',
      codex: 'xhigh',
      kimi: 'max',
      grok: 'high',
    });
  });

  it('claude-sdk sem effort -> default high/high', () => {
    expect(resolveChatInheritedEffort('claude-sdk', undefined)).toEqual({
      claude: 'high',
      codex: 'high',
      kimi: 'high',
      grok: 'high',
    });
  });

  it('codex-sdk com effort invalido -> default high/high', () => {
    expect(resolveChatInheritedEffort('codex-sdk', 'banana')).toEqual({
      claude: 'high',
      codex: 'high',
      kimi: 'high',
      grok: 'high',
    });
  });

  it('claude-sdk em low/medium traduz 1:1', () => {
    expect(resolveChatInheritedEffort('claude-sdk', 'low')).toEqual({
      claude: 'low',
      codex: 'low',
      kimi: 'low',
      grok: 'low',
    });
    expect(resolveChatInheritedEffort('claude-sdk', 'medium')).toEqual({
      claude: 'medium',
      codex: 'medium',
      kimi: 'high',
      grok: 'medium',
    });
  });

  it('Kimi e Grok propagam suas escalas nativas para todos os executores', () => {
    expect(resolveChatInheritedEffort('kimi-sdk', 'max')).toEqual({
      claude: 'max',
      codex: 'max',
      kimi: 'max',
      grok: 'high',
    });
    expect(resolveChatInheritedEffort('grok-sdk', 'medium')).toEqual({
      claude: 'medium',
      codex: 'medium',
      kimi: 'high',
      grok: 'medium',
    });
  });

  it('runtimes sem suporte a effort (compat/cursor/lion) -> undefined', () => {
    for (const runtime of ['claude-compat-sdk', 'cursor-sdk', 'lion-sdk']) {
      expect(resolveChatInheritedEffort(runtime, 'max')).toBeUndefined();
    }
  });

  it('runtime ausente -> undefined (nunca le setting global)', () => {
    expect(resolveChatInheritedEffort(undefined, 'max')).toBeUndefined();
  });
});

function makeReq(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    agentId: 'cloud-agent',
    prompt: 'tarefa',
    cwd: '/tmp',
    abortController: new AbortController(),
    permission: PERM_BYPASS_NO_GUARD,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    model: 'claude-sonnet-4-5',
    systemPrompt: 'sp',
    allowedTools: ['Read'],
    mcpServers: [],
    thinking: 'disabled',
    effort: undefined,
    thinkingBudget: undefined,
    maxTurns: undefined,
    maxToolRounds: undefined,
    ...overrides,
  } as AgentQueryConfig;
}

describe('cloud-executor: heranca de effort no query() do subagente', () => {
  it('inheritedEffort.claude SOBRESCREVE o effort configurado do agente', () => {
    const inherited: ChatInheritedEffort = { claude: 'max', codex: 'xhigh' };
    const opts = buildClaudeQueryOptions(
      makeReq({ inheritedEffort: inherited }),
      makeConfig({ effort: 'low' }),
      '/fake/cli.js',
      new AbortController(),
    );
    expect(opts.effort).toBe('max');
  });

  it('sem inheritedEffort vale config.effort do agente (pipeline intacto)', () => {
    const opts = buildClaudeQueryOptions(
      makeReq(),
      makeConfig({ effort: 'medium' }),
      '/fake/cli.js',
      new AbortController(),
    );
    expect(opts.effort).toBe('medium');
  });

  it('sem inheritedEffort e sem config.effort a chave effort nao entra', () => {
    const opts = buildClaudeQueryOptions(makeReq(), makeConfig(), '/fake/cli.js', new AbortController());
    expect('effort' in opts).toBe(false);
  });
});

function makeExecResult(): AgentExecutionResult {
  return {
    output: 'ok',
    metrics: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 0,
      apiRequests: 1,
      costUsd: 0,
      durationMs: 1,
    },
    model: 'm',
    runtime: 'cloud',
    provider: 'anthropic',
  };
}

describe('lionAgentDispatch: heranca de effort no call_agent', () => {
  const chatAgent = { id: 'a1', isActive: true, squad: 'general' };

  it('repassa o inheritedEffort resolvido ao executeAgent', async () => {
    const executor = vi.fn(async (_req: AgentExecutionRequest) => makeExecResult());
    const inherited: ChatInheritedEffort = { claude: 'max', codex: 'xhigh' };
    const r = await lionAgentDispatch(
      { agent_id: 'a1', task: 't' },
      {
        executor: executor as never,
        getAgent: (() => chatAgent) as never,
        resolveInheritedEffort: () => inherited,
      },
    );
    expect(r.ok).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
    const req = executor.mock.calls[0]![0] as unknown as AgentExecutionRequest;
    expect(req.inheritedEffort).toEqual({ claude: 'max', codex: 'xhigh' });
  });

  it('heranca undefined (orquestrador sem effort) -> campo ausente no request', async () => {
    const executor = vi.fn(async (_req: AgentExecutionRequest) => makeExecResult());
    const r = await lionAgentDispatch(
      { agent_id: 'a1', task: 't' },
      {
        executor: executor as never,
        getAgent: (() => chatAgent) as never,
        resolveInheritedEffort: () => undefined,
      },
    );
    expect(r.ok).toBe(true);
    const req = executor.mock.calls[0]![0] as unknown as AgentExecutionRequest;
    expect('inheritedEffort' in req).toBe(false);
  });
});

describe('wiring-audit (fonte): codex-executor e codex-agents-mcp', () => {
  it('codex-executor: inheritedEffort.codex tem precedencia com clamp pelo modelo do agente', () => {
    const src = readFileSync(join(MAIN_DIR, 'agent-runtime', 'codex-executor.ts'), 'utf-8');
    expect(src).toMatch(
      /const requestedEffort =\s*req\.inheritedEffort !== undefined\s*\? req\.inheritedEffort\.codex\s*: agent\.codexConfig\.reasoningEffort;/,
    );
    expect(src).toContain('reasoningEffortOverride: requestedEffort,');
  });

  it('codex-agents-mcp: run_codex_agent recebe heranca e ownership do contexto host-side', () => {
    const src = readFileSync(join(MAIN_DIR, 'codex-agents-mcp.ts'), 'utf-8');
    expect(src).not.toContain('dispatchLionSubagent');
    expect(src).toContain('executeAgent({');
    expect(src).toContain('cwd: host.workspace.cwd');
    expect(src).toContain('host.inheritedEffort');
    expect(src).toContain('dispatchContext: SubagentDispatchContext');
    expect(src).not.toContain('repoRoot: z.string()');
    expect(src).not.toContain('sessionId: z.string()');
    const orchestrator = readFileSync(join(MAIN_DIR, 'orchestrator.ts'), 'utf-8');
    expect(orchestrator).toContain(
      'inheritedEffort: resolveChatInheritedEffort(selection?.runtime, selection?.effort)',
    );
    expect(orchestrator).toContain('getCodexAgentsServer(');
  });
});

describe('heranca NAO se aplica a pipeline/harness/enrich (source-assertion)', () => {
  function grepDirForInheritedEffort(dir: string): string[] {
    const hits: string[] = [];
    for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf-8' })) {
      if (!entry.endsWith('.ts') || entry.includes('__tests__')) continue;
      const src = readFileSync(join(dir, entry), 'utf-8');
      if (src.includes('inheritedEffort')) hits.push(entry);
    }
    return hits;
  }

  it('pipeline-engine e pipeline-shared nao referenciam inheritedEffort', () => {
    expect(grepDirForInheritedEffort(join(MAIN_DIR, 'pipeline-engine'))).toEqual([]);
    expect(grepDirForInheritedEffort(join(MAIN_DIR, 'pipeline-shared'))).toEqual([]);
  });

  it('harness-engine e enrich (harness-*.ts) nao referenciam inheritedEffort', () => {
    for (const file of ['harness-engine.ts', 'harness-planner.ts', 'harness-evaluator.ts']) {
      const src = readFileSync(join(MAIN_DIR, file), 'utf-8');
      expect(src.includes('inheritedEffort')).toBe(false);
    }
  });

  it('os UNICOS producers de inheritedEffort no main sao os chokepoints do chat', () => {
    const producers = [
      join(MAIN_DIR, 'orchestrator.ts'),
      join(MAIN_DIR, 'claude-compat-sdk', 'index.ts'),
      join(MAIN_DIR, 'lion-sdk', 'index.ts'),
      join(MAIN_DIR, 'lion-sdk', 'tools', 'agent.ts'),
      join(MAIN_DIR, 'kimi-sdk', 'session.ts'),
      join(MAIN_DIR, 'grok-sdk', 'session.ts'),
      join(MAIN_DIR, 'local-ipc', 'jsonrpc-methods.ts'),
    ];
    for (const p of producers) {
      expect(readFileSync(p, 'utf-8').includes('inheritedEffort')).toBe(true);
    }
  });
});

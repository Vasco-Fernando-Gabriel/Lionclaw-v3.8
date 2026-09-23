import { describe, it, expect, vi } from 'vitest';
import type { AgentConfig } from '../../../src/types';
import type { AgentExecutionRequest, AgentExecutionResult, RuntimeExecutor } from '../agent-runtime/types';

vi.mock('../agent-runtime/cloud-executor', () => ({ cloudExecutor: { run: vi.fn() } }));
vi.mock('../agent-runtime/zai-executor', () => ({ zaiExecutor: { run: vi.fn() } }));
vi.mock('../agent-runtime/minimax-tokenplan-executor', () => ({
  minimaxTokenplanExecutor: { run: vi.fn() },
}));
vi.mock('../agent-runtime/codex-executor', () => ({ codexExecutor: { run: vi.fn() } }));
vi.mock('../agent-runtime/local-executor', () => ({ localExecutor: { run: vi.fn() } }));
vi.mock('../agent-runtime/external-executor', () => ({ externalExecutor: { run: vi.fn() } }));

vi.mock('../agent-runtime/watchdog', () => ({
  WATCHDOG_TIMEOUT_MS: 180_000,
  createWatchdog: () => ({
    reset: vi.fn(),
    stop: vi.fn(),
    wrapOnText: (cb?: (c: string) => void) => cb ?? ((): void => {}),
    wrapOnThinking: (cb?: (c: string) => void) => cb ?? ((): void => {}),
    wrapOnToolUse: (cb?: (t: string) => void) => cb ?? ((): void => {}),
    wrapOnToolUseComplete: (cb?: (t: string, i: unknown) => void) => cb ?? ((): void => {}),
    wrapOnActivity: (cb?: () => void) => cb ?? ((): void => {}),
  }),
}));

vi.mock('../db', () => ({ getAgent: vi.fn(() => undefined) }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildNarratorQueryConfig, executeNarrator } from '../dynamic-workflows/workflow-narrator-executor';
import { DYNAMIC_WORKFLOW_MAESTRO_ID } from '../seed-agents/dynamic-workflow-builder';

function narratorSeed(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: DYNAMIC_WORKFLOW_MAESTRO_ID,
    name: 'Dynamic Workflow Maestro',
    description: 'voz do Maestro (narrador)',
    systemPrompt: 'PROMPT_DO_SEED_DO_NARRADOR',
    model: 'claude-sonnet-4-6',
    allowedTools: ['Read', 'Glob', 'Grep'],
    mcpServers: [],
    isActive: true,
    sortOrder: 0,
    effort: 'high',
    thinking: 'adaptive',
    thinkingBudget: 6000,
    maxTurns: 80,
    skills: [],
    runtime: 'cloud',
    localMode: 'simple',
    maxToolRounds: 40,
    squad: 'dynamic-workflow',
    ...overrides,
  };
}

describe('buildNarratorQueryConfig - leanness + zero poder (fechamento S2)', () => {
  it('systemPrompt = SO o do seed (sem prefixo de RULES.md global)', () => {
    const config = buildNarratorQueryConfig(narratorSeed());
    expect(config.systemPrompt).toBe('PROMPT_DO_SEED_DO_NARRADOR');
  });

  it('SEM NENHUM MCP server: nem dominio, nem KB, nem skills', () => {
    const config = buildNarratorQueryConfig(narratorSeed());
    expect(config.mcpServers).toEqual([]);
  });

  it('tools = SO as de leitura do seed (nenhuma tool MCP)', () => {
    const config = buildNarratorQueryConfig(narratorSeed());
    expect(config.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('config de narracao NAO contem nenhuma tool de escrita/controle do dominio', () => {
    const config = buildNarratorQueryConfig(narratorSeed());
    const forbidden = /approve|intervene|author|edit_coordinator|abort|reply|inspect|Write|Edit|Bash/;
    for (const tool of config.allowedTools) {
      expect(tool, `tool proibida num turno de narracao: ${tool}`).not.toMatch(forbidden);
    }
    expect(config.mcpServers).toHaveLength(0);
  });

  it('model = o model configurado no agent (editavel em SubAgents, nunca hardcoded)', () => {
    expect(buildNarratorQueryConfig(narratorSeed()).model).toBe('claude-sonnet-4-6');
    expect(buildNarratorQueryConfig(narratorSeed({ model: 'claude-opus-4-8' })).model).toBe('claude-opus-4-8');
  });

  it('o codigo morto do Maestro-controlador nao existe mais no modulo (exports honestos)', async () => {
    const mod = await import('../dynamic-workflows/workflow-narrator-executor');
    expect('executeMaestro' in mod).toBe(false);
    expect('buildMaestroQueryConfig' in mod).toBe(false);
    expect('MAESTRO_EDIT_MODEL_DEFAULT' in mod).toBe(false);
    expect('executeNarrator' in mod).toBe(true);
    expect('buildNarratorQueryConfig' in mod).toBe(true);
  });
});

describe('executeNarrator - despacho dedicado (sem executeAgent)', () => {
  function fakeResult(model: string): AgentExecutionResult {
    return {
      output: 'ok',
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        toolUses: 0,
        apiRequests: 0,
        costUsd: 0,
        durationMs: 0,
      },
      model,
      runtime: 'cloud',
      provider: 'anthropic',
    };
  }

  it('despacha para o executor do runtime do seed com o config MINIMO', async () => {
    const captured: { req?: AgentExecutionRequest; cfg?: unknown } = {};
    const cloud: RuntimeExecutor = {
      run: vi.fn(async (req, cfg) => {
        captured.req = req;
        captured.cfg = cfg;
        return fakeResult('claude-sonnet-4-6');
      }),
    };

    const res = await executeNarrator(
      { prompt: 'digest do marco', cwd: '/tmp/run-1' },
      {
        getAgent: () => narratorSeed(),
        runtimeExecutors: { cloud },
      },
    );

    expect(res.output).toBe('ok');
    expect(cloud.run).toHaveBeenCalledTimes(1);
    const cfg = captured.cfg as { systemPrompt: string; mcpServers: unknown[] };
    expect(cfg.systemPrompt).toBe('PROMPT_DO_SEED_DO_NARRADOR');
    expect(cfg.mcpServers).toEqual([]);
    expect(captured.req?.prompt).toBe('digest do marco');
    expect(captured.req?.cwd).toBe('/tmp/run-1');
  });

  it('respeita o runtime do seed (codex usa o executor codex)', async () => {
    const codex: RuntimeExecutor = { run: vi.fn(async () => fakeResult('codex-model')) };
    const cloud: RuntimeExecutor = { run: vi.fn(async () => fakeResult('cloud-model')) };
    await executeNarrator(
      { prompt: 'p', cwd: '/tmp' },
      {
        getAgent: () => narratorSeed({ runtime: 'codex' }),
        runtimeExecutors: { codex, cloud },
      },
    );
    expect(codex.run).toHaveBeenCalledTimes(1);
    expect(cloud.run).not.toHaveBeenCalled();
  });

  it('lanca erro visivel se o agent vier sem model resolvido', async () => {
    const cloud: RuntimeExecutor = { run: vi.fn(async () => fakeResult('nunca')) };
    await expect(
      executeNarrator(
        { prompt: 'p', cwd: '/tmp' },
        {
          getAgent: () => narratorSeed({ model: '   ' }),
          runtimeExecutors: { cloud },
        },
      ),
    ).rejects.toThrow(/sem model resolvido/);
    expect(cloud.run).not.toHaveBeenCalled();
  });

  it('lanca se o seed do narrador nao existir', async () => {
    await expect(executeNarrator({ prompt: 'p', cwd: '/tmp' }, { getAgent: () => undefined })).rejects.toThrow(
      /Narrador seed nao encontrado/,
    );
  });
});

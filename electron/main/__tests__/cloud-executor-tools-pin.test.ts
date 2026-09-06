
import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../db', () => ({
  getSetting: vi.fn(),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(),
}));

import { buildClaudeQueryOptions } from '../agent-runtime/cloud-executor';
import { buildZaiQueryOptions } from '../agent-runtime/zai-executor';
import { buildMinimaxTpQueryOptions } from '../agent-runtime/minimax-tokenplan-executor';
import { PERM_BYPASS_NO_GUARD } from '../agent-runtime/permission-profiles';
import { SDK_DISALLOWED_TOOLS, TASK_TOOL_NAMES } from '../agent-runtime/sdk-tool-names';
import type { AgentExecutionRequest } from '../agent-runtime/types';
import type { AgentQueryConfig } from '../agent-config-resolver';

function makeReq(): AgentExecutionRequest {
  return {
    agentId: 'pin-agent',
    prompt: 'Do the thing',
    cwd: '/tmp/project',
    abortController: new AbortController(),
    permission: PERM_BYPASS_NO_GUARD,
  };
}

function makeConfig(runtime: string, model: string, allowedTools: string[]): AgentQueryConfig {
  return {
    model,
    systemPrompt: 'prompt',
    allowedTools,
    mcpServers: [],
    maxTurns: undefined,
    effort: undefined,
    thinking: undefined,
    runtime,
  } as unknown as AgentQueryConfig;
}

const WITH_TODO = ['Read', 'TodoWrite', 'Edit', 'mcp__lionclaw-kanban__board_list'];
const WITHOUT_TODO = ['Read', 'Glob', 'Grep', 'Bash'];
const MAPPED_WITH_TODO = ['Read', ...TASK_TOOL_NAMES, 'Edit', 'mcp__lionclaw-kanban__board_list'];

type Builder = (allowedTools: string[]) => Record<string, unknown>;

const builders: Array<[string, Builder]> = [
  [
    'cloud (buildClaudeQueryOptions)',
    (allowedTools) =>
      buildClaudeQueryOptions(
        makeReq(),
        makeConfig('cloud', 'claude-sonnet-4-5', allowedTools),
        '/tmp/claude.exe',
        new AbortController(),
      ),
  ],
  [
    'zai (buildZaiQueryOptions)',
    (allowedTools) =>
      buildZaiQueryOptions(
        makeReq(),
        makeConfig('zai', 'glm-5.2', allowedTools),
        '/tmp/claude.exe',
        new AbortController(),
        'sk-zai',
      ),
  ],
  [
    'minimax-tp (buildMinimaxTpQueryOptions)',
    (allowedTools) =>
      buildMinimaxTpQueryOptions(
        makeReq(),
        makeConfig('minimax-tp', 'MiniMax-M2.7', allowedTools),
        '/tmp/claude.exe',
        new AbortController(),
        'sk-minimax',
      ),
  ],
];

describe.each(builders)('builder %s — pin de ferramentas (D7/D8)', (_label, build) => {
  it('NAO emite lista positiva `tools`', () => {
    const opts = build(WITH_TODO);
    expect('tools' in opts).toBe(false);
  });

  it('emite disallowedTools IGUAL a SDK_DISALLOWED_TOOLS (copia mutavel, mesma ordem)', () => {
    const opts = build(WITH_TODO);
    expect(opts.disallowedTools).toEqual([...SDK_DISALLOWED_TOOLS]);
    expect(opts.disallowedTools).not.toBe(SDK_DISALLOWED_TOOLS);
    expect(Object.isFrozen(opts.disallowedTools)).toBe(false);
  });

  it('allowedTools = entrada com TodoWrite -> Task tools, nada mais alterado', () => {
    const opts = build(WITH_TODO);
    expect(opts.allowedTools).toEqual(MAPPED_WITH_TODO);
    expect((opts.allowedTools as string[]).length).toBe(WITH_TODO.length - 1 + TASK_TOOL_NAMES.length);
  });

  it('allowedTools sem TodoWrite e byte-identica a entrada', () => {
    const opts = build(WITHOUT_TODO);
    expect(opts.allowedTools).toEqual(WITHOUT_TODO);
  });

  it('allowedTools [] -> []', () => {
    const opts = build([]);
    expect(opts.allowedTools).toEqual([]);
  });

  it('mantem pathToClaudeCodeExecutable no builder (F21)', () => {
    const opts = build(WITHOUT_TODO);
    expect(opts.pathToClaudeCodeExecutable).toBe('/tmp/claude.exe');
  });
});

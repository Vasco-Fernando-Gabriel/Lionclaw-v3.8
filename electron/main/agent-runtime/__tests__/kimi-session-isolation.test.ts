
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dispatchLionSubagentSpy = vi.hoisted(() => vi.fn());

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@moonshot-ai/kimi-agent-sdk', () => ({
  createExternalTool: (def: { name: string; description: string; handler: unknown }) => ({
    name: def.name,
    description: def.description,
    parameters: {},
    handler: def.handler,
  }),
}));

vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async () => ({
    'memory-search': { command: 'node', args: ['memory.js'] },
  })),
  getMCPToolsFromRegistry: vi.fn(() => ['mcp__memory-search__search']),
}));

vi.mock('../../db', () => ({
  getSetting: vi.fn((key: string) => (key === 'mcp_prompt_mode' ? 'full' : undefined)),
}));

const executeAgentSpy = vi.fn(async (req: { cwd: string }) => ({
  output: `ran in ${req.cwd}`,
  model: 'kimi-code/kimi-for-coding',
  runtime: 'kimi' as const,
  provider: 'kimi',
  metrics: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolUses: 0,
    apiRequests: 1,
    costUsd: 0,
    durationMs: 1,
  },
}));

vi.mock('../execute', () => ({
  executeAgent: (req: { cwd: string }) => executeAgentSpy(req),
}));

vi.mock('../permission-profiles', () => ({
  PERM_BYPASS_NO_GUARD: { mode: 'bypassPermissions', dangerouslySkipPermissions: true },
}));

vi.mock('../subagent-dispatch', () => ({
  dispatchLionSubagent: async (
    input: unknown,
    host: { workspace: { cwd: string } },
  ) => {
    dispatchLionSubagentSpy(input);
    const result = await executeAgentSpy({ cwd: host.workspace.cwd });
    return {
      ok: true,
      executionId: 'exec-test',
      output: result.output,
      model: result.model,
      runtime: result.runtime,
      costUsd: 0,
    };
  },
}));

import {
  buildKimiSessionTools,
  stripUnmaterializedToolInstructions,
  type KimiToolProfile,
} from '../kimi-session-config';
import { KIMI_SUBAGENT_TOOL_NAME } from '../kimi-external-tools';
import type { AgentQueryConfig } from '../../agent-config-resolver';
import type { KimiAcpMcpServerEntry, KimiAcpProfile } from '../../kimi-acp/types';

function materializeMcpServers(
  _profile: KimiAcpProfile,
  opts: { mcpServers?: KimiAcpMcpServerEntry[] } = {},
): KimiAcpMcpServerEntry[] {
  return opts.mcpServers ?? [];
}

function makeConfig(overrides: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    model: 'kimi-code/kimi-for-coding',
    systemPrompt: 'Voce e um agente.',
    allowedTools: [],
    mcpServers: [],
    maxTurns: undefined,
    effort: 'medium',
    thinking: 'adaptive',
    thinkingBudget: undefined,
    runtime: 'kimi',
    ...overrides,
  };
}

function buildArgs(profile: KimiToolProfile, cwd: string) {
  const abortController = new AbortController();
  return {
    profile,
    config: makeConfig(),
    cwd,
    abortController,
    dispatchContext: {
      ownerKind: 'chat' as const,
      ownerId: `session:${cwd}`,
      sessionId: `session:${cwd}`,
      lane: 'desktop' as const,
      surface: 'test',
      workspace: { cwd, readRoots: [cwd], writeRoots: [] },
      permission: { mode: 'default' as const, dangerouslySkipPermissions: false },
      parentAbortSignal: abortController.signal,
      rootExecutionId: `root:${cwd}`,
      parentExecutionId: `root:${cwd}`,
      depth: 0,
      remainingBudget: 1,
      budgetState: { remaining: 1 },
      capabilityCeiling: { allowedTools: ['Agent'], allowedMcpServerIds: [] },
    },
  };
}

describe('Kimi per-session isolation (DONE CRITERION, SPEC-011 §11 Fase B / §13)', () => {
  beforeEach(() => {
    executeAgentSpy.mockClear();
    dispatchLionSubagentSpy.mockClear();
  });

  it('two concurrent sessions do not leak tools and honor prompt honesty', async () => {
    const argsA = buildArgs('chat', '/work/sessionA');
    const argsB = buildArgs('pipeline', '/work/sessionB');

    const [sessionA, sessionB] = await Promise.all([
      buildKimiSessionTools(argsA),
      buildKimiSessionTools(argsB),
    ]);

    const namesA = new Set(sessionA.externalTools.map((t) => t.name));
    const namesB = new Set(sessionB.externalTools.map((t) => t.name));

    expect(sessionB.externalTools.length).toBe(0);
    expect(namesB.size).toBe(0);

    expect(namesA.size).toBeGreaterThan(0);
    for (const n of namesB) expect(namesA.has(n)).toBe(true);
    expect(namesA.size).toBeGreaterThan(namesB.size);

    expect(sessionA.externalTools).not.toBe(sessionB.externalTools);

    const subagentTool = sessionA.externalTools.find((t) => t.name === KIMI_SUBAGENT_TOOL_NAME);
    expect(subagentTool).toBeDefined();
    const result = await subagentTool!.handler(
      { agentId: 'harness-coder', prompt: 'do work' },
      { transportCorrelation: { kind: 'mcp-request-id', value: '52' } },
    );
    expect(executeAgentSpy).toHaveBeenCalledTimes(1);
    expect(executeAgentSpy.mock.calls[0][0].cwd).toBe('/work/sessionA');
    expect(executeAgentSpy.mock.calls[0][0].cwd).not.toBe('/work/sessionB');
    expect(result.output).toContain('/work/sessionA');
    expect(dispatchLionSubagentSpy).toHaveBeenCalledWith(expect.objectContaining({
      transportCorrelation: { kind: 'mcp-request-id', value: '52' },
    }));
    expect(dispatchLionSubagentSpy.mock.calls[0]![0]).not.toHaveProperty('toolUseId');

    assertNoUnannouncedTool(sessionA.systemPrompt, namesA);
    assertNoUnannouncedTool(sessionB.systemPrompt, namesB);

    const mcpA = materializeMcpServers('chat');
    const mcpB = materializeMcpServers('pipeline');
    expect(mcpA).toEqual([]);
    expect(mcpB).toEqual([]);
  });

  it('concurrent builds with skills announcements: chat keeps it, pipeline strips it', async () => {
    const skillsBlock = `## Skills Disponiveis (via MCP)
- mcp__skills__list_skills: lista
- mcp__skills__load_skill: carrega
- mcp__skills__get_skill_metadata: meta
Skills vinculadas a voce: foo`;

    const mcpManager = await import('../../mcp-manager');
    (mcpManager.getMCPConfigForAgent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue?.({
      'memory-search': { command: 'node', args: ['memory.js'] },
      'skills': { command: 'node', args: ['skills.js'] },
    });
    (mcpManager.getMCPToolsFromRegistry as unknown as { mockImplementation: (f: (ids: string[]) => string[]) => void }).mockImplementation?.((ids: string[]) => {
      const map: Record<string, string[]> = {
        'memory-search': ['mcp__memory-search__search'],
        'skills': ['mcp__skills__list_skills', 'mcp__skills__load_skill', 'mcp__skills__get_skill_metadata'],
      };
      const out: string[] = [];
      for (const id of ids) out.push(...(map[id] ?? []));
      return out;
    });

    const cfgChat: AgentQueryConfig = makeConfig({ systemPrompt: `H.\n\n${skillsBlock}` });
    const cfgPipe: AgentQueryConfig = makeConfig({ systemPrompt: `H.\n\n${skillsBlock}` });

    const [chat, pipe] = await Promise.all([
      buildKimiSessionTools({ profile: 'chat', config: cfgChat, cwd: '/a', abortController: new AbortController() }),
      buildKimiSessionTools({ profile: 'pipeline', config: cfgPipe, cwd: '/b', abortController: new AbortController() }),
    ]);

    const chatNames = new Set(chat.externalTools.map((t) => t.name));
    expect(chatNames.has('mcp__skills__load_skill')).toBe(true);
    expect(chat.systemPrompt).toContain('## Skills Disponiveis (via MCP)');
    assertNoUnannouncedTool(chat.systemPrompt, chatNames);

    expect(pipe.externalTools.length).toBe(0);
    expect(pipe.systemPrompt).not.toContain('## Skills Disponiveis (via MCP)');
    expect(pipe.systemPrompt).not.toContain('mcp__skills__load_skill');
    assertNoUnannouncedTool(pipe.systemPrompt, new Set());
  });

  it('AC-S7.6: agent-scoped with a non-empty mcp allowlist materializes mcpServers:[] and the prompt strips those allowlist tool names (regression GATED, not orphan)', async () => {
    const allowlist = ['mcp__memory-search__search', 'mcp__skills__load_skill'];
    const promptAnnouncing =
      'Voce e um agente.\n\n' +
      '## Ferramentas\n' +
      '- mcp__memory-search__search: busca memoria\n' +
      '- mcp__skills__load_skill: carrega skill';

    const cfgAgent: AgentQueryConfig = makeConfig({
      allowedTools: allowlist,
      systemPrompt: promptAnnouncing,
    });
    const agentScoped = await buildKimiSessionTools({
      profile: 'agent-scoped',
      config: cfgAgent,
      cwd: '/work/agent',
      abortController: new AbortController(),
    });

    const inProcessNames = new Set(agentScoped.externalTools.map((t) => t.name));
    expect(inProcessNames.has('mcp__memory-search__search')).toBe(true);
    expect(inProcessNames.has('mcp__skills__load_skill')).toBe(true);

    const materializedMcp = materializeMcpServers('agent-scoped');
    expect(materializedMcp).toEqual([]);

    const wireMaterializedNames = new Set(materializedMcp.map((e) => e.id));
    const reconciledForWire = stripUnmaterializedToolInstructions(
      agentScoped.systemPrompt,
      wireMaterializedNames,
    );
    expect(reconciledForWire).not.toContain('mcp__memory-search__search');
    expect(reconciledForWire).not.toContain('mcp__skills__load_skill');
    assertNoUnannouncedTool(reconciledForWire, wireMaterializedNames);
  });
});

function assertNoUnannouncedTool(systemPrompt: string, names: Set<string>): void {
  const mentioned = systemPrompt.match(/mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+/g) ?? [];
  for (const tool of mentioned) {
    expect(names.has(tool), `prompt announces unmaterialized tool: ${tool}`).toBe(true);
  }
}

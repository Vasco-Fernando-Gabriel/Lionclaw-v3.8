import { describe, it, expect, vi, beforeEach } from 'vitest';

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

let mockCatalogConfig: Record<string, { command: string; args: string[]; env?: Record<string, string> }> | undefined;
let mockRegistryTools: Record<string, string[]>;
let mockRepoCtx: RepoChatContext | null = null;

vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async () => mockCatalogConfig),
  getMCPToolsFromRegistry: vi.fn((ids: string[]) => {
    const out: string[] = [];
    for (const id of ids) out.push(...(mockRegistryTools[id] ?? []));
    return out;
  }),
}));

vi.mock('../../db', () => ({
  getSetting: vi.fn((key: string) => (key === 'mcp_prompt_mode' ? 'full' : undefined)),
}));

vi.mock('../../repo-graph/turn-context', () => ({
  getRepoGraphTurnContext: vi.fn(() => mockRepoCtx),
}));

import {
  buildKimiSessionTools,
  stripUnmaterializedToolInstructions,
  type KimiToolProfile,
} from '../kimi-session-config';
import { KIMI_SUBAGENT_TOOL_NAME, KIMI_USER_QUESTION_TOOL_NAME } from '../kimi-external-tools';
import type { AgentQueryConfig } from '../../agent-config-resolver';
import type { RepoChatContext } from '../../repo-graph/turn-context';

const SKILLS_BLOCK = `## Skills Disponiveis (via MCP)
Voce tem acesso ao MCP server de skills com as seguintes tools:
- mcp__skills__list_skills: lista todas as skills disponiveis (aceita filtro por categoria)
- mcp__skills__load_skill: carrega o conteudo completo de uma skill pelo nome
- mcp__skills__get_skill_metadata: retorna metadados de uma skill sem o conteudo completo

Skills vinculadas a voce: foo
Quando a tarefa exigir uma dessas skills, use load_skill para carregar o conteudo e siga as instrucoes da skill.`;

const SKILLS_TOOLS = ['mcp__skills__list_skills', 'mcp__skills__load_skill', 'mcp__skills__get_skill_metadata'];

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

function args(profile: KimiToolProfile, config: AgentQueryConfig) {
  return { profile, config, cwd: '/tmp/work', abortController: new AbortController(), sessionId: 'sess-1' };
}

describe('buildKimiSessionTools - per-profile gate (SPEC-011 §9)', () => {
  beforeEach(() => {
    mockCatalogConfig = {
      'memory-search': { command: 'node', args: ['memory.js'] },
    };
    mockRegistryTools = {
      'memory-search': ['mcp__memory-search__search', 'mcp__memory-search__get'],
      'skills': SKILLS_TOOLS,
    };
  });

  it('(a) chat profile materializes subagent-trigger + user-question + >=1 catalog tool', async () => {
    const { externalTools } = await buildKimiSessionTools(args('chat', makeConfig()));
    const names = externalTools.map((t) => t.name);
    expect(names).toContain(KIMI_SUBAGENT_TOOL_NAME);
    expect(names).toContain(KIMI_USER_QUESTION_TOOL_NAME);
    expect(names.some((n) => n.startsWith('mcp__memory-search__'))).toBe(true);
    expect(externalTools.length).toBeGreaterThanOrEqual(3);
  });

  it('(b) pipeline profile => externalTools.length === 0', async () => {
    const { externalTools } = await buildKimiSessionTools(args('pipeline', makeConfig()));
    expect(externalTools.length).toBe(0);
  });

  it('(b2) pipeline materializa subagente somente com contexto host e Agent allowlisted', async () => {
    const abortController = new AbortController();
    const dispatchContext = {
      ownerKind: 'pipeline' as const,
      ownerId: 'project-1',
      lane: 'pipeline' as const,
      surface: 'pipeline:phase:13',
      workspace: {
        cwd: '/tmp/work',
        projectId: 'project-1',
        readRoots: ['/tmp/work'],
        writeRoots: ['/tmp/work'],
      },
      permission: { mode: 'bypassPermissions' as const, dangerouslySkipPermissions: true },
      parentAbortSignal: abortController.signal,
      rootExecutionId: 'root-1',
      parentExecutionId: 'root-1',
      depth: 0,
      remainingBudget: 4,
      budgetState: { remaining: 4 },
      capabilityCeiling: { allowedTools: ['Read', 'Agent'], allowedMcpServerIds: [] },
    };
    const denied = await buildKimiSessionTools({
      ...args('pipeline', makeConfig({ allowedTools: ['Read'] })),
      dispatchContext,
    });
    expect(denied.externalTools.map((tool) => tool.name)).not.toContain(KIMI_SUBAGENT_TOOL_NAME);

    const allowed = await buildKimiSessionTools({
      ...args('pipeline', makeConfig({ allowedTools: ['Read', 'Agent'] })),
      dispatchContext,
    });
    expect(allowed.externalTools.map((tool) => tool.name)).toEqual([KIMI_SUBAGENT_TOOL_NAME]);
    expect(allowed.systemPrompt).toContain(KIMI_SUBAGENT_TOOL_NAME);
  });

  it('(c) one-shot profile => externalTools.length === 0', async () => {
    const { externalTools } = await buildKimiSessionTools(args('one-shot', makeConfig()));
    expect(externalTools.length).toBe(0);
  });

  it('(d) agent-scoped => only the mcp__ allowlist entries materialized, builtins skipped', async () => {
    const config = makeConfig({ allowedTools: ['Read', 'Edit', 'mcp__memory-search__search'] });
    const { externalTools } = await buildKimiSessionTools(args('agent-scoped', config));
    const names = externalTools.map((t) => t.name).sort();
    expect(names).toEqual(['mcp__memory-search__search']);
    expect(names).not.toContain('Read');
    expect(names).not.toContain('Edit');
    expect(names).not.toContain(KIMI_SUBAGENT_TOOL_NAME);
    expect(names).not.toContain(KIMI_USER_QUESTION_TOOL_NAME);
  });

  it('(e) honesty (strip): pipeline profile drops the announced mcp__skills__* block', async () => {
    const config = makeConfig({ systemPrompt: `Voce e um agente.\n\n${SKILLS_BLOCK}` });
    const { externalTools, systemPrompt } = await buildKimiSessionTools(args('pipeline', config));
    expect(externalTools.length).toBe(0);
    for (const tool of SKILLS_TOOLS) {
      expect(systemPrompt).not.toContain(tool);
    }
    expect(systemPrompt).not.toContain('## Skills Disponiveis (via MCP)');
    expect(systemPrompt).toContain('Voce e um agente.');
  });

  it('(f) honesty (keep): agent-scoped with all skills tools => materialized AND announcement kept', async () => {
    const config = makeConfig({
      allowedTools: [...SKILLS_TOOLS],
      systemPrompt: `Voce e um agente.\n\n${SKILLS_BLOCK}`,
    });
    const { externalTools, systemPrompt } = await buildKimiSessionTools(args('agent-scoped', config));
    const names = externalTools.map((t) => t.name);
    for (const tool of SKILLS_TOOLS) {
      expect(names).toContain(tool);
      expect(systemPrompt).toContain(tool);
    }
    expect(systemPrompt).toContain('## Skills Disponiveis (via MCP)');
  });

  it('(f2) honesty (keep): chat with skills in the catalog => materialized AND announcement kept', async () => {
    mockCatalogConfig = {
      'memory-search': { command: 'node', args: ['memory.js'] },
      'skills': { command: 'node', args: ['skills.js'] },
    };
    const config = makeConfig({ systemPrompt: `Voce e um agente.\n\n${SKILLS_BLOCK}` });
    const { externalTools, systemPrompt } = await buildKimiSessionTools(args('chat', config));
    const names = externalTools.map((t) => t.name);
    for (const tool of SKILLS_TOOLS) {
      expect(names).toContain(tool);
    }
    expect(systemPrompt).toContain('## Skills Disponiveis (via MCP)');
  });

  it('(e2) honesty (strip generic): pipeline profile drops a NON-skills mcp__ mention from the prompt body', async () => {
    const prompt = [
      'Voce e um agente.',
      '',
      '## Memoria',
      'Use mcp__memory-search__search para buscar contexto antes de responder.',
      '',
      '## Encerramento',
      'Finalize com um resumo.',
    ].join('\n');
    const config = makeConfig({ systemPrompt: prompt });
    const { externalTools, systemPrompt } = await buildKimiSessionTools(args('pipeline', config));
    expect(externalTools.length).toBe(0);
    expect(systemPrompt).not.toContain('mcp__memory-search__search');
    expect(systemPrompt).not.toContain('## Memoria');
    expect(systemPrompt).toContain('Voce e um agente.');
    expect(systemPrompt).toContain('## Encerramento');
    const leaked = systemPrompt.match(/mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+/g) ?? [];
    expect(leaked).toEqual([]);
  });

  it('(e3) honesty (strip generic): a stray mcp__ mention on a bare line (no header) is stripped to the line', async () => {
    const prompt = 'Intro.\nChame mcp__foo__bar quando precisar.\nFim.';
    const config = makeConfig({ systemPrompt: prompt });
    const { systemPrompt } = await buildKimiSessionTools(args('one-shot', config));
    expect(systemPrompt).not.toContain('mcp__foo__bar');
    expect(systemPrompt).toContain('Intro.');
    expect(systemPrompt).toContain('Fim.');
  });

  it('(e4) honesty (strip) preserves a header-less trailing paragraph after the skills block (Finding 1, DECIDIDO invite)', async () => {
    const DECIDIDO_INVITE =
      'Sempre que voce concluir uma alteracao no documento, encerre sua mensagem perguntando ao usuario se ele deseja fazer mais alguma alteracao ou se pode clicar em APROVAR para avancar para a proxima etapa.';
    const config = makeConfig({ systemPrompt: `Voce e um agente.\n\n${SKILLS_BLOCK}\n\n${DECIDIDO_INVITE}` });
    const { externalTools, systemPrompt } = await buildKimiSessionTools(args('pipeline', config));
    expect(externalTools.length).toBe(0);
    expect(systemPrompt).not.toContain('## Skills Disponiveis (via MCP)');
    for (const tool of SKILLS_TOOLS) {
      expect(systemPrompt).not.toContain(tool);
    }
    expect(systemPrompt).toContain('APROVAR');
    expect(systemPrompt).toContain(DECIDIDO_INVITE);
    expect(systemPrompt).toContain('Voce e um agente.');
  });

  it('(g) bogus profile throws at the never-guard default', async () => {
    await expect(buildKimiSessionTools(args('bogus' as unknown as KimiToolProfile, makeConfig()))).rejects.toThrow(
      /unhandled KimiToolProfile/,
    );
  });

  it('(h) appends the kimi-only AgentSwarm steering; mentions lion_run_subagent ONLY when materialized', async () => {
    expect(makeConfig().systemPrompt).not.toContain('AgentSwarm');

    const chat = await buildKimiSessionTools(args('chat', makeConfig()));
    expect(chat.systemPrompt).toContain('AgentSwarm');
    expect(chat.systemPrompt).toContain(KIMI_SUBAGENT_TOOL_NAME);

    const pipe = await buildKimiSessionTools(args('pipeline', makeConfig()));
    expect(pipe.systemPrompt).toContain('AgentSwarm');
    expect(pipe.systemPrompt).not.toContain(KIMI_SUBAGENT_TOOL_NAME);
  });
});

describe('stripUnmaterializedToolInstructions - pure function', () => {
  it('strips the skills block when no skills tool is materialized', () => {
    const prompt = `Header.\n\n${SKILLS_BLOCK}\n\n## Outra Secao\ntexto`;
    const out = stripUnmaterializedToolInstructions(prompt, new Set());
    expect(out).not.toContain('## Skills Disponiveis (via MCP)');
    expect(out).not.toContain('mcp__skills__list_skills');
    expect(out).toContain('## Outra Secao');
    expect(out).toContain('Header.');
  });

  it('keeps the skills block when all three skills tools are materialized', () => {
    const prompt = `Header.\n\n${SKILLS_BLOCK}`;
    const out = stripUnmaterializedToolInstructions(prompt, new Set(SKILLS_TOOLS));
    expect(out).toContain('## Skills Disponiveis (via MCP)');
    expect(out).toContain('mcp__skills__load_skill');
  });

  it('strips when only a SUBSET of skills tools is materialized (block is atomic)', () => {
    const prompt = `Header.\n\n${SKILLS_BLOCK}`;
    const out = stripUnmaterializedToolInstructions(prompt, new Set(['mcp__skills__list_skills']));
    expect(out).not.toContain('## Skills Disponiveis (via MCP)');
  });

  it('keeps a header-less trailing paragraph after the skills block (Finding 1)', () => {
    const DECIDIDO_INVITE =
      'Sempre que voce concluir uma alteracao no documento, encerre sua mensagem perguntando ao usuario se ele deseja fazer mais alguma alteracao ou se pode clicar em APROVAR para avancar para a proxima etapa.';
    const prompt = `${SKILLS_BLOCK}\n\n${DECIDIDO_INVITE}`;
    const out = stripUnmaterializedToolInstructions(prompt, new Set());
    expect(out).not.toContain('## Skills Disponiveis (via MCP)');
    expect(out).not.toContain('mcp__skills__list_skills');
    expect(out).not.toContain('Skills vinculadas a voce');
    expect(out).toContain('APROVAR');
    expect(out).toBe(DECIDIDO_INVITE);
  });

  it('is a no-op for an empty prompt', () => {
    expect(stripUnmaterializedToolInstructions('', new Set())).toBe('');
  });

  it('is a no-op when there is no skills block to strip', () => {
    const prompt = 'Just an agent prompt with no MCP announcement.';
    expect(stripUnmaterializedToolInstructions(prompt, new Set())).toBe(prompt);
  });

  it('strips a non-skills mcp__ block while KEEPING a materialized one (generic sweep)', () => {
    const prompt = [
      'Header.',
      '',
      '## Memoria',
      'Use mcp__memory-search__search para buscar.',
      '',
      '## Busca Web',
      'Use mcp__web__fetch para a web.',
    ].join('\n');
    const out = stripUnmaterializedToolInstructions(prompt, new Set(['mcp__memory-search__search']));
    expect(out).toContain('## Memoria');
    expect(out).toContain('mcp__memory-search__search');
    expect(out).not.toContain('## Busca Web');
    expect(out).not.toContain('mcp__web__fetch');
  });

  it('removes the skills block AND a separate unmaterialized mcp__ block in one call', () => {
    const prompt = ['Header.', '', SKILLS_BLOCK, '', '## Memoria', 'Use mcp__memory-search__search.'].join('\n');
    const out = stripUnmaterializedToolInstructions(prompt, new Set());
    expect(out).not.toContain('## Skills Disponiveis (via MCP)');
    expect(out).not.toContain('## Memoria');
    const leaked = out.match(/mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+/g) ?? [];
    expect(leaked).toEqual([]);
    expect(out).toContain('Header.');
  });
});

describe('buildKimiSessionTools - repo-graph (CodeGraph) steering', () => {
  beforeEach(() => {
    mockCatalogConfig = {
      'repo-graph': { command: 'node', args: ['repo-graph.js'] },
    };
    mockRegistryTools = {
      'repo-graph': [
        'mcp__repo-graph__repo_graph_status',
        'mcp__repo-graph__repo_graph_search',
        'mcp__repo-graph__repo_graph_minimal_context',
      ],
    };
    mockRepoCtx = null;
  });

  it('announces repo-graph when its tools are materialized AND a repo is active this turn', async () => {
    mockRepoCtx = {
      repositoryId: 'r1',
      canonicalRootPath: '/Users/me/proj',
      status: 'ready',
      statsResumo: '260 arquivos, 2815 simbolos',
    };
    const { externalTools, systemPrompt } = await buildKimiSessionTools(args('chat', makeConfig()));
    expect(externalTools.map((t) => t.name)).toContain('mcp__repo-graph__repo_graph_search');
    expect(systemPrompt).toContain('Repositorio ativo da conversa (CodeGraph)');
    expect(systemPrompt).toContain('prefixo mcp__repo-graph__');
    expect(systemPrompt).toContain('mcp__repo-graph__repo_graph_search');
  });

  it('does NOT announce repo-graph when no repo is active this turn (section no-ops)', async () => {
    mockRepoCtx = null;
    const { externalTools, systemPrompt } = await buildKimiSessionTools(args('chat', makeConfig()));
    expect(externalTools.map((t) => t.name)).toContain('mcp__repo-graph__repo_graph_search');
    expect(systemPrompt).not.toContain('Repositorio ativo da conversa (CodeGraph)');
    expect(systemPrompt).not.toContain('prefixo mcp__repo-graph__');
  });

  it('does NOT announce repo-graph for the pipeline profile (no tools materialized)', async () => {
    mockRepoCtx = {
      repositoryId: 'r1',
      canonicalRootPath: '/Users/me/proj',
      status: 'stale',
      statsResumo: null,
    };
    const { externalTools, systemPrompt } = await buildKimiSessionTools(args('pipeline', makeConfig()));
    expect(externalTools).toHaveLength(0);
    expect(systemPrompt).not.toContain('Repositorio ativo da conversa (CodeGraph)');
  });
});

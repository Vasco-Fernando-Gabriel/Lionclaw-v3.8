import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
}));

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => null),
  getSetting: vi.fn((key: string) => state.settings.get(key)),
  getCompletedDocsCount: vi.fn(() => 0),
}));

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: vi.fn(() => [
    {
      id: 'google-gmail',
      name: 'Google Gmail',
      description: 'Email do dono',
      command: 'node',
      args: ['/x/gmail.js'],
      envKeys: [],
      isActive: true,
      visibleTo: 'all',
      indexMode: 'tools',
      status: 'stopped',
    },
    {
      id: 'lion-only-server',
      name: 'Lion Only',
      description: 'Server exclusivo codex/lion',
      command: 'node',
      args: ['/x/lion.js'],
      envKeys: [],
      isActive: true,
      visibleTo: 'codex-lion-only',
      indexMode: 'tools',
      status: 'stopped',
    },
    {
      id: 'claude-only-server',
      name: 'Claude Only',
      description: 'Server invisivel ao codex',
      command: 'node',
      args: ['/x/claude.js'],
      envKeys: [],
      isActive: true,
      visibleTo: 'claude-only',
      indexMode: 'tools',
      status: 'stopped',
    },
    {
      id: 'lionclaw-pipeline-control',
      name: 'LionClaw Pipeline Control',
      description: 'Drive de pipelines',
      command: 'node',
      args: ['/x/pc.js'],
      envKeys: [],
      isActive: true,
      visibleTo: 'all',
      indexMode: 'tools',
      status: 'stopped',
    },
  ]),
  getMcpToolRegistryEntries: vi.fn(() => [
    {
      mcpId: 'google-gmail',
      toolName: 'send_email',
      description: 'Envia um email pela conta do dono',
      inputSchema: null,
      lastDiscoveredAt: '2026-01-01T00:00:00.000Z',
    },
    {
      mcpId: 'lion-only-server',
      toolName: 'lion_tool',
      description: 'Tool do server exclusivo lion',
      inputSchema: null,
      lastDiscoveredAt: '2026-01-01T00:00:00.000Z',
    },
    {
      mcpId: 'claude-only-server',
      toolName: 'claude_secret_tool',
      description: 'Tool invisivel ao codex',
      inputSchema: null,
      lastDiscoveredAt: '2026-01-01T00:00:00.000Z',
    },
  ]),
}));

vi.mock('../skills', () => ({
  buildSkillsPromptSection: vi.fn(() => ''),
  buildAgentSkillsPromptSection: vi.fn(() => ''),
}));

vi.mock('../paths', () => ({
  getLionClawHome: () => '/nonexistent-lionclaw-home-for-tests',
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildSystemPrompt, buildMcpIndexSection, buildCodexMcpIndexSection } from '../prompt-builder';
import {
  GATEWAY_INVOKE_TOOL_NAME,
  CODEX_GATEWAY_INVOKE_TOOL_NAME,
  CODEX_GATEWAY_SCHEMA_TOOL_NAME,
} from '../mcp-display';

const SECTION_HEADER = '## Servidores MCP (indice via gateway)';
const MCP_TOKEN_RE = /mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+/g;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-06T12:00:00.000Z'));
  state.settings = new Map();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildCodexMcpIndexSection — naming flat + visibilidade dentro do builder', () => {
  it('flat naming (fixture item 4): mcp_invoke/mcp_schema e ZERO tokens mcp__ na secao', () => {
    const section = buildCodexMcpIndexSection();
    expect(section).toContain(SECTION_HEADER);
    expect(section).toContain(`${CODEX_GATEWAY_INVOKE_TOOL_NAME}(server, tool, args)`);
    expect(section).toContain(`${CODEX_GATEWAY_SCHEMA_TOOL_NAME}(server, tool)`);
    expect(section.match(MCP_TOKEN_RE) ?? []).toEqual([]);
    expect(section).not.toContain(GATEWAY_INVOKE_TOOL_NAME);
  });

  it("visibilidade AC-C6: 'all' e 'codex-lion-only' entram; valor fora do escopo NAO ganha linha nenhuma", () => {
    const section = buildCodexMcpIndexSection();
    expect(section).toContain('google-gmail');
    expect(section).toContain('lion-only-server');
    expect(section).toContain('lion_tool');
    expect(section).not.toContain('claude-only-server');
    expect(section).not.toContain('claude_secret_tool');
    expect(section).not.toContain('lionclaw-pipeline-control');
  });

  it('claude (sem chatSurface) NAO aplica o filtro de visibilidade — comportamento atual intocado', () => {
    const claudeSection = buildMcpIndexSection();
    expect(claudeSection).toContain('claude-only-server');
    expect(claudeSection).toContain('lion-only-server');
  });

  it("P7: NAO rele o setting — com mcp_prompt_mode='full' o builder codex segue devolvendo o indice (o gate e a composicao do turno)", () => {
    state.settings.set('mcp_prompt_mode', 'full');
    expect(buildMcpIndexSection()).toBe('');
    const section = buildCodexMcpIndexSection();
    expect(section).toContain(SECTION_HEADER);
  });

  it('AC-C9 (shadow-parity): chip OFF nao muda o conteudo de negocio do indice (gated ja e DIRECT)', () => {
    const on = buildCodexMcpIndexSection({ pipelineControl: true, dynamicWorkflows: true });
    const off = buildCodexMcpIndexSection({ pipelineControl: false, dynamicWorkflows: false });
    expect(off).toBe(on);
    expect(off).not.toContain('lionclaw-pipeline-control');
  });
});

describe('buildSystemPrompt — gate codex por codexMcpMode (o gate e o entregavel)', () => {
  it("codex + codexMcpMode 'index': bloco do indice presente com naming flat; nada de mcp__gateway__*", () => {
    const prompt = buildSystemPrompt(undefined, {
      chatSurface: 'codex-sdk',
      codexMcpMode: 'index',
    });
    expect(prompt).toContain(SECTION_HEADER);
    expect(prompt).toContain(`${CODEX_GATEWAY_INVOKE_TOOL_NAME}(server, tool, args)`);
    expect(prompt).not.toContain(GATEWAY_INVOKE_TOOL_NAME);
    expect(prompt).not.toContain('claude_secret_tool');
  });

  it("codex SEM codexMcpMode (ou 'full'): prompt byte-identico ao atual (AC-C5) — sem bloco, memoria legada", () => {
    const before = buildSystemPrompt(undefined, { chatSurface: 'codex-sdk' });
    const full = buildSystemPrompt(undefined, {
      chatSurface: 'codex-sdk',
      codexMcpMode: 'full',
    });
    expect(full).toBe(before);
    expect(full).not.toContain(SECTION_HEADER);
    expect(full).toContain('Voce tem acesso a tool "memory_search"');
    expect(full).not.toContain(`${CODEX_GATEWAY_INVOKE_TOOL_NAME}(server: "memory-search"`);
  });

  it("P8: agentId presente => sem indice mesmo com codexMcpMode 'index'", () => {
    const prompt = buildSystemPrompt('persona-x', {
      chatSurface: 'codex-sdk',
      codexMcpMode: 'index',
    });
    expect(prompt).not.toContain(SECTION_HEADER);
  });

  it("kimi segue FORA do gate mesmo com codexMcpMode 'index' (defensivo)", () => {
    const prompt = buildSystemPrompt(undefined, {
      chatSurface: 'kimi-sdk',
      codexMcpMode: 'index',
    });
    expect(prompt).not.toContain(SECTION_HEADER);
    expect(prompt).toContain('Voce tem acesso a tool "memory_search"');
  });
});

describe('secoes compartilhadas mode-aware (memoria/graph) — golden-set AC-10 de fluxo', () => {
  it('claude modo index (fase 1, regressao corrigida): memoria cita a rota via mcp__gateway__mcp_invoke', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(
      `Ela nao e tool nativa nesta sessao: invoque via ${GATEWAY_INVOKE_TOOL_NAME}(server: "memory-search", tool: "memory_search", args).`,
    );
    expect(prompt).not.toContain('Voce tem acesso a tool "memory_search"');
    expect(prompt).toContain('memoria de longo prazo');
    expect(prompt).toContain('USE ESTA TOOL sempre que:');
  });

  it('claude modo full: texto legado byte-identico (sem rota de meta-tool)', () => {
    state.settings.set('mcp_prompt_mode', 'full');
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Voce tem acesso a tool "memory_search" (MCP server memory-search) que faz busca hibrida');
    expect(prompt).not.toContain('nao e tool nativa nesta sessao');
  });

  it('codex modo index: memoria cita a rota FLAT (mcp_invoke), nunca a claude', () => {
    const prompt = buildSystemPrompt(undefined, {
      chatSurface: 'codex-sdk',
      codexMcpMode: 'index',
    });
    expect(prompt).toContain(
      `Ela nao e tool nativa nesta sessao: invoque via ${CODEX_GATEWAY_INVOKE_TOOL_NAME}(server: "memory-search", tool: "memory_search", args).`,
    );
    expect(prompt).not.toContain(`${GATEWAY_INVOKE_TOOL_NAME}(server: "memory-search"`);
  });

  it('graph_* mode-aware: com mgraph_mode ativo, modo index cita a rota via meta-tool; full mantem o texto legado', () => {
    state.settings.set('mgraph_mode', 'true');
    const indexPrompt = buildSystemPrompt();
    expect(indexPrompt).toContain(
      `que nao sao nativas nesta sessao: invoque via ${GATEWAY_INVOKE_TOOL_NAME}(server: "graph-search", tool: <nome da tool>, args):`,
    );
    expect(indexPrompt).toContain('**graph_search**');
    expect(indexPrompt).toContain('memory-first graph-fallback');

    state.settings.set('mcp_prompt_mode', 'full');
    const fullPrompt = buildSystemPrompt();
    expect(fullPrompt).toContain(
      'Voce tambem tem acesso ao Knowledge Graph via MCP server "graph-search" com as tools:',
    );
    expect(fullPrompt).not.toContain('que nao sao nativas nesta sessao');
  });

  it('codex modo index + mgraph: rota flat no graph tambem', () => {
    state.settings.set('mgraph_mode', 'true');
    const prompt = buildSystemPrompt(undefined, {
      chatSurface: 'codex-sdk',
      codexMcpMode: 'index',
    });
    expect(prompt).toContain(
      `invoque via ${CODEX_GATEWAY_INVOKE_TOOL_NAME}(server: "graph-search", tool: <nome da tool>, args):`,
    );
  });

  it('AC-C9: capabilities OFF no codex index = stub das secoes gated + indice de negocio intacto (shadow-parity)', () => {
    const off = buildSystemPrompt(undefined, {
      chatSurface: 'codex-sdk',
      codexMcpMode: 'index',
      capabilities: { pipelineControl: false, dynamicWorkflows: false },
    });
    expect(off).toContain('## Dirigir Pipelines (DESLIGADO nesta sessao)');
    expect(off).toContain('## Dirigir Workflows Dinamicos (DESLIGADO nesta sessao)');
    expect(off).toContain(SECTION_HEADER);
    expect(off).toContain('google-gmail');
    expect(off).not.toContain('lionclaw-pipeline-control: Drive de pipelines');
  });
});

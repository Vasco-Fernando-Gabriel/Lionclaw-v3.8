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
      mcpId: 'google-gmail',
      toolName: 'search_messages',
      description: 'Busca mensagens na caixa de entrada',
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

import { buildSystemPrompt, buildMcpIndexSection, getMcpPromptMode } from '../prompt-builder';
import { GATEWAY_INVOKE_TOOL_NAME, GATEWAY_SCHEMA_TOOL_NAME } from '../mcp-display';

const SECTION_HEADER = '## Servidores MCP (indice via gateway)';
const MODEL_LINE = /^- Modelo: .*\n/m;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-02T12:00:00.000Z'));
  state.settings = new Map();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getMcpPromptMode / buildMcpIndexSection', () => {
  it("default (chave ausente) e 'index'; 'full' explicito vence", () => {
    expect(getMcpPromptMode()).toBe('index');
    state.settings.set('mcp_prompt_mode', 'full');
    expect(getMcpPromptMode()).toBe('full');
  });

  it('modo index: bloco com meta-tools do gateway + tools do registry, sem tokens mcp__ de negocio', () => {
    const section = buildMcpIndexSection();
    expect(section).toContain(SECTION_HEADER);
    expect(section).toContain(GATEWAY_INVOKE_TOOL_NAME);
    expect(section).toContain(GATEWAY_SCHEMA_TOOL_NAME);
    expect(section).toContain('google-gmail');
    expect(section).toContain('send_email');
    expect(section).not.toContain('lionclaw-pipeline-control');
    const tokens = section.match(/mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+/g) ?? [];
    const offenders = tokens.filter((t) => t !== GATEWAY_INVOKE_TOOL_NAME && t !== GATEWAY_SCHEMA_TOOL_NAME);
    expect(offenders).toEqual([]);
  });

  it("modo full: bloco vazio ('')", () => {
    state.settings.set('mcp_prompt_mode', 'full');
    expect(buildMcpIndexSection()).toBe('');
  });
});

describe('buildSystemPrompt — presenca por modo + byte-parity', () => {
  it('modo index: prompt full-mode contem o bloco', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(SECTION_HEADER);
    expect(prompt).toContain(GATEWAY_INVOKE_TOOL_NAME);
  });

  it('modo full: bloco ausente e prompt byte-identico ao legado (deltas = secao + memoria mode-aware W5)', () => {
    const indexPrompt = buildSystemPrompt();
    const section = buildMcpIndexSection();
    expect(section.length).toBeGreaterThan(0);

    state.settings.set('mcp_prompt_mode', 'full');
    const fullPrompt = buildSystemPrompt();

    expect(fullPrompt).not.toContain(SECTION_HEADER);
    expect(fullPrompt).not.toContain(GATEWAY_INVOKE_TOOL_NAME);
    const indexMemory = [
      'Voce tem acesso a busca "memory_search" (MCP server memory-search) que faz busca hibrida',
      'na sua memoria de longo prazo, combinando BM25 (keywords) + busca vetorial semantica.',
      `Ela nao e tool nativa nesta sessao: invoque via ${GATEWAY_INVOKE_TOOL_NAME}(server: "memory-search", tool: "memory_search", args).`,
    ].join('\n');
    const legacyMemory = [
      'Voce tem acesso a tool "memory_search" (MCP server memory-search) que faz busca hibrida',
      'na sua memoria de longo prazo, combinando BM25 (keywords) + busca vetorial semantica.',
    ].join('\n');
    expect(indexPrompt).toContain(indexMemory);
    expect(fullPrompt).toContain(legacyMemory);
    expect(indexPrompt.replace(`\n\n---\n\n${section}`, '').replace(indexMemory, legacyMemory)).toBe(fullPrompt);
  });

  it('AC-7: troca do setting entre 2 montagens -> a segunda reflete o modo novo', () => {
    const first = buildSystemPrompt();
    expect(first).toContain(SECTION_HEADER);
    state.settings.set('mcp_prompt_mode', 'full');
    const second = buildSystemPrompt();
    expect(second).not.toContain(SECTION_HEADER);
  });
});

describe('buildSystemPrompt — superficies codex/kimi ficam sem o bloco', () => {
  it("chatSurface 'codex-sdk': sem bloco em modo index; identico ao prompt sem a secao, exceto a linha do modelo (7.5)", () => {
    const codexPrompt = buildSystemPrompt(undefined, { chatSurface: 'codex-sdk' });
    expect(codexPrompt).not.toContain(SECTION_HEADER);
    expect(codexPrompt).not.toContain(GATEWAY_INVOKE_TOOL_NAME);
    expect(codexPrompt).not.toMatch(MODEL_LINE);

    state.settings.set('mcp_prompt_mode', 'full');
    const claudeFullPrompt = buildSystemPrompt();
    expect(claudeFullPrompt).toMatch(MODEL_LINE);
    expect(codexPrompt).toBe(claudeFullPrompt.replace(MODEL_LINE, ''));
  });

  it("chatSurface 'kimi-sdk': sem bloco em modo index", () => {
    const kimiPrompt = buildSystemPrompt(undefined, { chatSurface: 'kimi-sdk' });
    expect(kimiPrompt).not.toContain(SECTION_HEADER);
    expect(kimiPrompt).not.toContain(GATEWAY_INVOKE_TOOL_NAME);
  });

  it("chatSurface 'grok-sdk': declara o runtime real sem identidade Claude", () => {
    const grokPrompt = buildSystemPrompt(undefined, { chatSurface: 'grok-sdk' });
    expect(grokPrompt).toContain('Voce roda pelo Grok Build CLI oficial via assinatura');
    expect(grokPrompt).not.toContain('infraestrutura do Claude Agent SDK');
  });

  it('minimal mode (subagentes): nunca carrega o bloco', () => {
    const minimal = buildSystemPrompt(undefined, { mode: 'minimal' });
    expect(minimal).not.toContain(SECTION_HEADER);
    expect(minimal).not.toContain(GATEWAY_INVOKE_TOOL_NAME);
  });

  it('agentId presente (P5): sem bloco em modo index — agente explicito nao tem gateway na sessao', () => {
    const agentPrompt = buildSystemPrompt('agente-p5', { mode: 'full' });
    expect(agentPrompt).not.toContain(SECTION_HEADER);
    expect(agentPrompt).not.toContain(GATEWAY_INVOKE_TOOL_NAME);
  });
});

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
  getAllMCPServers: vi.fn(() => []),
  getMcpToolRegistryEntries: vi.fn(() => []),
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

vi.mock('../tool-script/tool-script-availability', () => ({
  resolveToolScriptRegistration: vi.fn(() => ({ register: false })),
}));

import { buildSystemPrompt } from '../prompt-builder';
import { GATEWAY_INVOKE_TOOL_NAME } from '../mcp-display';

const CURSOR_IDENTITY_LINE =
  'Voce roda pelo agente do Cursor (@cursor/sdk) via assinatura, sob orquestracao do LionClaw. Voce NAO e o Cursor.';
const CLAUDE_IDENTITY_LINE = 'Voce roda sobre a infraestrutura do Claude Agent SDK, mas voce NAO e o Claude Code.';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
  state.settings = new Map();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildSystemPrompt — surface cursor-sdk (F2 item 5)', () => {
  it('identidade: linha da surface Cursor entra e a linha claude-family sai', () => {
    const prompt = buildSystemPrompt(undefined, {
      model: 'composer-2.5',
      chatSurface: 'cursor-sdk',
    });
    expect(prompt).toContain(CURSOR_IDENTITY_LINE);
    expect(prompt).not.toContain(CLAUDE_IDENTITY_LINE);
    expect(prompt).toContain('Nunca se refira a si mesmo como "Claude"');
  });

  it('nunca recebe o bloco do gateway claude, mesmo em modo index (indice proprio via cursor-session-config)', () => {
    state.settings.set('mcp_prompt_mode', 'index');
    const prompt = buildSystemPrompt(undefined, {
      model: 'composer-2.5',
      chatSurface: 'cursor-sdk',
    });
    expect(prompt).not.toContain('## Servidores MCP (indice via gateway)');
    expect(prompt).not.toContain(GATEWAY_INVOKE_TOOL_NAME);
    expect(prompt).toContain('Voce tem acesso a tool "memory_search"');
  });

  it('capabilities ON: secoes completas de pipelines e dynamic workflows', () => {
    const prompt = buildSystemPrompt(undefined, {
      model: 'composer-2.5',
      chatSurface: 'cursor-sdk',
      capabilities: { pipelineControl: true, dynamicWorkflows: true },
    });
    expect(prompt).toContain('## Dirigir Pipelines (tools pipeline-control)');
    expect(prompt).toContain('## Dirigir Workflows Dinamicos (tools dynamic-workflow)');
    expect(prompt).toContain('pipeline_create');
    expect(prompt).toContain('dynamic_workflow_author');
    expect(prompt).toContain('## Helpers permanentes do LionClaw');
  });

  it('capabilities OFF: stubs residuais no lugar das secoes (S5a)', () => {
    const prompt = buildSystemPrompt(undefined, {
      model: 'composer-2.5',
      chatSurface: 'cursor-sdk',
      capabilities: { pipelineControl: false, dynamicWorkflows: false },
    });
    expect(prompt).toContain('## Dirigir Pipelines (DESLIGADO nesta sessao)');
    expect(prompt).toContain('## Dirigir Workflows Dinamicos (DESLIGADO nesta sessao)');
    expect(prompt).not.toContain('## Dirigir Pipelines (tools pipeline-control)');
    expect(prompt).not.toContain('dynamic_workflow_author(');
  });

  it('runtime ativo: o bloco de runtime carimba o modelo do caller', () => {
    const prompt = buildSystemPrompt(undefined, {
      model: 'claude-fable-5',
      chatSurface: 'cursor-sdk',
    });
    expect(prompt).toContain('# Runtime');
    expect(prompt).toContain('- Modelo: claude-fable-5');
  });

  it('PARIDADE: difere do prompt kimi-sdk APENAS na linha de identidade da surface', () => {
    const cursorPrompt = buildSystemPrompt(undefined, {
      model: 'composer-2.5',
      chatSurface: 'cursor-sdk',
    });
    const kimiPrompt = buildSystemPrompt(undefined, {
      model: 'composer-2.5',
      chatSurface: 'kimi-sdk',
    });
    expect(cursorPrompt).not.toBe(kimiPrompt);
    expect(cursorPrompt.replace(CURSOR_IDENTITY_LINE, CLAUDE_IDENTITY_LINE)).toBe(kimiPrompt);
  });
});

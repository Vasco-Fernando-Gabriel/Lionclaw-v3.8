import { describe, it, expect, vi, beforeEach } from 'vitest';

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

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = new Map();
});

describe('7.5 - system prompt do Codex sem "Modelo:" (modelo vai por turno no turn/start)', () => {
  it('surface codex-sdk: a secao Runtime existe mas nao embute o nome do modelo', () => {
    const prompt = buildSystemPrompt(undefined, {
      model: 'gpt-5-codex',
      chatSurface: 'codex-sdk',
      codexMcpMode: 'full',
    });
    expect(prompt).toContain('# Runtime');
    expect(prompt).not.toContain('- Modelo:');
    expect(prompt).not.toContain('gpt-5-codex');
  });

  it('demais surfaces seguem com a linha "- Modelo: X" (delta restrito ao ramo Codex)', () => {
    expect(buildSystemPrompt(undefined, { model: 'composer-2.5', chatSurface: 'cursor-sdk' })).toContain(
      '- Modelo: composer-2.5',
    );
    expect(buildSystemPrompt(undefined, { model: 'claude-fable-5' })).toContain('- Modelo: claude-fable-5');
  });
});

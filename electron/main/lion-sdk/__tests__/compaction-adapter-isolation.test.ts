import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  createSession: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getAllAgents: vi.fn(() => []),
  getSession: vi.fn(() => ({ id: 'sid-test', title: 'Existing title', type: 'chat' })),
  getSessionMessages: vi.fn(() => []),
  insertMessage: vi.fn(),
  updateSessionTitle: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn((key: string) => {
    const map: Record<string, string> = {
      orchestrator_ollama_base_url: 'http://localhost:11434',
      orchestrator_lmstudio_base_url: 'http://localhost:1234',
      orchestrator_compaction_provider: 'lmstudio',
      orchestrator_compaction_model: 'lmstudio-model',
      orchestrator_compaction_runtime: 'lion-sdk',
    };
    return map[key] ?? '';
  }),
}));

vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async () => ({})),
}));

vi.mock('../../mcp-tool-bridge', () => ({
  setupMCPsForSession: vi.fn(async () => ({ client: { connections: [] }, tools: [] })),
  teardownMCPsForSession: vi.fn(async () => {}),
}));

vi.mock('../../skills', () => ({
  listSkills: vi.fn(() => []),
  buildAgentSkillsPromptSection: vi.fn(() => ''),
}));

vi.mock('../compaction', () => ({
  compactIfNeeded: vi.fn(async () => ({ messages: [], compacted: false })),
}));

const createdAdapters: Array<{ type: string; baseUrl: string }> = [];

vi.mock('../adapters/ollama', () => ({
  createOllamaAdapter: vi.fn(({ baseUrl }: { baseUrl: string }) => {
    createdAdapters.push({ type: 'ollama', baseUrl });
    return { name: 'ollama', streamCompletion: vi.fn() };
  }),
}));

vi.mock('../adapters/lmstudio', () => ({
  createLmStudioAdapter: vi.fn(({ baseUrl }: { baseUrl: string }) => {
    createdAdapters.push({ type: 'lmstudio', baseUrl });
    return { name: 'lmstudio', streamCompletion: vi.fn() };
  }),
}));

vi.mock('../adapters/openai-compatible', () => ({
  createOpenAiCompatibleAdapter: vi.fn(({ baseUrl }: { baseUrl: string }) => {
    createdAdapters.push({ type: 'openai-compatible', baseUrl });
    return { name: 'openai-compatible', streamCompletion: vi.fn() };
  }),
}));

vi.mock('../runtime', () => ({
  MAX_TOOL_TURNS: 5,
  runLionLoop: vi.fn(async () => {
    throw new Error('abort-in-test');
  }),
}));

import { executeLionSdkQuery } from '../index';
import type { OrchestratorSelection } from '../../orchestrator-selection';

const PRIMARY_SELECTION: OrchestratorSelection = {
  runtime: 'lion-sdk',
  provider: 'ollama',
  model: 'qwen2.5:27b',
  baseUrl: 'http://localhost:11434',
  source: 'settings',
};

beforeEach(() => {
  createdAdapters.length = 0;
  vi.clearAllMocks();
});

describe('compaction adapter isolation (FIX-2)', () => {
  it('primary adapter uses Ollama URL; compaction adapter uses LM Studio URL', async () => {
    await executeLionSdkQuery('hello', { sessionId: 'sid-test' }, () => null, undefined, PRIMARY_SELECTION).catch(
      () => {},
    );

    const ollamaAdapters = createdAdapters.filter((a) => a.type === 'ollama');
    const lmAdapters = createdAdapters.filter((a) => a.type === 'lmstudio');

    expect(ollamaAdapters.length).toBeGreaterThanOrEqual(1);
    expect(ollamaAdapters[0].baseUrl).toBe('http://localhost:11434');

    expect(lmAdapters.length).toBeGreaterThanOrEqual(1);
    expect(lmAdapters[0].baseUrl).toBe('http://localhost:1234');
    expect(lmAdapters[0].baseUrl).not.toBe('http://localhost:11434');
  });
});


import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatFeatureToggles } from '../../../../src/types';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const MOCK_SERVERS = [
  { id: 'lionclaw-pipeline-control', description: 'Controle de pipelines', isActive: true },
  { id: 'lionclaw-agents', description: 'Subagentes', isActive: true },
];

vi.mock('../../db', () => ({
  getAllMCPServers: () => MOCK_SERVERS,
  getPermissionBypass: () => false,
  getSetting: vi.fn((key: string) => (key === 'mcp_prompt_mode' ? 'full' : undefined)),
}));

vi.mock('../../paths', () => ({
  getAgentCwd: () => '/tmp/codex-v6-bug',
}));

vi.mock('../../prompt-builder', () => ({
  buildSystemPrompt: () => 'LION-PROMPT',
  loadGeneratedAgentContext: () => 'PERSONA',
}));

vi.mock('../../prompt-builder-repo-graph', () => ({
  appendRepoGraphSection: (p: string) => p,
}));

const capturedRuns: Array<{ sessionOptions: { systemPrompt: string } }> = [];
vi.mock('../../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: vi.fn(async (args: { sessionOptions: { systemPrompt: string } }) => {
    capturedRuns.push(args);
    return {};
  }),
}));

import {
  CODEX_SDK_SYSTEM_PROMPT_V4,
  CODEX_SDK_SYSTEM_PROMPT_V5,
  CODEX_SDK_SYSTEM_PROMPT_V6,
  CODEX_DRIVING_PIPELINES_STUB,
  buildCodexSdkSystemPromptV5,
  buildCodexSdkSystemPromptV6,
} from '../prompt';
import { createChatCodexSession } from '../session';

const OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false };

const BUG_PIPE_MARKER = 'Bug Pipe (`pipelineType: "bug"`, 9 phases)';
const BUG_GATE_MARKER = 'Phase 3 of the bug pipeline REQUIRES metadata';

async function deliveredSystemPrompt(capabilities?: ChatFeatureToggles): Promise<string> {
  await createChatCodexSession({
    sessionId: 'sess-codex-v6',
    model: 'gpt-5.5',
    capabilities,
  });
  expect(capturedRuns.length).toBeGreaterThan(0);
  return capturedRuns[capturedRuns.length - 1].sessionOptions.systemPrompt;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedRuns.length = 0;
});

describe('TB-36 — o prompt ENTREGUE ao Codex carrega o bloco do Bug Pipe', () => {
  it('createChatCodexSession entrega o bloco do Bug Pipe (cadeia O6 completa)', async () => {
    const systemPrompt = await deliveredSystemPrompt(undefined);
    expect(systemPrompt).toContain(BUG_PIPE_MARKER);
    expect(systemPrompt).toContain(BUG_GATE_MARKER);
    expect(systemPrompt).toContain('action: "approve-plan"');
    expect(systemPrompt).toContain('action: "close-pipeline"');
    expect(systemPrompt).toContain('`gateDocumentPath`');
  });

  it('o bloco vem da V6 (o call-site NAO ficou preso na V5)', async () => {
    const systemPrompt = await deliveredSystemPrompt(undefined);
    expect(systemPrompt.startsWith(CODEX_SDK_SYSTEM_PROMPT_V6)).toBe(true);
    expect(systemPrompt.startsWith(CODEX_SDK_SYSTEM_PROMPT_V5)).toBe(false);
    expect(CODEX_SDK_SYSTEM_PROMPT_V5).not.toContain(BUG_PIPE_MARKER);
    expect(CODEX_SDK_SYSTEM_PROMPT_V4).not.toContain(BUG_PIPE_MARKER);
  });

  it('pipelineControl OFF: o bloco inteiro (bug incluso) vira o stub', async () => {
    const systemPrompt = await deliveredSystemPrompt({ ...OFF });
    expect(systemPrompt).toContain(CODEX_DRIVING_PIPELINES_STUB);
    expect(systemPrompt).not.toContain(BUG_PIPE_MARKER);
    expect(systemPrompt).not.toContain(BUG_GATE_MARKER);
  });

  it('modo index preserva o bloco do bug (o splice mexe so no bullet de MCP)', () => {
    const naming = {
      invokeToolName: 'mcp__gateway__mcp_invoke',
      schemaToolName: 'mcp__gateway__mcp_schema',
      indexText: '- `google-drive`: files',
    };
    const prompt = buildCodexSdkSystemPromptV6(undefined, naming);
    expect(prompt).toContain(BUG_PIPE_MARKER);
    expect(prompt).toContain(BUG_GATE_MARKER);
    const v5Index = buildCodexSdkSystemPromptV5(undefined, naming);
    const stripped = prompt
      .split('\n')
      .filter(
        (line) =>
          !line.startsWith('- Bug Pipe (') && !line.startsWith('- Phase 3 of the bug pipeline'),
      )
      .join('\n');
    expect(stripped).toEqual(v5Index);
  });

  it('guardrail do arquivo: a V6 nao introduz em-dash', () => {
    expect(CODEX_SDK_SYSTEM_PROMPT_V6.includes('—')).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedSessions: Array<{ systemPrompt: string }> = [];
vi.mock('../../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: vi.fn(async (args: { sessionOptions: { systemPrompt: string } }) => {
    capturedSessions.push({ systemPrompt: args.sessionOptions.systemPrompt });
    return { __mock: 'codex-session' };
  }),
}));

vi.mock('../../db', () => ({
  getAllMCPServers: vi.fn(() => [
    { id: 'lionclaw-pipeline-control', name: 'LionClaw Pipeline Control', isActive: true, description: 'drive' },
  ]),
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => undefined),
  getSetting: vi.fn((key: string) => (key === 'mcp_prompt_mode' ? 'full' : undefined)),
  getCompletedDocsCount: vi.fn(() => 0),
  getPermissionBypass: () => false,
}));

vi.mock('../../mcp-manager', () => ({
  getAllMCPServers: vi.fn(() => []),
  getMcpToolRegistryEntries: vi.fn(() => []),
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('../../paths', () => ({
  getAgentCwd: () => '/tmp',
  getLionClawHome: () => '/tmp/lionclaw-test-i6-inexistente',
}));

vi.mock('../../skills', () => ({
  buildSkillsPromptSection: vi.fn(() => ''),
  buildAgentSkillsPromptSection: vi.fn(() => ''),
}));

vi.mock('../../local-agent-tools', () => ({
  getLocalAgentsDescription: vi.fn(() => ''),
  getExternalAgentsDescription: vi.fn(() => ''),
}));

vi.mock('../../codex-agent-tools', () => ({
  getCodexAgentsDescription: vi.fn(() => ''),
}));

import { createChatCodexSession } from '../session';
import { buildAlwaysOnChatHelpersSection, buildPipelineControlSection } from '../../prompt-builder';
import { CODEX_SDK_SYSTEM_PROMPT_V2 } from '../prompt';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  capturedSessions.length = 0;
  vi.clearAllMocks();
});

describe('I6/W6 - prompt final do Codex contem a secao de pipeline UMA vez', () => {
  it('mantem Telegram, preview e Skills anunciados mesmo com Pipeline e Workflows OFF', async () => {
    await createChatCodexSession({
      sessionId: 's-helpers-off',
      model: 'gpt-5.5',
      capabilities: { pipelineControl: false, dynamicWorkflows: false },
    });

    const finalPrompt = capturedSessions[0].systemPrompt;
    expect(countOccurrences(finalPrompt, buildAlwaysOnChatHelpersSection())).toBe(1);
    expect(finalPrompt).toContain('telegram_notify');
    expect(finalPrompt).toContain('preview_capture');
    expect(finalPrompt).toContain('lionclaw-skills.load_skill');
    expect(finalPrompt).toContain('Dirigir Pipelines (DESLIGADO nesta sessao)');
  });

  it('createChatCodexSession monta o prompt com buildPipelineControlSection EXATAMENTE uma vez', async () => {
    await createChatCodexSession({ sessionId: 's1', model: 'gpt-5.5' });

    expect(capturedSessions).toHaveLength(1);
    const finalPrompt = capturedSessions[0].systemPrompt;

    const section = buildPipelineControlSection();
    expect(countOccurrences(finalPrompt, section)).toBe(1);
    expect(countOccurrences(finalPrompt, '## Dirigir Pipelines (tools pipeline-control)')).toBe(1);
  });

  it('as tools pipeline_* continuam descobriveis no prompt final (via secao canonica)', async () => {
    await createChatCodexSession({ sessionId: 's2', model: 'gpt-5.5' });
    const finalPrompt = capturedSessions[0].systemPrompt;

    for (const tool of [
      'pipeline_list',
      'pipeline_inspect',
      'pipeline_create',
      'pipeline_drive',
      'pipeline_reply',
      'pipeline_approve',
      'pipeline_abort',
      'pipeline_pause',
    ]) {
      expect(finalPrompt).toContain(tool);
    }
    expect(finalPrompt).toContain('lionclaw-pipeline-control');
  });

  it('CODEX_SDK_SYSTEM_PROMPT_V2 nao duplica o bloco de anuncio das pipeline_*', async () => {
    expect(CODEX_SDK_SYSTEM_PROMPT_V2).not.toContain('Driving LionClaw pipelines via the');
    expect(CODEX_SDK_SYSTEM_PROMPT_V2).not.toContain('pipeline_list()');

    await createChatCodexSession({ sessionId: 's3', model: 'gpt-5.5' });
    const finalPrompt = capturedSessions[0].systemPrompt;
    expect(finalPrompt).not.toContain('Driving LionClaw pipelines via the');
  });

  it('V2 preserva a guidance "Driving Pipelines" e o guardrail sem em-dashes', () => {
    expect(CODEX_SDK_SYSTEM_PROMPT_V2).toContain('Driving Pipelines');
    expect(CODEX_SDK_SYSTEM_PROMPT_V2).toContain('drive in one step');
    expect(CODEX_SDK_SYSTEM_PROMPT_V2.includes('—')).toBe(false);
  });
});

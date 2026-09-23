import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatFeatureToggles } from '../../../../src/types';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const MOCK_SERVERS = [
  { id: 'google-drive', description: 'Drive do usuario', isActive: true },
  { id: 'lionclaw-pipeline-control', description: 'Controle de pipelines', isActive: true },
  { id: 'lionclaw-dynamic-workflows', description: 'Workflows dinamicos', isActive: true },
  { id: 'pipeline-control', description: 'Alias historico', isActive: true },
  { id: 'shopify-inativo', description: 'Fora por isActive', isActive: false },
];

vi.mock('../../db', () => ({
  getAllMCPServers: () => MOCK_SERVERS,
  getPermissionBypass: () => false,
  getSetting: vi.fn((key: string) => (key === 'mcp_prompt_mode' ? 'full' : undefined)),
}));

vi.mock('../../paths', () => ({
  getAgentCwd: () => '/tmp/codex-wiring',
}));

const buildSystemPromptMock = vi.fn((_agentId?: string, _opts?: Record<string, unknown>) => 'LION-PROMPT');
vi.mock('../../prompt-builder', () => ({
  buildSystemPrompt: (...a: unknown[]) => buildSystemPromptMock(...(a as [string?, Record<string, unknown>?])),
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
  CODEX_SDK_SYSTEM_PROMPT_V2,
  CODEX_SDK_SYSTEM_PROMPT_V3,
  CODEX_SDK_SYSTEM_PROMPT_V4,
  CODEX_SDK_SYSTEM_PROMPT_V6,
  CODEX_DRIVING_PIPELINES_STUB,
  buildCodexSdkSystemPromptV2,
  buildCodexSdkSystemPromptV3,
  buildCodexSdkSystemPromptV4,
  buildCodexMcpCatalogPrompt,
} from '../prompt';
import { createChatCodexSession } from '../session';

const OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false };
const ON: ChatFeatureToggles = { pipelineControl: true, dynamicWorkflows: true };
const MIXED: ChatFeatureToggles = { pipelineControl: true, dynamicWorkflows: false };

const FULL_BLOCK_MARKER = 'To DRIVE a pipeline autonomously';

async function createSession(capabilities?: ChatFeatureToggles): Promise<string> {
  await createChatCodexSession({
    sessionId: 'sess-codex',
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

describe('S5c codex: buildCodexSdkSystemPromptV2 (bloco Driving Pipelines condicional)', () => {
  it('sem capabilities -> retorna a PROPRIA constante V2 (mesma referencia = byte-identico)', () => {
    expect(buildCodexSdkSystemPromptV2(undefined)).toBe(CODEX_SDK_SYSTEM_PROMPT_V2);
  });

  it('pipelineControl ON -> V2 integra byte-identica', () => {
    expect(buildCodexSdkSystemPromptV2({ ...ON })).toBe(CODEX_SDK_SYSTEM_PROMPT_V2);
  });

  it('so dynamicWorkflows OFF -> V2 integra (o bloco e gated por pipelineControl)', () => {
    expect(buildCodexSdkSystemPromptV2({ ...MIXED })).toBe(CODEX_SDK_SYSTEM_PROMPT_V2);
  });

  it('pipelineControl OFF -> bloco baked substituido pelo stub; secoes vizinhas intactas', () => {
    const prompt = buildCodexSdkSystemPromptV2({ ...OFF });

    expect(prompt).not.toBe(CODEX_SDK_SYSTEM_PROMPT_V2);
    expect(prompt).toContain(CODEX_DRIVING_PIPELINES_STUB);
    expect(prompt).not.toContain(FULL_BLOCK_MARKER);
    expect(prompt).not.toContain('pipeline_inspect');
    expect(prompt).not.toContain('High-risk gates');
    expect(prompt.split('## Driving Pipelines').length - 1).toBe(1);
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('## Asking the User');
    expect(prompt).toContain('## Final Answer');
    expect(prompt.includes('—')).toBe(false);
  });
});

describe('buildCodexSdkSystemPromptV3 (bloco Driving Pipelines condicional)', () => {
  it('sem capabilities -> retorna a PROPRIA constante V3 (mesma referencia = byte-identico)', () => {
    expect(buildCodexSdkSystemPromptV3(undefined)).toBe(CODEX_SDK_SYSTEM_PROMPT_V3);
  });

  it('pipelineControl ON -> V3 integra byte-identica', () => {
    expect(buildCodexSdkSystemPromptV3({ ...ON })).toBe(CODEX_SDK_SYSTEM_PROMPT_V3);
  });

  it('pipelineControl OFF -> bloco baked substituido pelo stub; secoes vizinhas intactas', () => {
    const prompt = buildCodexSdkSystemPromptV3({ ...OFF });

    expect(prompt).not.toBe(CODEX_SDK_SYSTEM_PROMPT_V3);
    expect(prompt).toContain(CODEX_DRIVING_PIPELINES_STUB);
    expect(prompt).not.toContain(FULL_BLOCK_MARKER);
    expect(prompt).not.toContain('pipeline_inspect');
    expect(prompt).not.toContain('REACTIVE DRIVING');
    expect(prompt.split('## Driving Pipelines').length - 1).toBe(1);
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('## Asking the User');
    expect(prompt).toContain('## Final Answer');
    expect(prompt.includes('—')).toBe(false);
  });
});

describe('buildCodexSdkSystemPromptV4 (regra auto qualificada; versao de producao)', () => {
  it('sem capabilities -> retorna a PROPRIA constante V4 (mesma referencia = byte-identico)', () => {
    expect(buildCodexSdkSystemPromptV4(undefined)).toBe(CODEX_SDK_SYSTEM_PROMPT_V4);
  });

  it('V4 qualifica a regra auto (gate/pergunta no turno = agir) e mantem o stand-down', () => {
    expect(CODEX_SDK_SYSTEM_PROMPT_V4).toContain('ALWAYS read the turn message first');
    expect(CODEX_SDK_SYSTEM_PROMPT_V4).toContain('act on it in this turn');
    expect(CODEX_SDK_SYSTEM_PROMPT_V4).toContain('AND the turn shows nothing pending');
    expect(CODEX_SDK_SYSTEM_PROMPT_V4).toContain('REACTIVE DRIVING');
    expect(CODEX_SDK_SYSTEM_PROMPT_V4).toContain('Gate policy by mode');
    expect(CODEX_SDK_SYSTEM_PROMPT_V4).not.toContain('always go to the user');
    expect(CODEX_SDK_SYSTEM_PROMPT_V3).not.toContain('ALWAYS read the turn message first');
    expect(CODEX_SDK_SYSTEM_PROMPT_V4.includes('—')).toBe(false);
  });

  it('pipelineControl OFF -> stub na V4; secoes vizinhas intactas', () => {
    const prompt = buildCodexSdkSystemPromptV4({ ...OFF });
    expect(prompt).toContain(CODEX_DRIVING_PIPELINES_STUB);
    expect(prompt).not.toContain(FULL_BLOCK_MARKER);
    expect(prompt).not.toContain('REACTIVE DRIVING');
    expect(prompt.split('## Driving Pipelines').length - 1).toBe(1);
    expect(prompt).toContain('## Final Answer');
  });
});

describe('S5c codex: createChatCodexSession threada capabilities (prompt + catalogo)', () => {
  it('sem capabilities -> systemPrompt BYTE-IDENTICO a formula legada (V6 + persona + lion + catalogo integral)', async () => {
    const systemPrompt = await createSession(undefined);

    const legacyCatalog = buildCodexMcpCatalogPrompt(
      MOCK_SERVERS.filter((s) => s.isActive).map((s) => ({ id: s.id, description: s.description })),
    );
    expect(systemPrompt).toEqual([CODEX_SDK_SYSTEM_PROMPT_V6, 'PERSONA', 'LION-PROMPT', legacyCatalog].join('\n\n'));
    const withoutBugBlock = CODEX_SDK_SYSTEM_PROMPT_V6.split('\n')
      .filter((line) => !line.startsWith('- Bug Pipe (') && !line.startsWith('- Phase 3 of the bug pipeline'))
      .join('\n');
    expect(withoutBugBlock).toEqual(CODEX_SDK_SYSTEM_PROMPT_V4);
    const promptOpts = buildSystemPromptMock.mock.calls[0][1] as Record<string, unknown>;
    expect(promptOpts.capabilities).toBeUndefined();
    expect(promptOpts.chatSurface).toBe('codex-sdk');
  });

  it('caps ON -> composicao identica a legada (nenhum filtro, V2 integra)', async () => {
    const legacy = await createSession(undefined);
    const on = await createSession({ ...ON });
    expect(on).toEqual(legacy);
  });

  it('caps OFF -> stub na V2, gated (e alias pipeline-control) FORA do catalogo, buildSystemPrompt recebe OFF', async () => {
    const systemPrompt = await createSession({ ...OFF });

    expect(systemPrompt).toContain(CODEX_DRIVING_PIPELINES_STUB);
    expect(systemPrompt).not.toContain(FULL_BLOCK_MARKER);
    expect(systemPrompt).toContain('- `google-drive`');
    expect(systemPrompt).not.toContain('- `lionclaw-pipeline-control`');
    expect(systemPrompt).not.toContain('- `lionclaw-dynamic-workflows`');
    expect(systemPrompt).not.toContain('- `pipeline-control`');

    const promptOpts = buildSystemPromptMock.mock.calls[0][1] as Record<string, unknown>;
    expect(promptOpts.capabilities).toEqual(OFF);
  });

  it('mistos (pipeline ON, workflows OFF) -> V2 integra; catalogo perde SO o server de workflows', async () => {
    const systemPrompt = await createSession({ ...MIXED });

    expect(systemPrompt).toContain(FULL_BLOCK_MARKER);
    expect(systemPrompt).not.toContain(CODEX_DRIVING_PIPELINES_STUB);
    expect(systemPrompt).toContain('- `lionclaw-pipeline-control`');
    expect(systemPrompt).toContain('- `pipeline-control`');
    expect(systemPrompt).not.toContain('- `lionclaw-dynamic-workflows`');
  });
});

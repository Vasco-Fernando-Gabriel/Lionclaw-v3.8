import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const h = vi.hoisted(() => ({
  queryMock: vi.fn<(args: { prompt: unknown; options: Record<string, unknown> }) => unknown>(),
  getApiKeyMock: vi.fn(async (): Promise<string | null> => 'test-key'),
  getSessionMessagesMock: vi.fn((_sessionId: string): unknown[] => []),
  getSessionMock: vi.fn((_sessionId: string): Record<string, unknown> | undefined => undefined),
  getActiveSessionMock: vi.fn(),
  getActiveChatSessionMock: vi.fn(),
  insertMessageMock: vi.fn(() => 1),
  clearSessionPendingSeedMock: vi.fn(),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  rootLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: unknown; options: Record<string, unknown> }) => h.queryMock(args),
}));

vi.mock('../orchestrator-selection', () => ({
  resolveOrchestratorSelection: vi.fn(),
  InvalidOrchestratorSelectionError: class extends Error {},
}));

vi.mock('../claude-compat-sdk', () => ({
  executeClaudeCompatSdkQuery: vi.fn(async () => undefined),
  isClaudeCompatQueryActive: vi.fn(() => false),
  resetClaudeCompatSdkSessionState: vi.fn(),
  stopClaudeCompatQuery: vi.fn(),
}));

vi.mock('../codex-sdk', () => ({
  executeCodexSdkQuery: vi.fn(async () => undefined),
  isCodexSdkQueryActive: vi.fn(() => false),
  resetCodexSdkSessionState: vi.fn(),
  stopCodexSdkQuery: vi.fn(),
}));

vi.mock('../kimi-sdk', () => ({
  executeKimiSdkQuery: vi.fn(async () => undefined),
  isKimiSdkQueryActive: vi.fn(() => false),
  resetKimiSdkSessionState: vi.fn(),
  stopKimiSdkQuery: vi.fn(),
}));

vi.mock('../lion-sdk', () => ({
  executeLionSdkQuery: vi.fn(async () => undefined),
  isLionSdkQueryActive: vi.fn(() => false),
  resetLionSdkSessionState: vi.fn(),
  stopLionSdkQuery: vi.fn(),
}));

vi.mock('../db', () => ({
  threadIdOf: (s: { id: string; sdkSessionId?: string | null }) => s.sdkSessionId ?? s.id,
  getSessionOrchestrator: () => null,
  getAllAgents: () => [],
  getAgent: () => undefined,
  insertMessage: (...args: unknown[]) => h.insertMessageMock(...(args as [])),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  getSetting: vi.fn(() => undefined),
  updateSessionTokens: vi.fn(),
  getActiveSession: h.getActiveSessionMock,
  getActiveChatSession: h.getActiveChatSessionMock,
  getSession: (sessionId: string) => h.getSessionMock(sessionId),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: (sessionId: string) => h.getSessionMessagesMock(sessionId),
  insertTaskExecution: vi.fn(),
  getTurnIndexForUserMessage: vi.fn(() => 1),
  getLatestUserTurnIndex: vi.fn(() => 1),
  getHarnessProject: vi.fn(() => null),
  clearSessionPendingSeed: (...args: unknown[]) => h.clearSessionPendingSeedMock(...(args as [])),
}));

vi.mock('../activity-log', () => ({
  recordActivity: vi.fn(),
  isWriteTool: vi.fn(() => false),
  deriveToolDetail: vi.fn(() => ''),
}));

vi.mock('../knowledge-state', () => ({ setActiveAgentId: vi.fn() }));
vi.mock('../onboarding', () => ({ extractAndProcessOnboardingData: vi.fn(() => null) }));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));
vi.mock('../secrets-vault', () => ({
  getApiKey: (...args: unknown[]) => h.getApiKeyMock(...(args as [])),
  getSecret: async () => null,
}));
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(),
  GUARD_GATED_TOOLS: [],
}));
vi.mock('../mcp-manager', () => ({ getMCPConfigForAgent: async () => ({}) }));
vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: async () => ({
    allowedTools: [],
    systemPrompt: '',
    mcpServers: [],
    maxTurns: 0,
  }),
  mergeRepoGraphAllowlist: (tools: string[]) => tools,
  buildRepoGraphMcpSpec: () => ({}),
  REPO_GRAPH_MCP_SERVER_ID: 'repo-graph',
}));
vi.mock('../mcp-discovery', () => ({ getDisabledSDKMcps: () => [] }));
vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(),
  captureToolResult: vi.fn(),
  resetArtifactDetector: vi.fn(),
}));
vi.mock('../prompt-builder', () => ({ buildSystemPrompt: () => '' }));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/agent/cwd',
  getBackgroundCwd: () => '/bg/cwd',
  getCronCwd: () => '/cron/cwd',
  getLionClawHome: () => '/tmp',
}));
vi.mock('../codex-agents-mcp', () => ({ getCodexAgentsServer: () => undefined }));
vi.mock('../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(),
}));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../drive-usage-sink', () => ({
  reportDriveTurnUsage: vi.fn(),
  reportDriveTurnComplete: vi.fn(),
}));
vi.mock('../repo-graph/turn-context', () => ({
  setRepoGraphTurnSession: vi.fn(),
  clearRepoGraphTurnSession: vi.fn(),
  setRepoGraphTurnContext: vi.fn(),
  getRepoGraphTurnContext: vi.fn(() => null),
}));
vi.mock('../prompt-builder-repo-graph', () => ({
  appendRepoGraphSection: (prompt: string) => prompt,
  summarizeRepoGraphStats: () => '',
  buildRepoGraphSubagentSection: () => '',
}));

import {
  buildSdkPrompt,
  executeClaudeSdkQuery,
  resetSdkSessionState,
  resetTelegramSessionState,
  resetCronSessionState,
} from '../orchestrator';

const fakeGetWindow = () => null;

type SdkContentBlock =
  { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

interface CollectedUserMessage {
  type: string;
  session_id: string;
  parent_tool_use_id: string | null;
  message: { role: string; content: SdkContentBlock[] };
}

function makeImageAttachment(
  overrides: Partial<{
    id: string;
    type: string;
    filename: string;
    mimeType: string;
    data: string;
    size: number;
  }> = {},
) {
  return {
    id: 'att-1',
    type: 'image',
    filename: 'foto.png',
    mimeType: 'image/png',
    data: 'aGVsbG8=',
    size: 5,
    ...overrides,
  };
}

async function collectMessages(prompt: unknown): Promise<CollectedUserMessage[]> {
  expect(typeof prompt, 'prompt com imagem deveria ser AsyncIterable, nao string').not.toBe('string');
  const iterable = prompt as AsyncIterable<CollectedUserMessage>;
  const messages: CollectedUserMessage[] = [];
  const iterator = iterable[Symbol.asyncIterator]();
  let step = await iterator.next();
  while (!step.done) {
    messages.push(step.value);
    step = await iterator.next();
  }
  expect(step.done).toBe(true);
  return messages;
}

function legacySessionRow(id: string, type: 'chat' | 'telegram' = 'chat'): Record<string, unknown> {
  return {
    id,
    sdkSessionId: undefined,
    pendingSeed: undefined,
    title: 'x',
    type,
    status: 'active',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}

function okQueryResult() {
  return {
    async *[Symbol.asyncIterator]() {},
    toggleMcpServer: async () => {},
  };
}

function sdkCallOf(index: number): { prompt: unknown; options: Record<string, unknown> } {
  const call = h.queryMock.mock.calls[index];
  expect(call, `query() call #${index} deveria existir`).toBeDefined();
  return call[0] as { prompt: unknown; options: Record<string, unknown> };
}

beforeEach(() => {
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(() => okQueryResult());
  h.getApiKeyMock.mockReset();
  h.getApiKeyMock.mockResolvedValue('test-key');
  h.getSessionMessagesMock.mockReset();
  h.getSessionMessagesMock.mockReturnValue([]);
  h.getSessionMock.mockReset();
  h.getSessionMock.mockReturnValue(undefined);
  h.getActiveSessionMock.mockClear();
  h.getActiveChatSessionMock.mockClear();
  h.insertMessageMock.mockClear();
  h.clearSessionPendingSeedMock.mockClear();
  resetSdkSessionState();
  resetTelegramSessionState();
  resetCronSessionState();
});

describe('buildSdkPrompt: caminho texto-puro byte-identico (AC-25)', () => {
  it('sem attachments (undefined) retorna a PROPRIA string', () => {
    const msg = 'oi, tudo bem?';
    expect(buildSdkPrompt(msg, undefined, 'thread-1')).toBe(msg);
  });

  it('array de attachments vazio retorna a PROPRIA string', () => {
    const msg = 'mensagem qualquer';
    expect(buildSdkPrompt(msg, [], 'thread-1')).toBe(msg);
  });

  it('attachments SEM imagem (so outros tipos) retorna a PROPRIA string', () => {
    const msg = 'analise este arquivo';
    const atts = [makeImageAttachment({ id: 'a1', type: 'file', mimeType: 'application/pdf' })];
    expect(buildSdkPrompt(msg, atts, 'thread-1')).toBe(msg);
  });

  it('string vazia sem anexos permanece string vazia (nenhum default injetado)', () => {
    expect(buildSdkPrompt('', undefined, 'thread-1')).toBe('');
  });
});

describe('buildSdkPrompt: imagem vira content block nativo (AC-24)', () => {
  it('yielda UM unico SDKUserMessage e o iterador FECHA (sem streaming pendurado)', async () => {
    const prompt = buildSdkPrompt('o que ha na foto?', [makeImageAttachment()], 'thread-img');
    const messages = await collectMessages(prompt);

    expect(messages).toHaveLength(1);
    const m = messages[0];
    expect(m.type).toBe('user');
    expect(m.parent_tool_use_id).toBeNull();
    expect(m.message.role).toBe('user');
    expect(m.message.content).toHaveLength(2);
    expect(m.message.content[0]).toEqual({ type: 'text', text: 'o que ha na foto?' });
    expect(m.message.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    });
  });

  it('session_id do SDKUserMessage e o MESMO sdkThreadId resolvido, nunca um valor novo', async () => {
    const prompt = buildSdkPrompt('veja', [makeImageAttachment()], 'thread-uuid-42');
    const [m] = await collectMessages(prompt);
    expect(m.session_id).toBe('thread-uuid-42');
  });

  it('multiplas imagens: 1 bloco text + N blocos image, na ordem dos anexos', async () => {
    const atts = [
      makeImageAttachment({ id: 'a', data: 'AAA=', mimeType: 'image/jpeg' }),
      makeImageAttachment({ id: 'b', data: 'BBB=', mimeType: 'image/webp' }),
    ];
    const [m] = await collectMessages(buildSdkPrompt('compare', atts, 't'));

    expect(m.message.content).toHaveLength(3);
    expect(m.message.content[0].type).toBe('text');
    expect(m.message.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA=' },
    });
    expect(m.message.content[2]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/webp', data: 'BBB=' },
    });
  });

  it('anexos nao-imagem sao ignorados quando misturados com imagem', async () => {
    const atts = [
      makeImageAttachment({ id: 'doc', type: 'file', mimeType: 'application/pdf' }),
      makeImageAttachment({ id: 'img', data: 'IMG=' }),
    ];
    const [m] = await collectMessages(buildSdkPrompt('oi', atts, 't'));
    expect(m.message.content).toHaveLength(2);
  });

  it('mensagem vazia com imagem usa instrucao default SEM mencao a tool Read', async () => {
    const [m] = await collectMessages(buildSdkPrompt('', [makeImageAttachment()], 't'));
    const text = (m.message.content[0] as { type: 'text'; text: string }).text;
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('Read');
    expect(text).not.toContain('ferramenta');
  });

  it('media type fora do dominio da API e normalizado para image/png', async () => {
    const atts = [makeImageAttachment({ mimeType: 'image/tiff' })];
    const [m] = await collectMessages(buildSdkPrompt('x', atts, 't'));
    const img = m.message.content[1] as Extract<SdkContentBlock, { type: 'image' }>;
    expect(img.source.media_type).toBe('image/png');
  });
});

describe('executeClaudeSdkQuery: prompt ao SDK (SPEC 8.2)', () => {
  it('AC-25: texto puro chega ao SDK como a string EXATA da mensagem', async () => {
    h.getSessionMock.mockImplementation((id: string) => legacySessionRow(id));
    await executeClaudeSdkQuery('mensagem pura', { sessionId: 'd-txt', silent: true }, fakeGetWindow);

    expect(sdkCallOf(0).prompt).toBe('mensagem pura');
  });

  it('AC-24: imagem no desktop vira AsyncIterable com session_id = sdkThreadId legado (proprio sessionId)', async () => {
    h.getSessionMock.mockImplementation((id: string) => legacySessionRow(id));
    await executeClaudeSdkQuery(
      'o que e isto?',
      { sessionId: 'd-img', silent: true, attachments: [makeImageAttachment()] },
      fakeGetWindow,
    );

    const { prompt, options } = sdkCallOf(0);
    const [m] = await collectMessages(prompt);
    expect(m.session_id).toBe('d-img');
    expect(m.message.content[0]).toEqual({ type: 'text', text: 'o que e isto?' });
    expect(m.message.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    });
    expect(options.sessionId).toBe('d-img');
    expect('continue' in options).toBe(false);
    expect('resume' in options).toBe(false);
  });

  it('AC-24: com sdk_session_id setado, session_id do bloco = sdkThreadId (nunca o id do DB)', async () => {
    h.getSessionMock.mockImplementation((id: string) =>
      id === 'd-comp' ? { ...legacySessionRow(id), sdkSessionId: 'thread-uuid-9' } : undefined,
    );
    h.getSessionMessagesMock.mockImplementation((id: string) => (id === 'd-comp' ? [{ id: 1 }] : []));
    await executeClaudeSdkQuery(
      'veja a foto',
      { sessionId: 'd-comp', silent: true, attachments: [makeImageAttachment()] },
      fakeGetWindow,
    );

    const { prompt, options } = sdkCallOf(0);
    const [m] = await collectMessages(prompt);
    expect(m.session_id).toBe('thread-uuid-9');
    expect(options.resume).toBe('thread-uuid-9');
    expect(h.insertMessageMock).toHaveBeenCalledWith('d-comp', 'user', 'veja a foto');
  });

  it('pending_seed entra como preambulo do bloco de TEXTO quando ha imagem (SPEC 4.3 + 8.2)', async () => {
    h.getSessionMock.mockImplementation((id: string) =>
      id === 'd-seed' ? { ...legacySessionRow(id), pendingSeed: '[Resumo] contexto compactado' } : undefined,
    );
    await executeClaudeSdkQuery(
      'e agora?',
      { sessionId: 'd-seed', silent: true, attachments: [makeImageAttachment()] },
      fakeGetWindow,
    );

    const { prompt } = sdkCallOf(0);
    const [m] = await collectMessages(prompt);
    const text = (m.message.content[0] as { type: 'text'; text: string }).text;
    expect(text).toBe('[Resumo] contexto compactado\n\ne agora?');
  });
});

describe('orchestrator.ts: mecanismo legado de imagem removido (AC-24)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'orchestrator.ts'), 'utf8');

  it.each([['lionclaw-img-'], ['[Imagem '], ['os.tmpdir()']])('nao contem o padrao legado %p', (pattern: string) => {
    expect(src).not.toContain(pattern);
  });

  it('o site do query() usa buildSdkPrompt com o sdkThreadId resolvido', () => {
    expect(src).toContain('buildSdkPrompt(finalMessage, options.attachments, sdkThreadId)');
  });
});

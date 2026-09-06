
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  describeImageMock: vi.fn(async (): Promise<string> => ''),
  smokeAuditMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const iter = (async function* () {})();
    return Object.assign(iter, { toggleMcpServer: vi.fn(async () => undefined) });
  },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));
vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => undefined),
  insertMessage: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  getSetting: vi.fn(() => undefined),
  updateSessionTokens: vi.fn(),
  getActiveChatSession: vi.fn(() => ({ id: 'desktop-active' })),
  getSession: vi.fn(() => null),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  insertTaskExecution: vi.fn(),
  getTurnIndexForUserMessage: vi.fn(() => 0),
  getLatestUserTurnIndex: vi.fn(() => 0),
  getAllMCPServers: vi.fn(() => []),
  getPermissionBypass: () => false,
  insertRepoGraphTurnUsage: vi.fn(),
  getHarnessProject: vi.fn(() => undefined),
  clearSessionPendingSeed: vi.fn(),
}));
vi.mock('../knowledge-state', () => ({ setActiveAgentId: vi.fn() }));
vi.mock('../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
  completeOnboardingFromPersistedProfile: vi.fn(() => false),
}));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));
vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => 'fake-api-key'),
  getApiKey: vi.fn(async () => 'fake-api-key'),
}));
vi.mock('../permission-guard', () => ({ createPermissionGuard: () => vi.fn(), GUARD_GATED_TOOLS: [] }));
vi.mock('../mcp-manager', () => ({ getMCPConfigForAgent: vi.fn(async () => ({})) }));
vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => ({ allowedTools: [], systemPrompt: '', mcpServers: [], maxTurns: 0 })),
}));
vi.mock('../mcp-discovery', () => ({ getDisabledSDKMcps: () => [], getCachedSDKMcpServers: () => [] }));
vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(),
  captureToolResult: vi.fn(),
  resetArtifactDetector: vi.fn(),
}));
vi.mock('../prompt-builder', () => ({ buildSystemPrompt: () => '', loadGeneratedAgentContext: () => '' }));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/tmp',
  getBackgroundCwd: () => '/tmp',
  getCronCwd: () => '/tmp',
  getLionClawHome: () => '/tmp',
}));
vi.mock('../codex-agents-mcp', () => ({ getCodexAgentsServer: () => undefined }));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  ensureNodeInPath: vi.fn(),
  getClaudeCodeExecutablePath: () => '/tmp/claude-cli.js',
  getClaudeSdkProcessOptions: () => ({
    pathToClaudeCodeExecutable: '/tmp/claude-cli.js',
    executable: 'node',
  }),
}));
vi.mock('../title-generator', () => ({ ensureInitialSessionTitle: vi.fn(), generateSessionTitle: vi.fn() }));
vi.mock('../repo-graph/turn-context', () => ({
  getRepoGraphTurnContext: vi.fn(() => null),
  setRepoGraphTurnSession: vi.fn(),
  clearRepoGraphTurnSession: vi.fn(),
  setRepoGraphTurnContext: vi.fn(),
}));
vi.mock('../prompt-builder-repo-graph', () => ({ appendRepoGraphSection: (p: string) => p, buildRepoGraphSection: () => '' }));
vi.mock('../sdk-session-id', () => ({ makeScopedSdkSessionId: (s: string, i: string) => `${s}:${i}` }));
vi.mock('../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: vi.fn(async () => ({ send: vi.fn(), close: vi.fn() })),
}));
vi.mock('../codex-sdk/stream-translator', () => ({
  createCodexStreamTranslator: () => ({ callbacks: {}, finalize: vi.fn(), fail: vi.fn() }),
}));
vi.mock('../smoke-audit', () => ({ smokeAudit: h.smokeAuditMock }));

vi.mock('../vision-engine', async () => {
  const actual = await vi.importActual<typeof import('../vision-engine')>('../vision-engine');
  return { ...actual, describeImage: h.describeImageMock };
});

import { resolveDesktopVisionTurn } from '../orchestrator';
import type { QueryOptions } from '../orchestrator';
import {
  VISION_TRANSCRIPTION_MARKER,
  VisionCallError,
} from '../vision-engine';

const IMG = {
  id: 'a1',
  type: 'image',
  filename: 'x.jpg',
  mimeType: 'image/jpeg',
  data: 'AAAA',
  size: 4,
};

function opts(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return { sessionId: 'sess-1', silent: false, attachments: [IMG], ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveDesktopVisionTurn (Desktop)', () => {
  it('AC-V3 claude-sdk: bloco no message E displayMessage; anexo nativo segue', async () => {
    h.describeImageMock.mockResolvedValue('texto ocr da imagem');
    const r = await resolveDesktopVisionTurn('minha pergunta', opts(), 'claude-sdk', 'desktop');

    expect(r.message).toContain('minha pergunta');
    expect(r.message).toContain(VISION_TRANSCRIPTION_MARKER);
    expect(r.message).toContain('texto ocr da imagem');
    expect(r.options.displayMessage).toContain(VISION_TRANSCRIPTION_MARKER);
    expect(r.options.displayMessage).toContain('texto ocr da imagem');
    expect(r.options.attachments).toEqual([IMG]);
    expect(r.notice).toBeNull();
  });

  it('AC-V2 codex: bloco no texto; anexo de imagem NAO segue (texto carrega a transcricao)', async () => {
    h.describeImageMock.mockResolvedValue('ocr codex');
    const r = await resolveDesktopVisionTurn('pergunta', opts(), 'codex-sdk', 'desktop');

    expect(r.message).toContain(VISION_TRANSCRIPTION_MARKER);
    expect(r.message).toContain('ocr codex');
    expect(r.options.attachments).toEqual([]);
    expect(r.notice).toBeNull();
  });

  it('AC-V5 falha do vision: notice (P5), texto original, describeImage chamado 1x (sem troca de provider)', async () => {
    h.describeImageMock.mockRejectedValue(new VisionCallError('provider fora do ar'));
    const r = await resolveDesktopVisionTurn('so a pergunta', opts(), 'codex-sdk', 'desktop');

    expect(r.message).toBe('so a pergunta');
    expect(r.message).not.toContain(VISION_TRANSCRIPTION_MARKER);
    expect(r.notice).toContain('Vision indisponivel');
    expect(h.describeImageMock).toHaveBeenCalledTimes(1);
  });

  it('AC-V4 sem imagem: no-op (nao chama vision, nao mexe no texto)', async () => {
    const r = await resolveDesktopVisionTurn('texto puro', opts({ attachments: [] }), 'claude-sdk', 'desktop');
    expect(r.message).toBe('texto puro');
    expect(r.options.displayMessage).toBeUndefined();
    expect(h.describeImageMock).not.toHaveBeenCalled();
  });

  it('N imagens = N transcricoes concatenadas (SPEC 5)', async () => {
    h.describeImageMock.mockResolvedValueOnce('primeira').mockResolvedValueOnce('segunda');
    const two = [IMG, { ...IMG, id: 'a2', data: 'BBBB' }];
    const r = await resolveDesktopVisionTurn('pergunta', opts({ attachments: two }), 'claude-sdk', 'desktop');
    expect(r.message).toContain('primeira');
    expect(r.message).toContain('segunda');
    expect(h.describeImageMock).toHaveBeenCalledTimes(2);
  });

  it('Telegram (skipVisionTranscription): nao transcreve, mas aplica P4 do anexo nativo', async () => {
    const r = await resolveDesktopVisionTurn(
      'ja enriquecido',
      opts({ skipVisionTranscription: true }),
      'codex-sdk',
      'telegram',
    );
    expect(h.describeImageMock).not.toHaveBeenCalled();
    expect(r.message).toBe('ja enriquecido');
    expect(r.options.attachments).toEqual([]);
  });

  it('AC-V8: smoke-audit registra visionUsed=true no sucesso e false na falha', async () => {
    h.describeImageMock.mockResolvedValue('ok');
    await resolveDesktopVisionTurn('p', opts(), 'claude-sdk', 'desktop');
    expect(h.smokeAuditMock).toHaveBeenCalledWith(
      'attachment_capability',
      expect.objectContaining({ visionUsed: true, supported: true }),
    );

    h.smokeAuditMock.mockClear();
    h.describeImageMock.mockRejectedValue(new VisionCallError('x'));
    await resolveDesktopVisionTurn('p', opts(), 'codex-sdk', 'desktop');
    expect(h.smokeAuditMock).toHaveBeenCalledWith(
      'attachment_capability',
      expect.objectContaining({ visionUsed: false, supported: false }),
    );
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';

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
  getAllAgents: vi.fn(() => [] as unknown[]),
  getAgent: vi.fn(() => undefined),
  insertMessage: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  getSetting: vi.fn(() => undefined),
  updateSessionTokens: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getSession: vi.fn(() => null),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  insertTaskExecution: vi.fn(),
  getTurnIndexForUserMessage: vi.fn(() => 0),
  getLatestUserTurnIndex: vi.fn(() => 0),
  getAllMCPServers: vi.fn(() => []),
  getPermissionBypass: () => false,
  insertRepoGraphTurnUsage: vi.fn(),
  clearSessionPendingSeed: vi.fn(),
}));

vi.mock('../knowledge-state', () => ({ setActiveAgentId: vi.fn() }));
vi.mock('../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
  completeOnboardingFromPersistedProfile: vi.fn(() => false),
}));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));

const getApiKey = vi.fn(async () => null as string | null);
vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => 'fake-api-key'),
  getApiKey: () => getApiKey(),
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
vi.mock('../prompt-builder-repo-graph', () => ({
  appendRepoGraphSection: (p: string) => p,
  buildRepoGraphSection: () => '',
}));
vi.mock('../sdk-session-id', () => ({
  makeScopedSdkSessionId: (scope: string, sessionId: string) => `${scope}:${sessionId}`,
}));
vi.mock('../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: vi.fn(async () => ({
    send: vi.fn(async () => ({ status: 'completed', threadId: 't', content: '', usage: { totalTokens: 0 } })),
    close: vi.fn(),
  })),
}));
vi.mock('../codex-sdk/stream-translator', () => ({
  createCodexStreamTranslator: () => ({ callbacks: {}, finalize: vi.fn(), fail: vi.fn(), timelineEvents: () => [] }),
}));

import type { OrchestratorSelection } from '../orchestrator-selection';
let nextSelection: OrchestratorSelection;
vi.mock('../orchestrator-selection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator-selection')>();
  return {
    ...actual,
    resolveOrchestratorSelection: vi.fn(async () => nextSelection),
  };
});

type ExecArgs = [string, QueryOptionsShape, () => BrowserWindow | null, unknown, OrchestratorSelection];
interface QueryOptionsShape {
  silent?: boolean;
  sessionId?: string;
  onStreamChunk?: (chunk: { type: string; [k: string]: unknown }) => void;
}

const compatExec = vi.fn<(...a: ExecArgs) => Promise<void>>(async () => undefined);
vi.mock('../claude-compat-sdk', () => ({
  executeClaudeCompatSdkQuery: (...a: unknown[]) => compatExec(...(a as ExecArgs)),
  isClaudeCompatQueryActive: vi.fn(() => false),
  resetClaudeCompatSdkSessionState: vi.fn(),
  stopClaudeCompatQuery: vi.fn(),
  buildCompatEnv: vi.fn(() => ({})),
}));
const codexExec = vi.fn<(...a: ExecArgs) => Promise<void>>(async () => undefined);
vi.mock('../codex-sdk', () => ({
  executeCodexSdkQuery: (...a: unknown[]) => codexExec(...(a as ExecArgs)),
  isCodexSdkQueryActive: vi.fn(() => false),
  resetCodexSdkSessionState: vi.fn(),
  stopCodexSdkQuery: vi.fn(),
}));
const kimiExec = vi.fn<(...a: ExecArgs) => Promise<void>>(async () => undefined);
vi.mock('../kimi-sdk', () => ({
  executeKimiSdkQuery: (...a: unknown[]) => kimiExec(...(a as ExecArgs)),
  isKimiSdkQueryActive: vi.fn(() => false),
  resetKimiSdkSessionState: vi.fn(),
  stopKimiSdkQuery: vi.fn(),
}));
const lionExec = vi.fn<(...a: ExecArgs) => Promise<void>>(async () => undefined);
vi.mock('../lion-sdk', () => ({
  executeLionSdkQuery: (...a: unknown[]) => lionExec(...(a as ExecArgs)),
  isLionSdkQueryActive: vi.fn(() => false),
  resetLionSdkSessionState: vi.fn(),
  stopLionSdkQuery: vi.fn(),
}));

import { executeQuery, type QueryOptions } from '../orchestrator';
import { telegramLane, cronLane, type SdkLane } from '../sdk-lane';
import { getDesktopLane } from '../desktop-lanes';

const desktopLane = getDesktopLane('sess-net');

const SELECTIONS: Record<string, OrchestratorSelection> = {
  'claude-sdk': { runtime: 'claude-sdk', provider: 'anthropic', model: 'model-a', source: 'settings' },
  'claude-compat-sdk': { runtime: 'claude-compat-sdk', provider: 'zai', model: 'model-b', source: 'settings' },
  'codex-sdk': { runtime: 'codex-sdk', provider: 'codex', model: 'model-c', source: 'settings' },
  'kimi-sdk': { runtime: 'kimi-sdk', provider: 'kimi', model: 'model-d', source: 'settings' },
  'lion-sdk': { runtime: 'lion-sdk', provider: 'ollama', model: 'model-e', source: 'settings' },
};

const SUB_SDK_SPIES = {
  'claude-compat-sdk': compatExec,
  'codex-sdk': codexExec,
  'kimi-sdk': kimiExec,
  'lion-sdk': lionExec,
} as const;
type SubSdkRuntime = keyof typeof SUB_SDK_SPIES;
const SUB_SDK_RUNTIMES = Object.keys(SUB_SDK_SPIES) as SubSdkRuntime[];

interface SentChunk {
  type: string;
  code?: string;
  error?: string;
  sessionId?: string;
  [k: string]: unknown;
}

function makeWindow(): { getWindow: () => BrowserWindow | null; chunks: SentChunk[] } {
  const chunks: SentChunk[] = [];
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, chunk: SentChunk) => {
        if (channel === 'chat:stream') chunks.push(chunk);
      },
    },
  } as unknown as BrowserWindow;
  return { getWindow: () => win, chunks };
}

function options(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return { sessionId: 'sess-net', silent: false, ...overrides };
}

const llmEmptyChunks = (chunks: SentChunk[]) => chunks.filter((c) => c.type === 'error' && c.code === 'LLM-EMPTY');

beforeEach(() => {
  vi.clearAllMocks();
  getApiKey.mockResolvedValue(null);
});

describe('SB-10 AC-B26 — rede de seguranca no completion de executeQuery cobre os 5 runtimes', () => {
  for (const runtime of SUB_SDK_RUNTIMES) {
    it(`AC-B26: turno DESKTOP mudo em ${runtime} (executor termina sem chunk) emite o fallback LLM-EMPTY`, async () => {
      nextSelection = SELECTIONS[runtime];
      const { getWindow, chunks } = makeWindow();
      SUB_SDK_SPIES[runtime].mockResolvedValueOnce(undefined);

      await executeQuery('turno', options(), getWindow, desktopLane);

      const fallbacks = llmEmptyChunks(chunks);
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0].error).toBeTruthy();
      expect(fallbacks[0].sessionId).toBe('sess-net');
    });
  }

  it('AC-B26: turno normal (executor notifica done via hook) NAO emite fallback', async () => {
    nextSelection = SELECTIONS['claude-compat-sdk'];
    const { getWindow, chunks } = makeWindow();
    compatExec.mockImplementationOnce(async (_m, opts) => {
      opts.onStreamChunk?.({ type: 'session', content: 'sess-net' });
      opts.onStreamChunk?.({ type: 'text', content: 'ola' });
      opts.onStreamChunk?.({ type: 'done', content: 'sess-net' });
    });

    await executeQuery('turno', options(), getWindow, desktopLane);

    expect(llmEmptyChunks(chunks)).toHaveLength(0);
  });

  it('AC-B26: executor que ja emitiu chunk de erro proprio -> a rede fica muda (nao emite 2x)', async () => {
    nextSelection = SELECTIONS['kimi-sdk'];
    const { getWindow, chunks } = makeWindow();
    kimiExec.mockImplementationOnce(async (_m, opts) => {
      opts.onStreamChunk?.({ type: 'error', error: 'falha real do provider' });
    });

    await executeQuery('turno', options(), getWindow, desktopLane);

    expect(llmEmptyChunks(chunks)).toHaveLength(0);
  });

  it('AC-B26: executor que LANCA sem emitir chunk -> fallback emitido ANTES do erro subir ao caller', async () => {
    nextSelection = SELECTIONS['codex-sdk'];
    const { getWindow, chunks } = makeWindow();
    codexExec.mockRejectedValueOnce(new Error('executor exploded'));

    await expect(executeQuery('turno', options(), getWindow, desktopLane)).rejects.toThrow('executor exploded');

    expect(llmEmptyChunks(chunks)).toHaveLength(1);
  });

  it('AC-B26: SO lane DESKTOP — turno mudo em telegram/cron NUNCA recebe o fallback (contrato proprio)', async () => {
    for (const lane of [telegramLane, cronLane] as SdkLane[]) {
      nextSelection = SELECTIONS['lion-sdk'];
      const { getWindow, chunks } = makeWindow();
      lionExec.mockResolvedValueOnce(undefined);

      await executeQuery('turno', options(), getWindow, lane);

      expect(llmEmptyChunks(chunks)).toHaveLength(0);
    }
  });

  it('AC-B26: turno silent (nada streama) -> rede suprimida mesmo em turno mudo', async () => {
    nextSelection = SELECTIONS['claude-compat-sdk'];
    const { getWindow, chunks } = makeWindow();
    compatExec.mockResolvedValueOnce(undefined);

    await executeQuery('turno', options({ silent: true }), getWindow, desktopLane);

    expect(llmEmptyChunks(chunks)).toHaveLength(0);
  });

  it('AC-B26: claude-sdk com early-error (API key ausente) rastreado pelo hook -> erro real, SEM LLM-EMPTY por cima', async () => {
    nextSelection = SELECTIONS['claude-sdk'];
    const { getWindow, chunks } = makeWindow();
    await executeQuery('turno', options(), getWindow, desktopLane);

    expect(getApiKey).toHaveBeenCalledTimes(1);
    const errors = chunks.filter((c) => c.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('API key nao configurada');
    expect(llmEmptyChunks(chunks)).toHaveLength(0);
  });

  it('P2-2 (RM7): sem options.sessionId o turno e recusado com session_required e nenhum chunk sai sem lane', async () => {
    nextSelection = SELECTIONS['claude-compat-sdk'];
    const { getWindow, chunks } = makeWindow();

    await expect(executeQuery('turno', options({ sessionId: undefined }), getWindow, desktopLane)).rejects.toThrow(
      /session_required/,
    );

    expect(compatExec).not.toHaveBeenCalled();
    expect(chunks).toHaveLength(0);
  });

  it('AC-B26: o fallback LLM-EMPTY sempre carrega o sessionId do turno', async () => {
    nextSelection = SELECTIONS['claude-compat-sdk'];
    const { getWindow, chunks } = makeWindow();
    compatExec.mockImplementationOnce(async () => {});

    await executeQuery('turno', options({ sessionId: 'sess-net' }), getWindow, desktopLane);

    const fallbacks = llmEmptyChunks(chunks);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].sessionId).toBe('sess-net');
  });
});


import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrchestratorSelection } from '../../orchestrator-selection';
import { estimateTokens } from '../../token-estimator';


const insertMessage = vi.fn((): number => 1);
const updateSessionTokens = vi.fn();
const setSessionActiveContextTokens = vi.fn();
const clearSessionPendingSeed = vi.fn();
const getSession = vi.fn((): Record<string, unknown> | null => ({ id: 'sid', title: 't', type: 'chat' }));

vi.mock('../../db', () => ({
  createSession: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getAllAgents: vi.fn(() => []),
  getSession: () => getSession(),
  getSessionMessages: vi.fn(() => []),
  insertMessage: (...a: unknown[]) => insertMessage(...(a as [])),
  getTurnIndexForUserMessage: vi.fn(() => 1),
  getLatestUserTurnIndex: vi.fn(() => 0),
  updateSessionTokens: (...a: unknown[]) => updateSessionTokens(...(a as [])),
  setSessionActiveContextTokens: (...a: unknown[]) => setSessionActiveContextTokens(...(a as [])),
  clearSessionPendingSeed: (...a: unknown[]) => clearSessionPendingSeed(...(a as [])),
  getSetting: vi.fn((key: string) =>
    key === 'onboarding_completed' ? 'true' : '',
  ),
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../pricing', () => ({ calculateCost: vi.fn(() => 1.23) }));

vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async () => ({})),
  getMCPToolsFromRegistry: vi.fn(() => []),
}));
vi.mock('../../mcp-tool-bridge', () => ({
  setupMCPsForSession: vi.fn(async () => ({ client: { connections: [] }, tools: [] })),
  teardownMCPsForSession: vi.fn(async () => {}),
}));
vi.mock('../../skills', () => ({
  listSkills: vi.fn(() => []),
  buildAgentSkillsPromptSection: vi.fn(() => ''),
}));
vi.mock('../../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
}));
vi.mock('../../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../../onboarding', () => ({
  completeOnboardingFromConversationMessages: vi.fn(),
  completeOnboardingFromUserProfileMessage: vi.fn(() => false),
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
}));
vi.mock('../../prompt-builder', () => ({
  buildSystemPrompt: vi.fn(() => 'SYS'),
  buildPipelineControlSection: vi.fn(() => ''),
  getSubagentsPromptMode: vi.fn(() => 'index'),
}));
vi.mock('../../prompt-builder-repo-graph', () => ({
  getRepoGraphPromptSection: vi.fn(() => ''),
}));

vi.mock('../adapters/ollama', () => ({
  createOllamaAdapter: vi.fn(() => ({ name: 'ollama', streamCompletion: vi.fn() })),
}));
vi.mock('../adapters/lmstudio', () => ({
  createLmStudioAdapter: vi.fn(() => ({ name: 'lmstudio', streamCompletion: vi.fn() })),
}));
vi.mock('../adapters/openai-compatible', () => ({
  createOpenAiCompatibleAdapter: vi.fn(() => ({ name: 'openai-compatible', streamCompletion: vi.fn() })),
}));
vi.mock('../adapters/google-genai', () => ({
  createGoogleGenAiAdapter: vi.fn(() => ({ name: 'google-genai', streamCompletion: vi.fn() })),
}));

vi.mock('../title', () => ({ maybeGenerateLionSessionTitle: vi.fn(async () => {}) }));

const compactIfNeeded = vi.fn(async (_opts: unknown) => ({ messages: [], compacted: false }));
vi.mock('../compaction', () => ({
  compactIfNeeded: (opts: unknown) => compactIfNeeded(opts),
}));

const runLionLoop = vi.fn(async (..._args: unknown[]) => ({
  finalText: 'resposta lion',
  ok: true,
  usage: { inputTokens: 300, outputTokens: 90 },
}));
vi.mock('../runtime', () => ({
  MAX_TOOL_TURNS: 5,
  runLionLoop: (...args: unknown[]) => runLionLoop(...args),
}));


import { executeLionSdkQuery } from '../index';

const SELECTION: OrchestratorSelection = {
  runtime: 'lion-sdk',
  provider: 'ollama',
  model: 'qwen2.5:27b',
  baseUrl: 'http://localhost:11434',
  source: 'settings',
};

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReturnValue({ id: 'sid', title: 't', type: 'chat' });
});

describe('lion-sdk executor — SPEC orquestrador-fonte-unica S5', () => {
  it('3.5: updateSessionTokens gravado com os numeros do RunLionLoopResult.usage', async () => {
    await executeLionSdkQuery('oi', { sessionId: 'sid' }, () => null, undefined, SELECTION);
    expect(updateSessionTokens).toHaveBeenCalledWith('sid', 300, 90, 1.23, {
      costStatus: 'known',
      tokenStatus: 'reported',
      runtime: 'local',
    });
  });

  it('3.4: pending_seed prefixa o newUserMsg e clearSessionPendingSeed roda no sucesso', async () => {
    getSession.mockReturnValue({ id: 'sid', title: 't', type: 'chat', pendingSeed: 'SEED-LION' });
    await executeLionSdkQuery('minha pergunta', { sessionId: 'sid' }, () => null, undefined, SELECTION);

    const opts = compactIfNeeded.mock.calls[0][0] as { newUserMsg: string };
    expect(opts.newUserMsg.startsWith('SEED-LION\n\n')).toBe(true);
    expect(opts.newUserMsg).toContain('minha pergunta');
    expect(clearSessionPendingSeed).toHaveBeenCalledWith('sid');
  });

  it('3.4: SEM pending_seed o newUserMsg fica cru e clearSessionPendingSeed NUNCA roda', async () => {
    getSession.mockReturnValue({ id: 'sid', title: 't', type: 'chat' });
    await executeLionSdkQuery('cru', { sessionId: 'sid' }, () => null, undefined, SELECTION);

    const opts = compactIfNeeded.mock.calls[0][0] as { newUserMsg: string };
    expect(opts.newUserMsg).toBe('cru');
    expect(clearSessionPendingSeed).not.toHaveBeenCalled();
  });

  it('3.4: compactedUpToMessageId da sessao e repassado ao compactIfNeeded', async () => {
    getSession.mockReturnValue({ id: 'sid', title: 't', type: 'chat', compactedUpToMessageId: 42 });
    await executeLionSdkQuery('oi', { sessionId: 'sid' }, () => null, undefined, SELECTION);

    const opts = compactIfNeeded.mock.calls[0][0] as { compactedUpToMessageId?: number };
    expect(opts.compactedUpToMessageId).toBe(42);
  });

  it('contador ativo: sucesso do turno SETA o contexto vivo por chars/4 (prompt REAL + resposta), NAO o usage', async () => {
    getSession.mockReturnValue({ id: 'sid', title: 't', type: 'chat' });
    const bigChunk = 'H'.repeat(4000);
    compactIfNeeded.mockResolvedValueOnce({
      messages: [{ role: 'user', content: bigChunk }],
      compacted: false,
    } as never);

    await executeLionSdkQuery('oi', { sessionId: 'sid' }, () => null, undefined, SELECTION);

    expect(setSessionActiveContextTokens).toHaveBeenCalledTimes(1);
    const [sid, tokens] = setSessionActiveContextTokens.mock.calls[0] as [string, number];
    expect(sid).toBe('sid');
    expect(tokens).toBeGreaterThanOrEqual(Math.ceil(bigChunk.length / 4));
    expect(tokens).not.toBe(300);
    expect(tokens).not.toBe(390);
    expect(tokens).toBeGreaterThanOrEqual(
      estimateTokens(bigChunk) + Math.floor('resposta lion'.length / 4),
    );
  });

  it('contador ativo: turno que FALHA NAO seta (valor anterior preservado)', async () => {
    getSession.mockReturnValue({ id: 'sid', title: 't', type: 'chat' });
    runLionLoop.mockResolvedValueOnce({ finalText: '', ok: false, usage: { inputTokens: 0, outputTokens: 0 } });

    await executeLionSdkQuery('oi', { sessionId: 'sid' }, () => null, undefined, SELECTION);

    expect(setSessionActiveContextTokens).not.toHaveBeenCalled();
  });
});

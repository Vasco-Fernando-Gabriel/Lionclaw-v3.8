import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const insertRepoGraphTurnUsageMock = vi.fn();
vi.mock('../db', () => ({
  createSession: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getSession: vi.fn(() => undefined),
  clearSessionPendingSeed: vi.fn(),
  updateSessionTokens: vi.fn(),
  getSessionMessages: vi.fn(() => []),
  getSetting: vi.fn((key: string) => (key === 'onboarding_completed' ? 'true' : null)),
  getTurnIndexForUserMessage: vi.fn(() => 1),
  getLatestUserTurnIndex: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  insertMessage: vi.fn(() => 'msg-1'),
  getAllMCPServers: vi.fn(() => []),
  getPermissionBypass: () => false,
  insertRepoGraphTurnUsage: (input: unknown) => insertRepoGraphTurnUsageMock(input),
}));

interface CapturedSession {
  opts: Record<string, unknown>;
  sendPrompts: string[];
  close: ReturnType<typeof vi.fn>;
}
const capturedSessions: CapturedSession[] = [];
vi.mock('../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: vi.fn(async (args: { sessionOptions: Record<string, unknown> }) => {
    const opts = args.sessionOptions;
    const close = vi.fn();
    const captured: CapturedSession = { opts, sendPrompts: [], close };
    capturedSessions.push(captured);
    return {
      send: vi.fn(async (prompt: string) => {
        captured.sendPrompts.push(prompt);
        return {
          status: 'completed',
          threadId: 'thread-1',
          content: 'resposta do codex',
          usage: { totalTokens: 42 },
        };
      }),
      close,
    };
  }),
}));

vi.mock('../prompt-builder', () => ({
  buildSystemPrompt: () => 'LION-PROMPT',
  loadGeneratedAgentContext: () => '',
}));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/lionclaw/agents-home',
  getBackgroundCwd: () => '/lionclaw/agents-home',
  getLionClawHome: () => '/lionclaw',
}));
vi.mock('../codex-sdk/stream-translator', () => ({
  createCodexStreamTranslator: () => ({
    callbacks: {},
    finalize: vi.fn(),
    fail: vi.fn(),
    timelineEvents: () => [],
  }),
}));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../onboarding', () => ({
  completeOnboardingFromPersistedProfile: vi.fn(),
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
}));

const minimalContextMock = vi.fn();
vi.mock('../ipc/repo-graph', () => ({
  getRepoGraphEngine: () => ({
    asReader: () => ({ minimalContext: minimalContextMock }),
  }),
}));

import { executeCodexSdkQuery, resetCodexSdkSessionState } from '../codex-sdk';
import {
  setRepoGraphTurnSession,
  clearRepoGraphTurnSession,
  setRepoGraphTurnContext,
} from '../repo-graph/turn-context';
import { buildRepoGraphSection, appendRepoGraphSection } from '../prompt-builder-repo-graph';
import type { OrchestratorSelection } from '../orchestrator-selection';
import type { StreamChunk } from '../../../src/types';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-graph-chat-codex-'));
fs.mkdirSync(path.join(base, 'repo'), { recursive: true });
const repoDir = fs.realpathSync(path.join(base, 'repo'));

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const selection = {
  runtime: 'codex-sdk',
  model: 'gpt-5.5',
  provider: 'codex',
  source: 'settings',
} as unknown as OrchestratorSelection;

const RENDERED = `## Contexto do repositorio (CodeGraph)\nRepo: ${repoDir}\n- arquivo central`;

const sentChunks: StreamChunk[] = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (_channel: string, chunk: StreamChunk) => {
      sentChunks.push(chunk);
    },
  },
};
const getWindow = () => fakeWindow as never;

function setTurnComRepo(): void {
  setRepoGraphTurnSession('sess-1', 'codex-sdk');
  setRepoGraphTurnContext('sess-1', {
    repositoryId: 'repo-1',
    canonicalRootPath: repoDir,
    status: 'ready',
    statsResumo: '5 arquivos, 12 simbolos',
  });
}

beforeEach(() => {
  resetCodexSdkSessionState();
  vi.clearAllMocks();
  clearRepoGraphTurnSession();
  capturedSessions.length = 0;
  sentChunks.length = 0;
  minimalContextMock.mockResolvedValue({
    repositoryId: 'repo-1',
    rootPath: repoDir,
    files: [{ path: `${repoDir}/a.ts`, reason: 'define a' }],
    symbols: [{ name: 'a', kind: 'function', file: `${repoDir}/a.ts`, line: 1 }],
    renderedMarkdown: RENDERED,
  });
});

describe('FINDING-1 — chat codex COM repo ativo (AC-6 linha codex)', () => {
  it('sessao criada com opts.cwd = canonical root validado + baseline + turn_usage prefetch', async () => {
    setTurnComRepo();
    await executeCodexSdkQuery(
      'onde a funcao a() e definida?',
      { sessionId: 'sess-1' },
      getWindow,
      undefined,
      selection,
    );

    expect(capturedSessions.length).toBe(1);
    const session = capturedSessions[0]!;
    expect(session.opts['cwd']).toBe(repoDir);
    expect(session.opts['ownerKind']).toBe('chat');

    expect(session.sendPrompts.length).toBe(1);
    expect(session.sendPrompts[0]).toBe(`${RENDERED}\n\nonde a funcao a() e definida?`);

    expect(insertRepoGraphTurnUsageMock).toHaveBeenCalledTimes(1);
    const row = insertRepoGraphTurnUsageMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(row['source']).toBe('prefetch');
    expect(row['used']).toBe(true);
    expect(row['runtime']).toBe('codex-sdk');

    const repoChunks = sentChunks.filter((c) => c.type === 'repo_graph');
    expect(repoChunks.length).toBe(1);
    expect(repoChunks[0]!.repoGraph?.source).toBe('prefetch');

    const systemPrompt = session.opts['systemPrompt'] as string;
    expect(systemPrompt).toContain('CONTEXTO PRECOMPUTADO');
    expect(systemPrompt).toContain('repo_graph_impact');
    expect(systemPrompt).not.toContain('NAO estao disponiveis');
  });
});

describe('FINDING-1 — regressao SEM repo (cwd e prompt byte-identicos)', () => {
  it('sem repo ativo: cwd = getAgentCwd, prompt = mensagem crua, zero turn_usage', async () => {
    await executeCodexSdkQuery('pergunta qualquer', { sessionId: 'sess-1' }, getWindow, undefined, selection);

    const session = capturedSessions[0]!;
    expect(session.opts['cwd']).toBe('/lionclaw/agents-home');
    expect(session.sendPrompts[0]).toBe('pergunta qualquer');
    const systemPrompt = session.opts['systemPrompt'] as string;
    expect(systemPrompt).not.toContain('Repositorio ativo da conversa');
    expect(insertRepoGraphTurnUsageMock).not.toHaveBeenCalled();
    expect(sentChunks.filter((c) => c.type === 'repo_graph').length).toBe(0);
    expect(minimalContextMock).not.toHaveBeenCalled();
  });

  it('graph ausente/building (turno SEM ctx do hook F6): sem cwdOverride e sem baseline', async () => {
    setRepoGraphTurnSession('sess-1', 'codex-sdk');
    await executeCodexSdkQuery('pergunta qualquer', { sessionId: 'sess-1' }, getWindow, undefined, selection);

    const session = capturedSessions[0]!;
    expect(session.opts['cwd']).toBe('/lionclaw/agents-home');
    expect(session.sendPrompts[0]).toBe('pergunta qualquer');
    expect(insertRepoGraphTurnUsageMock).not.toHaveBeenCalled();
    expect(minimalContextMock).not.toHaveBeenCalled();
  });
});

describe('thread persistente — transicoes do repo em conversa ja aberta', () => {
  async function send(message: string): Promise<void> {
    await executeCodexSdkQuery(message, { sessionId: 'sess-1' }, getWindow, undefined, selection);
  }

  it('recria a thread ao anexar repo e ao remover repo', async () => {
    await send('turno sem repo');
    expect(capturedSessions).toHaveLength(1);
    expect(capturedSessions[0]!.opts['cwd']).toBe('/lionclaw/agents-home');

    setTurnComRepo();
    await send('turno depois de anexar');
    expect(capturedSessions).toHaveLength(2);
    expect(capturedSessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(capturedSessions[1]!.opts['cwd']).toBe(repoDir);
    expect(capturedSessions[1]!.opts['systemPrompt']).toContain('Repositorio ativo da conversa');
    expect(capturedSessions[1]!.sendPrompts[0]).toContain(RENDERED);

    clearRepoGraphTurnSession();
    await send('turno depois de remover');
    expect(capturedSessions).toHaveLength(3);
    expect(capturedSessions[1]!.close).toHaveBeenCalledTimes(1);
    expect(capturedSessions[2]!.opts['cwd']).toBe('/lionclaw/agents-home');
    expect(capturedSessions[2]!.opts['systemPrompt']).not.toContain('Repositorio ativo da conversa');
  });

  it('recria a thread quando status/stats mudam no mesmo repo e cwd', async () => {
    setTurnComRepo();
    await send('graph pronto');
    expect(capturedSessions).toHaveLength(1);

    setRepoGraphTurnContext('sess-1', {
      repositoryId: 'repo-1',
      canonicalRootPath: repoDir,
      status: 'stale',
      statsResumo: '6 arquivos, 14 simbolos',
    });
    await send('graph ficou stale');

    expect(capturedSessions).toHaveLength(2);
    expect(capturedSessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(capturedSessions[1]!.opts['cwd']).toBe(repoDir);
    const updatedPrompt = capturedSessions[1]!.opts['systemPrompt'] as string;
    expect(updatedPrompt).toContain('PRONTO (stale)');
    expect(updatedPrompt).toContain('6 arquivos, 14 simbolos');
  });
});

describe('Montagem da secao por variante (teste de montagem do AC)', () => {
  const ctx = {
    repositoryId: 'repo-1',
    canonicalRootPath: '/abs/fake-repo',
    status: 'ready' as const,
    statsResumo: null,
  };
  const SEVEN_TOOLS = [
    'repo_graph_status',
    'repo_graph_search',
    'repo_graph_minimal_context',
    'repo_graph_impact',
    'repo_graph_node',
    'repo_graph_callers',
    'repo_graph_callees',
  ];

  it("variante default ('mcp') segue anunciando as 7 tools (claude/compat/lion inalterados)", () => {
    const section = buildRepoGraphSection(ctx);
    for (const tool of SEVEN_TOOLS) {
      expect(section).toContain(tool);
    }
    expect(section).not.toContain('CONTEXTO PRECOMPUTADO');
  });

  it("variante 'codex' referencia o contexto precomputado e anuncia as 7 tools MCP read-only", () => {
    const section = buildRepoGraphSection(ctx, 'codex');
    expect(section).toContain('CONTEXTO PRECOMPUTADO');
    expect(section).toContain('/abs/fake-repo');
    for (const tool of SEVEN_TOOLS) {
      expect(section).toContain(tool);
    }
    expect(section).toContain('MCP repo-graph, read-only');
    expect(section).not.toContain('NAO estao disponiveis');
  });

  it('appendRepoGraphSection sem ctx do turno e byte-identico nas duas variantes', () => {
    clearRepoGraphTurnSession();
    expect(appendRepoGraphSection('# Base', 'sess-1')).toBe('# Base');
    expect(appendRepoGraphSection('# Base', 'sess-1', 'codex')).toBe('# Base');
  });
});

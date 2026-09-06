
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const getAgentMock = vi.fn();
const getSessionActiveRepositoryMock = vi.fn();
const getLocalRepositoryMock = vi.fn();
const insertRepoGraphTurnUsageMock = vi.fn();
vi.mock('../db', () => ({
  getAgent: (id: string) => getAgentMock(id),
  getAllAgents: vi.fn(() => []),
  getSetting: vi.fn(() => undefined),
  getActiveChatSession: vi.fn(() => null),
  getSessionActiveRepository: (sessionId: string) => getSessionActiveRepositoryMock(sessionId),
  getLocalRepository: (id: string) => getLocalRepositoryMock(id),
  insertRepoGraphTurnUsage: (input: unknown) => insertRepoGraphTurnUsageMock(input),
  getLatestUserTurnIndex: vi.fn(() => 1),
  startTaskExecution: vi.fn(),
  finalizeTaskExecutionOnce: vi.fn(),
  finalizeTaskExecutionRootIfIdle: vi.fn(),
}));

const executeAgentMock = vi.fn();
vi.mock('../agent-runtime', () => ({
  executeAgent: (req: unknown) => executeAgentMock(req),
}));
vi.mock('../agent-runtime/execute', () => ({
  executeAgent: (req: unknown) => executeAgentMock(req),
}));
vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => ({
    model: 'gpt-5.5',
    systemPrompt: '',
    allowedTools: [],
    mcpServers: [],
    maxTurns: undefined,
    effort: 'high',
    thinking: 'enabled',
    thinkingBudget: undefined,
    runtime: 'codex',
  })),
}));
vi.mock('../agent-runtime/permission-profiles', () => ({
  PERM_BYPASS_NO_GUARD: { name: 'bypass' },
}));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/lionclaw/agents-home',
  getBackgroundCwd: () => '/lionclaw/agents-home',
  getLionClawHome: () => '/lionclaw',
}));
vi.mock('../codex-runtime/binary', () => ({ isCodexAvailable: vi.fn() }));

const minimalContextMock = vi.fn();
vi.mock('../ipc/repo-graph', () => ({
  getRepoGraphEngine: () => ({
    asReader: () => ({ minimalContext: minimalContextMock }),
  }),
}));

const capturedTools: Array<{
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}> = [];
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (opts: { name: string }) => ({ type: 'sdk', name: opts.name, instance: {} }),
  tool: (
    name: string,
    _description: string,
    _schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<never>,
  ) => {
    capturedTools.push({ name, handler });
    return { name, handler };
  },
}));

import {
  resolveSubagentRepoRoot,
  type SubagentRepoRootDeps,
} from '../repo-graph/validate-root';
import { lionAgentDispatch } from '../lion-sdk/tools/agent';
import { getCodexAgentsServer } from '../codex-agents-mcp';
import {
  setRepoGraphTurnSession,
  clearRepoGraphTurnSession,
  setRepoGraphTurnContext,
} from '../repo-graph/turn-context';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-graph-containment-'));
const repoDir = fs.realpathSync(fs.mkdirSync(path.join(base, 'repo'), { recursive: true }) ?? path.join(base, 'repo'));
const otherDir = fs.realpathSync(fs.mkdirSync(path.join(base, 'other'), { recursive: true }) ?? path.join(base, 'other'));
const escapeLink = path.join(base, 'escape-link');
fs.symlinkSync(otherDir, escapeLink);

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const dbDeps: SubagentRepoRootDeps = {
  getSessionActiveRepository: (sessionId) =>
    sessionId === 'sess-1' ? { repositoryId: 'repo-1' } : null,
  getLocalRepository: (id) => (id === 'repo-1' ? { canonicalRootPath: repoDir } : null),
};

function seedDbMocks(): void {
  getSessionActiveRepositoryMock.mockImplementation((sessionId: string) =>
    sessionId === 'sess-1' ? { repositoryId: 'repo-1' } : null,
  );
  getLocalRepositoryMock.mockImplementation((id: string) =>
    id === 'repo-1' ? { canonicalRootPath: repoDir, status: 'ready' } : null,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRepoGraphTurnSession();
  seedDbMocks();
  executeAgentMock.mockResolvedValue({
    output: 'ok',
    model: 'fake-model',
    runtime: 'codex',
    metrics: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 10,
      toolUses: 0,
      apiRequests: 1,
    },
  });
});

describe('resolveSubagentRepoRoot — AC-8 (13.2)', () => {
  it('sessionId ausente com repoRoot -> { error }', async () => {
    const result = await resolveSubagentRepoRoot({ repoRoot: repoDir }, dbDeps);
    expect(result).toEqual({ error: expect.stringContaining('sessionId') });
  });

  it('repoRoot com "../" -> { error } (sem normalizacao silenciosa)', async () => {
    const sneaky = `${repoDir}/../repo`;
    const result = await resolveSubagentRepoRoot(
      { repoRoot: sneaky, sessionId: 'sess-1' },
      dbDeps,
    );
    expect(result).toEqual({ error: expect.stringContaining('../') });
  });

  it('repoRoot DIFERENTE do canonical da sessao -> { error }', async () => {
    const result = await resolveSubagentRepoRoot(
      { repoRoot: otherDir, sessionId: 'sess-1' },
      dbDeps,
    );
    expect(result).toEqual({
      error: expect.stringContaining('nao corresponde ao repositorio ativo'),
    });
  });

  it('symlink que escapa do canonical -> { error } (realpath, igualdade estrita)', async () => {
    const result = await resolveSubagentRepoRoot(
      { repoRoot: escapeLink, sessionId: 'sess-1' },
      dbDeps,
    );
    expect(result).toEqual({
      error: expect.stringContaining('nao corresponde ao repositorio ativo'),
    });
  });

  it('sessao sem repo ativo -> { error }', async () => {
    const result = await resolveSubagentRepoRoot(
      { repoRoot: repoDir, sessionId: 'sess-sem-repo' },
      dbDeps,
    );
    expect(result).toEqual({ error: expect.stringContaining('nenhum repositorio ativo') });
  });

  it('repoRoot IGUAL ao canonical -> { cwd } validado', async () => {
    const result = await resolveSubagentRepoRoot(
      { repoRoot: repoDir, sessionId: 'sess-1' },
      dbDeps,
    );
    expect(result).toEqual({ cwd: repoDir });
  });
});

describe('Lion Agent (11.4) — repoRoot validado + regressao sem repoRoot', () => {
  const agentLocal = {
    id: 'pesquisador-local',
    name: 'Pesquisador Local',
    isActive: true,
    squad: null,
    runtime: 'local',
  };

  beforeEach(() => {
    getAgentMock.mockReturnValue(agentLocal);
  });

  it('repoRoot invalido (../) -> { ok: false, error }', async () => {
    const result = await lionAgentDispatch({
      agent_id: 'pesquisador-local',
      task: 'tarefa',
      repoRoot: `${repoDir}/../repo`,
      sessionId: 'sess-1',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('../');
    expect(executeAgentMock).not.toHaveBeenCalled();
  });

  it('repoRoot divergente -> { ok: false, error }; executor NUNCA roda', async () => {
    const result = await lionAgentDispatch({
      agent_id: 'pesquisador-local',
      task: 'tarefa',
      repoRoot: otherDir,
      sessionId: 'sess-1',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nao corresponde');
    expect(executeAgentMock).not.toHaveBeenCalled();
  });

  it('repoRoot sem sessionId -> { ok: false, error }', async () => {
    const result = await lionAgentDispatch({
      agent_id: 'pesquisador-local',
      task: 'tarefa',
      repoRoot: repoDir,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('sessionId');
  });

  it('repoRoot valido -> executor recebe cwd = canonical root', async () => {
    const result = await lionAgentDispatch({
      agent_id: 'pesquisador-local',
      task: 'tarefa',
      repoRoot: repoDir,
      sessionId: 'sess-1',
    });
    expect(result.ok).toBe(true);
    const req = executeAgentMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(req['cwd']).toBe(repoDir);
  });

  it('REGRESSAO: sem repoRoot e sem repo ativo, cwd e prompt identicos aos atuais', async () => {
    const result = await lionAgentDispatch({
      agent_id: 'pesquisador-local',
      task: 'minha tarefa simples',
    });
    expect(result.ok).toBe(true);
    const req = executeAgentMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(req['cwd']).toBe('/lionclaw/agents-home');
    expect(req['prompt']).toBe('minha tarefa simples');
    expect(insertRepoGraphTurnUsageMock).not.toHaveBeenCalled();
  });

  it('runtime local COM repo ativo no turno: renderedMarkdown injetado no prompt (11.2/AC-7)', async () => {
    setRepoGraphTurnSession('sess-1', 'lion-sdk');
    setRepoGraphTurnContext({
      repositoryId: 'repo-1',
      canonicalRootPath: repoDir,
      status: 'ready',
      statsResumo: null,
    });
    minimalContextMock.mockResolvedValue({
      repositoryId: 'repo-1',
      rootPath: repoDir,
      files: [{ path: `${repoDir}/a.ts`, reason: 'define a' }],
      symbols: [{ name: 'a', kind: 'function', file: `${repoDir}/a.ts`, line: 1 }],
      renderedMarkdown: `## Contexto do repositorio (CodeGraph)\nRepo: ${repoDir}`,
    });

    const result = await lionAgentDispatch({
      agent_id: 'pesquisador-local',
      task: 'onde a() e usada?',
    });
    expect(result.ok).toBe(true);
    const req = executeAgentMock.mock.calls[0]![0] as Record<string, unknown>;
    const prompt = req['prompt'] as string;
    expect(prompt.startsWith('## Contexto do repositorio (CodeGraph)')).toBe(true);
    expect(prompt).toContain('onde a() e usada?');
    expect(insertRepoGraphTurnUsageMock).toHaveBeenCalledTimes(1);
    const row = insertRepoGraphTurnUsageMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(row['source']).toBe('prefetch');
  });
});

describe('run_codex_agent (11.3) — workspace e ownership definidos pelo host', () => {
  const codexAgent = {
    id: 'coder-codex',
    name: 'Coder Codex',
    isActive: true,
    runtime: 'codex',
    codexConfig: { model: 'gpt-5.5' },
  };

  async function getRunCodexAgent() {
    if (capturedTools.length === 0) {
      await getCodexAgentsServer({
        ownerKind: 'chat',
        ownerId: 'sess-1',
        sessionId: 'sess-1',
        lane: 'desktop',
        surface: 'test',
        workspace: { cwd: repoDir, readRoots: [repoDir], writeRoots: [] },
        permission: { mode: 'default', dangerouslySkipPermissions: false },
        parentAbortSignal: new AbortController().signal,
        rootExecutionId: 'root-codex-test',
        parentExecutionId: 'root-codex-test',
        depth: 0,
        remainingBudget: 16,
        budgetState: { remaining: 16 },
        capabilityCeiling: { allowedTools: ['Agent'], allowedMcpServerIds: [] },
      });
    }
    const tool = capturedTools.find((t) => t.name === 'run_codex_agent');
    expect(tool).toBeDefined();
    return tool!;
  }

  beforeEach(() => {
    getAgentMock.mockReturnValue(codexAgent);
  });

  it('ignora cwd/session forjados e usa exclusivamente o workspace do host', async () => {
    const tool = await getRunCodexAgent();
    const result = await tool.handler({
      agentId: 'coder-codex',
      prompt: 'tarefa',
      repoRoot: `${repoDir}/../repo`,
      sessionId: 'sess-forjada',
    });
    expect(result.isError).toBeFalsy();
    const request = executeAgentMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(request['cwd']).toBe(repoDir);
    expect(request).not.toHaveProperty('sessionId');
    expect(request).not.toHaveProperty('repoRoot');
  });

  it('nao exige sessionId do modelo', async () => {
    const tool = await getRunCodexAgent();
    const result = await tool.handler({
      agentId: 'coder-codex',
      prompt: 'tarefa',
    });
    expect(result.isError).toBeFalsy();
    expect(executeAgentMock).toHaveBeenCalledOnce();
  });

  it('chama o caminho Codex dedicado com cwd e abort cunhados pelo host', async () => {
    const tool = await getRunCodexAgent();
    const result = await tool.handler({
      agentId: 'coder-codex',
      prompt: 'tarefa no repo',
    });
    expect(result.isError).toBeFalsy();
    expect(executeAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: repoDir,
      abortController: expect.any(AbortController),
      executionContext: expect.objectContaining({
        ownerId: 'sess-1',
        rootExecutionId: 'root-codex-test',
      }),
    }));
  });

  it('encaminha context/prompt ao Codex sem aceitar ownership do modelo', async () => {
    const tool = await getRunCodexAgent();
    const result = await tool.handler({
      agentId: 'coder-codex',
      prompt: 'pergunta',
      context: 'dados lidos',
    });
    expect(result.isError).toBeFalsy();
    expect(executeAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: repoDir,
      prompt: 'dados lidos\n\npergunta',
    }));
    expect(insertRepoGraphTurnUsageMock).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../../../../src/types';
import type { SwarmRuntime } from '../../../../src/types/swarm';
const mocks = vi.hoisted(() => ({
  agents: new Map<string, AgentConfig>(),
  execute: vi.fn(),
  dispose: vi.fn(),
  enabled: ['Read', 'Grep', 'Glob', 'Write', 'WebSearch', 'WebFetch'],
}));
vi.mock('../../db', () => ({
  getAgent: (id: string) => mocks.agents.get(id),
  getAllAgents: () => [...mocks.agents.values()],
  getEnabledTools: () => mocks.enabled,
}));
vi.mock('../../agent-config-resolver', () => ({
  resolveAgentQueryConfig: async (id: string) => {
    const a = mocks.agents.get(id)!;
    return {
      model: a.model,
      runtime: a.runtime,
      systemPrompt: a.systemPrompt,
      allowedTools: a.allowedTools,
      mcpServers: [],
      maxTurns: 10,
      effort: a.effort,
      thinking: a.thinking,
    };
  },
}));
vi.mock('../swarm-availability', () => ({ assertSwarmBackendAvailable: async () => {} }));
vi.mock('../execute', () => ({ executeAgent: (req: unknown) => mocks.execute(req) }));
vi.mock('../../swarm/worker-bridge', () => ({
  createSwarmWorkerBridge: () => ({ extraArgs: ['-c', 'mcp_servers.swarm-worker={}'], dispose: mocks.dispose }),
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('../../paths', () => ({ getLionClawHome: () => '/fixture' }));
import { resolveSwarmMember, executeSwarmAttempt, getSwarmCatalog } from '../swarm-adapter';
const runtimes: SwarmRuntime[] = ['cloud', 'zai', 'minimax-tp', 'codex', 'kimi', 'local', 'external'];
function makeAgent(runtime: SwarmRuntime): AgentConfig {
  return {
    id: runtime,
    name: runtime,
    description: 'role',
    model: 'configured-model',
    systemPrompt: 'prompt',
    runtime,
    squad: 'swarm',
    allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Bash', 'Agent'],
    mcpServers: ['unsafe'],
    skills: [],
    isActive: true,
    sortOrder: 0,
    effort: 'high',
    thinking: 'adaptive',
    ...(runtime === 'local'
      ? { localConfig: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'provider-model' } }
      : {}),
    ...(runtime === 'external'
      ? {
          externalConfig: {
            provider: 'openai-compatible',
            protocol: 'openai-compatible',
            baseUrl: 'https://fixture.invalid',
            apiKeyRef: 'vault-reference',
            model: 'provider-model',
          },
        }
      : {}),
    ...(runtime === 'codex' ? { codexConfig: { model: 'provider-model', sandbox: 'danger-full-access' } } : {}),
  };
}
beforeEach(() => {
  mocks.agents.clear();
  mocks.enabled = ['Read', 'Grep', 'Glob', 'Write', 'WebSearch', 'WebFetch'];
  mocks.execute.mockReset();
  mocks.dispose.mockClear();
});
describe('Swarm snapshots across all seven runtime families', () => {
  it.each(runtimes)(
    '%s freezes registered configuration, ephemeral provider comes from explicit reference',
    async (runtime) => {
      const original = makeAgent(runtime);
      mocks.agents.set(runtime, original);
      const registered = await resolveSwarmMember({ kind: 'registered', agentId: runtime }, '/fixture');
      original.systemPrompt = 'edited';
      original.model = 'edited';
      original.allowedTools.push('Edit');
      expect(registered.config.systemPrompt).toBe('prompt');
      expect(registered.config.allowedTools).not.toContain('Bash');
      expect(registered.config.allowedTools).not.toContain('Agent');
      const ephemeral = await resolveSwarmMember(
        {
          kind: 'ephemeral',
          runtime,
          model: 'explicit-model',
          rolePrompt: 'only my role',
          allowedTools: ['Read', 'Grep', 'Glob'],
          providerProfileId: `agent:${runtime}`,
        },
        '/fixture',
      );
      expect(ephemeral.model).toBe('explicit-model');
      expect(ephemeral.config.systemPrompt).toBe('only my role');
      expect(ephemeral.agent.id).toContain('swarm-ephemeral');
      expect(mocks.agents.size).toBe(1);
      expect(JSON.stringify(ephemeral.snapshot)).not.toContain('unsafe');
    },
  );
  it('requires provider profile for local/external and reports honest web restriction', async () => {
    await expect(
      resolveSwarmMember(
        { kind: 'ephemeral', runtime: 'external', model: 'm', rolePrompt: 'p', allowedTools: ['Read'] },
        '/tmp',
      ),
    ).rejects.toThrow('provider-profile-required');
    const agent = makeAgent('local');
    agent.allowedTools = ['WebSearch'];
    mocks.agents.set(agent.id, agent);
    expect((await getSwarmCatalog()).members[0].available).toBe(false);
  });
  it('uses captured snapshot after DB deletion and revokes Codex worker bridge on abort', async () => {
    const a = makeAgent('codex');
    mocks.agents.set(a.id, a);
    const resolved = await resolveSwarmMember({ kind: 'registered', agentId: a.id }, '/fixture');
    mocks.agents.clear();
    const abort = new AbortController();
    mocks.execute.mockImplementation(async (req) => {
      expect(req.executionAgent.model).toBe('provider-model');
      expect(req.swarmFindingsMcpArgs).toHaveLength(2);
      abort.abort();
      return { output: 'ok' };
    });
    await executeSwarmAttempt({
      resolved,
      cwd: '/fixture',
      prompt: 'p',
      findingsPath: '/artifact/findings.md',
      runId: 'run',
      slug: 's',
      attemptId: 'a',
      settings: { concurrencyCap: 1, maxAttempts: 1, idleTimeoutMs: 100, hardTimeoutMs: 1000 },
      abortController: abort,
      writeFindings: async () => {},
      uploadFindings: async () => ({ uploadId: 'u', nextSeq: 0, sha256: '' }),
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.dispose).toHaveBeenCalled();
  });
});

it('global disabled tools cannot be re-enabled by ephemeral persona; web/code essentials fail preflight', async () => {
  mocks.enabled = ['Read', 'Glob', 'Write'];
  await expect(
    resolveSwarmMember(
      { kind: 'ephemeral', runtime: 'cloud', model: 'm', rolePrompt: 'p', allowedTools: ['Read', 'Glob', 'Grep'] },
      '/tmp',
    ),
  ).rejects.toThrow('essenciais');
  const web = makeAgent('cloud');
  web.allowedTools = ['WebSearch', 'WebFetch', 'Write'];
  mocks.agents.set(web.id, web);
  await expect(resolveSwarmMember({ kind: 'registered', agentId: web.id }, '/tmp')).rejects.toThrow('essenciais');
});

it('expands per-attempt paths and slug without changing the captured snapshot', async () => {
  const agent = makeAgent('cloud');
  agent.systemPrompt = '{{RUN_DIR}} {{SLUG}} {{FINDINGS_PATH}}';
  mocks.agents.set(agent.id, agent);
  const resolved = await resolveSwarmMember({ kind: 'registered', agentId: agent.id }, '/repo');
  const before = JSON.stringify(resolved.snapshot);
  mocks.execute.mockImplementation(async (req) => {
    expect(req.resolvedConfigOverride.systemPrompt).toBe(
      '/artifacts/run member /artifacts/run/_attempts/member/attempt/findings.md',
    );
    expect(req.prompt).toContain('member');
    expect(req.prompt).not.toContain('{{SLUG}}');
    return { output: 'ok' };
  });
  await executeSwarmAttempt({
    resolved,
    cwd: '/repo',
    prompt: 'Inspect {{SLUG}}',
    findingsPath: '/artifacts/run/_attempts/member/attempt/findings.md',
    runId: 'run',
    slug: 'member',
    attemptId: 'attempt',
    settings: { concurrencyCap: 1, maxAttempts: 1, idleTimeoutMs: 100, hardTimeoutMs: 1000 },
    abortController: new AbortController(),
    writeFindings: async () => {},
  });
  expect(JSON.stringify(resolved.snapshot)).toBe(before);
  expect(resolved.config.systemPrompt).toContain('{{RUN_DIR}}');
});

it('keeps Cursor outside Swarm without removing the existing runtime', async () => {
  const agent: AgentConfig = { ...makeAgent('cloud'), id: 'cursor', runtime: 'cursor' };
  mocks.agents.set(agent.id, agent);
  await expect(resolveSwarmMember({ kind: 'registered', agentId: agent.id }, '/repo')).rejects.toThrow(
    'fora do escopo',
  );
  expect((await getSwarmCatalog()).members).toHaveLength(0);
});

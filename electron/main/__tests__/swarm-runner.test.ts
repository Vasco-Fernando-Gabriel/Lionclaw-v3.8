import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../../src/types';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { AgentExecutionResult } from '../agent-runtime/types';
import type { SwarmAttemptExecution, SwarmResolvedMember } from '../agent-runtime/swarm-adapter';
import { SwarmRunner, type SwarmRunnerDependencies } from '../swarm/runner';
import { SwarmArtifacts } from '../swarm/artifacts';
import { DEFAULT_SWARM_SETTINGS, type SwarmStartInput } from '../../../src/types/swarm';

let root: string;
const resolved: SwarmResolvedMember = {
  runtime: 'cloud',
  model: 'test',
  snapshot: { model: 'test' },
  agent: {} as AgentConfig,
  config: {} as AgentQueryConfig,
};
const report =
  '# Auditoria\n## Resumo\nVerificado.\n## Achados\nNenhum achado.\n## Fora de escopo / não verificado\nNão executei o app.\n';
function result(slug: string, status = 'ok'): AgentExecutionResult {
  return {
    runtime: 'cloud',
    model: 'test',
    provider: 'test',
    output: `---\nSTATUS: ${status}\nSUMMARY: análise concluída\nFINDINGS: ${slug}.md`,
    metrics: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 1,
      apiRequests: 1,
      costUsd: 0.1,
      durationMs: 1,
    },
  };
}
function input(requestId: string, n = 1): SwarmStartInput {
  return {
    requestId,
    cwd: root,
    objective: 'Auditar',
    mode: 'comite',
    target: '.',
    members: Array.from({ length: n }, (_, i) => ({
      slug: `lens-${i}`,
      objective: 'auditar',
      member: { kind: 'registered', agentId: 'swarm-code-explorer' },
    })),
  };
}
const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
function setup(overrides: Partial<SwarmRunnerDependencies> = {}) {
  const artifacts = new SwarmArtifacts(path.join(root, 'artifacts'));
  const deliver = vi.fn();
  const settings = { ...DEFAULT_SWARM_SETTINGS };
  const deps: SwarmRunnerDependencies = {
    artifacts,
    resolve: vi.fn(async () => resolved),
    execute: vi.fn(async (req) => {
      await req.writeFindings?.(report);
      return result(req.slug);
    }),
    catalog: async () => ({ members: [], profiles: [] }),
    readSettings: () => settings,
    writeSettings: (s) => Object.assign(settings, s),
    project: vi.fn(),
    deliver,
    reportError: vi.fn(),
    recoverAttempt: async () => true,
    random: () => 0.5,
    ...overrides,
  };
  return { runner: new SwarmRunner(deps), deps, artifacts, deliver };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-runner-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});
describe('Swarm runner lifecycle', () => {
  it('fences asynchronous admission on logout and holds its maintenance lease', async () => {
    let resolve!: (value: SwarmResolvedMember) => void;
    const release = vi.fn();
    const { runner, deps, artifacts } = setup({
      resolve: () =>
        new Promise((done) => {
          resolve = done;
        }),
      beginAdmission: () => ({ assertActive: vi.fn(), release }),
    });
    await runner.recover();
    const pending = runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('admission'));
    const rejection = expect(pending).rejects.toThrow(/Admissão cancelada/);
    await flush();
    expect(runner.hasActiveWork('s')).toBe(true);
    expect(release).not.toHaveBeenCalled();
    await runner.abortAll();
    resolve(resolved);
    await rejection;
    expect(release).toHaveBeenCalledTimes(1);
    expect(runner.hasActiveWork()).toBe(false);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(artifacts.list()).toEqual([]);
    await runner.shutdown();
  });
  it('retries terminal delivery without restart and includes the absolute artifact directory', async () => {
    let available = false;
    const deliver = vi.fn(() => {
      if (!available) throw new Error('db unavailable');
    });
    const { runner, artifacts } = setup({ deliver });
    await runner.recover();
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('delivery'));
    await flush();
    const failures = deliver.mock.calls.length;
    expect(failures).toBeGreaterThan(0);
    available = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(deliver).toHaveBeenCalledTimes(failures + 1);
    expect((deliver.mock.calls as unknown as Array<[unknown, string]>)[failures][1]).toContain(
      path.join(artifacts.root, started.runId),
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(deliver).toHaveBeenCalledTimes(failures + 1);
    await runner.shutdown();
  });
  it('returns a queued run, publishes findings and produces one immutable terminal event', async () => {
    const { runner, deliver, artifacts } = setup();
    await runner.recover();
    const started = await runner.start({ sessionId: 's1', swarmEnabled: true, readRoots: [root] }, input('a'));
    expect(started.status).toBe('queued');
    await flush();
    const run = await runner.getRunState('s1', started.runId);
    expect(run.status).toBe('done');
    expect(run.items[0].findingsFile).toBe('lens-0.md');
    expect(artifacts.read(`${run.runId}/lens-0.md`)).toBe(report);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await runner.abort('s1', run.runId)).toEqual(run);
    expect(deliver).toHaveBeenCalledTimes(1);
    await runner.shutdown();
  });
  it('rejects chip OFF and performs the entire preflight before spawning', async () => {
    const { runner, deps } = setup({
      resolve: vi.fn().mockResolvedValueOnce(resolved).mockRejectedValueOnce(new Error('last member invalid')),
    });
    await runner.recover();
    await expect(runner.start({ sessionId: 's', swarmEnabled: false, readRoots: [root] }, input('a'))).rejects.toThrow(
      /chip/,
    );
    await expect(
      runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('a', 2)),
    ).rejects.toThrow(/last member/);
    expect(deps.execute).not.toHaveBeenCalled();
    await runner.shutdown();
  });
  it('shares capacity across chats and drains a reduced cap without killing workers', async () => {
    const pending: Array<{ req: SwarmAttemptExecution; settle: (r: AgentExecutionResult) => void }> = [];
    const { runner } = setup({ execute: (req) => new Promise((settle) => pending.push({ req, settle })) });
    await runner.recover();
    runner.setSettings({ ...DEFAULT_SWARM_SETTINGS, concurrencyCap: 2 });
    await runner.start({ sessionId: 'a', swarmEnabled: true, readRoots: [root] }, input('a', 2));
    await runner.start({ sessionId: 'b', swarmEnabled: true, readRoots: [root] }, input('b', 2));
    await flush();
    expect(pending).toHaveLength(2);
    runner.setSettings({ ...DEFAULT_SWARM_SETTINGS, concurrencyCap: 1 });
    expect(pending.every((p) => !p.req.abortController.signal.aborted)).toBe(true);
    pending[0].settle(result(pending[0].req.slug, 'failed'));
    await flush();
    expect(pending).toHaveLength(2);
    pending[1].settle(result(pending[1].req.slug, 'failed'));
    await flush();
    expect(pending).toHaveLength(3);
    pending[2].settle(result(pending[2].req.slug, 'failed'));
    await flush();
    expect(pending).toHaveLength(4);
    pending[3].settle(result(pending[3].req.slug, 'failed'));
    await flush();
    expect(runner.hasActiveWork()).toBe(false);
    await runner.shutdown();
  });
  it('starts four committee specialists concurrently in one run before any member finishes', async () => {
    const pending: Array<{ req: SwarmAttemptExecution; settle: (r: AgentExecutionResult) => void }> = [];
    const { runner, artifacts, deliver } = setup({
      execute: (req) => new Promise((settle) => pending.push({ req, settle })),
    });
    await runner.recover();
    runner.setSettings({ ...DEFAULT_SWARM_SETTINGS, concurrencyCap: 4 });
    const slugs = ['secrets', 'auth', 'owasp', 'isolation'];
    const agentIds = [
      'swarm-secrets-scanner',
      'swarm-auth-auditor',
      'swarm-owasp-scanner',
      'swarm-isolation-inspector',
    ];
    const started = await runner.start(
      { sessionId: 'security-chat', swarmEnabled: true, readRoots: [root] },
      {
        requestId: 'security-committee',
        cwd: root,
        objective: 'Auditar segurança',
        mode: 'comite',
        target: '.',
        members: slugs.map((slug, i) => ({
          slug,
          objective: `Analisar ${slug}`,
          member: { kind: 'registered', agentId: agentIds[i] },
        })),
      },
    );
    await flush();

    expect(pending.map(({ req }) => req.slug).sort()).toEqual([...slugs].sort());
    expect(new Set(pending.map(({ req }) => req.runId))).toEqual(new Set([started.runId]));
    expect(artifacts.list()).toEqual([started.runId]);
    const running = await runner.getRunState('security-chat', started.runId);
    expect(running.status).toBe('running');
    expect(running.items.map((item) => item.status)).toEqual(['running', 'running', 'running', 'running']);
    expect(deliver).not.toHaveBeenCalled();

    for (const { req, settle } of pending) {
      await req.writeFindings?.(report);
      settle(result(req.slug));
    }
    await flush();
    const completed = await runner.getRunState('security-chat', started.runId);
    expect(completed.status).toBe('done');
    expect(completed.items.map((item) => item.findingsFile).sort()).toEqual(slugs.map((slug) => `${slug}.md`).sort());
    expect(deliver).toHaveBeenCalledTimes(1);
    await runner.shutdown();
  });
  it('recovers a validated checkpoint before publication without rerunning its worker', async () => {
    const { runner, artifacts, deps } = setup();
    await runner.recover();
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('publication'));
    await flush();
    await runner.shutdown();
    const run = artifacts.load(started.runId);
    run.status = 'running';
    run.finishedAt = null;
    run.terminalRevision = null;
    const item = run.items[0];
    item.status = 'running';
    item.findingsFile = null;
    const attempt = item.attempts[0];
    attempt.outcome = null;
    attempt.endedAt = null;
    attempt.terminationConfirmedAt = null;
    artifacts.save(run);
    fs.unlinkSync(path.join(artifacts.root, run.runId, `${item.slug}.md`));
    const execute = vi.fn();
    const recoverAttempt = vi.fn(async () => true);
    const recovered = new SwarmRunner({ ...deps, execute, recoverAttempt });
    await recovered.recover();
    expect(recoverAttempt).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect((await recovered.getRunState('s', run.runId)).status).toBe('done');
    expect(artifacts.read(`${run.runId}/${item.slug}.md`)).toBe(report);
    await recovered.shutdown();
  });
  it('deduplicates simultaneous requests and refuses conflicting reuse', async () => {
    const { runner } = setup();
    await runner.recover();
    const ctx = { sessionId: 's', swarmEnabled: true, readRoots: [root] };
    const [a, b] = await Promise.all([runner.start(ctx, input('a')), runner.start(ctx, input('a'))]);
    expect(a.runId).toBe(b.runId);
    await expect(runner.start(ctx, { ...input('a'), objective: 'different' })).rejects.toThrow(/outro plano/);
    await flush();
    await runner.shutdown();
  });
  it('keeps request identity when persisting a snapshot fails before dispatch', async () => {
    const { runner, artifacts, deps } = setup();
    await runner.recover();
    const atomic = artifacts.atomic.bind(artifacts);
    vi.spyOn(artifacts, 'atomic').mockImplementation((relative, content) => {
      if (relative.endsWith('/config.json')) throw new Error('snapshot disk failure');
      atomic(relative, content);
    });
    const ctx = { sessionId: 's', swarmEnabled: true, readRoots: [root] };
    await expect(runner.start(ctx, input('snapshot'))).rejects.toThrow(/snapshot disk failure/);
    const repeated = await runner.start(ctx, input('snapshot'));
    expect(repeated.status).toBe('failed');
    expect(artifacts.list()).toEqual([repeated.runId]);
    expect(deps.execute).not.toHaveBeenCalled();
    await runner.shutdown();
  });
  it('retries only a transiently failed item after backoff and preserves every attempt', async () => {
    let calls = 0;
    const { runner, artifacts } = setup({
      execute: vi.fn(async (req) => {
        calls++;
        req.onText?.('texto parcial');
        if (calls === 1) throw Object.assign(new Error('network reset'), { code: 'ECONNRESET' });
        await req.writeFindings?.(report);
        return result(req.slug);
      }),
    });
    await runner.recover();
    const start = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('retry'));
    await flush();
    expect((await runner.getRunState('s', start.runId)).items[0].status).toBe('retrying');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(calls).toBe(2);
    const run = await runner.getRunState('s', start.runId);
    expect(run.status).toBe('done');
    expect(run.items[0].attempts).toHaveLength(2);
    expect(artifacts.read(`${run.runId}/${run.items[0].attempts[0].outputFile}`)).toBe('texto parcial');
    await runner.shutdown();
  });
  it('does not retry honest task failure or claim success when findings are missing', async () => {
    const { runner, deps } = setup({ execute: vi.fn(async (req) => result(req.slug, 'failed')) });
    await runner.recover();
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('logical'));
    await flush();
    expect((await runner.getRunState('s', started.runId)).status).toBe('failed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.execute).toHaveBeenCalledTimes(1);
    await runner.shutdown();
  });
  it('uses exponential backoff after the first retry without occupying slots', async () => {
    const { runner, deps } = setup({
      execute: vi.fn(async () => {
        throw Object.assign(new Error('temporary'), { code: 'ECONNRESET' });
      }),
    });
    await runner.recover();
    runner.setSettings({ ...DEFAULT_SWARM_SETTINGS, maxAttempts: 3 });
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('exponential'));
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(deps.execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.execute).toHaveBeenCalledTimes(3);
    expect((await runner.getRunState('s', started.runId)).status).toBe('failed');
    await runner.shutdown();
  });
  it('exposes persistence failure and rejects subsequent work', async () => {
    let req!: SwarmAttemptExecution;
    let settle!: (r: AgentExecutionResult) => void;
    const { runner, artifacts } = setup({
      execute: (r) => {
        req = r;
        return new Promise((done) => {
          settle = done;
        });
      },
    });
    await runner.recover();
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('disk'));
    await flush();
    const save = vi.spyOn(artifacts, 'save').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    await expect(runner.abort('s', started.runId)).rejects.toThrow('ENOSPC');
    expect(req.abortController.signal.aborted).toBe(true);
    await expect(runner.getRunState('s', started.runId)).rejects.toThrow(/Persistência Swarm indisponível/);
    await expect(
      runner.start({ sessionId: 'b', swarmEnabled: true, readRoots: [root] }, input('later')),
    ).rejects.toThrow(/indisponível/);
    settle(result(req.slug));
    await flush();
    save.mockRestore();
    await runner.shutdown();
  });
  it('awaits process exit during shutdown even when the abort checkpoint fails', async () => {
    let req!: SwarmAttemptExecution;
    let settle!: (r: AgentExecutionResult) => void;
    const { runner, artifacts } = setup({
      execute: (r) => {
        req = r;
        return new Promise((done) => {
          settle = done;
        });
      },
    });
    await runner.recover();
    await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('shutdown'));
    await flush();
    vi.spyOn(artifacts, 'save').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    let closed = false;
    const closing = runner.shutdown().then(() => {
      closed = true;
    });
    await flush();
    expect(req.abortController.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    settle(result(req.slug));
    await closing;
    expect(closed).toBe(true);
  });
  it('retains a stopping slot and fences late writes until the executor really exits', async () => {
    let req!: SwarmAttemptExecution;
    let settle!: (r: AgentExecutionResult) => void;
    const { runner } = setup({
      execute: (r) => {
        req = r;
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
    });
    await runner.recover();
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('abort'));
    await flush();
    const stopping = await runner.abort('s', started.runId);
    expect(stopping.status).toBe('aborting');
    expect(stopping.items[0].status).toBe('stopping');
    await expect(req.writeFindings?.(report)).rejects.toThrow(/escrita/);
    await expect(runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('b'))).rejects.toThrow(
      /ativa/,
    );
    settle(result(req.slug));
    await flush();
    const done = await runner.getRunState('s', started.runId);
    expect(done.status).toBe('aborted');
    expect(done.items[0].status).toBe('cancelled');
    await runner.shutdown();
  });
  it('recovers interrupted pending work without replay and reconstructs terminal delivery', async () => {
    const { runner, artifacts, deps } = setup();
    await runner.recover();
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('recover'));
    await flush();
    await runner.shutdown();
    const before = artifacts.load(started.runId);
    const deliver = vi.fn();
    const restarted = new SwarmRunner({ ...deps, deliver });
    await restarted.recover();
    expect(artifacts.load(started.runId)).toEqual(before);
    expect(deliver).toHaveBeenCalledTimes(1);
    await restarted.shutdown();
  });
});

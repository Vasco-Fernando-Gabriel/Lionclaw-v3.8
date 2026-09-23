import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  warn: vi.fn(),
  updateAgent: vi.fn(),
  settings: {} as Record<string, string | undefined>,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

const AGENT = {
  id: 'a1',
  name: 'Agent 1',
  description: '',
  model: 'claude-opus-5',
  effort: 'high',
  runtime: 'cloud',
  allowedTools: ['Read'],
  mcpServers: ['x'],
  skills: ['s'],
  isActive: true,
  squad: 'backend',
};

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => [AGENT]),
  getAgent: vi.fn(() => AGENT),
  getSetting: (key: string) => h.settings[key],
  getSessionOrchestrator: vi.fn(() => null),
  listHarnessProjects: vi.fn(() => []),
  updateAgent: (...args: unknown[]) => h.updateAgent(...args),
}));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../seed-agents', () => ({ getSeedAgentById: vi.fn() }));
vi.mock('../pipeline-shared/lock', () => ({ isProjectLocked: vi.fn(() => false) }));
vi.mock('../codex-runtime/model-capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../codex-runtime/model-capabilities')>();
  return { ...actual, getCodexModelCapabilities: vi.fn(async () => null), findDiscoveredCodexModel: () => undefined };
});

import { syncAgentsToOrchestrator } from '../agent-sync';

const deps = { getHarnessEngine: () => null };

beforeEach(() => {
  h.warn.mockClear();
  h.updateAgent.mockClear();
  h.settings = {
    orchestrator_runtime: 'claude-sdk',
    orchestrator_provider: 'anthropic',
    orchestrator_model: 'claude-opus-5',
    orchestrator_effort: 'high',
  };
});

describe('AC-15 (main): agents:sync-to-orchestrator com selection explicita (7.7)', () => {
  const selection = { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-sonnet-5', effort: 'max' } as const;

  it('dryRun reflete a selecao (nao o padrao), ecoa em response.orchestrator e nao grava', async () => {
    const res = await syncAgentsToOrchestrator({ dryRun: true, selection, mode: 'manual-button' }, deps);
    expect(res.blocked).toBe(false);
    if (res.blocked) throw new Error('unexpected');
    expect(res.orchestrator).toEqual({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      effort: 'max',
    });
    expect(res.results[0]?.after).toMatchObject({ runtime: 'cloud', model: 'claude-sonnet-5', effort: 'max' });
    expect(res.results[0]?.changed).toBe(true);
    expect(h.updateAgent).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalledWith(expect.stringMatching(/alias deprecated/));
  });

  it('sync real grava o patch derivado da selecao', async () => {
    const res = await syncAgentsToOrchestrator({ selection, mode: 'manual-button' }, deps);
    if (res.blocked) throw new Error('unexpected');
    expect(h.updateAgent).toHaveBeenCalledTimes(1);
    expect(h.updateAgent.mock.calls[0]?.[1]).toMatchObject({
      runtime: 'cloud',
      model: 'claude-sonnet-5',
      effort: 'max',
    });
    expect(res.summary).toEqual({ updated: 1, skipped: 0, failed: 0 });
  });

  it('selecao com modelo fora do provider e recusada com erro tipado', async () => {
    await expect(
      syncAgentsToOrchestrator(
        { dryRun: true, selection: { runtime: 'claude-sdk', provider: 'anthropic', model: 'gpt-5.5' } },
        deps,
      ),
    ).rejects.toMatchObject({ name: 'InvalidOrchestratorSelectionError' });
  });

  it('alias sem selection usa o Orquestrador padrao (surface default) com log warn (RM5)', async () => {
    const res = await syncAgentsToOrchestrator({ dryRun: true, mode: 'manual-button' }, deps);
    if (res.blocked) throw new Error('unexpected');
    expect(res.orchestrator).toEqual({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-opus-5',
      effort: 'high',
    });
    expect(h.warn).toHaveBeenCalledWith(expect.stringMatching(/alias deprecated/));
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessProject } from '@/types';
import {
  authRequiredPayloadFromProject,
  CodexAuthRequiredModal,
} from '@/components/pipeline/CodexAuthRequiredModal';
import { SprintList } from '@/components/harness/SprintList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const listProjects = vi.fn();
const resumeAfterAuth = vi.fn(async () => ({ ok: true as const }));
const onAuthRequired = vi.fn(() => vi.fn());

function pausedProject(provider: 'codex' | 'grok' | 'kimi'): HarnessProject {
  return {
    id: 'project-reloaded',
    name: 'Projeto',
    projectPath: '/tmp/project',
    specPath: '/tmp/project/SPEC.md',
    status: 'paused',
    config: {
      maxRoundsPerSprint: 2,
      usePlaywright: false,
      evaluatorAgentId: 'harness-evaluator',
      plannerAgentId: 'harness-planner',
      stack: [],
      providerAuthCheckpoint: {
        checkpointId: 'checkpoint-reloaded',
        pauseReason: 'provider-auth',
        provider,
        ownerKind: 'harness',
        phaseNumber: 14,
        agentId: 'harness-evaluator',
        roundId: 'round-7',
        claimState: 'pending',
        resume: { kind: 'run' },
      },
    },
    currentSprintIndex: 0,
    totalSprints: 1,
    totalFeatures: 1,
    plannerInputTokens: 0,
    plannerOutputTokens: 0,
    plannerCacheTokens: 0,
    plannerCostUsd: 0,
    plannerDurationMs: 0,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

function claimedRunningProject(provider: 'codex' | 'grok' | 'kimi'): HarnessProject {
  const project = pausedProject(provider);
  return {
    ...project,
    status: 'running',
    config: {
      ...project.config,
      providerAuthCheckpoint: {
        ...project.config.providerAuthCheckpoint!,
        claimState: 'claimed',
      },
    },
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  listProjects.mockResolvedValue([pausedProject('kimi')]);
  (window as unknown as { lionclaw: unknown }).lionclaw = {
    pipeline: {
      onAuthRequired,
      resumeAfterAuth: vi.fn(),
      abort: vi.fn(),
    },
    harness: {
      listProjects,
      resumeAfterAuth,
      abort: vi.fn(),
      getSprints: vi.fn(async () => [{
        id: 'sprint-1',
        projectId: 'project-reloaded',
        sprintIndex: 0,
        sprintJsonId: 'sprint-json-1',
        name: 'Sprint 1',
        status: 'interrupted',
        roundsUsed: 1,
        maxRounds: 2,
      }]),
      onSprintUpdate: vi.fn(() => vi.fn()),
      onPlanningDone: vi.fn(() => vi.fn()),
    },
    enrich: { resumeAfterAuth: vi.fn(), abort: vi.fn() },
    codex: { openLogin: vi.fn(), test: vi.fn() },
    grok: { openLogin: vi.fn(), test: vi.fn() },
    kimi: {
      openLogin: vi.fn(),
      status: vi.fn(async () => ({ usable: true, reason: null })),
    },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('CodexAuthRequiredModal apos reload', () => {
  it('preserva provider e round do checkpoint no payload reidratado', () => {
    expect(authRequiredPayloadFromProject(pausedProject('grok'))).toMatchObject({
      projectId: 'project-reloaded',
      provider: 'grok',
      runtime: 'grok',
      ownerKind: 'harness',
      roundId: 'round-7',
    });
  });

  it('recupera somente running com checkpoint ja claimed', () => {
    expect(authRequiredPayloadFromProject(claimedRunningProject('grok'))).toMatchObject({
      projectId: 'project-reloaded',
      provider: 'grok',
      ownerKind: 'harness',
    });

    const pendingRunning = claimedRunningProject('grok');
    pendingRunning.config.providerAuthCheckpoint!.claimState = 'pending';
    expect(authRequiredPayloadFromProject(pendingRunning)).toBeNull();
  });

  it('abre pelo estado inicial e retoma pelo provider correto sem resume generico', async () => {
    listProjects.mockResolvedValueOnce([claimedRunningProject('kimi')]);

    await act(async () => {
      root.render(<CodexAuthRequiredModal />);
    });

    expect(listProjects).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Kimi desconectado');
    expect(container.textContent).toContain('checkpoint salvo');

    const verify = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Verificar autenticacao');
    if (!verify) throw new Error('botao Verificar autenticacao nao encontrado');
    await act(async () => verify.click());

    const resume = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Retomar harness');
    if (!resume) throw new Error('botao Retomar harness nao encontrado');
    await act(async () => resume.click());

    expect(resumeAfterAuth).toHaveBeenCalledWith('project-reloaded', 'kimi');
  });

  it('expoe retomada provider-aware no SprintList para claimed + running', async () => {
    const project = claimedRunningProject('grok');

    await act(async () => {
      root.render(
        <SprintList
          projectId={project.id}
          projectStatus={project.status}
          providerAuthCheckpoint={project.config.providerAuthCheckpoint}
        />,
      );
    });

    const resume = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Retomar com Grok Build');
    if (!resume) throw new Error('acao provider-aware de recovery nao encontrada');
    await act(async () => resume.click());

    expect(resumeAfterAuth).toHaveBeenCalledWith('project-reloaded', 'grok');
  });
});


import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('zustand/middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zustand/middleware')>();
  return {
    ...actual,
    persist: (config: unknown) => config,
    createJSONStorage: () => undefined,
  };
});

const getProjectResponses = new Map<string, Record<string, unknown>>();
let getProjectCalls: string[] = [];
let auditAgentsResponse: unknown = { agents: [] };

beforeAll(() => {
  const noop = () => () => {};
  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      pipeline: {
        onStream: noop,
        onPhaseChanged: noop,
        onProjectUpdated: noop,
        onNotesUpdated: noop,
        onSprintComplete: noop,
        onSprintUpdated: noop,
        onAgentCompleted: noop,
        onDocumentUpdated: noop,
        onSprintsLoaded: noop,
        onSprintRound: noop,
        onResetComplete: noop,
        onSecurityAgentStatus: noop,
        onResolutionTrackerComplete: noop,
        onManifest: noop,
        listProjects: async () => [],
        getMetrics: async () => ({ phases: [] }),
        getProject: async (projectId: string) => {
          getProjectCalls.push(projectId);
          return getProjectResponses.get(projectId) ?? { error: 'not found' };
        },
        getPhaseMessages: async () => [],
        readManifest: async () => null,
        getSecurityAgentStatus: async () => [],
        getAuditAgentsState: async () => auditAgentsResponse,
      },
      tasks: { getPendingDueCount: async () => 0 },
      scheduler: { getPendingReviewCount: async () => 0 },
    },
  };
});

import { usePipelineStore } from '@/stores/pipeline-store';
import type { PipelineProject } from '@/types';

function makeProject(
  id: string,
  pipelineType: string,
  overrides: Partial<PipelineProject> = {},
): PipelineProject {
  return {
    id,
    name: id,
    projectPath: '/tmp/repo',
    specPath: '',
    status: 'running',
    currentPhase: 3,
    createdAt: '',
    updatedAt: '',
    pipelineType,
    metadata: { startPhase: 1 },
    ...overrides,
  } as unknown as PipelineProject;
}

async function waitForRefresh(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 550));
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  getProjectResponses.clear();
  getProjectCalls = [];
  auditAgentsResponse = { agents: [] };
  usePipelineStore.setState({
    projects: [],
    activeProjectId: null,
    projectStates: new Map(),
    _lastTouchedAt: new Map(),
    error: null,
  });
});

describe('TB-43 / B-AC29: metadata.bugOutcome chega por EVENTO', () => {
  it('phase-changed terminal faz bugOutcome virar no-bug sem refetch manual', async () => {
    usePipelineStore.setState({ projects: [makeProject('bug-1', 'bug')] });
    getProjectResponses.set('bug-1', {
      id: 'bug-1',
      pipelineType: 'bug',
      status: 'done',
      currentPhase: null,
      metadata: { bugOutcome: 'no-bug' },
    });

    usePipelineStore.getState()._handlePhaseChanged({
      projectId: 'bug-1',
      phase: null,
      status: 'pipeline-completed',
      awaitingUser: false,
    });

    expect(usePipelineStore.getState().projects[0].metadata?.bugOutcome).toBeUndefined();

    await waitForRefresh();

    expect(usePipelineStore.getState().projects[0].metadata?.bugOutcome).toBe('no-bug');
    expect(getProjectCalls).toEqual(['bug-1']);
  });

  it('o refetch NAO sobrescreve status/currentPhase nem apaga o resto do metadata', async () => {
    usePipelineStore.setState({ projects: [makeProject('bug-2', 'bug')] });
    getProjectResponses.set('bug-2', {
      id: 'bug-2',
      pipelineType: 'bug',
      status: 'idle',
      currentPhase: 99,
      name: 'NOME DO REFETCH',
      metadata: { bugOutcome: 'no-bug' },
    });

    usePipelineStore.getState()._handlePhaseChanged({
      projectId: 'bug-2',
      phase: null,
      status: 'pipeline-completed',
      awaitingUser: false,
    });
    await waitForRefresh();

    const p = usePipelineStore.getState().projects[0];
    expect(p.metadata?.bugOutcome).toBe('no-bug');
    expect(p.status).toBe('done');
    expect(p.currentPhase).toBeNull();
    expect(p.name).toBe('bug-2');
    expect(p.metadata?.startPhase).toBe(1);
  });

  it('project-updated tambem dispara o refresh (segundo tail)', async () => {
    usePipelineStore.setState({ projects: [makeProject('bug-3', 'bug')] });
    getProjectResponses.set('bug-3', {
      id: 'bug-3',
      pipelineType: 'bug',
      metadata: { bugOutcome: 'fix' },
    });

    usePipelineStore.getState()._handleProjectUpdated({
      projectId: 'bug-3',
      patch: { status: 'running' },
    });
    await waitForRefresh();

    expect(usePipelineStore.getState().projects[0].metadata?.bugOutcome).toBe('fix');
  });
});

describe('TB-43: nao-regressao do security', () => {
  it('projeto security nao dispara _refreshBugOutcome', async () => {
    usePipelineStore.setState({ projects: [makeProject('sec-1', 'security')] });
    getProjectResponses.set('sec-1', {
      id: 'sec-1',
      pipelineType: 'security',
      metadata: { securitySummary: { totalFindings: 4 } },
    });

    usePipelineStore.getState()._handlePhaseChanged({
      projectId: 'sec-1',
      phase: null,
      status: 'pipeline-completed',
      awaitingUser: false,
    });
    await waitForRefresh();

    const p = usePipelineStore.getState().projects[0];
    expect(p.metadata?.securitySummary).toEqual({ totalFindings: 4 });
    expect(p.metadata?.bugOutcome).toBeUndefined();
    expect(getProjectCalls).toEqual(['sec-1']);
  });

  it('_refreshBugOutcome chamado direto para projeto nao-bug e no-op', async () => {
    usePipelineStore.setState({ projects: [makeProject('sec-2', 'security')] });
    usePipelineStore.getState()._refreshBugOutcome('sec-2');
    await waitForRefresh();
    expect(getProjectCalls).toEqual([]);
  });

  it('_refreshBugOutcome para projeto inexistente e no-op', async () => {
    usePipelineStore.getState()._refreshBugOutcome('fantasma');
    await waitForRefresh();
    expect(getProjectCalls).toEqual([]);
  });
});


describe('TB-38 (ii): slug vem de agentSlug quando presente, derivacao historica quando nao', () => {
  function snapshot(agentId: string, agentSlug?: string): Record<string, unknown> {
    return {
      agentId,
      ...(agentSlug !== undefined ? { agentSlug } : {}),
      agentName: agentId,
      status: 'completed',
      costUsd: 0.1,
      durationMs: 1000,
      model: 'claude-opus-5',
      runtime: 'cloud',
      filesAnalyzed: 0,
      additionalFilesAfterStart: 2,
      toolCallsCount: 5,
    };
  }

  it('ids bug-* usam o agentSlug persistido (a string surgery daria "bug" nos tres)', async () => {
    auditAgentsResponse = {
      agents: [
        snapshot('bug-root-cause-analyst', 'root-cause'),
        snapshot('bug-context-historian', 'historian'),
        snapshot('bug-hypothesis-refuter', 'refuter'),
      ],
    };

    await usePipelineStore.getState().loadAuditAgents('bug-slug');

    const agents = usePipelineStore.getState().projectStates.get('bug-slug')?.auditAgents;
    expect(agents?.get('bug-root-cause-analyst')?.slug).toBe('root-cause');
    expect(agents?.get('bug-context-historian')?.slug).toBe('historian');
    expect(agents?.get('bug-hypothesis-refuter')?.slug).toBe('refuter');
  });

  it('security continua byte-identico com agentSlug undefined (security-auth-analyst -> auth)', async () => {
    auditAgentsResponse = {
      agents: [snapshot('security-auth-analyst'), snapshot('security-secrets-hunter')],
    };

    await usePipelineStore.getState().loadAuditAgents('sec-slug');

    const agents = usePipelineStore.getState().projectStates.get('sec-slug')?.auditAgents;
    expect(agents?.get('security-auth-analyst')?.slug).toBe('auth');
    expect(agents?.get('security-secrets-hunter')?.slug).toBe('secrets');
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkflowRunRow, type WorkflowActivityNode } from '@/components/dynamic-workflow/WorkflowRunRow';
import { WorkflowChatStrip } from '@/components/dynamic-workflow/WorkflowChatStrip';
import {
  selectChatBoundActiveRuns,
  workflowIndicatorLabel,
} from '@/components/dynamic-workflow/BackgroundWorkflowIndicator';
import { ActivityPanel } from '@/components/chat/ActivityPanel';
import { useDynamicWorkflowStore } from '@/stores/dynamic-workflow-store';
import { createThreadState, useChatStore } from '@/stores/chat-store';
import { useAppStore } from '@/stores/app-store';
import type { DynamicWorkflowRun, LiveActivity } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeRun(patch?: Partial<DynamicWorkflowRun>): DynamicWorkflowRun {
  return {
    id: 'run-1',
    definitionId: 'def-1',
    chatSessionId: 'sess-1',
    status: 'running',
    currentPhaseId: 'implement',
    currentNodeId: 'coder',
    workspaceMode: 'run-worktree',
    baseBranch: 'main',
    baseCommitSha: 'abc',
    baseWorktreeHash: null,
    worktreePath: '/tmp/wt',
    worktreeBranch: 'dynworkflow/run-1',
    deliveredAt: null,
    finalizedAt: null,
    closerSessionId: null,
    closerStatus: null,
    inputJson: '{"autonomy":"auto"}',
    outputJson: null,
    checkpointJson: '{}',
    error: null,
    totalCostUsd: 0.0123,
    totalDurationMs: 12000,
    createdBy: 'human',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:10.000Z',
    completedAt: null,
    ...patch,
  };
}

function activity(patch: Partial<LiveActivity> & Pick<LiveActivity, 'id' | 'kind' | 'label' | 'status'>): LiveActivity {
  return { turnIndex: 1, ...patch };
}

function makeWorkflowNode(): WorkflowActivityNode {
  return {
    ...activity({
      id: 'workflow:run-1',
      kind: 'workflow',
      label: 'Workflow - implement',
      status: 'running',
      projectId: 'run-1',
      description: 'Fase implement - node coder',
      costUsd: 0.0123,
      startedAt: '2026-01-01T00:00:00.000Z',
    }),
    children: [
      {
        ...activity({
          id: 'workflow:run-1:node:coder#1',
          parentId: 'workflow:run-1',
          kind: 'subagent',
          label: 'coder',
          status: 'done',
          costUsd: 0.01,
        }),
        children: [],
      },
      {
        ...activity({
          id: 'workflow:run-1:group:validators',
          parentId: 'workflow:run-1',
          kind: 'subagent',
          label: 'grupo paralelo: validators',
          status: 'running',
          description: '3 agentes em paralelo',
        }),
        children: [
          { ...activity({ id: 'v1', kind: 'subagent', label: 'validator-spec', status: 'running' }), children: [] },
          { ...activity({ id: 'v2', kind: 'subagent', label: 'validator-tests', status: 'done' }), children: [] },
        ],
      },
      {
        ...activity({
          id: 'workflow:run-1:gate:final',
          parentId: 'workflow:run-1',
          kind: 'subagent',
          label: 'gate: final',
          status: 'running',
          description: 'gate aguardando decisao (orchestrator)',
        }),
        children: [],
      },
    ],
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

function mount(node: React.ReactElement): void {
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
}

function unmount(): void {
  const r = root;
  if (r) {
    act(() => {
      r.unmount();
    });
    root = null;
  }
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);

  if (typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = (() => {}) as Element['scrollTo'];
  }

  (window as unknown as Record<string, unknown>).lionclaw = {
    swarm: {
      listRuns: vi.fn().mockResolvedValue({ runs: [], nextCursor: null }),
      onStream: vi.fn().mockReturnValue(() => {}),
    },
    dynamicWorkflow: {
      listRuns: vi.fn().mockResolvedValue([]),
      getRun: vi.fn().mockResolvedValue(null),
      getNodes: vi.fn().mockResolvedValue([]),
      getEvents: vi.fn().mockResolvedValue([]),
      getArtifacts: vi.fn().mockResolvedValue([]),
      getSnapshot: vi.fn().mockResolvedValue(null),
      intervene: vi.fn().mockResolvedValue({ ok: true }),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
  };

  useDynamicWorkflowStore.setState({
    runs: [],
    selectedRun: null,
    selectedRunId: null,
  });
  useChatStore.setState({ currentSessionId: 'sess-1', threads: {} });
  useAppStore.setState({ currentPage: 'chat' });
});

afterEach(() => {
  unmount();
  container.remove();
  vi.restoreAllMocks();
});

describe('WorkflowRunRow (S16, bloco kind workflow)', () => {
  it('renderiza o header, os filhos node-agente e o grupo paralelo como sub-lista', () => {
    useDynamicWorkflowStore.setState({ runs: [makeRun()] });
    mount(<WorkflowRunRow node={makeWorkflowNode()} now={Date.parse('2026-01-01T00:00:10.000Z')} />);

    const text = container.textContent ?? '';
    expect(text).toContain('Workflow - implement');
    expect(text).toContain('coder');
    expect(text).toContain('grupo paralelo: validators');
    expect(text).toContain('validator-spec');
    expect(text).toContain('validator-tests');
    expect(container.querySelector('[data-testid="workflow-run-row"]')).not.toBeNull();
  });

  it('mostra o CTA de gate pendente quando ha um filho de gate aberto', () => {
    useDynamicWorkflowStore.setState({ runs: [makeRun()] });
    mount(<WorkflowRunRow node={makeWorkflowNode()} now={Date.now()} />);
    const cta = container.querySelector('[data-testid="workflow-gate-cta"]');
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toContain('Gate pendente');
  });

  it('navega para a pagina do run ao clicar no header (projectId = runId)', () => {
    const setPage = vi.spyOn(useAppStore.getState(), 'setPage');
    const openRun = vi.spyOn(useDynamicWorkflowStore.getState(), 'openRun').mockResolvedValue();
    useDynamicWorkflowStore.setState({ runs: [makeRun()] });
    mount(<WorkflowRunRow node={makeWorkflowNode()} now={Date.now()} />);

    const header = container.querySelector('[data-testid="workflow-run-row"] [role="button"]') as HTMLElement | null;
    expect(header).not.toBeNull();
    act(() => {
      header?.click();
    });
    expect(openRun).toHaveBeenCalledWith('run-1');
    expect(setPage).toHaveBeenCalledWith('dynamic-workflow');
  });
});

describe('WorkflowRunRow: status VIVO sobrepoe o node congelado pelo turno', () => {
  it('node "stopped" (turno do orquestrador encerrou) mas run VIVO running -> mostra "Executando", nao "Parado"', () => {
    useDynamicWorkflowStore.setState({ runs: [makeRun({ status: 'running' })] });
    const frozenNode: WorkflowActivityNode = { ...makeWorkflowNode(), status: 'stopped' };
    mount(<WorkflowRunRow node={frozenNode} now={Date.now()} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Executando');
    expect(text).not.toContain('Parado');
  });

  it('run VIVO terminal (completed) -> mostra "Concluido" mesmo com node ainda running', () => {
    useDynamicWorkflowStore.setState({ runs: [makeRun({ status: 'completed' })] });
    const runningNode: WorkflowActivityNode = { ...makeWorkflowNode(), status: 'running' };
    mount(<WorkflowRunRow node={runningNode} now={Date.now()} />);
    expect(container.textContent ?? '').toContain('Concluido');
  });

  it('sem run vivo na store -> cai no status do node de atividade (fallback graceful)', () => {
    useDynamicWorkflowStore.setState({ runs: [] });
    const stoppedNode: WorkflowActivityNode = { ...makeWorkflowNode(), status: 'stopped' };
    mount(<WorkflowRunRow node={stoppedNode} now={Date.now()} />);
    expect(container.textContent ?? '').toContain('Parado');
  });
});

describe('WorkflowRunRow sem seletor de autonomia (modo unico automatico)', () => {
  it('NAO renderiza o seletor de autonomia (semi/full/auto-drive removidos)', () => {
    useDynamicWorkflowStore.setState({ runs: [makeRun({ inputJson: '{"autonomy":"auto"}' })] });
    mount(<WorkflowRunRow node={makeWorkflowNode()} now={Date.now()} />);

    expect(container.querySelector('[data-testid="workflow-autonomy-selector"]')).toBeNull();
    expect(container.querySelector('[data-testid="workflow-autonomy-semi"]')).toBeNull();
    expect(container.querySelector('[data-testid="workflow-autonomy-full"]')).toBeNull();
    expect(container.querySelector('[data-testid="workflow-autonomy-auto-drive"]')).toBeNull();
  });

  it('o row continua renderizando header + gate CTA mesmo sem o seletor', () => {
    useDynamicWorkflowStore.setState({ runs: [makeRun({ inputJson: '{"autonomy":"auto"}' })] });
    mount(<WorkflowRunRow node={makeWorkflowNode()} now={Date.now()} />);

    expect(container.querySelector('[data-testid="workflow-run-row"]')).not.toBeNull();
    expect(container.textContent ?? '').toContain('Workflow - implement');
    expect(container.querySelector('[data-testid="workflow-gate-cta"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workflow-autonomy-selector"]')).toBeNull();
  });
});

describe('ActivityPanel rows existentes inalterados (S16)', () => {
  function setActivities(activities: LiveActivity[]): void {
    useChatStore.setState({
      currentSessionId: 'sess-1',
      threads: { 'sess-1': createThreadState({ activities, messages: [], activitiesPanelOpen: true }) },
    });
  }

  it('um root kind pipeline ainda renderiza como bloco de pipeline (nao intercepta workflow)', () => {
    setActivities([activity({ id: 'p1', kind: 'pipeline', label: 'Fase 1', status: 'running', projectId: 'proj-1' })]);
    mount(<ActivityPanel />);
    const text = container.textContent ?? '';
    expect(text).toContain('Fase 1');
    expect(text).toContain('Trabalhando');
    expect(container.querySelector('[data-testid="workflow-run-row"]')).toBeNull();
  });

  it('um root kind workflow renderiza o WorkflowRunRow dedicado', () => {
    useDynamicWorkflowStore.setState({ runs: [makeRun()] });
    setActivities([
      activity({
        id: 'workflow:run-1',
        kind: 'workflow',
        label: 'Workflow - implement',
        status: 'running',
        projectId: 'run-1',
      }),
    ]);
    mount(<ActivityPanel />);
    expect(container.querySelector('[data-testid="workflow-run-row"]')).not.toBeNull();
  });

  it('workflow com run VIVO fica fixo no pino abaixo de Limites e sai do bloco do turno', () => {
    useDynamicWorkflowStore.setState({ runs: [makeRun({ status: 'running' })] });
    setActivities([
      activity({
        id: 'workflow:run-1',
        kind: 'workflow',
        label: 'Workflow - implement',
        status: 'running',
        projectId: 'run-1',
      }),
    ]);
    mount(<ActivityPanel />);
    const pinned = container.querySelector('[data-testid="workflow-pinned"]');
    expect(pinned).not.toBeNull();
    expect(pinned!.querySelector('[data-testid="workflow-run-row"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="workflow-run-row"]').length).toBe(1);
    expect(container.textContent ?? '').toContain('Workflow fixado no topo do painel.');
  });

  it('workflow com run TERMINAL nao e fixado: fica no bloco do turno', () => {
    useDynamicWorkflowStore.setState({ runs: [makeRun({ status: 'completed' })] });
    setActivities([
      activity({
        id: 'workflow:run-1',
        kind: 'workflow',
        label: 'Workflow - implement',
        status: 'running',
        projectId: 'run-1',
      }),
    ]);
    mount(<ActivityPanel />);
    expect(container.querySelector('[data-testid="workflow-pinned"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="workflow-run-row"]').length).toBe(1);
    expect(container.textContent ?? '').not.toContain('Workflow fixado no topo do painel.');
  });

  it('tool e subagente renderizam (sem virar bloco de workflow)', () => {
    setActivities([
      activity({ id: 's1', kind: 'subagent', label: 'meu-agente', status: 'running' }),
      activity({ id: 't1', kind: 'tool', label: 'Read', status: 'done', file: '/tmp/x.ts' }),
    ]);
    mount(<ActivityPanel />);
    const text = container.textContent ?? '';
    expect(text).toContain('meu-agente');
    expect(text).toContain('Read');
    expect(container.querySelector('[data-testid="workflow-run-row"]')).toBeNull();
  });
});

describe('WorkflowChatStrip (S16, 4.3)', () => {
  it('renderiza repo/fase/node/custo/status com run fake chat-bound ativo', () => {
    useDynamicWorkflowStore.setState({ runs: [makeRun()] });
    useChatStore.setState({ currentSessionId: 'sess-1' });
    mount(<WorkflowChatStrip repoLabel="meu-repo" />);

    const strip = container.querySelector('[data-testid="workflow-chat-strip"]');
    expect(strip).not.toBeNull();
    const text = strip?.textContent ?? '';
    expect(text).toContain('meu-repo');
    expect(text).toContain('implement');
    expect(text).toContain('coder');
    expect(text).toMatch(/\$0\.012/);
    expect(text).toContain('executando');
  });

  it('some quando nao ha run chat-bound ativo na conversa', () => {
    useDynamicWorkflowStore.setState({ runs: [makeRun({ chatSessionId: 'outra-sessao' })] });
    useChatStore.setState({ currentSessionId: 'sess-1' });
    mount(<WorkflowChatStrip repoLabel="meu-repo" />);
    expect(container.querySelector('[data-testid="workflow-chat-strip"]')).toBeNull();
  });

  it('some quando o run terminou (status terminal nao e ativo)', () => {
    useDynamicWorkflowStore.setState({ runs: [makeRun({ status: 'completed' })] });
    useChatStore.setState({ currentSessionId: 'sess-1' });
    mount(<WorkflowChatStrip repoLabel="meu-repo" />);
    expect(container.querySelector('[data-testid="workflow-chat-strip"]')).toBeNull();
  });
});

describe('selectChatBoundActiveRuns (S16, AC-13)', () => {
  it('filtra por sessao + status ativo e ordena por startedAt desc', () => {
    const a = makeRun({ id: 'a', chatSessionId: 'sess-1', status: 'running', startedAt: '2026-01-01T00:00:01.000Z' });
    const b = makeRun({ id: 'b', chatSessionId: 'sess-1', status: 'blocked', startedAt: '2026-01-01T00:00:05.000Z' });
    const cOther = makeRun({ id: 'c', chatSessionId: 'sess-2', status: 'running' });
    const dDone = makeRun({ id: 'd', chatSessionId: 'sess-1', status: 'completed' });
    const out = selectChatBoundActiveRuns([a, b, cOther, dDone], 'sess-1');
    expect(out.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('sessao null retorna vazio', () => {
    expect(selectChatBoundActiveRuns([makeRun()], null)).toEqual([]);
  });

  it('label inclui fase/node quando ambos existem', () => {
    expect(workflowIndicatorLabel(makeRun({ currentPhaseId: 'p', currentNodeId: 'n' }))).toBe('p/n');
    expect(workflowIndicatorLabel(makeRun({ currentPhaseId: 'p', currentNodeId: null }))).toBe('p');
  });
});

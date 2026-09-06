// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  WorkflowEventTimeline,
  buildTimelineFeed,
  timelineItemFromEvent,
} from '@/components/dynamic-workflow/WorkflowEventTimeline';
import type { CockpitNodeRun } from '@/types/dynamic-workflow-cockpit';
import { CloserChatView } from '@/components/dynamic-workflow/CloserChatView';
import { summarizeCloserWalkthrough } from '@/components/dynamic-workflow/WorkflowHandoffView';
import { DynamicWorkflowGateModal } from '@/components/dynamic-workflow/DynamicWorkflowGateModal';
import {
  useDynamicWorkflowStore,
  deriveWorkflowUIStatus,
  extractQuestionPrompt,
} from '@/stores/dynamic-workflow-store';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowStreamChunk,
  DynamicWorkflowEvent,
} from '@/types';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;


function makeRun(patch: Partial<DynamicWorkflowRun> = {}): DynamicWorkflowRun {
  return {
    id: 'run-1',
    definitionId: 'def-1',
    chatSessionId: null,
    status: 'running',
    currentPhaseId: 'implement',
    currentNodeId: 'coder',
    workspaceMode: 'run-worktree',
    baseBranch: 'main',
    baseCommitSha: 'abc1234567',
    baseWorktreeHash: null,
    worktreePath: '/tmp/run-1',
    worktreeBranch: 'dynworkflow/run-1',
    deliveredAt: null,
    finalizedAt: null,
    closerSessionId: null,
    closerStatus: null,
    inputJson: '{}',
    outputJson: null,
    checkpointJson: '{}',
    error: null,
    totalCostUsd: 0.1,
    totalDurationMs: 1000,
    createdBy: 'manual',
    startedAt: '2026-06-12T10:00:00.000Z',
    updatedAt: '2026-06-12T10:00:00.000Z',
    completedAt: null,
    ...patch,
  };
}

function resetStore(): void {
  act(() => {
    useDynamicWorkflowStore.setState({
      runs: [],
      selectedRunId: null,
      selectedRun: null,
      nodes: [],
      events: [],
      artifacts: [],
      snapshot: null,
      nodeRuns: [],
      manifest: null,
      nodeStreams: {},
      selectedRoundIndex: null,
      closerThread: [],
      maestroThread: [],
      pendingQuestion: null,
      narrationByRun: {},
      streamingRunIds: new Set<string>(),
      awaitingUserRunIds: new Set<string>(),
      maestroBusyRunIds: new Set<string>(),
      closerBusyRunIds: new Set<string>(),
      error: null,
    });
  });
}


describe('store: awaiting-user, narracao do Maestro e eco (AC-23 + F6)', () => {
  beforeEach(() => {
    resetStore();
    (window as unknown as Record<string, unknown>).lionclaw = {
      dynamicWorkflow: {
        listRuns: vi.fn(async () => []),
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
    };
  });

  it('question-pending marca awaiting-user e preenche pendingQuestion, sem tocar run.status', () => {
    const run = makeRun({ status: 'running' });
    act(() => {
      useDynamicWorkflowStore.setState({
        selectedRunId: 'run-1',
        selectedRun: run,
      });
    });

    const chunk: DynamicWorkflowStreamChunk = {
      kind: 'runner',
      runId: 'run-1',
      type: 'event',
      eventType: 'question-pending',
      nodeId: 'coder',
      payload: { prompt: 'Posso sobrescrever config.ts?' },
    };
    act(() => {
      useDynamicWorkflowStore.getState()._handleStreamChunk(chunk);
    });

    const st = useDynamicWorkflowStore.getState();
    expect(st.getUIStatus('run-1')).toBe('awaiting-user');
    expect(st.selectedRun?.status).toBe('running');
    expect(st.pendingQuestion).not.toBeNull();
    expect(st.pendingQuestion?.nodeId).toBe('coder');
    expect(st.pendingQuestion?.prompt).toBe('Posso sobrescrever config.ts?');
  });

  it('deriveWorkflowUIStatus: awaiting-user vence streaming; status terminal ignora flags', () => {
    expect(deriveWorkflowUIStatus('running', { awaitingUser: true, isStreaming: true })).toBe(
      'awaiting-user',
    );
    expect(deriveWorkflowUIStatus('running', { isStreaming: true })).toBe('streaming');
    expect(deriveWorkflowUIStatus('completed', { awaitingUser: true })).toBe('completed');
  });

  it('extractQuestionPrompt tolera payload sem prompt', () => {
    expect(extractQuestionPrompt({ prompt: 'oi' })).toBe('oi');
    expect(extractQuestionPrompt({ question: 'q?' })).toBe('q?');
    expect(extractQuestionPrompt(null)).toContain('pergunta');
    expect(extractQuestionPrompt({})).toContain('pergunta');
  });

  it('F6: chunk kind narrator acumula na thread do Maestro (role maestro) do run aberto', () => {
    act(() => {
      useDynamicWorkflowStore.setState({ selectedRunId: 'run-1' });
    });
    const chunk: DynamicWorkflowStreamChunk = {
      kind: 'narrator',
      runId: 'run-1',
      type: 'text',
      content: 'Sprint 1 fechou, abrindo a sprint 2.',
    };
    act(() => {
      useDynamicWorkflowStore.getState()._handleStreamChunk(chunk);
    });
    const thread = useDynamicWorkflowStore.getState().maestroThread;
    expect(thread).toHaveLength(1);
    expect(thread[0].role).toBe('maestro');
    expect(thread[0].content).toContain('Sprint 1 fechou');
    expect(useDynamicWorkflowStore.getState().narrationByRun['run-1']).toContain(
      'Sprint 1 fechou, abrindo a sprint 2.',
    );
  });

  it('narracao (kind narrator) limpa o flag maestroBusyRunIds do run (E6.3)', () => {
    act(() => {
      useDynamicWorkflowStore.setState({
        selectedRunId: 'run-1',
        maestroBusyRunIds: new Set<string>(['run-1']),
      });
    });
    act(() => {
      useDynamicWorkflowStore.getState()._handleStreamChunk({
        kind: 'narrator', runId: 'run-1', type: 'text', content: 'Troquei pro opus.',
      });
    });
    expect(useDynamicWorkflowStore.getState().maestroBusyRunIds.has('run-1')).toBe(false);
  });
});


describe('store: openRun re-hidrata narracao/decisoes do cockpit (E6.1/T11)', () => {
  beforeEach(() => {
    resetStore();
    act(() => {
      useDynamicWorkflowStore.setState({
        persistedNarrationByRun: {},
        gateDecisionsByRun: {},
      });
    });
  });

  it('openRun popula persistedNarrationByRun via getMessages e gateDecisionsByRun via getEvents', async () => {
    const messages = [
      {
        id: 1,
        runId: 'run-1',
        nodeId: null,
        role: 'assistant',
        source: 'workflow-orchestrator-agent',
        kind: 'narrator',
        content: 'planejamento concluido.',
        toolCallsJson: null,
        agentId: null,
        createdAt: '2026-06-12T10:00:01.000Z',
      },
    ];
    const events = [
      {
        id: 2,
        runId: 'run-1',
        nodeId: null,
        phaseId: null,
        seq: 2,
        type: 'gate-approved',
        payloadJson: JSON.stringify({
          gateId: 'gate-plan-review-orchestrator',
          approvedBy: 'orchestrator',
        }),
        createdAt: '2026-06-12T10:01:00.000Z',
      },
    ];
    (window as unknown as Record<string, unknown>).lionclaw = {
      dynamicWorkflow: {
        getRun: vi.fn(async () => makeRun()),
        getNodes: vi.fn(async () => []),
        getEvents: vi.fn(async () => events),
        getArtifacts: vi.fn(async () => []),
        getSnapshot: vi.fn(async () => null),
        getMessages: vi.fn(async () => messages),
      },
    };

    await act(async () => {
      await useDynamicWorkflowStore.getState().openRun('run-1');
    });

    const st = useDynamicWorkflowStore.getState();
    expect(st.persistedNarrationByRun['run-1']).toEqual(['planejamento concluido.']);
    expect(st.gateDecisionsByRun['run-1']).toHaveLength(1);
    expect(st.gateDecisionsByRun['run-1'][0]).toMatchObject({
      gateId: 'gate-plan-review-orchestrator',
      decision: 'approved',
      decidedBy: 'orchestrator',
    });
    expect(st.narrationByRun['run-1']).toBeUndefined();
  });
});


describe('WorkflowEventTimeline (F6 sec 5.1, aba secundaria)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = function stub(): void {
      };
    }
  });

  afterEach(() => {
    if (root) {
      const r = root;
      act(() => r.unmount());
      root = null;
    }
    container.remove();
  });

  it('renderiza os itens do feed (evento + nodeId) e o placeholder quando vazio', () => {
    root = createRoot(container);
    act(() => {
      root?.render(
        <WorkflowEventTimeline
          feed={[
            { id: 'e1', kind: 'event', text: 'run-started' },
            { id: 'e2', kind: 'human', text: 'valida o DB-first', nodeId: 'coder' },
          ]}
        />,
      );
    });
    const timeline = container.querySelector('[data-testid="event-timeline"]');
    expect(timeline).not.toBeNull();
    expect(container.textContent).toContain('run-started');
    expect(container.textContent).toContain('valida o DB-first');
    expect(container.textContent).toContain('coder');

    act(() => {
      root?.render(<WorkflowEventTimeline feed={[]} />);
    });
    expect(container.textContent).toContain('Eventos e intervencoes do run');
  });
});


describe('CloserChatView (AC-28 / 13.8)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = function stub(): void {
      };
    }
  });

  afterEach(() => {
    if (root) {
      const r = root;
      act(() => r.unmount());
      root = null;
    }
    container.remove();
  });

  function renderCloser(
    status: string,
    onFinalize = vi.fn(async () => ({ ok: true as const })),
    isBusy = false,
  ): void {
    root = createRoot(container);
    act(() => {
      root?.render(
        <CloserChatView
          runId="run-1"
          thread={[{ id: 'm1', role: 'closer', content: 'Entrega pronta.' }]}
          status={status}
          isBusy={isBusy}
          onSend={async () => ({ ok: true })}
          onFinalize={onFinalize}
        />,
      );
    });
  }

  it('em delivered mostra o botao Finalizar Workflow e o input de conversa', () => {
    renderCloser('delivered');
    expect(container.querySelector('[data-testid="finalize-workflow"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="closer-input"]')).not.toBeNull();
    expect(container.textContent).toContain('Entrega pronta');
  });

  it('em running (nao-delivered) NAO mostra Finalizar', () => {
    renderCloser('running');
    expect(container.querySelector('[data-testid="finalize-workflow"]')).toBeNull();
  });

  it('finalize chama onFinalize', async () => {
    const onFinalize = vi.fn(async () => ({ ok: true }) as { ok: true });
    renderCloser('delivered', onFinalize);
    const btn = container.querySelector(
      '[data-testid="finalize-workflow"]',
    ) as HTMLButtonElement;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onFinalize).toHaveBeenCalledTimes(1);
  });

  it('pos-completed: somente leitura (sem input e sem CTA de criacao)', () => {
    renderCloser('completed');
    expect(container.querySelector('[data-testid="closer-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="finalize-workflow"]')).toBeNull();
    expect(container.querySelector('[data-testid="new-workflow-cta"]')).toBeNull();
  });

  it('Inc4: isBusy mostra o spinner "digitando" no header; sem isBusy nao', () => {
    renderCloser('delivered', undefined, false);
    expect(container.querySelector('.animate-spin')).toBeNull();
    act(() => root?.unmount());
    root = null;
    renderCloser('delivered', undefined, true);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });
});


describe('DynamicWorkflowGateModal: re-plan affordance (SM-2)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      const r = root;
      act(() => r.unmount());
      root = null;
    }
    container.remove();
  });

  function renderModal(
    allowReplan: boolean,
    onDecide = vi.fn(
      async (_decision: 'approve' | 'reject' | 'replan', _reason?: string) =>
        null as string | null,
    ),
  ): typeof onDecide {
    root = createRoot(container);
    act(() => {
      root?.render(
        <DynamicWorkflowGateModal
          open
          gateId="gate-plan-review-human"
          mode="human"
          prompt="Plano nao convergiu; revise."
          allowReplan={allowReplan}
          onClose={() => {}}
          onDecide={onDecide}
        />,
      );
    });
    return onDecide;
  }

  it('gate de plano (allowReplan): mostra o botao "Voltar pro planner" alem de Aprovar/Rejeitar', () => {
    renderModal(true);
    expect(container.querySelector('[data-testid="gate-replan-button"]')).not.toBeNull();
    expect(container.textContent).toContain('Voltar pro planner');
    expect(container.textContent).toContain('Aprovar');
    expect(container.textContent).toContain('Rejeitar');
  });

  it('gate de entrega (sem allowReplan): NAO mostra o botao de re-plan, so Aprovar/Rejeitar', () => {
    renderModal(false);
    expect(container.querySelector('[data-testid="gate-replan-button"]')).toBeNull();
    expect(container.textContent).toContain('Aprovar');
    expect(container.textContent).toContain('Rejeitar');
  });

  it('clicar "Voltar pro planner" chama onDecide com a decisao "replan" (RunView monta o payload action:replan)', async () => {
    const onDecide = renderModal(true);
    const btn = container.querySelector(
      '[data-testid="gate-replan-button"]',
    ) as HTMLButtonElement;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0]?.[0]).toBe('replan');
  });

  it('clicar Aprovar chama onDecide com "approve" (decisao as-is, sem replan)', async () => {
    const onDecide = renderModal(true);
    const approveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Aprovar',
    ) as HTMLButtonElement;
    await act(async () => {
      approveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0]?.[0]).toBe('approve');
  });
});


describe('summarizeCloserWalkthrough (resumo do walkthrough do closer)', () => {
  it('pega a ULTIMA fala do closer (a apresentacao mais recente da entrega)', () => {
    const summary = summarizeCloserWalkthrough([
      { id: '1', role: 'human', content: 'como rodo?' },
      { id: '2', role: 'closer', content: 'primeira versao do walkthrough' },
      { id: '3', role: 'human', content: 'e os testes?' },
      { id: '4', role: 'closer', content: 'walkthrough final: rode npm test' },
    ]);
    expect(summary).toBe('walkthrough final: rode npm test');
  });

  it('sem fala do closer retorna string vazia', () => {
    expect(
      summarizeCloserWalkthrough([{ id: '1', role: 'human', content: 'oi' }]),
    ).toBe('');
    expect(summarizeCloserWalkthrough([])).toBe('');
  });

  it('trunca textos longos com reticencias', () => {
    const long = 'x'.repeat(2000);
    const summary = summarizeCloserWalkthrough(
      [{ id: '1', role: 'closer', content: long }],
      100,
    );
    expect(summary.length).toBeLessThanOrEqual(103);
    expect(summary.endsWith('...')).toBe(true);
  });
});


describe('WorkflowEventTimeline D22: tipo cru + label, node encurtado, hora local', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = function stub(): void {
      };
    }
  });

  afterEach(() => {
    if (root) {
      const r = root;
      act(() => r.unmount());
      root = null;
    }
    container.remove();
  });

  function ev(
    seq: number,
    type: string,
    nodeId: string | null,
    phaseId: string | null,
    payload: Record<string, unknown>,
    createdAt = '2026-09-02 04:42:52',
  ): DynamicWorkflowEvent {
    return { id: seq, runId: 'run-1', nodeId, phaseId, seq, type, payloadJson: JSON.stringify(payload), createdAt };
  }

  it('renderiza o tipo cru E o label humano; nodeId sem ":" fica intacto; hora local com timeZone', () => {
    root = createRoot(container);
    const feed = buildTimelineFeed(
      [
        ev(1, 'run-started', null, null, {}),
        ev(2, 'node-completed', 'coder', 'implement', { attempt: 0, durationMs: 65000, costUsd: 0.25 }),
      ],
      [],
    );
    act(() => {
      root?.render(<WorkflowEventTimeline feed={feed} timeZone="America/Sao_Paulo" />);
    });
    const text = container.textContent ?? '';
    expect(text).toContain('run-started');
    expect(text).toContain('run iniciado');
    expect(text).toContain('node-completed');
    expect(text).toContain('node concluiu');
    const nodeSpan = container.querySelector('[data-testid="timeline-node"]');
    expect(nodeSpan?.textContent).toBe('[coder #0]');
    expect(nodeSpan?.getAttribute('title')).toBe('coder');
    expect(text).toContain('1m05s');
    expect(text).toContain('$0.250');
    expect(container.querySelector('[data-testid="timeline-time"]')?.textContent).toBe('01:42');
    expect(container.querySelector('[data-testid="timeline-day"]')?.textContent).toContain('02/09/2026');
    expect(container.querySelector('[data-testid="timeline-phase"]')?.textContent).toBe('implement');
  });

  it('nodeId implicito "cc:<fase>:<label>:<occ>" e encurtado para o label; nome dos nodeRuns tem precedencia', () => {
    const nodeRuns = [
      {
        nodeId: 'cc:Sprint 1:dynamic-workflow-coder:0',
        agentId: 'dynamic-workflow-coder',
        label: 'u-s1-ac1',
      } as unknown as CockpitNodeRun,
    ];
    const [byLabel] = buildTimelineFeed(
      [ev(1, 'node-started', 'cc:Sprint 1:dynamic-workflow-coder:0', 'Sprint 1', { attempt: 0 })],
      nodeRuns,
    );
    expect(byLabel.nodeLabel).toBe('u-s1-ac1');
    expect(byLabel.nodeId).toBe('cc:Sprint 1:dynamic-workflow-coder:0');
    const [bySlice] = buildTimelineFeed(
      [ev(2, 'node-started', 'cc:Sprint 1:refute-f0:3', 'Sprint 1', { attempt: 0 })],
      [],
    );
    expect(bySlice.nodeLabel).toBe('refute-f0');
    const [byPayload] = buildTimelineFeed(
      [ev(3, 'node-started', 'cc:Sprint 1:x:0', 'Sprint 1', { attempt: 0, label: 'do-payload' })],
      [],
    );
    expect(byPayload.nodeLabel).toBe('do-payload');
  });

  it('severidade e detalhes por tipo/payload (failed, attention, ok, neutral)', () => {
    const failed = timelineItemFromEvent(
      ev(1, 'node-failed', 'coder', 'impl', { attempt: 0, failureClass: 'logic', error: 'writeset violado em src/x.ts' }),
    );
    expect(failed.severity).toBe('failed');
    expect(failed.details).toContain('classe logic');
    expect(failed.details?.some((d) => d.includes('writeset violado'))).toBe(true);

    const provider = timelineItemFromEvent(
      ev(2, 'run-blocked-provider', 'coder', null, { failureClass: 'provider-limit', retriesExhausted: true, nodeError: 'rate limited' }),
    );
    expect(provider.severity).toBe('failed');
    expect(provider.details).toContain('rate limited');

    const retry = timelineItemFromEvent(ev(3, 'node-retry-scheduled', 'coder', null, { attempt: 1, backoffMs: 30000 }));
    expect(retry.severity).toBe('attention');
    expect(retry.details).toContain('backoff 30s');

    const greenOk = timelineItemFromEvent(ev(4, 'green-check', null, 'S1', { ok: true, inconclusive: false }));
    expect(greenOk.severity).toBe('ok');
    expect(greenOk.details).toContain('verde');
    const inconclusive = timelineItemFromEvent(ev(5, 'green-check', null, 'S1', { ok: false, inconclusive: true }));
    expect(inconclusive.severity).toBe('attention');
    expect(inconclusive.details).toContain('inconclusivo');

    const boundary = timelineItemFromEvent(
      ev(6, 'gate-blocked', null, 'boundary:S1', { gateId: 'boundary:S1', mode: 'orchestrator', semaphore: 'ATENCAO' }),
    );
    expect(boundary.severity).toBe('attention');
    expect(boundary.details).toContain('SEMAFORO: ATENCAO');
    const humanGate = timelineItemFromEvent(ev(7, 'gate-blocked', null, null, { gateId: 'cc-delivery', mode: 'orchestrator' }));
    expect(humanGate.severity).toBe('failed');

    const p1 = timelineItemFromEvent(
      ev(8, 'node-completed', 'v', 'S1', { attempt: 0, validatorVerdict: { verdict: 'fail', findingsTotal: 2, blockers: 1 }, p1Count: 1 }),
    );
    expect(p1.severity).toBe('attention');
    expect(p1.details).toContain('fail, 1 P1');

    const phase = timelineItemFromEvent(ev(9, 'phase-changed', null, 'Sprint 2', { phase: 'Sprint 2' }));
    expect(phase.severity).toBe('neutral');
    expect(phase.phaseId).toBe('Sprint 2');
    expect(phase.details).toEqual(['Sprint 2']);

    const broken = timelineItemFromEvent({ ...ev(10, 'custom-event', null, null, {}), payloadJson: '{nope' });
    expect(broken.text).toBe('custom-event');
    expect(broken.label).toBeUndefined();
    expect(broken.details).toEqual([]);
  });

  it('placeholder preservado e sem zinc-600/700 fora de meta mono (D26)', () => {
    root = createRoot(container);
    act(() => {
      root?.render(<WorkflowEventTimeline feed={[]} />);
    });
    const empty = container.querySelector('[data-testid="timeline-empty"]');
    expect(empty?.textContent).toContain('Eventos e intervencoes do run aparecem aqui.');
    expect(empty?.className).toContain('text-zinc-400');
    expect(empty?.className).toContain('text-[12px]');
    expect(container.querySelectorAll('[class*="text-zinc-600"], [class*="text-zinc-700"]').length).toBe(0);
  });
});

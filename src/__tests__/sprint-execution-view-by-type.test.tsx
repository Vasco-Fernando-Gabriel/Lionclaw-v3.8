// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeProjectState {
  sprints: unknown[];
  currentPhase: number | null;
  isStreaming: boolean;
  selectedSprintTab: number;
  pipelineSprintIndex: number | null;
  coderStream: unknown[];
  evaluatorStream: unknown[];
  metrics: unknown;
  streamTimeline: unknown[];
  phaseMetrics: unknown;
}

interface FakeStoreState {
  projects: Array<{ id: string; pipelineType?: string }>;
  sprintHistoryCache: Record<string, Record<number, unknown>>;
  setSelectedSprintTab: (n: number) => void;
  loadSprintHistory: (projectId: string, sprintIndex: number) => Promise<void>;
  abortPipeline: () => Promise<void>;
}

const fake = vi.hoisted(() => ({
  store: null as unknown as FakeStoreState,
  project: null as unknown as FakeProjectState,
}));

vi.mock('@/stores/pipeline-store', () => {
  const usePipelineStore = <T,>(selector: (s: FakeStoreState) => T): T => selector(fake.store);
  usePipelineStore.setState = () => undefined;
  usePipelineStore.getState = () => fake.store;
  return { usePipelineStore };
});

vi.mock('@/hooks/useActiveProjectState', () => ({
  useActiveProjectState: <T,>(selector: (s: FakeProjectState) => T): T | null =>
    fake.project ? selector(fake.project) : null,
}));

let SprintExecutionView: typeof import('@/components/pipeline/SprintExecutionView').SprintExecutionView;
let container: HTMLDivElement;
let root: Root;

const PHASE8_TEXT = 'CONTEUDO-PERSISTIDO-DA-FASE-8';

function resetFakes(pipelineType: string, currentPhase: number | null): void {
  fake.store = {
    projects: [{ id: 'p1', pipelineType }],
    sprintHistoryCache: {
      p1: {
        0: [
          {
            role: 'assistant',
            phaseNumber: 8,
            roundIndex: 1,
            content: PHASE8_TEXT,
            toolCalls: [],
          },
        ],
      },
    },
    setSelectedSprintTab: vi.fn(),
    loadSprintHistory: vi.fn(async () => undefined),
    abortPipeline: vi.fn(async () => undefined),
  };
  fake.project = {
    sprints: [],
    currentPhase,
    isStreaming: false,
    selectedSprintTab: 0,
    pipelineSprintIndex: 0,
    coderStream: [],
    evaluatorStream: [],
    metrics: null,
    streamTimeline: [],
    phaseMetrics: null,
  };
}

beforeAll(async () => {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  ({ SprintExecutionView } = await import('@/components/pipeline/SprintExecutionView'));
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(): void {
  act(() => {
    root.render(<SprintExecutionView totalSprints={1} maxRounds={3} projectId="p1" />);
  });
}

describe('TB-25e — SprintExecutionView classifica a fase POR TIPO', () => {
  it('security na fase 8: a mensagem da fase 8 NAO e bucketizada como Coder', () => {
    resetFakes('security', 8);
    render();
    expect(container.textContent).not.toContain(PHASE8_TEXT);
  });

  it('bug na fase 8: a mensagem da fase 8 E bucketizada como Coder', () => {
    resetFakes('bug', 8);
    render();
    expect(container.textContent).toContain(PHASE8_TEXT);
    expect(container.textContent).toContain('Coder');
  });

  it('security na fase 8 nao entra em execucao de sprint (nao ha round Coder ao vivo)', () => {
    resetFakes('security', 8);
    fake.store.sprintHistoryCache = { p1: { 0: [] } };
    render();
    expect(container.textContent).not.toContain('Coder');
    expect(container.textContent).not.toContain('Evaluator');
  });

  it('bug na fase 8 entra em execucao de sprint com o round rotulado Coder', () => {
    resetFakes('bug', 8);
    fake.store.sprintHistoryCache = { p1: { 0: [] } };
    render();
    expect(container.textContent).toContain('Coder');
  });

  it('security na fase 10 (fase de loop REAL do tipo) continua sendo Coder', () => {
    resetFakes('security', 10);
    fake.store.sprintHistoryCache = { p1: { 0: [] } };
    render();
    expect(container.textContent).toContain('Coder');
  });
});

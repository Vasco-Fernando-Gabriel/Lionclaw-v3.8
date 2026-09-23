// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeProjectState {
  isStreaming: boolean;
  awaitingUser: boolean;
  agentCompleted: boolean;
  phaseStatus: string;
}

interface FakeStoreState {
  projects: Array<{ id: string; pipelineType?: string }>;
  activeProjectId: string | null;
  getCurrentMessages: () => Array<{ role: string; content: string }>;
  approvePhase: (metadata?: Record<string, unknown>) => Promise<void>;
  abortPipeline: () => Promise<void>;
  confirmDevelopment: () => Promise<void>;
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

let PhaseActionButtons: typeof import('@/components/pipeline/PhaseActionButtons').PhaseActionButtons;
let container: HTMLDivElement;
let root: Root;

const makeApproveSpy = () => vi.fn(async (_metadata?: Record<string, unknown>): Promise<void> => undefined);
let approveSpy: ReturnType<typeof makeApproveSpy>;

const GENERIC_HINT = 'em Aprovar para avancar';

function resetFakes(pipelineType: string): void {
  approveSpy = makeApproveSpy();
  fake.store = {
    projects: [{ id: 'p1', pipelineType }],
    activeProjectId: 'p1',
    getCurrentMessages: () => [{ role: 'assistant', content: 'plano pronto' }],
    approvePhase: approveSpy,
    abortPipeline: vi.fn(async () => undefined),
    confirmDevelopment: vi.fn(async () => undefined),
  };
  fake.project = {
    isStreaming: false,
    awaitingUser: true,
    agentCompleted: true,
    phaseStatus: 'awaiting-user',
  };
}

beforeAll(async () => {
  ({ PhaseActionButtons } = await import('@/components/pipeline/PhaseActionButtons'));
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

function render(currentPhase: number): void {
  act(() => {
    root.render(<PhaseActionButtons currentPhase={currentPhase} />);
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

function clickByText(text: string): void {
  const btn = buttons().find((b) => (b.textContent ?? '').includes(text));
  if (!btn)
    throw new Error(
      `botao "${text}" nao encontrado; havia: ${buttons()
        .map((b) => b.textContent)
        .join(' | ')}`,
    );
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('TB-37 (a): bug fase 3 renderiza os dois botoes do gate', () => {
  it('renderiza "Aprovar" e "Encerrar Pipeline"', () => {
    resetFakes('bug');
    render(3);
    const labels = buttons().map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.includes('Aprovar'))).toBe(true);
    expect(labels.some((l) => l.includes('Encerrar Pipeline'))).toBe(true);
  });
});

describe('TB-37 (b): bug fase 3 NAO cai no ApprovalButtons generico', () => {
  it('nao renderiza o hint do caminho generico e renderiza exatamente 2 botoes', () => {
    resetFakes('bug');
    render(3);
    expect(container.textContent ?? '').not.toContain(GENERIC_HINT);
    expect(buttons()).toHaveLength(2);
  });

  it('projeto NAO-bug na fase 3 continua no ApprovalButtons generico', () => {
    resetFakes('development');
    render(3);
    expect(container.textContent ?? '').toContain(GENERIC_HINT);
    expect(container.textContent ?? '').not.toContain('Encerrar Pipeline');
    expect(buttons()).toHaveLength(1);
  });
});

describe('TB-37 (c): cada clique chama approvePhase com o payload do desfecho', () => {
  it('"Aprovar" chama approvePhase({ action: "approve-plan" })', () => {
    resetFakes('bug');
    render(3);
    clickByText('Aprovar');
    expect(approveSpy).toHaveBeenCalledTimes(1);
    expect(approveSpy).toHaveBeenCalledWith({ action: 'approve-plan' });
  });

  it('"Encerrar Pipeline" chama approvePhase({ action: "close-pipeline" })', () => {
    resetFakes('bug');
    render(3);
    clickByText('Encerrar Pipeline');
    expect(approveSpy).toHaveBeenCalledTimes(1);
    expect(approveSpy).toHaveBeenCalledWith({ action: 'close-pipeline' });
  });
});

describe('TB-37 (d): architecture-review fase 4 continua no ApprovalButtons', () => {
  it('renderiza o label proprio da fase 4 e nenhum botao de encerrar', () => {
    resetFakes('architecture-review');
    render(4);
    expect(container.textContent ?? '').toContain('Fechar decisoes e gerar SPEC');
    expect(container.textContent ?? '').not.toContain('Encerrar Pipeline');
    expect(buttons()).toHaveLength(1);
  });

  it('o clique continua chamando approvePhase SEM payload', () => {
    resetFakes('architecture-review');
    render(4);
    clickByText('Fechar decisoes e gerar SPEC');
    expect(approveSpy).toHaveBeenCalledTimes(1);
    expect(approveSpy).toHaveBeenCalledWith();
  });
});

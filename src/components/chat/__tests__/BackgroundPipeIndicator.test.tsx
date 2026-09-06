// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  BackgroundPipeIndicator,
  parseStartedAt,
  selectActiveDrives,
} from '../BackgroundPipeIndicator';
import { useDriveStore } from '@/stores/drive-store';
import { usePipelineStore } from '@/stores/pipeline-store';
import { useAppStore, type Page } from '@/stores/app-store';
import type { DriveState } from '@/types';
import type { PipelineProject } from '@/types/pipeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeDrive(patch?: Partial<DriveState>): DriveState {
  return {
    driver: 'orchestrator',
    status: 'driving',
    handoff: 'none',
    mode: 'semi',
    requiresHumanPhases: [],
    ...patch,
  };
}

function makeProject(
  id: string,
  name: string,
  currentPhase: PipelineProject['currentPhase'],
): PipelineProject {
  return {
    id,
    name,
    projectPath: `/tmp/${id}`,
    specPath: `/tmp/${id}/spec.md`,
    status: 'running',
    currentPhase,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function isoSecondsAgo(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

describe('BackgroundPipeIndicator (B3)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let setActiveProjectSpy: Mock<(projectId: string | null) => void>;
  let setPageSpy: Mock<(page: Page) => void>;

  function mount(): void {
    root = createRoot(container);
    act(() => {
      root?.render(<BackgroundPipeIndicator />);
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
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);

    (window as unknown as Record<string, unknown>).lionclaw = {
      drive: { getState: vi.fn(async () => null) },
    };

    setActiveProjectSpy = vi.fn<(projectId: string | null) => void>();
    setPageSpy = vi.fn<(page: Page) => void>();
    useDriveStore.setState({ drives: new Map(), pending: new Set() });
    usePipelineStore.setState({
      projects: [],
      projectStates: new Map(),
      setActiveProject: setActiveProjectSpy,
    });
    useAppStore.setState({ setPage: setPageSpy });
  });

  afterEach(() => {
    unmount();
    container.remove();
    vi.useRealTimers();
  });

  it('driving: chip com nome+fase+relogio; remount NAO zera o elapsed (B3-AC1)', () => {
    useDriveStore.setState({
      drives: new Map([['p1', makeDrive({ startedAt: isoSecondsAgo(65) })]]),
    });
    usePipelineStore.setState({ projects: [makeProject('p1', 'Meu App', 3)] });

    mount();
    expect(container.textContent).toContain('Meu App - Fase 3');
    expect(container.textContent).toContain('1:05');
    expect(container.querySelector('.animate-spin')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.textContent).toContain('1:10');

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    mount();
    expect(container.textContent).toContain('1:20');
    expect(container.textContent).not.toContain('0:00');
  });

  it('awaiting-human: icone de pausa (sem spin) + "aguardando voce" + relogio', () => {
    useDriveStore.setState({
      drives: new Map([
        ['p1', makeDrive({ status: 'awaiting-human', startedAt: isoSecondsAgo(30) })],
      ]),
    });
    usePipelineStore.setState({ projects: [makeProject('p1', 'Meu App', 4)] });

    mount();
    expect(container.textContent).toContain('Meu App - Fase 4');
    expect(container.textContent).toContain('aguardando voce');
    expect(container.textContent).toContain('0:30');
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('ausente: sem drive dirigido => nada renderizado, zero render extra (B3-AC2)', () => {
    useDriveStore.setState({
      drives: new Map<string, DriveState | null>([
        ['p1', null],
        ['p2', makeDrive({ status: 'stopped' })],
        ['p3', makeDrive({ driver: 'human' })],
      ]),
    });
    usePipelineStore.setState({
      projects: [
        makeProject('p1', 'A', 1),
        makeProject('p2', 'B', 2),
        makeProject('p3', 'C', 3),
      ],
    });

    mount();
    expect(container.innerHTML).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drive sem startedAt (legado): mostra a fase SEM relogio (graceful)', () => {
    useDriveStore.setState({
      drives: new Map([['p1', makeDrive()]]),
    });
    usePipelineStore.setState({ projects: [makeProject('p1', 'Meu App', 7)] });

    mount();
    expect(container.textContent).toContain('Meu App - Fase 7');
    expect(container.querySelector('.font-mono')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clique: navega pro pipeline (setActiveProject + setPage)', () => {
    useDriveStore.setState({
      drives: new Map([['p1', makeDrive({ startedAt: isoSecondsAgo(10) })]]),
    });
    usePipelineStore.setState({ projects: [makeProject('p1', 'Meu App', 3)] });

    mount();
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(setActiveProjectSpy).toHaveBeenCalledWith('p1');
    expect(setPageSpy).toHaveBeenCalledWith('pipeline');
  });

  it('multiplos drives: mostra o mais recente + badge "+N"', () => {
    useDriveStore.setState({
      drives: new Map([
        ['p1', makeDrive({ startedAt: isoSecondsAgo(300) })],
        ['p2', makeDrive({ startedAt: isoSecondsAgo(10) })],
      ]),
    });
    usePipelineStore.setState({
      projects: [makeProject('p1', 'Antigo', 2), makeProject('p2', 'Recente', 9)],
    });

    mount();
    expect(container.textContent).toContain('Recente - Fase 9');
    expect(container.textContent).not.toContain('Antigo');
    expect(container.textContent).toContain('+1');
  });

  it('fase corrente do projectStates tem precedencia sobre a do projeto', () => {
    useDriveStore.setState({
      drives: new Map([['p1', makeDrive({ startedAt: isoSecondsAgo(5) })]]),
    });
    const empty = usePipelineStore.getState()._createEmptyProjectState();
    usePipelineStore.setState({
      projects: [makeProject('p1', 'Meu App', 3)],
      projectStates: new Map([['p1', { ...empty, currentPhase: 5 }]]),
    });

    mount();
    expect(container.textContent).toContain('Meu App - Fase 5');
  });
});

describe('selectActiveDrives / parseStartedAt (helpers puros)', () => {
  it('filtra so driver=orchestrator com status driving/awaiting-human', () => {
    const drives = new Map<string, DriveState | null>([
      ['a', makeDrive({ status: 'driving' })],
      ['b', makeDrive({ status: 'awaiting-human' })],
      ['c', makeDrive({ status: 'stopped' })],
      ['d', makeDrive({ driver: 'human', status: 'driving' })],
      ['e', null],
    ]);
    const active = selectActiveDrives(drives);
    expect(active.map((x) => x.projectId).sort()).toEqual(['a', 'b']);
  });

  it('ordena do mais recente pro mais antigo; sem startedAt vai pro fim', () => {
    const drives = new Map<string, DriveState | null>([
      ['velho', makeDrive({ startedAt: '2026-06-09T10:00:00.000Z' })],
      ['legado', makeDrive()],
      ['novo', makeDrive({ startedAt: '2026-06-09T12:00:00.000Z' })],
    ]);
    const active = selectActiveDrives(drives);
    expect(active.map((x) => x.projectId)).toEqual(['novo', 'velho', 'legado']);
  });

  it('parseStartedAt: ISO valido vira epoch ms; ausente/invalido vira null', () => {
    expect(parseStartedAt('2026-06-09T12:00:00.000Z')).toBe(
      Date.parse('2026-06-09T12:00:00.000Z'),
    );
    expect(parseStartedAt(undefined)).toBeNull();
    expect(parseStartedAt('nao-e-data')).toBeNull();
  });
});

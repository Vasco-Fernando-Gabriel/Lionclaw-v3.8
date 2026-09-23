// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatCapabilityToggles, ChatCapabilityResendAffordance } from '../ChatCapabilityToggle';
import {
  useChatFeatureTogglesStore,
  computeMcpAvailability,
  capabilityForServerId,
} from '@/stores/chat-feature-toggles-store';
import { createThreadState, useChatStore } from '@/stores/chat-store';
import type { ChatFeatureTogglesResult, ChatSession, MCPServerConfig } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function okResult(pipelineControl: boolean, dynamicWorkflows: boolean): ChatFeatureTogglesResult {
  return { ok: true, toggles: { pipelineControl, dynamicWorkflows } };
}

function mcpServer(id: string, isActive: boolean): MCPServerConfig {
  return { id, name: id, command: 'node', args: [], envKeys: [], isActive };
}

const BOTH_ACTIVE: MCPServerConfig[] = [
  mcpServer('lionclaw-pipeline-control', true),
  mcpServer('lionclaw-dynamic-workflows', true),
];

function makeSession(id: string, patch?: Partial<ChatSession>): ChatSession {
  return {
    id,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    status: 'active',
    type: 'chat',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('ChatCapabilityToggles (S7, A.8)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let getFeatureTogglesMock: Mock;
  let setFeatureTogglesMock: Mock;
  let mcpListMock: Mock;
  let sendMock: Mock;

  function mount(node: React.ReactElement): void {
    if (!root) root = createRoot(container);
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

  function chip(capability: 'pipelineControl' | 'dynamicWorkflows' | 'swarm'): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(`[data-capability="${capability}"]`);
    expect(el).not.toBeNull();
    return el!;
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);

    getFeatureTogglesMock = vi.fn(async () => okResult(false, false));
    setFeatureTogglesMock = vi.fn(async () => okResult(false, false));
    mcpListMock = vi.fn(async () => BOTH_ACTIVE);
    sendMock = vi.fn(async () => undefined);

    (window as unknown as Record<string, unknown>).lionclaw = {
      chat: {
        getFeatureToggles: getFeatureTogglesMock,
        setFeatureToggles: setFeatureTogglesMock,
        send: sendMock,
      },
      mcp: { list: mcpListMock },
    };

    useChatFeatureTogglesStore.setState({
      sessions: {},
      mcpAvailable: { pipelineControl: true, dynamicWorkflows: true, swarm: true },
    });
    useChatStore.setState({
      sessions: [makeSession('s1')],
      telegramSessions: [],
      openLanes: [],
      currentSessionId: 's1',
      threads: { s1: createThreadState({ hydrated: true }) },
      streamingSessionIds: new Set(),
    });
  });

  afterEach(() => {
    unmount();
    container.remove();
    vi.restoreAllMocks();
  });

  it('loading: chips em pulse + disabled ate hidratar; depois off (zinc) habilitado', async () => {
    const d = deferred<ChatFeatureTogglesResult>();
    getFeatureTogglesMock.mockReturnValue(d.promise);

    mount(<ChatCapabilityToggles sessionId="s1" />);

    for (const cap of ['pipelineControl', 'dynamicWorkflows'] as const) {
      const el = chip(cap);
      expect(el.dataset.state).toBe('loading');
      expect(el.disabled).toBe(true);
      expect(el.className).toContain('animate-pulse');
    }

    await act(async () => {
      d.resolve(okResult(false, false));
    });

    for (const cap of ['pipelineControl', 'dynamicWorkflows'] as const) {
      const el = chip(cap);
      expect(el.dataset.state).toBe('off');
      expect(el.disabled).toBe(false);
      expect(el.getAttribute('aria-pressed')).toBe('false');
      expect(el.className).toContain('text-zinc-500');
    }
    expect(getFeatureTogglesMock).toHaveBeenCalledWith('s1');
  });

  it('on: Pipeline cyan, Workflows violet, aria-pressed + tooltip "Vale para o próximo envio"', async () => {
    getFeatureTogglesMock.mockResolvedValue(okResult(true, true));

    mount(<ChatCapabilityToggles sessionId="s1" />);
    await flush();

    const pipe = chip('pipelineControl');
    expect(pipe.dataset.state).toBe('on');
    expect(pipe.getAttribute('aria-pressed')).toBe('true');
    expect(pipe.className).toContain('text-cyan-300');
    expect(pipe.getAttribute('aria-label')).toContain('Pipeline: ligado');
    expect(pipe.title).toContain('Vale para o próximo envio');

    const wf = chip('dynamicWorkflows');
    expect(wf.dataset.state).toBe('on');
    expect(wf.className).toContain('text-violet-300');
    expect(wf.getAttribute('aria-label')).toContain('Workflows: ligado');
  });

  it('disabled (read-only/onboarding): chips VISIVEIS porem desabilitados, nao ocultos', async () => {
    getFeatureTogglesMock.mockResolvedValue(okResult(false, false));

    mount(<ChatCapabilityToggles sessionId="s1" disabled />);
    await flush();

    const chips = container.querySelectorAll('[data-capability]');
    expect(chips.length).toBe(3);
    for (const el of chips) {
      expect((el as HTMLButtonElement).disabled).toBe(true);
    }
    act(() => {
      chip('pipelineControl').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(setFeatureTogglesMock).not.toHaveBeenCalled();
  });

  it('unavailable: toggle on + MCP global inativo = amber + snapshot efetivo false', async () => {
    getFeatureTogglesMock.mockResolvedValue(okResult(true, false));
    mcpListMock.mockResolvedValue([
      mcpServer('lionclaw-pipeline-control', false), // MCP global INATIVO
      mcpServer('lionclaw-dynamic-workflows', true),
    ]);

    mount(<ChatCapabilityToggles sessionId="s1" />);
    await flush();

    const pipe = chip('pipelineControl');
    expect(pipe.dataset.state).toBe('unavailable');
    expect(pipe.className).toContain('text-amber-400');
    expect(pipe.getAttribute('aria-label')).toContain('indisponível');
    expect(chip('dynamicWorkflows').dataset.state).toBe('off');

    const snapshot = useChatFeatureTogglesStore.getState().snapshotForSend('s1');
    expect(snapshot).toEqual({ pipelineControl: false, dynamicWorkflows: false, swarm: false });
  });

  it('toggle: clique chama chat:set-feature-toggles com o patch e atualiza o chip', async () => {
    getFeatureTogglesMock.mockResolvedValue(okResult(false, false));
    setFeatureTogglesMock.mockResolvedValue(okResult(true, false));

    mount(<ChatCapabilityToggles sessionId="s1" />);
    await flush();

    await act(async () => {
      chip('pipelineControl').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(setFeatureTogglesMock).toHaveBeenCalledWith('s1', { pipelineControl: true });
    expect(chip('pipelineControl').dataset.state).toBe('on');
    expect(chip('pipelineControl').getAttribute('aria-pressed')).toBe('true');
    expect(chip('dynamicWorkflows').dataset.state).toBe('off');
  });

  it('set com erro estruturado: chip mantem estado e o erro humano aparece', async () => {
    getFeatureTogglesMock.mockResolvedValue(okResult(false, false));
    setFeatureTogglesMock.mockResolvedValue({
      ok: false,
      code: 'session_not_active',
      error: 'Sessão não está ativa.',
    } satisfies ChatFeatureTogglesResult);

    mount(<ChatCapabilityToggles sessionId="s1" />);
    await flush();

    await act(async () => {
      chip('pipelineControl').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(chip('pipelineControl').dataset.state).toBe('off');
    expect(container.textContent).toContain('Sessão não está ativa.');
  });

  it('reidratacao ao trocar sessao NAO vaza estado da sessao anterior (AC-A13)', async () => {
    const s1 = deferred<ChatFeatureTogglesResult>();
    const s2 = deferred<ChatFeatureTogglesResult>();
    getFeatureTogglesMock.mockImplementation((sessionId: string) => (sessionId === 's1' ? s1.promise : s2.promise));

    mount(<ChatCapabilityToggles sessionId="s1" />);
    await act(async () => {
      s1.resolve(okResult(true, true));
    });
    expect(chip('pipelineControl').dataset.state).toBe('on');

    mount(<ChatCapabilityToggles sessionId="s2" />);
    expect(chip('pipelineControl').dataset.state).toBe('loading');
    expect(chip('dynamicWorkflows').dataset.state).toBe('loading');
    expect(useChatFeatureTogglesStore.getState().snapshotForSend('s2')).toBeUndefined();
    expect(useChatFeatureTogglesStore.getState().snapshotForSend('s1')).toEqual({
      pipelineControl: true,
      dynamicWorkflows: true,
      swarm: false,
    });

    await act(async () => {
      s2.resolve(okResult(false, false));
    });
    expect(chip('pipelineControl').dataset.state).toBe('off');
    expect(useChatFeatureTogglesStore.getState().snapshotForSend('s2')).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
      swarm: false,
    });
  });

  it('resposta ATRASADA da sessao antiga chegando depois e descartada (race)', async () => {
    const s1 = deferred<ChatFeatureTogglesResult>();
    const s2 = deferred<ChatFeatureTogglesResult>();
    getFeatureTogglesMock.mockImplementation((sessionId: string) => (sessionId === 's1' ? s1.promise : s2.promise));

    mount(<ChatCapabilityToggles sessionId="s1" />);
    mount(<ChatCapabilityToggles sessionId="s2" />);

    await act(async () => {
      s2.resolve(okResult(false, false));
    });
    expect(chip('pipelineControl').dataset.state).toBe('off');

    await act(async () => {
      s1.resolve(okResult(true, true));
    });
    expect(chip('pipelineControl').dataset.state).toBe('off');
    expect(useChatFeatureTogglesStore.getState().sessions.s2.toggles).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
      swarm: false,
    });
    expect(useChatFeatureTogglesStore.getState().sessions.s1.toggles).toEqual({
      pipelineControl: true,
      dynamicWorkflows: true,
      swarm: false,
    });
  });

  it('sendMessage envia o snapshot atual em todo send; sem hidratacao OMITE featureToggles', async () => {
    await useChatStore.getState().sendMessage('primeira');
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1].featureToggles).toBeUndefined();

    getFeatureTogglesMock.mockResolvedValue(okResult(true, false));
    await act(async () => {
      await useChatFeatureTogglesStore.getState().hydrate('s1');
    });
    useChatStore.setState({ threads: { s1: createThreadState({ hydrated: true }) }, streamingSessionIds: new Set() });
    await useChatStore.getState().sendMessage('segunda');
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][1].featureToggles).toEqual({
      pipelineControl: true,
      dynamicWorkflows: false,
      swarm: false,
    });
  });

  it('Swarm aceita revisão baixa de run nova após run anterior concluída', async () => {
    let emit: (event: { runId: string; chatSessionId: string; revision: number }) => void = () => {};
    const api = window.lionclaw as unknown as Record<string, unknown>;
    api.swarm = {
      listRuns: async () => ({ runs: [{ runId: 'old' }], nextCursor: null }),
      getRunState: async (_sessionId: string, runId: string) => ({
        runId,
        revision: runId === 'old' ? 30 : 1,
        status: runId === 'old' ? 'done' : 'running',
        items: [{ status: 'running' }],
      }),
      onStream: (callback: typeof emit) => {
        emit = callback;
        return () => {};
      },
    };
    mount(<ChatCapabilityToggles sessionId="s1" />);
    await flush();
    await act(async () => {
      emit({ runId: 'new', chatSessionId: 's1', revision: 1 });
    });
    expect(chip('swarm').textContent).toContain('0/1');
  });

  it('chips NUNCA mostram nome/fase de execucao — so o rotulo do toggle (AC-A14/A15)', async () => {
    getFeatureTogglesMock.mockResolvedValue(okResult(true, true));
    mount(<ChatCapabilityToggles sessionId="s1" />);
    await flush();

    expect(chip('pipelineControl').textContent).toBe('Pipeline');
    expect(chip('dynamicWorkflows').textContent).toBe('Workflows');
    expect(container.textContent).not.toMatch(/Fase \d/);
    expect(container.querySelector('.font-mono')).toBeNull();
  });
});

describe('ChatCapabilityResendAffordance (S7, AC-A21)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let getFeatureTogglesMock: Mock;
  let setFeatureTogglesMock: Mock;
  let sendMock: Mock;

  function mount(node: React.ReactElement): void {
    if (!root) root = createRoot(container);
    act(() => {
      root?.render(node);
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);

    getFeatureTogglesMock = vi.fn(async () => okResult(false, false));
    setFeatureTogglesMock = vi.fn(async () => okResult(true, false));
    sendMock = vi.fn(async () => undefined);

    (window as unknown as Record<string, unknown>).lionclaw = {
      chat: {
        getFeatureToggles: getFeatureTogglesMock,
        setFeatureToggles: setFeatureTogglesMock,
        send: sendMock,
      },
      mcp: { list: vi.fn(async () => BOTH_ACTIVE) },
    };

    useChatFeatureTogglesStore.setState({
      sessions: {},
      mcpAvailable: { pipelineControl: true, dynamicWorkflows: true, swarm: true },
    });
    useChatStore.setState({
      sessions: [makeSession('s1')],
      telegramSessions: [],
      openLanes: [],
      currentSessionId: 's1',
      threads: { s1: createThreadState({ hydrated: true }) },
      streamingSessionIds: new Set(),
    });
  });

  afterEach(() => {
    const r = root;
    if (r) {
      act(() => {
        r.unmount();
      });
      root = null;
    }
    container.remove();
    vi.restoreAllMocks();
  });

  it('sem erro de capability: nada renderizado; codigo desconhecido e ignorado', () => {
    mount(<ChatCapabilityResendAffordance />);
    expect(container.innerHTML).toBe('');

    act(() => {
      useChatStore.getState().handleStreamChunk({ type: 'error', sessionId: 's1', error: 'boom' });
    });
    expect(container.innerHTML).toBe('');
    act(() => {
      useChatStore.getState().handleStreamChunk({
        type: 'error',
        sessionId: 's1',
        error: 'x',
        code: 'orchestrator_unconfigured',
      });
    });
    expect(container.innerHTML).toBe('');
  });

  it('erro chat_capability_pipeline_disabled: oferece "Ligar Pipeline e reenviar", liga SO no clique e reenvia com o novo snapshot', async () => {
    await act(async () => {
      await useChatFeatureTogglesStore.getState().hydrate('s1');
    });
    await act(async () => {
      await useChatStore.getState().sendMessage('roda o pipeline do projeto X');
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1].featureToggles).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
      swarm: false,
    });

    act(() => {
      useChatStore.getState().handleStreamChunk({
        type: 'error',
        sessionId: 's1',
        error: 'Pipeline está desligado para esta sessão. Ligue o chip Pipeline no chat e envie novamente.',
        code: 'chat_capability_pipeline_disabled',
      });
    });

    mount(<ChatCapabilityResendAffordance />);
    expect(container.textContent).toContain('Pipeline está desligado para esta sessão');
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Ligar Pipeline e reenviar',
    );
    expect(button).not.toBeUndefined();
    expect(setFeatureTogglesMock).not.toHaveBeenCalled();

    useChatStore.setState({ threads: { s1: createThreadState({ hydrated: true }) }, streamingSessionIds: new Set() });
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(setFeatureTogglesMock).toHaveBeenCalledWith('s1', { pipelineControl: true });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][0]).toBe('roda o pipeline do projeto X');
    expect(sendMock.mock.calls[1][1].featureToggles).toEqual({
      pipelineControl: true,
      dynamicWorkflows: false,
      swarm: false,
    });
    expect(container.textContent).not.toContain('Ligar Pipeline e reenviar');
  });

  it('erro chat_capability_workflows_disabled: botao rotulado com Workflows e patch correto', async () => {
    setFeatureTogglesMock.mockResolvedValue(okResult(false, true));
    await act(async () => {
      await useChatFeatureTogglesStore.getState().hydrate('s1');
    });
    await act(async () => {
      await useChatStore.getState().sendMessage('cria um workflow');
    });

    act(() => {
      useChatStore.getState().handleStreamChunk({
        type: 'error',
        sessionId: 's1',
        error: 'Workflows está desligado para esta sessão. Ligue o chip Workflows no chat e envie novamente.',
        code: 'chat_capability_workflows_disabled',
      });
    });

    mount(<ChatCapabilityResendAffordance />);
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Ligar Workflows e reenviar',
    );
    expect(button).not.toBeUndefined();

    useChatStore.setState({ threads: { s1: createThreadState({ hydrated: true }) }, streamingSessionIds: new Set() });
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(setFeatureTogglesMock).toHaveBeenCalledWith('s1', { dynamicWorkflows: true });
    expect(sendMock.mock.calls[1][1].featureToggles).toEqual({
      pipelineControl: false,
      dynamicWorkflows: true,
      swarm: false,
    });
  });

  it('novo envio do usuario limpa a affordance pendente (reenvio e sempre da ULTIMA mensagem)', async () => {
    await act(async () => {
      await useChatFeatureTogglesStore.getState().hydrate('s1');
    });
    act(() => {
      useChatFeatureTogglesStore.getState().recordSend({ sessionId: 's1', message: 'antiga' });
      useChatStore.getState().handleStreamChunk({
        type: 'error',
        sessionId: 's1',
        error: 'Pipeline está desligado para esta sessão.',
        code: 'chat_capability_pipeline_disabled',
      });
    });
    mount(<ChatCapabilityResendAffordance />);
    expect(container.textContent).toContain('Pipeline');

    await act(async () => {
      await useChatStore.getState().sendMessage('mensagem nova');
    });
    expect(container.innerHTML).toBe('');
  });

  it('dispensar fecha a affordance sem ligar nada', async () => {
    act(() => {
      useChatFeatureTogglesStore.getState().recordSend({ sessionId: 's1', message: 'm' });
      useChatFeatureTogglesStore.getState().handleCapabilityError('s1', 'chat_capability_pipeline_disabled', undefined);
    });
    mount(<ChatCapabilityResendAffordance />);
    expect(container.textContent).toContain('Pipeline está desligado para esta sessão');

    const dismiss = container.querySelector<HTMLButtonElement>('[aria-label="Dispensar aviso"]');
    expect(dismiss).not.toBeNull();
    await act(async () => {
      dismiss!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.innerHTML).toBe('');
    expect(setFeatureTogglesMock).not.toHaveBeenCalled();
  });
});

describe('helpers puros do chat-feature-toggles-store', () => {
  it('capabilityForServerId: ids canonicos + alias normalizados (AC-A17); resto undefined', () => {
    expect(capabilityForServerId('lionclaw-pipeline-control')).toBe('pipelineControl');
    expect(capabilityForServerId('pipeline-control')).toBe('pipelineControl');
    expect(capabilityForServerId('LionClaw-Pipeline-Control')).toBe('pipelineControl');
    expect(capabilityForServerId('lionclaw-dynamic-workflows')).toBe('dynamicWorkflows');
    expect(capabilityForServerId('dynamic-workflows')).toBe('dynamicWorkflows');
    expect(capabilityForServerId('lionclaw-agents')).toBeUndefined();
    expect(capabilityForServerId('repo-graph')).toBeUndefined();
  });

  it('computeMcpAvailability: ausente ou isActive=false = indisponivel', () => {
    expect(computeMcpAvailability([])).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
      swarm: false,
    });
    expect(
      computeMcpAvailability([
        mcpServer('lionclaw-pipeline-control', true),
        mcpServer('lionclaw-dynamic-workflows', false),
        mcpServer('lionclaw-agents', true),
      ]),
    ).toEqual({ pipelineControl: true, dynamicWorkflows: false, swarm: false });
  });
});

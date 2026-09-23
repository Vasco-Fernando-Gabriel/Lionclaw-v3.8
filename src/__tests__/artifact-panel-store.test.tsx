// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createThreadState, useChatStore } from '@/stores/chat-store';
import { useArtifactPanelStore } from '@/stores/artifact-panel-store';
import type { ArtifactData } from '@/types';

function htmlArtifact(id: string): ArtifactData {
  return {
    id,
    type: 'html',
    title: `Pagina ${id}`,
    toolName: 'file-output',
    data: {
      filePath: `C:\\Users\\x\\.lionclaw\\artifacts\\${id}.html`,
      fileName: `${id}.html`,
      size: 10,
      sha256: 'a'.repeat(64),
    },
  };
}

describe('artifact-panel-store (7.1 / 7.3 / 7.5, D10 / D12)', () => {
  beforeEach(() => {
    useChatStore.setState({
      currentSessionId: 'lane-a',
      threads: {
        'lane-a': createThreadState({ activitiesPanelOpen: true }),
        'lane-b': createThreadState({ activitiesPanelOpen: false }),
      },
    });
    useArtifactPanelStore.setState({ current: null, sessionId: null, mode: 'side', activitiesWereOpen: null });
  });

  it('abrir recolhe o painel de Atividade pelo toggle existente e fechar restaura o estado anterior', () => {
    useArtifactPanelStore.getState().open(htmlArtifact('a1'), 'lane-a');
    expect(useArtifactPanelStore.getState().mode).toBe('side');
    expect(useChatStore.getState().threads['lane-a'].activitiesPanelOpen).toBe(false);

    useArtifactPanelStore.getState().close();
    expect(useArtifactPanelStore.getState().current).toBeNull();
    expect(useChatStore.getState().threads['lane-a'].activitiesPanelOpen).toBe(true);
  });

  it('nao reabre Atividade que ja estava recolhida', () => {
    useArtifactPanelStore.getState().open(htmlArtifact('b1'), 'lane-b');
    useArtifactPanelStore.getState().close();
    expect(useChatStore.getState().threads['lane-b'].activitiesPanelOpen).toBe(false);
  });

  it('abrir outro artefato na mesma lane substitui sem mexer no estado guardado de Atividade', () => {
    useArtifactPanelStore.getState().open(htmlArtifact('a1'), 'lane-a');
    useArtifactPanelStore.getState().open(htmlArtifact('a2'), 'lane-a');
    expect(useArtifactPanelStore.getState().current?.id).toBe('a2');
    expect(useArtifactPanelStore.getState().activitiesWereOpen).toBe(true);
    useArtifactPanelStore.getState().close();
    expect(useChatStore.getState().threads['lane-a'].activitiesPanelOpen).toBe(true);
  });

  it('minimizar devolve Atividade; restaurar recolhe de novo; tela cheia nunca e automatica', () => {
    useArtifactPanelStore.getState().open(htmlArtifact('a1'), 'lane-a');
    useArtifactPanelStore.getState().setMode('minimized');
    expect(useChatStore.getState().threads['lane-a'].activitiesPanelOpen).toBe(true);
    expect(useArtifactPanelStore.getState().current?.id).toBe('a1');

    useArtifactPanelStore.getState().setMode('side');
    expect(useChatStore.getState().threads['lane-a'].activitiesPanelOpen).toBe(false);

    useArtifactPanelStore.getState().open(htmlArtifact('a3'), 'lane-a');
    expect(useArtifactPanelStore.getState().mode).toBe('side');
  });

  it('setMode sem artefato e no-op', () => {
    useArtifactPanelStore.getState().setMode('full');
    expect(useArtifactPanelStore.getState().mode).toBe('side');
  });
});

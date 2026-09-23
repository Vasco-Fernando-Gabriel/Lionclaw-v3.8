import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach } from 'vitest';
import type { DriveState, OpenChatSession } from '@/types';
import type { PipelineProject } from '@/types/pipeline';

export function lane(id: string, laneBadge: number, over: Partial<OpenChatSession> = {}): OpenChatSession {
  return {
    id,
    laneBadge,
    title: `Conversa ${id}`,
    orchestrator: null,
    messageCount: 4,
    lastUserMessageAt: '2020-01-01T00:00:00Z',
    createdAt: '2020-01-01T00:00:00Z',
    updatedAt: '2020-01-01T00:00:00Z',
    state: 'idle',
    drive: null,
    ...over,
  };
}
export function drive(sessionId: string, status: DriveState['status'] = 'driving'): DriveState {
  return { sessionId, status, driver: 'orchestrator', handoff: 'none', mode: 'semi', requiresHumanPhases: [] };
}
export function project(id: string): PipelineProject {
  return {
    id,
    name: id,
    projectPath: '',
    specPath: '',
    status: 'running',
    currentPhase: null,
    createdAt: '',
    updatedAt: '',
  };
}
export function mountedTest() {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  return {
    get container() {
      return container;
    },
    async render(node: ReactNode) {
      await act(async () => {
        root.render(node);
      });
    },
  };
}

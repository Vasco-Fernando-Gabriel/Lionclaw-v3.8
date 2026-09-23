// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let streamCb: ((chunk: unknown) => void) | null = null;
let onEventCleanup: ReturnType<typeof vi.fn>;

beforeAll(() => {
  onEventCleanup = vi.fn();
  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      dynamicWorkflow: {
        listRuns: vi.fn(async () => []),
        getRun: vi.fn(async () => null),
        getNodes: vi.fn(async () => []),
        getEvents: vi.fn(async () => []),
        getArtifacts: vi.fn(async () => []),
        getSnapshot: vi.fn(async () => null),
        onEvent: vi.fn((cb: (chunk: unknown) => void) => {
          streamCb = cb;
          return onEventCleanup;
        }),
      },
    },
  };
});

import { useDynamicWorkflowStore } from '@/stores/dynamic-workflow-store';

describe('ChatPage: fiacao do listener do dynamic-workflow-store (DEFECT-6 ITEM 3)', () => {
  const chatPageSource = readFileSync(join(__dirname, '..', 'pages', 'ChatPage.tsx'), 'utf8');

  it('importa o store de dynamic-workflow', () => {
    expect(chatPageSource).toMatch(
      /import\s*\{\s*useDynamicWorkflowStore\s*\}\s*from\s*'@\/stores\/dynamic-workflow-store'/,
    );
  });

  it('chama useDynamicWorkflowStore.getState().init() (monta o listener no ancestral)', () => {
    expect(chatPageSource).toContain('useDynamicWorkflowStore.getState().init()');
  });

  it('monta o init dentro de um useEffect que DEVOLVE o cleanup (sem vazamento)', () => {
    const idx = chatPageSource.indexOf('useDynamicWorkflowStore.getState().init()');
    expect(idx).toBeGreaterThan(0);
    const window = chatPageSource.slice(Math.max(0, idx - 200), idx + 200);
    expect(window).toMatch(/const\s+cleanup\s*=\s*useDynamicWorkflowStore\.getState\(\)\.init\(\)/);
    expect(window).toMatch(/return\s+cleanup\s*;/);
  });

  it('espelha o padrao ja existente do useRepoGraphStore.getState().init() (consistencia)', () => {
    expect(chatPageSource).toContain('useRepoGraphStore.getState().init()');
  });
});

describe('dynamic-workflow-store.init(): listener + cleanup (mecanismo do cockpit)', () => {
  beforeEach(() => {
    streamCb = null;
    onEventCleanup.mockClear();
    useDynamicWorkflowStore.setState({
      streamingRunIds: new Set<string>(),
      awaitingUserRunIds: new Set<string>(),
    });
  });

  it('init() registra o listener via dynamicWorkflow.onEvent e devolve o cleanup', () => {
    const cleanup = useDynamicWorkflowStore.getState().init();
    expect(typeof streamCb).toBe('function');
    expect(typeof cleanup).toBe('function');
    cleanup();
    expect(onEventCleanup).toHaveBeenCalledTimes(1);
  });

  it('um chunk de node ao vivo chega ao reducer e marca o run como streaming', () => {
    const cleanup = useDynamicWorkflowStore.getState().init();
    expect(streamCb).toBeTruthy();
    streamCb!({ runId: 'run-xyz', kind: 'node', type: 'text', nodeId: 'scout', content: 'oi' });
    expect(useDynamicWorkflowStore.getState().streamingRunIds.has('run-xyz')).toBe(true);
    streamCb!({ runId: 'run-xyz', type: 'done' });
    expect(useDynamicWorkflowStore.getState().streamingRunIds.has('run-xyz')).toBe(false);
    cleanup();
  });
});

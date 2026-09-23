import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));
vi.mock('../db', () => ({
  insertSecurityAgentStatus: vi.fn(),
  updateSecurityAgentStatus: vi.fn(),
  savePipelinePhaseMetrics: vi.fn(),
}));
vi.mock('../agent-config-resolver', () => ({ resolveAgentQueryConfig: vi.fn() }));
vi.mock('../repo-profiler', () => ({
  EXCLUDED_FROM_AUDIT_PATTERNS: [],
}));
vi.mock('../pipeline-paths', () => ({ getPipelineDocsContext: vi.fn() }));
vi.mock('../permission-guard', () => ({ setActiveSecurityAuditPhase: vi.fn() }));
vi.mock('../pipeline-engine/provider-auth', () => ({ rethrowPipelinePause: vi.fn() }));
vi.mock('../seed-agents/index', () => ({
  SECRETS_SCANNER_ID: 'secrets',
  AUTH_AUDITOR_ID: 'auth',
  ISOLATION_INSPECTOR_ID: 'isolation',
  DUPLICATION_DETECTOR_ID: 'duplication',
  LOGIC_ANALYZER_ID: 'logic',
  STANDARDS_CHECKER_ID: 'standards',
  OWASP_SCANNER_ID: 'owasp',
}));

import { PipelinePausedError } from '../agent-runtime/types';
import { partitionSecurityAuditResume, runWithConcurrencyLimit } from '../security-audit-runner';

describe('security audit concurrency pause', () => {
  it('retoma apenas pending/running e preserva completed/failed', () => {
    const agents = [
      { agentId: 'completed', name: 'Completed', tags: [], order: 1, slug: 'completed' },
      { agentId: 'failed', name: 'Failed', tags: [], order: 2, slug: 'failed' },
      { agentId: 'running', name: 'Running', tags: [], order: 3, slug: 'running' },
      { agentId: 'pending', name: 'Pending', tags: [], order: 4, slug: 'pending' },
      { agentId: 'new', name: 'New', tags: [], order: 5, slug: 'new' },
    ];

    const resume = partitionSecurityAuditResume(agents, [
      { agentId: 'completed', status: 'completed' },
      { agentId: 'failed', status: 'failed', errorMessage: 'falhou antes' },
      { agentId: 'running', status: 'running' },
      { agentId: 'pending', status: 'pending' },
    ]);

    expect(resume.queue.map((agent) => agent.agentId)).toEqual(['running', 'pending', 'new']);
    expect(resume.interruptedAgentIds).toEqual(['running']);
    expect(resume.failed).toEqual([{ agentId: 'failed', name: 'Failed', error: 'falhou antes' }]);
  });

  it('aborta a fila, aguarda siblings ativos e propaga o PipelinePausedError original', async () => {
    const controller = new AbortController();
    const pauseError = new PipelinePausedError('auth necessaria', 'grok-auth');
    const started: number[] = [];
    let releaseSibling!: () => void;
    let siblingObservedAbort = false;
    let siblingSettled = false;

    const siblingGate = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });

    const pool = runWithConcurrencyLimit(
      [1, 2, 3],
      2,
      async (item) => {
        started.push(item);
        if (item === 1) throw pauseError;

        await new Promise<void>((resolve) => {
          controller.signal.addEventListener(
            'abort',
            () => {
              siblingObservedAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        await siblingGate;
        siblingSettled = true;
      },
      controller,
    );
    const rejection = pool.catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(controller.signal.aborted).toBe(true);
      expect(siblingObservedAbort).toBe(true);
    });
    expect(started).toEqual([1, 2]);
    expect(siblingSettled).toBe(false);

    releaseSibling();

    expect(await rejection).toBe(pauseError);
    expect(siblingSettled).toBe(true);
    expect(started).not.toContain(3);
  });

  it('mantem rejeicoes inesperadas isoladas e conclui o restante da fila', async () => {
    const controller = new AbortController();
    const completed: number[] = [];

    await expect(
      runWithConcurrencyLimit(
        [1, 2, 3],
        2,
        async (item) => {
          if (item === 1) throw new Error('falha ordinaria');
          completed.push(item);
        },
        controller,
      ),
    ).resolves.toBeUndefined();

    expect(completed).toEqual([2, 3]);
    expect(controller.signal.aborted).toBe(false);
  });
});

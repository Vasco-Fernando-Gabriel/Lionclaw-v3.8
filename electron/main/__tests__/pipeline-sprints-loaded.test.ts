import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emitIPC: vi.fn(),
  getHarnessSprints: vi.fn(),
}));

vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: mocks.emitIPC }));
vi.mock('../db', () => ({ getHarnessSprints: mocks.getHarnessSprints }));

import { emitPipelineSprintsLoaded } from '../pipeline-engine/stream';

describe('emitPipelineSprintsLoaded', () => {
  beforeEach(() => {
    mocks.emitIPC.mockReset();
    mocks.getHarnessSprints.mockReset();
  });

  it('publica as 10 sprints reconciliadas usando os indices canonicos do banco', () => {
    mocks.getHarnessSprints.mockReturnValue(
      Array.from({ length: 10 }, (_, sprintIndex) => ({
        id: `db-sprint-${sprintIndex + 1}`,
        sprintIndex,
        sprintJsonId: `sprint-${String(sprintIndex + 1).padStart(3, '0')}`,
        name: `Sprint ${sprintIndex + 1}`,
        status: 'pending',
        coderAgentId: 'coder',
        evaluatorAgentId: 'evaluator',
      })),
    );

    emitPipelineSprintsLoaded('terra-max');

    const payload = mocks.emitIPC.mock.calls[0]?.[1] as {
      projectId: string;
      sprints: Array<{ index: number; sprintJsonId: string }>;
    };
    expect(mocks.emitIPC).toHaveBeenCalledOnce();
    expect(mocks.emitIPC).toHaveBeenCalledWith('pipeline:sprints-loaded', expect.any(Object));
    expect(payload.projectId).toBe('terra-max');
    expect(payload.sprints).toHaveLength(10);
    expect(payload.sprints[9]).toMatchObject({ index: 9, sprintJsonId: 'sprint-010' });
  });
});

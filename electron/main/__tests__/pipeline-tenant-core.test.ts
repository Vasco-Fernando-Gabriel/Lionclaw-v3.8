import { describe, it, expect } from 'vitest';
import { h } from './pipeline-tenant-fixture';
import {
  pipelineListCore,
  pipelineInspectCore,
  buildDriveSummary,
  assertPipeVisibleToLane,
} from '../pipeline-control-core';
import { acquireDriveLock } from '../drive-lock';
const a = { lane: 'desktop', sessionId: 'A' };
const b = { lane: 'desktop', sessionId: 'B' };
const telegram = { lane: 'telegram', sessionId: null };
describe('pipeline tenant core', () => {
  it('omits foreign projects and denies inspect before engine access', () => {
    expect(pipelineListCore(b)).toMatchObject({ ok: true, value: [{ id: 'P2', drive: null }] });
    expect(pipelineInspectCore('P1', b)).toMatchObject({
      ok: false,
      code: 'drive_owned_by_other_lane',
      error: expect.stringContaining('Lane 1'),
    });
    expect(h.engineRead).not.toHaveBeenCalled();
  });
  it('reads all for telegram and identifies the owning caller', () => {
    expect(pipelineListCore(telegram)).toMatchObject({
      ok: true,
      value: [
        { id: 'P1', drive: { ownedByThisLane: false, laneBadge: 1 } },
        { id: 'P2', drive: null },
      ],
    });
    expect(pipelineInspectCore('P1', a)).toMatchObject({
      ok: true,
      value: { drive: { sessionId: 'A', ownedByThisLane: true } },
    });
    expect(pipelineInspectCore('P1', telegram).ok).toBe(true);
  });
  it('stopped projects reappear with historical session ownership', () => {
    h.drive!.status = 'stopped';
    expect(pipelineListCore(b)).toMatchObject({ ok: true, value: [{ id: 'P1' }, { id: 'P2' }] });
    expect(buildDriveSummary('P1', a)).toMatchObject({ status: 'stopped', sessionId: 'A', ownedByThisLane: true });
  });
  it('closed lanes have no invented badge and remain invisible while engaged', () => {
    h.closed = true;
    expect(buildDriveSummary('P1', telegram)).toMatchObject({ laneBadge: null, laneTitle: null });
    expect(assertPipeVisibleToLane('pipeline_inspect', 'P1', b)?.code).toBe('drive_owned_by_other_lane');
  });
  it('RAM owner takes priority over persisted owner', () => {
    acquireDriveLock('P1', 'B');
    expect(assertPipeVisibleToLane('pipeline_inspect', 'P1', b)).toBeNull();
    expect(assertPipeVisibleToLane('pipeline_inspect', 'P1', a)?.code).toBe('drive_owned_by_other_lane');
  });
});

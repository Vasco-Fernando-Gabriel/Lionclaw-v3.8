import { describe, it, expect } from 'vitest';
import { h, bind, rpc } from './pipeline-tenant-fixture';
import { pipelineCreateCore } from '../pipeline-control-core';
import { acquireDriveLock } from '../drive-lock';
import { buildLaneBusyMessage, dbLaneMessagesDeps } from '../drive-lane-messages';
const input = { projectPath: '/project', pipelineType: 'feature', name: 'New', brief: 'Brief', drive: 'semi' };
describe('pipeline create lane precheck', () => {
  it('returns structured lane_busy from drive and create without creating', async () => {
    acquireDriveLock('P1', 'A');
    const error = buildLaneBusyMessage('P1', 'A', dbLaneMessagesDeps);
    h.engage.mockReturnValue({ ok: false, error, code: 'lane_busy' });
    const binding = bind('A');
    expect(await rpc('pipeline_drive', { ...binding, id: 'P2', mode: 'semi' })).toMatchObject({
      result: { error, code: 'lane_busy' },
    });
    expect(await rpc('pipeline_create', { ...binding, ...input })).toMatchObject({
      result: { error, code: 'lane_busy' },
    });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });
  it('does not push or emit when background engage has no caller session', async () => {
    await pipelineCreateCore({ ...input, pipelineType: 'feature', drive: 'semi', driveSessionId: null });
    await Promise.resolve();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });
  it.each([false, true])('pushes residual failure and real event fields (drive exists: %s)', async (createdDrive) => {
    h.createdDrive = createdDrive;
    let finish!: () => void;
    h.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const binding = bind('A');
    expect(await rpc('pipeline_create', { ...binding, ...input })).toMatchObject({ result: { id: 'P3' } });
    acquireDriveLock('P1', 'A');
    const error = buildLaneBusyMessage('P1', 'A', dbLaneMessagesDeps);
    h.engage.mockReturnValue({ ok: false, error, code: 'lane_busy' });
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.insert).toHaveBeenCalledWith('A', 'assistant', error, undefined, expect.any(String));
    expect(h.send).toHaveBeenCalledWith(
      'chat:stream',
      expect.objectContaining({
        type: 'assistant_pushed',
        sessionId: 'A',
        message: expect.objectContaining({ content: error }),
      }),
    );
    expect(h.emit).toHaveBeenCalledWith('drive:state-changed', {
      projectId: 'P3',
      drive: createdDrive ? h.drive : null,
      sessionId: createdDrive ? 'A' : null,
      laneBadge: createdDrive ? 1 : null,
    });
  });
});

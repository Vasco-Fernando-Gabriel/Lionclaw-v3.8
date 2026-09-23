import { describe, it, expect, vi } from 'vitest';
import { h, bind, rpc } from './pipeline-tenant-fixture';
import { createInternalCapabilityLease, verifyInternalCapabilityLease } from '../chat-capability-lease';
import { registerChatCapabilityTurn } from '../chat-capability-context';
import * as core from '../pipeline-control-core';
const actions = [
  'pipeline_inspect',
  'pipeline_drive',
  'pipeline_reply',
  'pipeline_approve',
  'pipeline_abort',
  'pipeline_pause',
  'pipeline_escalate',
  'design_session_config',
];
describe.each(['shadow', 'enforce'] as const)('tenant dispatch %s', (mode) => {
  it.each(actions)('%s refuses foreign owner before capabilities, lease and core', async (method) => {
    h.mode = mode;
    const binding = bind();
    const spies = [
      vi.spyOn(core, 'pipelineInspectCore'),
      vi.spyOn(core, 'pipelineDriveCore'),
      vi.spyOn(core, 'pipelineReplyCore'),
      vi.spyOn(core, 'pipelineApproveCore'),
      vi.spyOn(core, 'pipelineAbortCore'),
      vi.spyOn(core, 'pipelinePauseCore'),
      vi.spyOn(core, 'pipelineEscalateCore'),
      vi.spyOn(core, 'designSessionConfigCore'),
    ];
    expect(await rpc(method, { ...binding, id: 'P1', mode: 'semi' })).toMatchObject({
      result: { code: 'drive_owned_by_other_lane' },
    });
    expect(h.capability).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.permission).not.toHaveBeenCalled();
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
  it.each([...actions.filter((a) => a !== 'pipeline_inspect'), 'pipeline_create'])(
    '%s refuses writes outside drive turn scope',
    async (method) => {
      h.mode = mode;
      expect(await rpc(method, { ...bind('A', 'P1'), id: 'P2' })).toMatchObject({
        result: { code: 'drive_scope_violation' },
      });
      expect(h.capability).not.toHaveBeenCalled();
      expect(h.consume).not.toHaveBeenCalled();
      expect(h.permission).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
      expect(h.engage).not.toHaveBeenCalled();
    },
  );
  it('allows human B on unowned P2 and telegram reads', async () => {
    h.mode = mode;
    expect(await rpc('pipeline_drive', { ...bind(), id: 'P2', mode: 'semi' })).toMatchObject({
      result: { driving: true, sessionId: 'B' },
    });
    expect(h.capability).toHaveBeenCalled();
    expect(await rpc('pipeline_list', bind('T', undefined, 'telegram'))).toMatchObject({
      result: [{ id: 'P1' }, { id: 'P2' }],
    });
    expect(await rpc('pipeline_inspect', { ...bind('T', undefined, 'telegram'), id: 'P1' })).toMatchObject({
      result: { id: 'P1' },
    });
  });
  it('preserves a single-use lease through tenant and scope refusals', async () => {
    h.mode = mode;
    const binding = bind('B', 'P2');
    const lease = createInternalCapabilityLease({
      coordinator: 'pipeline-drive-coordinator',
      driveProjectId: 'P2',
      driveTurnId: 'dt',
      allowedServerIds: ['lionclaw-pipeline-control'],
      allowedToolPrefixes: ['pipeline_'],
      ttlMs: 60000,
      maxUses: 1,
    });
    registerChatCapabilityTurn({
      surface: 'chat',
      sessionId: 'B',
      turnId: 't',
      origin: 'system-event',
      capabilities: { pipelineControl: false, dynamicWorkflows: false },
      driveProjectId: 'P2',
      driveTurnId: 'dt',
      internalLeaseToken: lease.token,
      leaseCoordinator: 'pipeline-drive-coordinator',
    });
    expect(await rpc('pipeline_drive', { ...binding, id: 'P1', mode: 'semi' })).toMatchObject({
      result: { code: 'drive_owned_by_other_lane' },
    });
    expect(await rpc('pipeline_create', binding)).toMatchObject({ result: { code: 'drive_scope_violation' } });
    expect(h.capability).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
    expect(await rpc('pipeline_drive', { ...binding, id: 'P2', mode: 'semi' })).toMatchObject({
      result: { driving: true },
    });
    expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({ dryRun: mode === 'shadow' }));
    expect(
      verifyInternalCapabilityLease({
        token: lease.token,
        coordinator: 'pipeline-drive-coordinator',
        driveProjectId: 'P2',
        driveTurnId: 'dt',
        serverId: 'lionclaw-pipeline-control',
        toolName: 'pipeline_drive',
        dryRun: true,
      }),
    ).toBe(mode === 'shadow');
  });
  it('authenticates before tenant checks', async () => {
    h.mode = mode;
    expect(await rpc('pipeline_drive', { id: 'P1' })).toMatchObject({
      error: { message: expect.stringContaining('turn_binding_required') },
    });
    expect(h.capability).not.toHaveBeenCalled();
  });
});

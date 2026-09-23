import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const db = vi.hoisted(() => ({
  getDriveState: vi.fn(),
  getDriveSessionId: vi.fn(() => null),
  getOpenLaneSessionById: vi.fn(),
  setDriveState: vi.fn(),
}));
vi.mock('../db', () => db);

const coordinator = vi.hoisted(() => ({
  getDrive: vi.fn(() => null),
  startDrive: vi.fn(),
  resumeDrive: vi.fn(),
  assumirDrive: vi.fn(),
  stopDrive: vi.fn(),
  setMode: vi.fn(),
}));
vi.mock('../pipeline-drive-coordinator', () => ({
  getPipelineDriveCoordinator: () => coordinator,
}));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

import { registerDriveHandlers } from '../ipc/drive';
import { clearingSessions, markSessionClearing } from '../clearing-sessions';

const DRIVE = { projectId: 'proj', sessionId: 'lane-A', mode: 'semi', status: 'driving', driver: 'orchestrator' };

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  registerDriveHandlers({ getMainWindow: () => null } as never);
  coordinator.startDrive.mockReturnValue({ ok: true, drive: DRIVE });
  coordinator.resumeDrive.mockReturnValue({ ok: true, drive: DRIVE });
  db.getOpenLaneSessionById.mockImplementation((id: string) =>
    id === 'lane-A' || id === 'lane-B' ? { id, laneBadge: id === 'lane-A' ? 1 : 2 } : null,
  );
});

describe('AC-23 (V9, parte main): drive:start/drive:resume exigem o sessionId da lane escolhida na UI', () => {
  it('drive:start sem sessionId = session_required, nunca heuristica', async () => {
    const result = await handlers.get('drive:start')!(undefined, 'proj', 'semi');
    expect(result).toMatchObject({ code: 'session_required' });
    expect(coordinator.startDrive).not.toHaveBeenCalled();
    expect(db.getDriveState).not.toHaveBeenCalled();
  });

  it('drive:start com lane aberta vincula o drive a ELA (config.drive.sessionId === A)', async () => {
    const result = await handlers.get('drive:start')!(undefined, 'proj', 'full', 'lane-A');
    expect(result).toEqual({ ok: true, drive: DRIVE, sessionId: 'lane-A' });
    expect(coordinator.startDrive).toHaveBeenCalledWith('proj', 'lane-A', 'full');
  });

  it('drive:start com conversa que nao e lane aberta = session_not_active', async () => {
    const result = await handlers.get('drive:start')!(undefined, 'proj', 'semi', 'encerrada');
    expect(result).toMatchObject({ code: 'session_not_active' });
    expect(coordinator.startDrive).not.toHaveBeenCalled();
  });

  it('drive:start repassa o code tipado da recusa do coordenador (5.4)', async () => {
    coordinator.startDrive.mockReturnValue({
      ok: false,
      code: 'lane_busy',
      error: 'ja existe um drive ativo no projeto "Outro" (proj_b), dirigido pela Lane 1: "x".',
    });
    const result = await handlers.get('drive:start')!(undefined, 'proj', 'semi', 'lane-A');
    expect(result).toMatchObject({ code: 'lane_busy' });
    expect(result).toMatchObject({ error: expect.stringContaining('ja existe um drive ativo') });
  });

  it('drive:start numa lane em Clear = session_clearing (lanes 6.10)', async () => {
    markSessionClearing('lane-A', 'running', 1);
    try {
      const result = await handlers.get('drive:start')!(undefined, 'proj', 'semi', 'lane-A');
      expect(result).toMatchObject({ code: 'session_clearing' });
      expect(coordinator.startDrive).not.toHaveBeenCalled();
    } finally {
      clearingSessions.clear();
    }
  });

  it('drive:resume sem sessionId delega ao coordenador, que resolve a lane pela coluna', async () => {
    coordinator.resumeDrive.mockReturnValue({ ok: true, drive: DRIVE });
    const result = await handlers.get('drive:resume')!(undefined, 'proj');
    expect(result).toEqual({ ok: true, drive: DRIVE, sessionId: 'lane-A' });
    expect(coordinator.resumeDrive).toHaveBeenCalledWith('proj', undefined, { fromHuman: true });
  });

  it('drive:resume NAO grava a coluna: quem grava e o coordenador, depois do lock (5.2)', async () => {
    await handlers.get('drive:resume')!(undefined, 'proj', 'lane-B');
    expect(db.setDriveState).not.toHaveBeenCalled();
  });

  it('drive:resume com sessionId da UI VENCE a lane persistida (inverte a precedencia antiga)', async () => {
    coordinator.resumeDrive.mockReturnValue({ ok: true, drive: { ...DRIVE, sessionId: 'lane-B' } });
    const result = await handlers.get('drive:resume')!(undefined, 'proj', 'lane-B');
    expect(result).toMatchObject({ sessionId: 'lane-B' });
    expect(coordinator.resumeDrive).toHaveBeenCalledWith('proj', 'lane-B', { fromHuman: true });
  });

  it('drive:resume com conversa que nao e lane aberta = session_not_active, sem chamar o coordenador', async () => {
    const result = await handlers.get('drive:resume')!(undefined, 'proj', 'encerrada');
    expect(result).toMatchObject({ code: 'session_not_active' });
    expect(coordinator.resumeDrive).not.toHaveBeenCalled();
  });

  it('drive:resume repassa session_not_active do coordenador (coluna apontando para lane fechada)', async () => {
    coordinator.resumeDrive.mockReturnValue({
      ok: false,
      code: 'session_not_active',
      error: 'session_not_active: a lane que dirigia este pipeline nao esta mais aberta.',
    });
    const result = await handlers.get('drive:resume')!(undefined, 'proj');
    expect(result).toMatchObject({ code: 'session_not_active' });
  });
});

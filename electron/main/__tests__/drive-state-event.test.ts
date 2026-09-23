import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveState } from '../../../src/types';
import type { OpenDesktopSessionRow } from '../db';

vi.mock('../db', () => ({
  getDriveSessionId: vi.fn(),
  getOpenLaneSessionById: vi.fn(),
}));

import { buildDriveStateChangedEvent } from '../drive-state-event';
import { getDriveSessionId, getOpenLaneSessionById } from '../db';

const mockedGetDriveSessionId = vi.mocked(getDriveSessionId);
const mockedGetOpenLaneSessionById = vi.mocked(getOpenLaneSessionById);

function makeDrive(overrides: Partial<DriveState> = {}): DriveState {
  return {
    driver: 'orchestrator',
    status: 'driving',
    handoff: 'none',
    mode: 'semi',
    requiresHumanPhases: [],
    ...overrides,
  };
}

function makeLaneRow(id: string, laneBadge: number): OpenDesktopSessionRow {
  return {
    id,
    laneBadge,
    title: `Lane ${laneBadge}`,
    orchestrator: null,
    messageCount: 3,
    lastUserMessageAt: '2026-09-17 10:00:00',
    createdAt: '2026-09-17 09:00:00',
    updatedAt: '2026-09-17 10:00:00',
    dreamingStartedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetDriveSessionId.mockReturnValue(null);
  mockedGetOpenLaneSessionById.mockReturnValue(null);
});

describe('buildDriveStateChangedEvent - drive encerrado', () => {
  it('drive null devolve sessionId e laneBadge null sem consultar o banco', () => {
    const event = buildDriveStateChangedEvent('proj-1', null);

    expect(event).toEqual({
      projectId: 'proj-1',
      drive: null,
      sessionId: null,
      laneBadge: null,
    });
    expect(mockedGetDriveSessionId).not.toHaveBeenCalled();
    expect(mockedGetOpenLaneSessionById).not.toHaveBeenCalled();
  });
});

describe('buildDriveStateChangedEvent - drive ativo', () => {
  it('resolve sessionId pela coluna e laneBadge pela lane aberta', () => {
    mockedGetDriveSessionId.mockReturnValue('sess_col');
    mockedGetOpenLaneSessionById.mockReturnValue(makeLaneRow('sess_col', 4));
    const drive = makeDrive({ sessionId: 'sess_col' });

    const event = buildDriveStateChangedEvent('proj-1', drive);

    expect(event).toEqual({
      projectId: 'proj-1',
      drive,
      sessionId: 'sess_col',
      laneBadge: 4,
    });
    expect(mockedGetDriveSessionId).toHaveBeenCalledWith('proj-1');
    expect(mockedGetOpenLaneSessionById).toHaveBeenCalledWith('sess_col');
  });

  it('ignora o espelho JSON do drive e usa a coluna quando os dois divergem', () => {
    mockedGetDriveSessionId.mockReturnValue('sess_col');
    mockedGetOpenLaneSessionById.mockReturnValue(makeLaneRow('sess_col', 2));

    const event = buildDriveStateChangedEvent('proj-1', makeDrive({ sessionId: 'sess_json' }));

    expect(event.sessionId).toBe('sess_col');
    expect(event.laneBadge).toBe(2);
    expect(mockedGetOpenLaneSessionById).toHaveBeenCalledWith('sess_col');
  });

  it('lane em turno (status driving) tem laneBadge resolvido: a lane nao vem do state', () => {
    mockedGetDriveSessionId.mockReturnValue('sess_streaming');
    mockedGetOpenLaneSessionById.mockReturnValue(makeLaneRow('sess_streaming', 7));

    const event = buildDriveStateChangedEvent('proj-1', makeDrive({ status: 'driving' }));

    expect(event.laneBadge).toBe(7);
  });

  it('sessao fora das lanes abertas: sessionId preservado e laneBadge null', () => {
    mockedGetDriveSessionId.mockReturnValue('sess_fechada');
    mockedGetOpenLaneSessionById.mockReturnValue(null);

    const event = buildDriveStateChangedEvent('proj-1', makeDrive());

    expect(event.sessionId).toBe('sess_fechada');
    expect(event.laneBadge).toBeNull();
  });

  it('projeto sem coluna session_id: sessionId null e nenhuma busca de lane', () => {
    mockedGetDriveSessionId.mockReturnValue(null);

    const event = buildDriveStateChangedEvent('proj-1', makeDrive({ sessionId: 'sess_json' }));

    expect(event.sessionId).toBeNull();
    expect(event.laneBadge).toBeNull();
    expect(mockedGetOpenLaneSessionById).not.toHaveBeenCalled();
  });
});

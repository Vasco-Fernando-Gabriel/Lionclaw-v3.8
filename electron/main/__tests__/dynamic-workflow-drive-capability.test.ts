import { describe, it, expect, beforeEach } from 'vitest';
import {
  mintDriveCapability,
  consumeDriveCapability,
  registerReadOnlyDriveTurn,
  isReadOnlyDriveTurn,
  remainingWakeCapabilityUses,
  WAKE_CAPABILITY_ACTIONS,
  WAKE_CAPABILITY_MAX_USES,
  _resetDriveCapabilitiesForTesting,
  type DriveCapabilityAction,
} from '../dynamic-workflows/drive-capability';

const FUTURE = 10_000;
const TURN = 'run-1:1';

beforeEach(() => {
  _resetDriveCapabilitiesForTesting();
});

function mintGate(over?: { runId?: string; gateId?: string; driveTurnId?: string; expiresAt?: number }): void {
  mintDriveCapability({
    runId: over?.runId ?? 'run-1',
    scope: 'gate',
    gateId: over?.gateId ?? 'gate-A',
    driveTurnId: over?.driveTurnId ?? TURN,
    expiresAt: over?.expiresAt ?? Date.now() + FUTURE,
  });
}

function mintWake(over?: {
  runId?: string;
  driveTurnId?: string;
  expiresAt?: number;
  maxUses?: number;
  actions?: readonly DriveCapabilityAction[];
}): void {
  mintDriveCapability({
    runId: over?.runId ?? 'run-1',
    scope: 'wake',
    driveTurnId: over?.driveTurnId ?? TURN,
    expiresAt: over?.expiresAt ?? Date.now() + FUTURE,
    maxUses: over?.maxUses ?? WAKE_CAPABILITY_MAX_USES,
    actions: over?.actions ?? WAKE_CAPABILITY_ACTIONS,
  });
}

describe('drive-capability scope:gate (E2.3, endurecida por driveTurnId em D7)', () => {
  it('mint + consume valido (mesmo runId+gateId+driveTurnId, approve) devolve a capability', () => {
    mintGate();
    const cap = consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'approve', gateId: 'gate-A' });
    expect(cap).not.toBeNull();
    expect(cap!.runId).toBe('run-1');
    expect(cap!.gateId).toBe('gate-A');
    expect(cap!.scope).toBe('gate');
    expect(cap!.driveTurnId).toBe(TURN);
  });

  it('mint LEGADO sem scope (shape E2.3) e tratado como gate', () => {
    mintDriveCapability({ runId: 'run-1', gateId: 'gate-A', driveTurnId: TURN, expiresAt: Date.now() + FUTURE });
    expect(
      consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'approve', gateId: 'gate-A' }),
    ).not.toBeNull();
  });

  it('USO UNICO: a 2a consume do mesmo par devolve null', () => {
    mintGate();
    const req = { runId: 'run-1', driveTurnId: TURN, action: 'approve' as const, gateId: 'gate-A' };
    expect(consumeDriveCapability(req)).not.toBeNull();
    expect(consumeDriveCapability(req)).toBeNull();
  });

  it('D7 OBRIGATORIO: mesmo run, driveTurnId DIFERENTE = negado e a capability NAO e consumida', () => {
    mintGate({ driveTurnId: 'run-1:1' });
    expect(
      consumeDriveCapability({ runId: 'run-1', driveTurnId: 'run-1:2', action: 'approve', gateId: 'gate-A' }),
    ).toBeNull();
    expect(
      consumeDriveCapability({ runId: 'run-1', driveTurnId: 'run-1:1', action: 'approve', gateId: 'gate-A' }),
    ).not.toBeNull();
  });

  it('sem driveTurnId no contexto = negado (fail-closed), capability intacta', () => {
    mintGate();
    expect(
      consumeDriveCapability({ runId: 'run-1', driveTurnId: undefined, action: 'approve', gateId: 'gate-A' }),
    ).toBeNull();
    expect(consumeDriveCapability({ runId: 'run-1', driveTurnId: '', action: 'approve', gateId: 'gate-A' })).toBeNull();
    expect(
      consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'approve', gateId: 'gate-A' }),
    ).not.toBeNull();
  });

  it('expirada: consume apos expiresAt devolve null e remove o registro', () => {
    const now = 1_000_000;
    mintGate({ expiresAt: now + 100 });
    expect(
      consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'approve', gateId: 'gate-A' }, now + 101),
    ).toBeNull();
    expect(
      consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'approve', gateId: 'gate-A' }, now),
    ).toBeNull();
  });

  it('isolamento de par: outro runId ou outro gateId nao casa; gate nao libera intervene/abort', () => {
    mintGate();
    expect(
      consumeDriveCapability({ runId: 'run-2', driveTurnId: TURN, action: 'approve', gateId: 'gate-A' }),
    ).toBeNull();
    expect(
      consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'approve', gateId: 'gate-B' }),
    ).toBeNull();
    expect(consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'intervene:pause' })).toBeNull();
    expect(consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'abort' })).toBeNull();
    expect(
      consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'approve', gateId: 'gate-A' }),
    ).not.toBeNull();
  });

  it('re-mint para o mesmo par sobrescreve (turno mais recente vence)', () => {
    mintGate({ driveTurnId: 'run-1:1' });
    mintGate({ driveTurnId: 'run-1:2' });
    expect(
      consumeDriveCapability({ runId: 'run-1', driveTurnId: 'run-1:1', action: 'approve', gateId: 'gate-A' }),
    ).toBeNull();
    const cap = consumeDriveCapability({ runId: 'run-1', driveTurnId: 'run-1:2', action: 'approve', gateId: 'gate-A' });
    expect(cap!.driveTurnId).toBe('run-1:2');
  });

  it('inputs vazios: mint sem runId/gateId/driveTurnId e no-op', () => {
    mintGate({ runId: '' });
    mintGate({ gateId: '' });
    mintGate({ driveTurnId: '' });
    expect(
      consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'approve', gateId: 'gate-A' }),
    ).toBeNull();
    expect(consumeDriveCapability({ runId: '', driveTurnId: TURN, action: 'approve', gateId: 'gate-A' })).toBeNull();
  });
});

describe('drive-capability scope:wake (D7)', () => {
  it('lista FECHADA de acoes: intervene pause/resume/switch-agent/adjust-next-node/rerun-node, abort, approve', () => {
    expect([...WAKE_CAPABILITY_ACTIONS].sort()).toEqual(
      [
        'intervene:pause',
        'intervene:resume',
        'intervene:switch-agent',
        'intervene:adjust-next-node',
        'intervene:rerun-node',
        'abort',
        'approve',
      ].sort(),
    );
    expect(WAKE_CAPABILITY_MAX_USES).toBe(3);
  });

  it('autoriza intervene pause / rerun-node e abort do MESMO run e MESMO driveTurnId', () => {
    mintWake();
    expect(consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'intervene:pause' })).not.toBeNull();
    expect(
      consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'intervene:rerun-node' }),
    ).not.toBeNull();
    expect(consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'abort' })).not.toBeNull();
  });

  it('approve do gate pendente via wake (sem capability de gate) casa pelo {runId, driveTurnId}', () => {
    mintWake();
    const cap = consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'approve', gateId: 'boundary:S1' });
    expect(cap).not.toBeNull();
    expect(cap!.scope).toBe('wake');
  });

  it('D7 OBRIGATORIO: mesmo run, driveTurnId diferente = negado (nada consumido)', () => {
    mintWake({ driveTurnId: 'run-1:1' });
    expect(consumeDriveCapability({ runId: 'run-1', driveTurnId: 'run-1:2', action: 'intervene:pause' })).toBeNull();
    expect(remainingWakeCapabilityUses('run-1', 'run-1:1')).toBe(3);
  });

  it('sem driveTurnId no contexto = negado; outro run = negado', () => {
    mintWake();
    expect(consumeDriveCapability({ runId: 'run-1', driveTurnId: undefined, action: 'intervene:pause' })).toBeNull();
    expect(consumeDriveCapability({ runId: 'run-1', driveTurnId: null, action: 'intervene:pause' })).toBeNull();
    expect(consumeDriveCapability({ runId: 'run-2', driveTurnId: TURN, action: 'intervene:pause' })).toBeNull();
    expect(remainingWakeCapabilityUses('run-1', TURN)).toBe(3);
  });

  it('maxUses 3: a 4a acao e negada; tentativas negadas nao contam', () => {
    mintWake();
    expect(consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'intervene:pause' })).not.toBeNull();
    expect(remainingWakeCapabilityUses('run-1', TURN)).toBe(2);
    mintWake({ runId: 'run-x', actions: ['intervene:pause'] });
    expect(consumeDriveCapability({ runId: 'run-x', driveTurnId: TURN, action: 'abort' })).toBeNull();
    expect(remainingWakeCapabilityUses('run-x', TURN)).toBe(3);

    expect(consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'intervene:resume' })).not.toBeNull();
    expect(consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'abort' })).not.toBeNull();
    expect(remainingWakeCapabilityUses('run-1', TURN)).toBe(0);
    expect(consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'intervene:pause' })).toBeNull();
  });

  it('TTL: expirada e removida e nao casa', () => {
    const now = 5_000_000;
    mintWake({ expiresAt: now + 10 * 60_000 });
    expect(
      consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'intervene:pause' }, now + 10 * 60_000),
    ).toBeNull();
    expect(remainingWakeCapabilityUses('run-1', TURN)).toBe(0);
  });

  it('gate + wake coexistem no mesmo turno: approve do gate consome a de GATE primeiro (wake intacta)', () => {
    mintGate({ gateId: 'cc-delivery' });
    mintWake();
    const cap = consumeDriveCapability({ runId: 'run-1', driveTurnId: TURN, action: 'approve', gateId: 'cc-delivery' });
    expect(cap!.scope).toBe('gate');
    expect(remainingWakeCapabilityUses('run-1', TURN)).toBe(3);
  });
});

describe('read-only drive turns (D6)', () => {
  it('registra e consulta; vazio/ausente = false', () => {
    registerReadOnlyDriveTurn('run-1:7');
    expect(isReadOnlyDriveTurn('run-1:7')).toBe(true);
    expect(isReadOnlyDriveTurn('run-1:8')).toBe(false);
    expect(isReadOnlyDriveTurn(undefined)).toBe(false);
    expect(isReadOnlyDriveTurn('')).toBe(false);
    registerReadOnlyDriveTurn('');
    expect(isReadOnlyDriveTurn('')).toBe(false);
  });
});

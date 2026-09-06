
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  createInternalCapabilityLease,
  verifyInternalCapabilityLease,
  __resetInternalCapabilityLeasesForTests,
  type InternalCapabilityLeaseInput,
} from '../chat-capability-lease';

function leaseInput(
  overrides: Partial<InternalCapabilityLeaseInput> = {},
): InternalCapabilityLeaseInput {
  return {
    coordinator: 'pipeline-drive-coordinator',
    driveProjectId: 'proj-42',
    driveTurnId: 'drive-turn-7',
    allowedServerIds: ['lionclaw-pipeline-control'],
    allowedToolPrefixes: ['pipeline_'],
    ttlMs: 60_000,
    ...overrides,
  };
}

function verifyInput(token: string, overrides: Record<string, string> = {}) {
  return {
    token,
    coordinator: 'pipeline-drive-coordinator',
    driveProjectId: 'proj-42',
    driveTurnId: 'drive-turn-7',
    serverId: 'lionclaw-pipeline-control',
    toolName: 'pipeline_reply',
    ...overrides,
  };
}

beforeEach(() => {
  __resetInternalCapabilityLeasesForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-03T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('lease valida', () => {
  it('token criado + todos os criterios batendo -> aceita', () => {
    const { token } = createInternalCapabilityLease(leaseInput());
    expect(verifyInternalCapabilityLease(verifyInput(token))).toBe(true);
  });

  it('token e opaco base64url de 32 bytes e unico por lease', () => {
    const a = createInternalCapabilityLease(leaseInput()).token;
    const b = createInternalCapabilityLease(leaseInput()).token;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('serverId com alias historico normaliza antes da allowlist (pipeline-control == lionclaw-pipeline-control)', () => {
    const { token } = createInternalCapabilityLease(leaseInput());
    expect(
      verifyInternalCapabilityLease(
        verifyInput(token, { serverId: 'pipeline-control' }),
      ),
    ).toBe(true);
  });

  it('sem maxUses: reutilizavel dentro do TTL', () => {
    const { token } = createInternalCapabilityLease(leaseInput());
    for (let i = 0; i < 5; i++) {
      expect(verifyInternalCapabilityLease(verifyInput(token))).toBe(true);
    }
  });
});

describe('expiracao (TTL)', () => {
  it('lease expirada nega', () => {
    const { token } = createInternalCapabilityLease(leaseInput({ ttlMs: 1_000 }));

    vi.advanceTimersByTime(999);
    expect(verifyInternalCapabilityLease(verifyInput(token))).toBe(true);

    vi.advanceTimersByTime(2); // t=1001 >= expiresAt
    expect(verifyInternalCapabilityLease(verifyInput(token))).toBe(false);
  });

  it('depois de expirar, nega SEMPRE (registro removido)', () => {
    const { token } = createInternalCapabilityLease(leaseInput({ ttlMs: 1_000 }));
    vi.advanceTimersByTime(1_001);
    expect(verifyInternalCapabilityLease(verifyInput(token))).toBe(false);
    expect(verifyInternalCapabilityLease(verifyInput(token))).toBe(false);
  });
});

describe('maxUses', () => {
  it('nega apos exceder maxUses', () => {
    const { token } = createInternalCapabilityLease(leaseInput({ maxUses: 2 }));

    expect(verifyInternalCapabilityLease(verifyInput(token))).toBe(true);
    expect(verifyInternalCapabilityLease(verifyInput(token))).toBe(true);
    expect(verifyInternalCapabilityLease(verifyInput(token))).toBe(false);
  });

  it('verificacao NEGADA nao consome uso', () => {
    const { token } = createInternalCapabilityLease(leaseInput({ maxUses: 1 }));

    expect(
      verifyInternalCapabilityLease(
        verifyInput(token, { serverId: 'lionclaw-dynamic-workflows' }),
      ),
    ).toBe(false);

    expect(verifyInternalCapabilityLease(verifyInput(token))).toBe(true);
    expect(verifyInternalCapabilityLease(verifyInput(token))).toBe(false);
  });
});

describe('dryRun (S6b): checa validade IDENTICA sem consumir uso', () => {
  it('dryRun repetido NAO consome; verify consumidor (default) consome no sucesso', () => {
    const { token } = createInternalCapabilityLease(leaseInput({ maxUses: 1 }));

    for (let i = 0; i < 5; i++) {
      expect(
        verifyInternalCapabilityLease({ ...verifyInput(token), dryRun: true }),
      ).toBe(true);
    }

    expect(verifyInternalCapabilityLease(verifyInput(token))).toBe(true);
    expect(verifyInternalCapabilityLease(verifyInput(token))).toBe(false);
  });

  it('dryRun:false explicito consome igual ao default', () => {
    const { token } = createInternalCapabilityLease(leaseInput({ maxUses: 1 }));
    expect(
      verifyInternalCapabilityLease({ ...verifyInput(token), dryRun: false }),
    ).toBe(true);
    expect(
      verifyInternalCapabilityLease({ ...verifyInput(token), dryRun: false }),
    ).toBe(false);
  });

  it('dryRun NAO afrouxa NENHUM predicado (identico ao verify consumidor)', () => {
    const { token } = createInternalCapabilityLease(leaseInput());
    const dry = (overrides: Record<string, string> = {}) =>
      verifyInternalCapabilityLease({ ...verifyInput(token, overrides), dryRun: true });

    expect(dry()).toBe(true);
    expect(dry({ coordinator: 'coordenador-malicioso' })).toBe(false);
    expect(dry({ coordinator: 'dynamic-workflow-ignition' })).toBe(false);
    expect(dry({ driveProjectId: 'proj-outro' })).toBe(false);
    expect(dry({ driveTurnId: 'drive-turn-99' })).toBe(false);
    expect(dry({ serverId: 'lionclaw-dynamic-workflows' })).toBe(false);
    expect(dry({ toolName: 'dynamic_workflow_run' })).toBe(false);
    expect(
      verifyInternalCapabilityLease({
        ...verifyInput('token-forjado-qualquer'),
        dryRun: true,
      }),
    ).toBe(false);
  });

  it('dryRun respeita maxUses JA esgotado (checa o mesmo predicado, so nao incrementa)', () => {
    const { token } = createInternalCapabilityLease(leaseInput({ maxUses: 1 }));
    expect(verifyInternalCapabilityLease(verifyInput(token))).toBe(true); // consome o unico uso
    expect(
      verifyInternalCapabilityLease({ ...verifyInput(token), dryRun: true }),
    ).toBe(false);
  });

  it('dryRun respeita TTL (expirada nega)', () => {
    const { token } = createInternalCapabilityLease(leaseInput({ ttlMs: 1_000 }));
    vi.advanceTimersByTime(1_001);
    expect(
      verifyInternalCapabilityLease({ ...verifyInput(token), dryRun: true }),
    ).toBe(false);
  });
});

describe('spoof / criterios divergentes -> nega', () => {
  it('coordinator fora da enum fechada nega', () => {
    const { token } = createInternalCapabilityLease(leaseInput());
    expect(
      verifyInternalCapabilityLease(
        verifyInput(token, { coordinator: 'coordenador-malicioso' }),
      ),
    ).toBe(false);
  });

  it('coordinator NA enum mas diferente do da lease nega', () => {
    const { token } = createInternalCapabilityLease(leaseInput());
    expect(
      verifyInternalCapabilityLease(
        verifyInput(token, { coordinator: 'dynamic-workflow-ignition' }),
      ),
    ).toBe(false);
  });

  it('driveProjectId errado nega', () => {
    const { token } = createInternalCapabilityLease(leaseInput());
    expect(
      verifyInternalCapabilityLease(
        verifyInput(token, { driveProjectId: 'proj-outro' }),
      ),
    ).toBe(false);
  });

  it('driveTurnId errado nega', () => {
    const { token } = createInternalCapabilityLease(leaseInput());
    expect(
      verifyInternalCapabilityLease(
        verifyInput(token, { driveTurnId: 'drive-turn-99' }),
      ),
    ).toBe(false);
  });

  it('serverId fora da allowlist nega', () => {
    const { token } = createInternalCapabilityLease(leaseInput());
    expect(
      verifyInternalCapabilityLease(
        verifyInput(token, {
          serverId: 'lionclaw-dynamic-workflows',
          toolName: 'pipeline_reply',
        }),
      ),
    ).toBe(false);
  });

  it('toolName fora dos prefixos permitidos nega', () => {
    const { token } = createInternalCapabilityLease(leaseInput());
    expect(
      verifyInternalCapabilityLease(
        verifyInput(token, { toolName: 'dynamic_workflow_run' }),
      ),
    ).toBe(false);
  });

  it('token desconhecido (forjado) nega', () => {
    createInternalCapabilityLease(leaseInput());
    expect(
      verifyInternalCapabilityLease(verifyInput('token-forjado-qualquer')),
    ).toBe(false);
  });

  it('token vazio nega', () => {
    createInternalCapabilityLease(leaseInput());
    expect(verifyInternalCapabilityLease(verifyInput(''))).toBe(false);
  });

  it('lease de workflow autoriza dynamic_workflow_* e NAO pipeline_*', () => {
    const { token } = createInternalCapabilityLease(
      leaseInput({
        coordinator: 'dynamic-workflow-ignition',
        allowedServerIds: ['lionclaw-dynamic-workflows'],
        allowedToolPrefixes: ['dynamic_workflow_'],
      }),
    );

    expect(
      verifyInternalCapabilityLease(
        verifyInput(token, {
          coordinator: 'dynamic-workflow-ignition',
          serverId: 'lionclaw-dynamic-workflows',
          toolName: 'dynamic_workflow_approve_gate',
        }),
      ),
    ).toBe(true);

    expect(
      verifyInternalCapabilityLease(
        verifyInput(token, {
          coordinator: 'dynamic-workflow-ignition',
          serverId: 'lionclaw-pipeline-control',
          toolName: 'pipeline_reply',
        }),
      ),
    ).toBe(false);
  });
});

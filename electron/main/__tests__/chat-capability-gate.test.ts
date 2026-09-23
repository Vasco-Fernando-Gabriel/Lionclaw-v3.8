import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const settings: Record<string, string | undefined> = {};
  const logEntries: Array<{ level: string; data: unknown; msg: string }> = [];
  const makeLevel =
    (level: string) =>
    (...args: unknown[]) => {
      const [first, second] = args;
      if (typeof first === 'string') {
        logEntries.push({ level, data: undefined, msg: first });
      } else {
        logEntries.push({
          level,
          data: first,
          msg: typeof second === 'string' ? second : '',
        });
      }
    };
  const state = { getSettingThrows: false };
  return { settings, logEntries, makeLevel, state };
});

vi.mock('../db', () => ({
  getSetting: (key: string) => {
    if (hoisted.state.getSettingThrows) throw new Error('db quebrado');
    return hoisted.settings[key];
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: hoisted.makeLevel('info'),
    warn: hoisted.makeLevel('warn'),
    error: hoisted.makeLevel('error'),
    debug: hoisted.makeLevel('debug'),
  }),
}));

import {
  assertChatCapability,
  failClosedChatCapability,
  getChatCapabilityGateMode,
  getChatCapabilityForServer,
  CHAT_CAPABILITY_GATE_MODE_SETTING_KEY,
} from '../chat-capability-gate';
import {
  registerChatCapabilityTurn,
  setActiveChatTurn,
  __resetChatCapabilityContextForTests,
  type ChatCapabilityTurnContextInput,
} from '../chat-capability-context';
import { createInternalCapabilityLease, __resetInternalCapabilityLeasesForTests } from '../chat-capability-lease';

const PIPELINE_SERVER = 'lionclaw-pipeline-control';
const WORKFLOWS_SERVER = 'lionclaw-dynamic-workflows';

const PIPELINE_OFF_MESSAGE =
  'Pipeline está desligado para esta sessão. Ligue o chip Pipeline no chat e envie novamente.';
const WORKFLOWS_OFF_MESSAGE =
  'Workflows está desligado para esta sessão. Ligue o chip Workflows no chat e envie novamente.';

function setMode(mode: 'shadow' | 'enforce' | undefined): void {
  if (mode === undefined) {
    delete hoisted.settings[CHAT_CAPABILITY_GATE_MODE_SETTING_KEY];
  } else {
    hoisted.settings[CHAT_CAPABILITY_GATE_MODE_SETTING_KEY] = mode;
  }
}

function seedTurn(overrides?: Partial<ChatCapabilityTurnContextInput>): { sessionId: string; turnId: string } {
  const sessionId = overrides?.sessionId ?? 'sess-1';
  const turnId = overrides?.turnId ?? 'turn-1';
  registerChatCapabilityTurn({
    surface: 'chat',
    sessionId,
    turnId,
    capabilities: { pipelineControl: false, dynamicWorkflows: false },
    ...overrides,
  });
  setActiveChatTurn({ sessionId, lane: 'desktop', turnId });
  return { sessionId, turnId };
}

function negariaLogs(): Array<{ data: Record<string, unknown>; msg: string }> {
  return hoisted.logEntries
    .filter((e) => e.msg.includes('negaria'))
    .map((e) => ({ data: (e.data ?? {}) as Record<string, unknown>, msg: e.msg }));
}

beforeEach(() => {
  hoisted.logEntries.length = 0;
  hoisted.state.getSettingThrows = false;
  for (const key of Object.keys(hoisted.settings)) delete hoisted.settings[key];
  __resetChatCapabilityContextForTests();
  __resetInternalCapabilityLeasesForTests();
});

describe('getChatCapabilityGateMode', () => {
  it('setting ausente -> shadow (DEFAULT)', () => {
    expect(getChatCapabilityGateMode()).toBe('shadow');
  });

  it('enforce (com trim/case) -> enforce; valor invalido -> shadow', () => {
    setMode('enforce');
    expect(getChatCapabilityGateMode()).toBe('enforce');
    hoisted.settings[CHAT_CAPABILITY_GATE_MODE_SETTING_KEY] = '  ENFORCE ';
    expect(getChatCapabilityGateMode()).toBe('enforce');
    hoisted.settings[CHAT_CAPABILITY_GATE_MODE_SETTING_KEY] = 'banana';
    expect(getChatCapabilityGateMode()).toBe('shadow');
  });

  it('erro de leitura do DB -> shadow (fail-safe, nunca arma nem lanca)', () => {
    hoisted.state.getSettingThrows = true;
    expect(getChatCapabilityGateMode()).toBe('shadow');
  });
});

describe('getChatCapabilityForServer', () => {
  it('mapeia os 2 helpers gated (com alias e case-insensitive) e nada mais', () => {
    expect(getChatCapabilityForServer(PIPELINE_SERVER)).toBe('pipelineControl');
    expect(getChatCapabilityForServer(WORKFLOWS_SERVER)).toBe('dynamicWorkflows');
    expect(getChatCapabilityForServer('pipeline-control')).toBe('pipelineControl');
    expect(getChatCapabilityForServer(' LIONCLAW-PIPELINE-CONTROL ')).toBe('pipelineControl');
    expect(getChatCapabilityForServer('google-gmail')).toBeUndefined();
  });
});

describe('server nao-gated', () => {
  it('ok em qualquer surface/modo, sem log de negaria', () => {
    setMode('enforce');
    expect(
      assertChatCapability({
        serverId: 'google-gmail',
        toolName: 'send_email',
        context: { surface: 'chat', sessionId: 'sess-1', turnId: 'turn-1' },
      }),
    ).toEqual({ ok: true });
    expect(negariaLogs()).toHaveLength(0);
  });
});

describe('surface pipeline/harness/enrich', () => {
  it('ok mesmo com helper gated + enforce + sem turn-context', () => {
    setMode('enforce');
    for (const surface of ['pipeline', 'harness', 'enrich'] as const) {
      expect(
        assertChatCapability({
          serverId: PIPELINE_SERVER,
          toolName: 'pipeline_drive',
          context: { surface },
        }),
      ).toEqual({ ok: true });
    }
    expect(negariaLogs()).toHaveLength(0);
  });
});

describe('surface chat', () => {
  it('capability OFF + shadow (DEFAULT) -> ok MAS loga "negaria {capability} em {server}.{tool}"', () => {
    seedTurn();
    const result = assertChatCapability({
      serverId: PIPELINE_SERVER,
      toolName: 'pipeline_create',
      context: { surface: 'chat', sessionId: 'sess-1', turnId: 'turn-1' },
    });
    expect(result).toEqual({ ok: true });
    const logs = negariaLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].msg).toContain('negaria pipelineControl em lionclaw-pipeline-control.pipeline_create');
    expect(logs[0].data['shadow']).toBe(true);
    expect(logs[0].data['code']).toBe('chat_capability_pipeline_disabled');
  });

  it('capability OFF + enforce -> nega com code/message exatos (Pipeline)', () => {
    setMode('enforce');
    seedTurn();
    const result = assertChatCapability({
      serverId: PIPELINE_SERVER,
      toolName: 'pipeline_reply',
      context: { surface: 'chat', sessionId: 'sess-1', turnId: 'turn-1' },
    });
    expect(result).toEqual({
      ok: false,
      code: 'chat_capability_pipeline_disabled',
      capability: 'pipelineControl',
      message: PIPELINE_OFF_MESSAGE,
    });
  });

  it('capability OFF + enforce -> nega com code/message exatos (Workflows)', () => {
    setMode('enforce');
    seedTurn();
    const result = assertChatCapability({
      serverId: WORKFLOWS_SERVER,
      toolName: 'dynamic_workflow_start',
      context: { surface: 'chat', sessionId: 'sess-1', turnId: 'turn-1' },
    });
    expect(result).toEqual({
      ok: false,
      code: 'chat_capability_workflows_disabled',
      capability: 'dynamicWorkflows',
      message: WORKFLOWS_OFF_MESSAGE,
    });
  });

  it('alias "pipeline-control" e gated igual (0.4 — nenhum gate compara ID bruto)', () => {
    setMode('enforce');
    seedTurn();
    const result = assertChatCapability({
      serverId: 'pipeline-control',
      toolName: 'pipeline_drive',
      context: { surface: 'chat', sessionId: 'sess-1', turnId: 'turn-1' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('chat_capability_pipeline_disabled');
  });

  it('capability ON -> ok em shadow E em enforce', () => {
    seedTurn({ capabilities: { pipelineControl: true, dynamicWorkflows: true } });
    expect(
      assertChatCapability({
        serverId: PIPELINE_SERVER,
        toolName: 'pipeline_drive',
        context: { surface: 'chat', sessionId: 'sess-1', turnId: 'turn-1' },
      }),
    ).toEqual({ ok: true });
    setMode('enforce');
    expect(
      assertChatCapability({
        serverId: WORKFLOWS_SERVER,
        toolName: 'dynamic_workflow_inspect',
        context: { surface: 'chat', sessionId: 'sess-1', turnId: 'turn-1' },
      }),
    ).toEqual({ ok: true });
    expect(negariaLogs()).toHaveLength(0);
  });

  it('resolucao por sessionId/turnId EXPLICITOS no context (sem depender da lane)', () => {
    setMode('enforce');
    registerChatCapabilityTurn({
      surface: 'chat',
      sessionId: 'sess-x',
      turnId: 'turn-x',
      capabilities: { pipelineControl: true, dynamicWorkflows: false },
    });
    expect(
      assertChatCapability({
        serverId: PIPELINE_SERVER,
        toolName: 'pipeline_list',
        context: { surface: 'chat', sessionId: 'sess-x', turnId: 'turn-x' },
      }),
    ).toEqual({ ok: true });
  });

  it('sem turn-context + enforce -> FAIL CLOSED (AC-A18)', () => {
    setMode('enforce');
    const result = assertChatCapability({
      serverId: PIPELINE_SERVER,
      toolName: 'pipeline_drive',
      context: { surface: 'chat', sessionId: 'sess-1', turnId: 'turn-1' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('chat_capability_no_turn_context');
      expect(result.capability).toBe('pipelineControl');
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('sem turn-context + shadow (DEFAULT) -> ok (comportamento pre-S4 preservado) + loga', () => {
    const result = assertChatCapability({
      serverId: WORKFLOWS_SERVER,
      toolName: 'dynamic_workflow_generate',
      context: { surface: 'chat', sessionId: 'sess-1', turnId: 'turn-1' },
    });
    expect(result).toEqual({ ok: true });
    const logs = negariaLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].data['reason']).toBe('no-turn-context');
  });

  it('turno system-event + lease valida forca a capability efetiva ON (0.5.2) mesmo com toggle OFF', () => {
    setMode('enforce');
    const { token } = createInternalCapabilityLease({
      coordinator: 'pipeline-drive-coordinator',
      driveProjectId: 'proj-1',
      driveTurnId: 'dt-1',
      allowedServerIds: [PIPELINE_SERVER],
      allowedToolPrefixes: ['pipeline_'],
      ttlMs: 60_000,
    });
    seedTurn({
      origin: 'system-event',
      internalLeaseToken: token,
      driveProjectId: 'proj-1',
      driveTurnId: 'dt-1',
    });
    expect(
      assertChatCapability({
        serverId: PIPELINE_SERVER,
        toolName: 'pipeline_reply',
        context: { surface: 'chat', sessionId: 'sess-1', turnId: 'turn-1' },
      }),
    ).toEqual({ ok: true });
  });
});

describe('surface system-event', () => {
  function leasedTurn(): { token: string } {
    const { token } = createInternalCapabilityLease({
      coordinator: 'pipeline-drive-coordinator',
      driveProjectId: 'proj-1',
      driveTurnId: 'dt-1',
      allowedServerIds: [PIPELINE_SERVER],
      allowedToolPrefixes: ['pipeline_'],
      ttlMs: 60_000,
    });
    seedTurn({
      origin: 'system-event',
      internalLeaseToken: token,
      driveProjectId: 'proj-1',
      driveTurnId: 'dt-1',
    });
    return { token };
  }

  it('lease valida (via turn-context) -> ok em enforce', () => {
    setMode('enforce');
    leasedTurn();
    expect(
      assertChatCapability({
        serverId: PIPELINE_SERVER,
        toolName: 'pipeline_approve',
        context: { surface: 'system-event', sessionId: 'sess-1', turnId: 'turn-1' },
      }),
    ).toEqual({ ok: true });
  });

  it('lease valida (campos direto no context, sem turn-context) -> ok em enforce', () => {
    setMode('enforce');
    const { token } = createInternalCapabilityLease({
      coordinator: 'dynamic-workflow-ignition',
      driveProjectId: 'run-1',
      driveTurnId: 'wake-1',
      allowedServerIds: [WORKFLOWS_SERVER],
      allowedToolPrefixes: ['dynamic_workflow_'],
      ttlMs: 60_000,
    });
    expect(
      assertChatCapability({
        serverId: WORKFLOWS_SERVER,
        toolName: 'dynamic_workflow_approve',
        context: {
          surface: 'system-event',
          internalLeaseToken: token,
          driveProjectId: 'run-1',
          driveTurnId: 'wake-1',
        },
      }),
    ).toEqual({ ok: true });
  });

  it('sem lease + enforce -> negado (AC-A19: origin sozinho NAO basta)', () => {
    setMode('enforce');
    seedTurn({ origin: 'system-event' });
    const result = assertChatCapability({
      serverId: PIPELINE_SERVER,
      toolName: 'pipeline_drive',
      context: { surface: 'system-event', sessionId: 'sess-1', turnId: 'turn-1' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('chat_capability_lease_invalid');
  });

  it('token forjado + enforce -> negado; em shadow -> ok mas loga', () => {
    setMode('enforce');
    seedTurn({
      origin: 'system-event',
      internalLeaseToken: 'token-forjado',
      driveProjectId: 'proj-1',
      driveTurnId: 'dt-1',
    });
    const denied = assertChatCapability({
      serverId: PIPELINE_SERVER,
      toolName: 'pipeline_drive',
      context: { surface: 'system-event', sessionId: 'sess-1', turnId: 'turn-1' },
    });
    expect(denied.ok).toBe(false);

    setMode(undefined);
    hoisted.logEntries.length = 0;
    const shadowed = assertChatCapability({
      serverId: PIPELINE_SERVER,
      toolName: 'pipeline_drive',
      context: { surface: 'system-event', sessionId: 'sess-1', turnId: 'turn-1' },
    });
    expect(shadowed).toEqual({ ok: true });
    expect(negariaLogs()).toHaveLength(1);
  });

  it('tool fora do prefixo da lease -> negado em enforce', () => {
    setMode('enforce');
    leasedTurn();
    const result = assertChatCapability({
      serverId: PIPELINE_SERVER,
      toolName: 'dynamic_workflow_start', // lease so autoriza pipeline_*
      context: { surface: 'system-event', sessionId: 'sess-1', turnId: 'turn-1' },
    });
    expect(result.ok).toBe(false);
  });

  it('o lease token NUNCA aparece em nenhum log do gate', () => {
    setMode('enforce');
    const { token } = leasedTurn();
    assertChatCapability({
      serverId: PIPELINE_SERVER,
      toolName: 'pipeline_reply',
      context: { surface: 'system-event', sessionId: 'sess-1', turnId: 'turn-1' },
    });
    assertChatCapability({
      serverId: PIPELINE_SERVER,
      toolName: 'nao_autorizada',
      context: { surface: 'system-event', sessionId: 'sess-1', turnId: 'turn-1' },
    });
    const serialized = JSON.stringify(hoisted.logEntries);
    expect(serialized).not.toContain(token);
  });
});

describe('S6b: shadow observa com dryRun (nao esgota a lease); enforce consome', () => {
  function leasedSystemEventTurn(maxUses: number): { token: string } {
    const { token } = createInternalCapabilityLease({
      coordinator: 'pipeline-drive-coordinator',
      driveProjectId: 'proj-1',
      driveTurnId: 'dt-1',
      allowedServerIds: [PIPELINE_SERVER],
      allowedToolPrefixes: ['pipeline_'],
      ttlMs: 60_000,
      maxUses,
    });
    seedTurn({
      origin: 'system-event',
      internalLeaseToken: token,
      driveProjectId: 'proj-1',
      driveTurnId: 'dt-1',
      leaseCoordinator: 'pipeline-drive-coordinator',
      leaseCapability: 'pipelineControl',
    });
    return { token };
  }

  it('shadow: N observacoes would-allow NAO consomem o unico uso; o enforce posterior ainda passa e consome', () => {
    leasedSystemEventTurn(1);

    for (let i = 0; i < 5; i++) {
      expect(
        assertChatCapability({
          serverId: PIPELINE_SERVER,
          toolName: 'pipeline_reply',
          context: { surface: 'system-event', sessionId: 'sess-1', turnId: 'turn-1' },
        }),
      ).toEqual({ ok: true });
    }

    setMode('enforce');
    expect(
      assertChatCapability({
        serverId: PIPELINE_SERVER,
        toolName: 'pipeline_reply',
        context: { surface: 'system-event', sessionId: 'sess-1', turnId: 'turn-1' },
      }),
    ).toEqual({ ok: true });

    const denied = assertChatCapability({
      serverId: PIPELINE_SERVER,
      toolName: 'pipeline_reply',
      context: { surface: 'system-event', sessionId: 'sess-1', turnId: 'turn-1' },
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe('chat_capability_lease_invalid');
  });

  it('shadow: surface chat em turno system-event (efetivas via lease) tambem nao consome', () => {
    leasedSystemEventTurn(1);

    for (let i = 0; i < 3; i++) {
      expect(
        assertChatCapability({
          serverId: PIPELINE_SERVER,
          toolName: 'pipeline_drive',
          context: { surface: 'chat', sessionId: 'sess-1', turnId: 'turn-1' },
        }),
      ).toEqual({ ok: true });
    }
    expect(negariaLogs()).toHaveLength(0);

    setMode('enforce');
    expect(
      assertChatCapability({
        serverId: PIPELINE_SERVER,
        toolName: 'pipeline_drive',
        context: { surface: 'chat', sessionId: 'sess-1', turnId: 'turn-1' },
      }),
    ).toEqual({ ok: true });
  });

  it('enforce: cada gate que passa via lease consome 1 uso (enforcement real e o unico ponto de consumo)', () => {
    setMode('enforce');
    leasedSystemEventTurn(2);

    expect(
      assertChatCapability({
        serverId: PIPELINE_SERVER,
        toolName: 'pipeline_reply',
        context: { surface: 'system-event', sessionId: 'sess-1', turnId: 'turn-1' },
      }),
    ).toEqual({ ok: true });
    expect(
      assertChatCapability({
        serverId: PIPELINE_SERVER,
        toolName: 'pipeline_approve',
        context: { surface: 'system-event', sessionId: 'sess-1', turnId: 'turn-1' },
      }),
    ).toEqual({ ok: true });
    const denied = assertChatCapability({
      serverId: PIPELINE_SERVER,
      toolName: 'pipeline_reply',
      context: { surface: 'system-event', sessionId: 'sess-1', turnId: 'turn-1' },
    });
    expect(denied.ok).toBe(false);
  });
});

describe('OBS-1: iteracao da enum (lease via context, sem coordinator gravado)', () => {
  it('lease valida do ULTIMO coordinator da enum -> ok SEM warn "lease interna NEGADA" por tentativa (intermediarias em debug)', () => {
    setMode('enforce');
    const { token } = createInternalCapabilityLease({
      coordinator: 'scheduler-internal', // ultimo da enum: forca 2 tentativas erradas antes
      driveProjectId: 'run-9',
      driveTurnId: 'wake-9',
      allowedServerIds: [WORKFLOWS_SERVER],
      allowedToolPrefixes: ['dynamic_workflow_'],
      ttlMs: 60_000,
    });
    hoisted.logEntries.length = 0;

    expect(
      assertChatCapability({
        serverId: WORKFLOWS_SERVER,
        toolName: 'dynamic_workflow_approve',
        context: {
          surface: 'system-event',
          internalLeaseToken: token,
          driveProjectId: 'run-9',
          driveTurnId: 'wake-9',
        },
      }),
    ).toEqual({ ok: true });

    const negadaWarns = hoisted.logEntries.filter((e) => e.level === 'warn' && e.msg.includes('lease interna NEGADA'));
    expect(negadaWarns).toHaveLength(0);
    const negadaDebugs = hoisted.logEntries.filter(
      (e) => e.level === 'debug' && e.msg.includes('lease interna NEGADA'),
    );
    expect(negadaDebugs.length).toBeGreaterThan(0);
  });

  it('TODOS os coordinators falhando -> UM warn resumo do fallback (nao 1 por tentativa)', () => {
    setMode('enforce');
    hoisted.logEntries.length = 0;

    const result = assertChatCapability({
      serverId: WORKFLOWS_SERVER,
      toolName: 'dynamic_workflow_approve',
      context: {
        surface: 'system-event',
        internalLeaseToken: 'token-forjado',
        driveProjectId: 'run-9',
        driveTurnId: 'wake-9',
      },
    });
    expect(result.ok).toBe(false);

    const negadaWarns = hoisted.logEntries.filter((e) => e.level === 'warn' && e.msg.includes('lease interna NEGADA'));
    expect(negadaWarns).toHaveLength(1);
    expect(negadaWarns[0].msg).toContain('nenhum coordinator da enum fechada validou');
  });
});

describe('failClosedChatCapability', () => {
  it('enforce -> nega com no-turn-context; shadow -> ok + loga; nao-gated -> ok', () => {
    setMode('enforce');
    const denied = failClosedChatCapability({
      serverId: PIPELINE_SERVER,
      toolName: 'pipeline_list',
      reason: 'unauthenticated-connection',
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe('chat_capability_no_turn_context');

    setMode(undefined);
    hoisted.logEntries.length = 0;
    expect(
      failClosedChatCapability({
        serverId: WORKFLOWS_SERVER,
        toolName: 'dynamic_workflow_start',
        reason: 'no-active-desktop-turn',
      }),
    ).toEqual({ ok: true });
    expect(negariaLogs()).toHaveLength(1);
    expect(negariaLogs()[0].data['reason']).toBe('no-active-desktop-turn');

    setMode('enforce');
    expect(
      failClosedChatCapability({
        serverId: 'google-gmail',
        toolName: 'send_email',
        reason: 'unauthenticated-connection',
      }),
    ).toEqual({ ok: true });
  });
});

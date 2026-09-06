
import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { resolveEffectiveCapabilities } from '../chat-capability-context';
import {
  CHAT_CAPABILITIES_DEFAULT_OFF,
  CHAT_CAPABILITIES_LEGACY_ON,
} from '../../../src/types';

describe('resolveEffectiveCapabilities (0.5.2)', () => {
  it('turno de usuario: efetivas = toggles da sessao (identidade)', () => {
    expect(
      resolveEffectiveCapabilities({
        sessionToggles: { pipelineControl: true, dynamicWorkflows: false },
        origin: 'user',
      }),
    ).toEqual({ pipelineControl: true, dynamicWorkflows: false });

    expect(
      resolveEffectiveCapabilities({
        sessionToggles: CHAT_CAPABILITIES_DEFAULT_OFF,
      }),
    ).toEqual({ pipelineControl: false, dynamicWorkflows: false });

    expect(
      resolveEffectiveCapabilities({
        sessionToggles: CHAT_CAPABILITIES_LEGACY_ON,
      }),
    ).toEqual({ pipelineControl: true, dynamicWorkflows: true });
  });

  it('system-event + lease valida de pipelineControl: forca ON mesmo com toggles OFF', () => {
    const effective = resolveEffectiveCapabilities({
      sessionToggles: { pipelineControl: false, dynamicWorkflows: false },
      origin: 'system-event',
      lease: { valid: true, capability: 'pipelineControl' },
    });
    expect(effective).toEqual({
      pipelineControl: true,
      dynamicWorkflows: false, // a OUTRA capability nao e forcada
    });
  });

  it('system-event + lease valida de dynamicWorkflows: forca ON so ela', () => {
    const effective = resolveEffectiveCapabilities({
      sessionToggles: { pipelineControl: false, dynamicWorkflows: false },
      origin: 'system-event',
      lease: { valid: true, capability: 'dynamicWorkflows' },
    });
    expect(effective).toEqual({
      pipelineControl: false,
      dynamicWorkflows: true,
    });
  });

  it('system-event SEM lease: nao forca nada (efetivas = toggles)', () => {
    expect(
      resolveEffectiveCapabilities({
        sessionToggles: { pipelineControl: false, dynamicWorkflows: false },
        origin: 'system-event',
      }),
    ).toEqual({ pipelineControl: false, dynamicWorkflows: false });
  });

  it('system-event com lease INVALIDA (valid: false): nao forca', () => {
    expect(
      resolveEffectiveCapabilities({
        sessionToggles: { pipelineControl: false, dynamicWorkflows: false },
        origin: 'system-event',
        lease: { valid: false, capability: 'pipelineControl' },
      }),
    ).toEqual({ pipelineControl: false, dynamicWorkflows: false });
  });

  it('turno de USUARIO com lease valida: nao forca (a excecao exige origin system-event)', () => {
    expect(
      resolveEffectiveCapabilities({
        sessionToggles: { pipelineControl: false, dynamicWorkflows: false },
        origin: 'user',
        lease: { valid: true, capability: 'pipelineControl' },
      }),
    ).toEqual({ pipelineControl: false, dynamicWorkflows: false });
  });

  it('lease valida nao DESLIGA capability ja ligada na sessao', () => {
    expect(
      resolveEffectiveCapabilities({
        sessionToggles: { pipelineControl: true, dynamicWorkflows: true },
        origin: 'system-event',
        lease: { valid: true, capability: 'pipelineControl' },
      }),
    ).toEqual({ pipelineControl: true, dynamicWorkflows: true });
  });

  it('e PURA: nao muta o input e devolve objeto novo', () => {
    const sessionToggles = { pipelineControl: false, dynamicWorkflows: false };
    const effective = resolveEffectiveCapabilities({
      sessionToggles,
      origin: 'system-event',
      lease: { valid: true, capability: 'pipelineControl' },
    });

    expect(effective).not.toBe(sessionToggles);
    expect(sessionToggles).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
    });
  });
});

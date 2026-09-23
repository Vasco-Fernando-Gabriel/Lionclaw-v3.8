import { describe, it, expect } from 'vitest';
import { resolvePhase4StartAction, type Phase4StartGateInput } from '@/components/open-design/phase4-start-gate';

function input(over: Partial<Phase4StartGateInput> = {}): Phase4StartGateInput {
  return {
    driveEngaged: false,
    startPending: false,
    startStatusLoaded: true,
    bootInstallReady: true,
    sessionConfigPresent: true,
    bootstrapIdle: true,
    ...over,
  };
}

describe('resolvePhase4StartAction - A3 (decisao de inicio da fase OD)', () => {
  it('A-AC3: drive engajado + start pendente -> show-cta (NUNCA auto-ensure)', () => {
    const action = resolvePhase4StartAction(input({ driveEngaged: true, startPending: true }));
    expect(action).toBe('show-cta');
    expect(action).not.toBe('auto-ensure');
  });

  it('A-AC7: fora de drive (driveEngaged false) -> auto-ensure', () => {
    const action = resolvePhase4StartAction(input({ driveEngaged: false, startPending: false }));
    expect(action).toBe('auto-ensure');
  });

  it('A-AC7b: drive parado/assumido (driveEngaged false) -> auto-inicio mantido', () => {
    const action = resolvePhase4StartAction(input({ driveEngaged: false, startPending: false }));
    expect(action).toBe('auto-ensure');
  });

  it('drive engajado mas GO ja dado (startPending false) -> auto-ensure', () => {
    const action = resolvePhase4StartAction(input({ driveEngaged: true, startPending: false }));
    expect(action).toBe('auto-ensure');
  });

  it('boot install nao pronto -> wait (nada a decidir, mesmo fora de drive)', () => {
    expect(resolvePhase4StartAction(input({ bootInstallReady: false }))).toBe('wait');
  });

  it('sessionConfig ausente -> wait', () => {
    expect(resolvePhase4StartAction(input({ sessionConfigPresent: false }))).toBe('wait');
  });

  it('bootstrap fora de idle -> wait (geracao ja em curso/feita)', () => {
    expect(resolvePhase4StartAction(input({ bootstrapIdle: false }))).toBe('wait');
  });

  it('pre-condicoes mandam: drive engajado + start pendente mas boot nao pronto -> wait', () => {
    const action = resolvePhase4StartAction(input({ driveEngaged: true, startPending: true, bootInstallReady: false }));
    expect(action).toBe('wait');
  });
});

describe('resolvePhase4StartAction - anti-race de boot (TOCTOU, A3)', () => {
  it('startStatusLoaded false -> wait, NUNCA auto-ensure (canal ainda nao respondeu)', () => {
    const action = resolvePhase4StartAction(
      input({
        startStatusLoaded: false,
        driveEngaged: false,
        startPending: false,
        bootInstallReady: true,
        sessionConfigPresent: true,
        bootstrapIdle: true,
      }),
    );
    expect(action).toBe('wait');
    expect(action).not.toBe('auto-ensure');
  });

  it('startStatusLoaded false sob autostart config-only semeado -> wait (cenario real da race)', () => {
    const action = resolvePhase4StartAction(input({ startStatusLoaded: false, sessionConfigPresent: true }));
    expect(action).toBe('wait');
  });

  it('startStatusLoaded true reabilita a decisao normal (auto-ensure fora de drive)', () => {
    const action = resolvePhase4StartAction(input({ startStatusLoaded: true, driveEngaged: false }));
    expect(action).toBe('auto-ensure');
  });
});

describe('resolvePhase4StartAction - A-AC3b (invariante do componente: so auto-ensure dispara ensureSession)', () => {
  function wouldAutoEnsure(action: string): boolean {
    return action === 'auto-ensure';
  }

  it('mock do canal {driveEngaged:true, startPending:true} -> show-cta e ensureSession NAO auto-dispara', () => {
    const action = resolvePhase4StartAction(input({ startStatusLoaded: true, driveEngaged: true, startPending: true }));
    expect(action).toBe('show-cta');
    expect(wouldAutoEnsure(action)).toBe(false);
  });

  it('enquanto o canal nao respondeu (startStatusLoaded false) ensureSession tambem NAO auto-dispara', () => {
    const action = resolvePhase4StartAction(
      input({ startStatusLoaded: false, driveEngaged: false, startPending: false }),
    );
    expect(wouldAutoEnsure(action)).toBe(false);
  });

  it('fora de drive e com o canal resolvido, ensureSession auto-dispara (fluxo humano)', () => {
    const action = resolvePhase4StartAction(input({ startStatusLoaded: true, driveEngaged: false }));
    expect(wouldAutoEnsure(action)).toBe(true);
  });
});

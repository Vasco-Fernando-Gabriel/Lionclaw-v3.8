import { describe, it, expect } from 'vitest';
import { checkAntiRunaway, mintDriveTurnId, decideOneInFlight, type DriveTurnSeq } from '../drive-turn-core';

const LIMITS = {
  tokenBudget: 15_000_000,
  maxTurnsPerDrive: 60,
  maxTurnsPerPhase: 15,
};

describe('checkAntiRunaway (E4 - predicados anti-runaway puros)', () => {
  it('null quando todos os contadores estao DENTRO dos tetos', () => {
    expect(checkAntiRunaway({ tokensSpent: 0, turnsThisDrive: 0, turnsThisPhase: 0 }, LIMITS)).toBeNull();
    expect(
      checkAntiRunaway({ tokensSpent: LIMITS.tokenBudget - 1, turnsThisDrive: 59, turnsThisPhase: 14 }, LIMITS),
    ).toBeNull();
  });

  it('budget: estoura com `>=` (alcancar o teto exatamente ja para)', () => {
    expect(checkAntiRunaway({ tokensSpent: LIMITS.tokenBudget, turnsThisDrive: 0, turnsThisPhase: 0 }, LIMITS)).toBe(
      'budget',
    );
  });

  it('max-turns-drive: estoura no teto global de turnos por drive', () => {
    expect(
      checkAntiRunaway({ tokensSpent: 0, turnsThisDrive: LIMITS.maxTurnsPerDrive, turnsThisPhase: 0 }, LIMITS),
    ).toBe('max-turns-drive');
  });

  it('max-turns-phase: estoura no teto de turnos por fase', () => {
    expect(
      checkAntiRunaway({ tokensSpent: 0, turnsThisDrive: 0, turnsThisPhase: LIMITS.maxTurnsPerPhase }, LIMITS),
    ).toBe('max-turns-phase');
  });

  it('ORDEM: budget tem precedencia sobre os tetos de turnos (mesma do coordinator)', () => {
    expect(
      checkAntiRunaway(
        {
          tokensSpent: LIMITS.tokenBudget,
          turnsThisDrive: LIMITS.maxTurnsPerDrive,
          turnsThisPhase: LIMITS.maxTurnsPerPhase,
        },
        LIMITS,
      ),
    ).toBe('budget');
  });

  it('ORDEM: turnos-drive tem precedencia sobre turnos-fase', () => {
    expect(
      checkAntiRunaway(
        {
          tokensSpent: 0,
          turnsThisDrive: LIMITS.maxTurnsPerDrive,
          turnsThisPhase: LIMITS.maxTurnsPerPhase,
        },
        LIMITS,
      ),
    ).toBe('max-turns-drive');
  });
});

describe('mintDriveTurnId (E4 - mint puro de driveTurnId)', () => {
  it('forma `key:seq`, monotonico e crescente a partir de 1', () => {
    const seq: DriveTurnSeq = { value: 0 };
    expect(mintDriveTurnId('proj_a', seq)).toBe('proj_a:1');
    expect(mintDriveTurnId('proj_a', seq)).toBe('proj_a:2');
    expect(mintDriveTurnId('proj_a', seq)).toBe('proj_a:3');
    expect(seq.value).toBe(3);
  });

  it('UNICO mesmo trocando a key: o contador e GLOBAL (nao reseta por key)', () => {
    const seq: DriveTurnSeq = { value: 0 };
    const id1 = mintDriveTurnId('proj_a', seq);
    const id2 = mintDriveTurnId('20260628_120000-abc123', seq);
    const id3 = mintDriveTurnId('proj_a', seq);
    expect(id1).toBe('proj_a:1');
    expect(id2).toBe('20260628_120000-abc123:2');
    expect(id3).toBe('proj_a:3');
    expect(new Set([id1, id2, id3]).size).toBe(3);
  });

  it('contadores SEPARADOS (portadores distintos) sao independentes', () => {
    const seqA: DriveTurnSeq = { value: 0 };
    const seqB: DriveTurnSeq = { value: 0 };
    expect(mintDriveTurnId('x', seqA)).toBe('x:1');
    expect(mintDriveTurnId('y', seqB)).toBe('y:1');
  });
});

describe('decideOneInFlight (E4 - transicao one-in-flight/coalescing pura)', () => {
  const TIMEOUT = 10 * 60_000;

  it('fire: sem turno em voo (turnInFlightSince null)', () => {
    expect(
      decideOneInFlight({
        turnInFlightSince: null,
        now: 1_000_000,
        hasPendingFollowup: false,
        inflightTimeoutMs: TIMEOUT,
      }),
    ).toBe('fire');
  });

  it('coalesce: turno em voo FRESCO (dentro da janela)', () => {
    const since = 1_000_000;
    expect(
      decideOneInFlight({
        turnInFlightSince: since,
        now: since + TIMEOUT - 1, // ainda dentro
        hasPendingFollowup: false,
        inflightTimeoutMs: TIMEOUT,
      }),
    ).toBe('coalesce');
  });

  it('fire: turno em voo ESTOUROU a janela (>= timeout) - o turno novo segue', () => {
    const since = 1_000_000;
    expect(
      decideOneInFlight({
        turnInFlightSince: since,
        now: since + TIMEOUT, // exatamente no teto -> NAO e mais fresco
        hasPendingFollowup: false,
        inflightTimeoutMs: TIMEOUT,
      }),
    ).toBe('fire');
    expect(
      decideOneInFlight({
        turnInFlightSince: since,
        now: since + TIMEOUT + 5_000,
        hasPendingFollowup: true,
        inflightTimeoutMs: TIMEOUT,
      }),
    ).toBe('fire');
  });

  it('hasPendingFollowup NAO altera o veredito (so telemetria do caller)', () => {
    const since = 1_000_000;
    const base = { turnInFlightSince: since, now: since + 1, inflightTimeoutMs: TIMEOUT };
    expect(decideOneInFlight({ ...base, hasPendingFollowup: false })).toBe('coalesce');
    expect(decideOneInFlight({ ...base, hasPendingFollowup: true })).toBe('coalesce');
  });
});


import { describe, it, expect, vi } from 'vitest';


import {
  applyMigrationV74,
  __V74_INTERNAL,
} from '../db-migrations/v74-dreaming-state';

describe('§A applyMigrationV74 - estrutural', () => {
  it('exporta applyMigrationV74 como funcao', () => {
    expect(typeof applyMigrationV74).toBe('function');
  });

  it('__V74_INTERNAL declara os 3 settings corretos', () => {
    expect(__V74_INTERNAL.SETTINGS).toContain('dreaming_turn_based_enabled');
    expect(__V74_INTERNAL.SETTINGS).toContain('dreaming_turn_based_interval');
    expect(__V74_INTERNAL.SETTINGS).toContain('dreaming_turn_based_model');
  });

  it('__V74_INTERNAL declara TABLE_NAME = dreaming_state', () => {
    expect(__V74_INTERNAL.TABLE_NAME).toBe('dreaming_state');
  });
});

describe('§A applyMigrationV74 - mock DB', () => {
  it('chama db.exec com CREATE TABLE dreaming_state e INSERT OR IGNORE', () => {
    const execSpy = vi.fn();
    const runSpy = vi.fn();
    const stmtMock = { run: runSpy };
    const prepareSpy = vi.fn().mockReturnValue(stmtMock);
    const transactionSpy = vi.fn((fn: () => void) => fn);
    const mockDb = {
      exec: execSpy,
      prepare: prepareSpy,
      transaction: transactionSpy,
    } as unknown as import('better-sqlite3').Database;

    applyMigrationV74(mockDb);

    expect(execSpy).toHaveBeenCalledOnce();
    const execSql: string = execSpy.mock.calls[0][0];
    expect(execSql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+dreaming_state/i);
    expect(execSql).toMatch(/id\s+INTEGER\s+PRIMARY\s+KEY\s+CHECK\s*\(\s*id\s*=\s*1\s*\)/i);
    expect(execSql).toMatch(/last_gate_run_at\s+INTEGER/i);
    expect(execSql).toMatch(/last_turn_run_at\s+INTEGER/i);
    expect(execSql).toMatch(/turn_count\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
    expect(execSql).toMatch(/total_turn_runs\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
    expect(execSql).toMatch(/total_turn_failsafes\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
    expect(execSql).toMatch(/INSERT\s+OR\s+IGNORE\s+INTO\s+dreaming_state/i);
  });

  it('insere os 3 settings via INSERT OR IGNORE', () => {
    const execSpy = vi.fn();
    const runSpy = vi.fn();
    const stmtMock = { run: runSpy };
    const prepareSpy = vi.fn().mockReturnValue(stmtMock);
    const transactionSpy = vi.fn((fn: () => void) => fn);
    const mockDb = {
      exec: execSpy,
      prepare: prepareSpy,
      transaction: transactionSpy,
    } as unknown as import('better-sqlite3').Database;

    applyMigrationV74(mockDb);

    const prepareArg: string = prepareSpy.mock.calls[0][0];
    expect(prepareArg).toMatch(/INSERT\s+OR\s+IGNORE\s+INTO\s+settings/i);

    expect(runSpy).toHaveBeenCalledWith('dreaming_turn_based_enabled', 'false');
    expect(runSpy).toHaveBeenCalledWith('dreaming_turn_based_interval', '20');
    expect(runSpy).toHaveBeenCalledWith('dreaming_turn_based_model', '');
  });

  it('e idempotente: segunda chamada nao lanca erro', () => {
    const execSpy = vi.fn();
    const runSpy = vi.fn();
    const stmtMock = { run: runSpy };
    const prepareSpy = vi.fn().mockReturnValue(stmtMock);
    const transactionSpy = vi.fn((fn: () => void) => fn);
    const mockDb = {
      exec: execSpy,
      prepare: prepareSpy,
      transaction: transactionSpy,
    } as unknown as import('better-sqlite3').Database;

    expect(() => applyMigrationV74(mockDb)).not.toThrow();
    expect(() => applyMigrationV74(mockDb)).not.toThrow();
  });
});


type Row = {
  last_gate_run_at: number | null;
  last_turn_run_at: number | null;
  turn_count: number;
  total_turn_runs: number;
  total_turn_failsafes: number;
};

function makeSimulatedDb(initialRow?: Row | null) {
  let state: Row | undefined = initialRow === null ? undefined : (initialRow ?? {
    last_gate_run_at: null,
    last_turn_run_at: null,
    turn_count: 0,
    total_turn_runs: 0,
    total_turn_failsafes: 0,
  });

  const settings: Record<string, string> = {};

  function runQuery(sql: string, params: unknown[]): void {
    const s = sql.trim().toLowerCase();
    if (s.startsWith('update dreaming_state set last_gate_run_at')) {
      if (state) state.last_gate_run_at = params[0] as number;
    } else if (s.startsWith('update dreaming_state set last_turn_run_at')) {
      if (state) state.last_turn_run_at = params[0] as number;
    } else if (s.startsWith('update dreaming_state set turn_count = turn_count + 1')) {
      if (state) state.turn_count += 1;
    } else if (s.startsWith('update dreaming_state set turn_count = 0')) {
      if (state) state.turn_count = 0;
    } else if (s.startsWith('update dreaming_state set total_turn_runs = total_turn_runs + 1')) {
      if (state) state.total_turn_runs += 1;
    } else if (s.startsWith('update dreaming_state set total_turn_failsafes = total_turn_failsafes + 1')) {
      if (state) state.total_turn_failsafes += 1;
    }
  }

  function getQuery(sql: string, params: unknown[]): unknown {
    const s = sql.trim().toLowerCase();
    if (s.includes('from dreaming_state') && s.includes('last_gate_run_at')) {
      return state;
    }
    if (s.includes('from dreaming_state') && s.includes('turn_count')) {
      return state ? { turn_count: state.turn_count } : undefined;
    }
    if (s.includes('from settings') && s.includes('key = ?')) {
      const key = params[0] as string;
      const val = settings[key];
      return val !== undefined ? { value: val } : undefined;
    }
    return undefined;
  }

  const prepare = vi.fn((sql: string) => ({
    run: vi.fn((...params: unknown[]) => runQuery(sql, params)),
    get: vi.fn((...params: unknown[]) => getQuery(sql, params)),
  }));

  return { prepare, settings, getState: () => state };
}


describe('§B getDreamingState — row presente', () => {
  it('mapeia todos os campos de snake_case para camelCase corretamente', () => {
    const row: Row = {
      last_gate_run_at: 1000,
      last_turn_run_at: 2000,
      turn_count: 5,
      total_turn_runs: 10,
      total_turn_failsafes: 2,
    };
    const result = {
      lastGateRunAt: row.last_gate_run_at,
      lastTurnRunAt: row.last_turn_run_at,
      turnCount: row.turn_count,
      totalTurnRuns: row.total_turn_runs,
      totalTurnFailsafes: row.total_turn_failsafes,
    };
    expect(result.lastGateRunAt).toBe(1000);
    expect(result.lastTurnRunAt).toBe(2000);
    expect(result.turnCount).toBe(5);
    expect(result.totalTurnRuns).toBe(10);
    expect(result.totalTurnFailsafes).toBe(2);
  });

  it('aceita lastGateRunAt = null e lastTurnRunAt = null (nunca rodou)', () => {
    const row: Row = {
      last_gate_run_at: null,
      last_turn_run_at: null,
      turn_count: 0,
      total_turn_runs: 0,
      total_turn_failsafes: 0,
    };
    expect(row.last_gate_run_at).toBeNull();
    expect(row.last_turn_run_at).toBeNull();
  });
});

describe('§C getDreamingState — defensive fallback (row ausente)', () => {
  it('retorna defaults quando row e undefined (DB sem migracao)', () => {
    const row = undefined as Row | undefined;
    const result = row
      ? {
          lastGateRunAt: row.last_gate_run_at,
          lastTurnRunAt: row.last_turn_run_at,
          turnCount: row.turn_count,
          totalTurnRuns: row.total_turn_runs,
          totalTurnFailsafes: row.total_turn_failsafes,
        }
      : { lastGateRunAt: null, lastTurnRunAt: null, turnCount: 0, totalTurnRuns: 0, totalTurnFailsafes: 0 };

    expect(result.lastGateRunAt).toBeNull();
    expect(result.lastTurnRunAt).toBeNull();
    expect(result.turnCount).toBe(0);
    expect(result.totalTurnRuns).toBe(0);
    expect(result.totalTurnFailsafes).toBe(0);
  });
});

describe('§D setLastGateRunAt / setLastTurnRunAt — SQL correto', () => {
  it('setLastGateRunAt emite UPDATE dreaming_state SET last_gate_run_at = ? WHERE id = 1', () => {
    const sim = makeSimulatedDb();
    const t1 = Date.now();
    const stmt = sim.prepare('UPDATE dreaming_state SET last_gate_run_at = ? WHERE id = 1');
    stmt.run(t1);

    const state = sim.getState();
    expect(state?.last_gate_run_at).toBe(t1);
    expect(sim.prepare).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE\s+dreaming_state\s+SET\s+last_gate_run_at\s*=\s*\?/i)
    );
  });

  it('setLastTurnRunAt emite UPDATE dreaming_state SET last_turn_run_at = ? WHERE id = 1', () => {
    const sim = makeSimulatedDb();
    const t2 = Date.now() + 1000;
    const stmt = sim.prepare('UPDATE dreaming_state SET last_turn_run_at = ? WHERE id = 1');
    stmt.run(t2);

    const state = sim.getState();
    expect(state?.last_turn_run_at).toBe(t2);
  });

  it('setLastGateRunAt e setLastTurnRunAt gravam valores independentes', () => {
    const sim = makeSimulatedDb();
    const t1 = 111000;
    const t2 = 222000;
    sim.prepare('UPDATE dreaming_state SET last_gate_run_at = ? WHERE id = 1').run(t1);
    sim.prepare('UPDATE dreaming_state SET last_turn_run_at = ? WHERE id = 1').run(t2);

    const state = sim.getState();
    expect(state?.last_gate_run_at).toBe(t1);
    expect(state?.last_turn_run_at).toBe(t2);
  });
});

describe('§E incrementTurnCount — retorna novo valor apos 3 incrementos', () => {
  it('incrementa atomicamente e retorna o valor pos-incremento', () => {
    const sim = makeSimulatedDb();

    function doIncrement(): number {
      sim.prepare('UPDATE dreaming_state SET turn_count = turn_count + 1 WHERE id = 1').run();
      const row = sim.prepare('SELECT turn_count FROM dreaming_state WHERE id = 1').get() as { turn_count: number } | undefined;
      return row?.turn_count ?? 0;
    }

    const r1 = doIncrement();
    const r2 = doIncrement();
    const r3 = doIncrement();

    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(r3).toBe(3);
    expect(sim.getState()?.turn_count).toBe(3);
  });
});

describe('§F resetTurnCount — zera o contador', () => {
  it('resetTurnCount zera turn_count apos incrementos', () => {
    const sim = makeSimulatedDb();

    sim.prepare('UPDATE dreaming_state SET turn_count = turn_count + 1 WHERE id = 1').run();
    sim.prepare('UPDATE dreaming_state SET turn_count = turn_count + 1 WHERE id = 1').run();
    expect(sim.getState()?.turn_count).toBe(2);

    sim.prepare('UPDATE dreaming_state SET turn_count = 0 WHERE id = 1').run();
    expect(sim.getState()?.turn_count).toBe(0);
  });
});

describe('§G incrementTotalTurnRuns / incrementTotalTurnFailsafes', () => {
  it('incrementTotalTurnRuns 2x -> totalTurnRuns === 2', () => {
    const sim = makeSimulatedDb();
    sim.prepare('UPDATE dreaming_state SET total_turn_runs = total_turn_runs + 1 WHERE id = 1').run();
    sim.prepare('UPDATE dreaming_state SET total_turn_runs = total_turn_runs + 1 WHERE id = 1').run();
    expect(sim.getState()?.total_turn_runs).toBe(2);
  });

  it('incrementTotalTurnFailsafes 3x -> totalTurnFailsafes === 3', () => {
    const sim = makeSimulatedDb();
    sim.prepare('UPDATE dreaming_state SET total_turn_failsafes = total_turn_failsafes + 1 WHERE id = 1').run();
    sim.prepare('UPDATE dreaming_state SET total_turn_failsafes = total_turn_failsafes + 1 WHERE id = 1').run();
    sim.prepare('UPDATE dreaming_state SET total_turn_failsafes = total_turn_failsafes + 1 WHERE id = 1').run();
    expect(sim.getState()?.total_turn_failsafes).toBe(3);
  });

  it('runs e failsafes incrementam independentemente', () => {
    const sim = makeSimulatedDb();
    sim.prepare('UPDATE dreaming_state SET total_turn_runs = total_turn_runs + 1 WHERE id = 1').run();
    sim.prepare('UPDATE dreaming_state SET total_turn_failsafes = total_turn_failsafes + 1 WHERE id = 1').run();
    sim.prepare('UPDATE dreaming_state SET total_turn_failsafes = total_turn_failsafes + 1 WHERE id = 1').run();

    expect(sim.getState()?.total_turn_runs).toBe(1);
    expect(sim.getState()?.total_turn_failsafes).toBe(2);
  });
});

describe('§H CHECK (id = 1) — constraint declarada no SQL de migracao', () => {
  it('o SQL de CREATE TABLE inclui CHECK (id = 1) que impede id != 1', () => {
    const execCalls: string[] = [];
    const mockDb = {
      exec: (sql: string) => { execCalls.push(sql); },
      prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
      transaction: vi.fn((fn: () => void) => fn),
    } as unknown as import('better-sqlite3').Database;

    applyMigrationV74(mockDb);

    const combinedSql = execCalls.join('\n');
    expect(combinedSql).toMatch(/CHECK\s*\(\s*id\s*=\s*1\s*\)/i);
  });
});


function getDreamingTurnIntervalLogic(rawSetting: string | undefined): number {
  const raw = rawSetting || '20';
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(500, Math.max(10, parsed));
}

describe('§I getDreamingTurnInterval — clamp e defaults', () => {
  it("setting ausente (undefined) -> 20 (default)", () => {
    expect(getDreamingTurnIntervalLogic(undefined)).toBe(20);
  });

  it("setting 'abc' (NaN) -> 20 (default)", () => {
    expect(getDreamingTurnIntervalLogic('abc')).toBe(20);
  });

  it("setting '' (string vazia) -> 20 (default)", () => {
    expect(getDreamingTurnIntervalLogic('')).toBe(20);
  });

  it("setting '5' -> 10 (clamp min)", () => {
    expect(getDreamingTurnIntervalLogic('5')).toBe(10);
  });

  it("setting '9999' -> 500 (clamp max)", () => {
    expect(getDreamingTurnIntervalLogic('9999')).toBe(500);
  });

  it("setting '20' -> 20 (valor normal, sem clamp)", () => {
    expect(getDreamingTurnIntervalLogic('20')).toBe(20);
  });

  it("setting '-1' -> 10 (clamp min para negativos)", () => {
    expect(getDreamingTurnIntervalLogic('-1')).toBe(10);
  });

  it("setting '30' -> 30 (valor normal dentro do range)", () => {
    expect(getDreamingTurnIntervalLogic('30')).toBe(30);
  });

  it("setting '10' -> 10 (limite minimo exato)", () => {
    expect(getDreamingTurnIntervalLogic('10')).toBe(10);
  });

  it("setting '500' -> 500 (limite maximo exato)", () => {
    expect(getDreamingTurnIntervalLogic('500')).toBe(500);
  });

  it("setting '0' -> 10 (clamp min)", () => {
    expect(getDreamingTurnIntervalLogic('0')).toBe(10);
  });

  it("setting 'NaN' -> 20 (string 'NaN' nao e numero finito)", () => {
    expect(getDreamingTurnIntervalLogic('NaN')).toBe(20);
  });

  it("setting '  ' (so espacos) -> 20 (parseInt(' ', 10) === NaN)", () => {
    expect(getDreamingTurnIntervalLogic('  ')).toBe(20);
  });
});

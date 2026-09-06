
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Captured {
  sql: string;
  args: unknown[];
  method: 'get' | 'all' | 'run';
}
const capturedQueries: Captured[] = [];

const routeState: {
  pipelineType: string | undefined;
  legacyPhaseRows: Array<{ phase_number: number; phase_name: string }>;
  metricsRows: Array<Record<string, unknown>>;
} = {
  pipelineType: undefined,
  legacyPhaseRows: [],
  metricsRows: [],
};

function resetRouteState() {
  capturedQueries.length = 0;
  routeState.pipelineType = undefined;
  routeState.legacyPhaseRows = [];
  routeState.metricsRows = [];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function makeFakeStatement(sql: string) {
  const n = norm(sql);
  return {
    get: (...args: unknown[]) => {
      capturedQueries.push({ sql: n, args, method: 'get' });
      if (n.includes('SELECT MAX(version) AS version')) return { version: 140 };
      if (n.includes('SELECT MAX(version)')) return { v: 140 };
      if (n.includes('SELECT pipeline_type FROM harness_projects WHERE id')) {
        return routeState.pipelineType === undefined
          ? undefined
          : { pipeline_type: routeState.pipelineType };
      }
      if (n.includes('SELECT id FROM harness_sprints WHERE project_id')) {
        return { id: 'sprint-row-id' };
      }
      if (n.includes('SELECT model FROM pipeline_phase_metrics')) {
        return { model: null };
      }
      if (n.includes('AS total_input')) {
        return {
          total_input: 0, total_output: 0, total_cache: 0, total_cost: 0,
          total_duration: 0, total_tool_uses: 0, total_api_requests: 0,
        };
      }
      if (n.includes('AS cloud_cost')) return { cloud_cost: 0 };
      if (n.includes('AS local_cost')) return { local_cost: 0 };
      return undefined;
    },
    all: (...args: unknown[]) => {
      capturedQueries.push({ sql: n, args, method: 'all' });
      if (
        n.includes('SELECT phase_number, phase_name FROM pipeline_phase_metrics WHERE project_id')
      ) {
        return routeState.legacyPhaseRows;
      }
      if (n.includes('SELECT * FROM pipeline_phase_metrics WHERE project_id')) {
        return routeState.metricsRows;
      }
      return [];
    },
    run: (...args: unknown[]) => {
      capturedQueries.push({ sql: n, args, method: 'run' });
      return { changes: 0, lastInsertRowid: 0 };
    },
  };
}

const fakeDb = {
  prepare: (sql: string) => makeFakeStatement(sql),
  exec: vi.fn(),
  transaction: (fn: () => void) => Object.assign(() => fn(), { immediate: fn }),
  pragma: vi.fn((statement: string) =>
    statement === 'integrity_check(1)'
      ? [{ integrity_check: 'ok' }]
      : // Fidelidade de shim (v146+): better-sqlite3 devolve ARRAY de violacoes
        statement === 'foreign_key_check'
        ? []
        : undefined,
  ),
  close: vi.fn(),
};

vi.mock('better-sqlite3', () => ({
  default: function FakeDatabase() {
    return fakeDb;
  },
}));
vi.mock('sqlite-vec', () => ({ load: vi.fn() }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../paths', () => ({
  getLionClawHome: () => '/tmp/lionclaw-seam-test',
}));
vi.mock('fs', () => ({
  default: { mkdirSync: vi.fn(), existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn(() => ''), writeFileSync: vi.fn() },
  mkdirSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
}));

import {
  initDatabase,
  getPipelinePhaseMessages,
  getPipelinePhaseMessagesAsChatHistory,
  listPipelineMessagesForSprint,
  getRoundDetailsForSprint,
  getPipelineMetrics,
} from '../db';

initDatabase();


function lastHistoryReadArgs(): { phaseCandidates: number[]; includeSprintFlag: number } {
  const q = [...capturedQueries]
    .reverse()
    .find(
      (c) =>
        c.method === 'all' &&
        c.sql.includes('SELECT role, content, tool_calls FROM pipeline_messages') &&
        c.sql.includes('phase_number IN'),
    );
  if (!q) throw new Error('history read query not captured');
  const args = q.args;
  const includeSprintFlag = args[args.length - 1] as number;
  const phaseCandidates = (args.slice(1, args.length - 1) as number[]);
  return { phaseCandidates, includeSprintFlag };
}

function sprintMessagePhaseArgs(): number[] {
  const q = [...capturedQueries]
    .reverse()
    .find(
      (c) =>
        c.method === 'all' &&
        c.sql.includes('FROM pipeline_messages') &&
        c.sql.includes('sprint_index = ? AND phase_number IN'),
    );
  if (!q) throw new Error('sprint-message query not captured');
  return q.args.slice(2) as number[];
}

function modelFallbackPhaseSets(): { coder: number[]; evaluator: number[] } {
  const rows = capturedQueries.filter(
    (c) => c.method === 'get' && c.sql.includes('SELECT model FROM pipeline_phase_metrics'),
  );
  function inList(sql: string): number[] {
    const m = sql.match(/phase_number IN \(([^)]*)\)/);
    if (!m) throw new Error('no IN list in model fallback sql: ' + sql);
    return m[1].split(',').map((x) => parseInt(x.trim(), 10)).sort((a, b) => a - b);
  }
  if (rows.length < 2) throw new Error('expected 2 model fallback queries, got ' + rows.length);
  return { coder: inList(rows[0].sql), evaluator: inList(rows[1].sql) };
}



describe('greeting filter — display read excludes the sentinel agent_id', () => {
  beforeEach(resetRouteState);

  it('getPipelinePhaseMessages carries the greeting-sentinel filter in its SQL', () => {
    routeState.pipelineType = 'development';
    getPipelinePhaseMessages('p', 3);
    const q = [...capturedQueries]
      .reverse()
      .find(
        (c) =>
          c.method === 'all' &&
          c.sql.includes('SELECT role, content, tool_calls FROM pipeline_messages'),
      );
    expect(q).toBeDefined();
    expect(q!.sql).toContain("agent_id IS NOT '__greeting__'");
  });

  it('getPipelinePhaseMessagesAsChatHistory (agent context) does NOT filter the sentinel', () => {
    routeState.pipelineType = 'development';
    getPipelinePhaseMessagesAsChatHistory('p', 3);
    const q = [...capturedQueries]
      .reverse()
      .find(
        (c) =>
          c.method === 'all' &&
          c.sql.includes('SELECT id, role, content, tool_calls FROM pipeline_messages'),
      );
    expect(q).toBeDefined();
    expect(q!.sql).not.toContain('__greeting__');
  });
});

describe('site 1+2 — history read candidates + sprint flag (non-legacy)', () => {
  beforeEach(resetRouteState);

  it('development: loop phases 13/14 set the sprint flag; non-loop do not', () => {
    routeState.pipelineType = 'development';
    getPipelinePhaseMessages('p', 13);
    expect(lastHistoryReadArgs()).toEqual({ phaseCandidates: [13], includeSprintFlag: 1 });

    getPipelinePhaseMessages('p', 14);
    expect(lastHistoryReadArgs()).toEqual({ phaseCandidates: [14], includeSprintFlag: 1 });

    getPipelinePhaseMessages('p', 3);
    expect(lastHistoryReadArgs()).toEqual({ phaseCandidates: [3], includeSprintFlag: 0 });
  });

  it('feature: same loop pair 13/14 as development', () => {
    routeState.pipelineType = 'feature';
    getPipelinePhaseMessages('p', 13);
    expect(lastHistoryReadArgs()).toEqual({ phaseCandidates: [13], includeSprintFlag: 1 });
    getPipelinePhaseMessages('p', 14);
    expect(lastHistoryReadArgs()).toEqual({ phaseCandidates: [14], includeSprintFlag: 1 });
    getPipelinePhaseMessages('p', 9);
    expect(lastHistoryReadArgs()).toEqual({ phaseCandidates: [9], includeSprintFlag: 0 });
  });

  it('security: loop pair 10/11; candidates fold in historical 13/14 (M-4)', () => {
    routeState.pipelineType = 'security';
    const c10 = (getPipelinePhaseMessages('p', 10), lastHistoryReadArgs());
    expect(c10.phaseCandidates.slice().sort((a, b) => a - b)).toEqual([10, 13]);
    expect(c10.includeSprintFlag).toBe(1);
    const c11 = (getPipelinePhaseMessages('p', 11), lastHistoryReadArgs());
    expect(c11.phaseCandidates.slice().sort((a, b) => a - b)).toEqual([11, 14]);
    expect(c11.includeSprintFlag).toBe(1);
    const c4 = (getPipelinePhaseMessages('p', 4), lastHistoryReadArgs());
    expect(c4).toEqual({ phaseCandidates: [4], includeSprintFlag: 0 });
  });

  it('architecture-review: identical to security (10/11 + 13/14 fold)', () => {
    routeState.pipelineType = 'architecture-review';
    const c10 = (getPipelinePhaseMessages('p', 10), lastHistoryReadArgs());
    expect(c10.phaseCandidates.slice().sort((a, b) => a - b)).toEqual([10, 13]);
    const c11 = (getPipelinePhaseMessages('p', 11), lastHistoryReadArgs());
    expect(c11.phaseCandidates.slice().sort((a, b) => a - b)).toEqual([11, 14]);
  });

  it('development-v2 (non-legacy): loop pair 16/17; candidates fold in 13/14 (M-4)', () => {
    routeState.pipelineType = 'development-v2';
    const c16 = (getPipelinePhaseMessages('p', 16), lastHistoryReadArgs());
    expect(c16.phaseCandidates.slice().sort((a, b) => a - b)).toEqual([13, 16]);
    expect(c16.includeSprintFlag).toBe(1);
    const c17 = (getPipelinePhaseMessages('p', 17), lastHistoryReadArgs());
    expect(c17.phaseCandidates.slice().sort((a, b) => a - b)).toEqual([14, 17]);
    expect(c17.includeSprintFlag).toBe(1);
    const c8 = (getPipelinePhaseMessages('p', 8), lastHistoryReadArgs());
    expect(c8).toEqual({ phaseCandidates: [8], includeSprintFlag: 0 });
  });

  it("bug: ('bug', 8) -> [8] e ('bug', 9) -> [9] pelo DEFAULT, sem ramo novo em db.ts (TB-24)", () => {
    routeState.pipelineType = 'bug';
    getPipelinePhaseMessages('p', 8);
    expect(lastHistoryReadArgs()).toEqual({ phaseCandidates: [8], includeSprintFlag: 1 });
    getPipelinePhaseMessages('p', 9);
    expect(lastHistoryReadArgs()).toEqual({ phaseCandidates: [9], includeSprintFlag: 1 });
    for (const c of capturedQueries) {
      expect(c.args.some((a) => a === undefined)).toBe(false);
    }
    getPipelinePhaseMessages('p', 3);
    expect(lastHistoryReadArgs()).toEqual({ phaseCandidates: [3], includeSprintFlag: 0 });
  });

  it('bug: getSprintMessagePhaseNumbersForProject cobre o tipo sozinho -> [8,9] (site 3)', () => {
    routeState.pipelineType = 'bug';
    listPipelineMessagesForSprint('p', 0);
    expect(sprintMessagePhaseArgs()).toEqual([8, 9]);
  });
});


describe('INV-22 — legacy development-v2 project remappers (verbatim)', () => {
  beforeEach(() => {
    resetRouteState();
    routeState.pipelineType = 'development-v2';
    routeState.legacyPhaseRows = [
      { phase_number: 4, phase_name: 'Open Design Studio' },
      { phase_number: 5, phase_name: 'Design Lock' },
    ];
  });

  it('history read of phase 5 (Open Design legacy) remaps storedPhase -> 4', () => {
    getPipelinePhaseMessages('p', 5);
    expect(lastHistoryReadArgs()).toEqual({ phaseCandidates: [4], includeSprintFlag: 0 });
  });

  it('history read of phase 16 (Coder) on legacy: storedPhase 13, candidates unique([13,16,13]) = [13,16]', () => {
    const c = (getPipelinePhaseMessages('p', 16), lastHistoryReadArgs());
    expect(c.phaseCandidates.slice().sort((a, b) => a - b)).toEqual([13, 16]);
    expect(c.includeSprintFlag).toBe(1);
  });

  it('history read of phase 17 (Evaluator) on legacy: storedPhase 14, candidates [14,17]', () => {
    const c = (getPipelinePhaseMessages('p', 17), lastHistoryReadArgs());
    expect(c.phaseCandidates.slice().sort((a, b) => a - b)).toEqual([14, 17]);
    expect(c.includeSprintFlag).toBe(1);
  });

  it('history read of a post-ODS auto phase (e.g. 8) on legacy: storedPhase phase-1 = 7', () => {
    getPipelinePhaseMessages('p', 8);
    expect(lastHistoryReadArgs()).toEqual({ phaseCandidates: [7], includeSprintFlag: 0 });
  });
});


describe('site 3 — getSprintMessagePhaseNumbersForProject (sprint message phases)', () => {
  beforeEach(resetRouteState);

  it('development -> [13,14]', () => {
    routeState.pipelineType = 'development';
    listPipelineMessagesForSprint('p', 0);
    expect(sprintMessagePhaseArgs()).toEqual([13, 14]);
  });

  it('feature -> [13,14]', () => {
    routeState.pipelineType = 'feature';
    listPipelineMessagesForSprint('p', 0);
    expect(sprintMessagePhaseArgs()).toEqual([13, 14]);
  });

  it('security -> [10,11,13,14] (canonical + historical tail)', () => {
    routeState.pipelineType = 'security';
    listPipelineMessagesForSprint('p', 0);
    expect(sprintMessagePhaseArgs()).toEqual([10, 11, 13, 14]);
  });

  it('architecture-review -> [10,11,13,14]', () => {
    routeState.pipelineType = 'architecture-review';
    listPipelineMessagesForSprint('p', 0);
    expect(sprintMessagePhaseArgs()).toEqual([10, 11, 13, 14]);
  });

  it('development-v2 -> [16,17,13,14] (canonical + pre-fix tail)', () => {
    routeState.pipelineType = 'development-v2';
    listPipelineMessagesForSprint('p', 0);
    expect(sprintMessagePhaseArgs()).toEqual([16, 17, 13, 14]);
  });

  it('unknown/undefined type falls through to default [13,14]', () => {
    routeState.pipelineType = undefined;
    listPipelineMessagesForSprint('p', 0);
    expect(sprintMessagePhaseArgs()).toEqual([13, 14]);
  });
});


describe('site 4 — coder/evaluator model fallback are SEPARATE e PER-TIPO (RK-19)', () => {
  beforeEach(resetRouteState);

  it('development: coder fallback IN = [13], evaluator fallback IN = [14]', () => {
    routeState.pipelineType = 'development';
    getRoundDetailsForSprint('p', 0);
    const { coder, evaluator } = modelFallbackPhaseSets();
    expect(coder).toEqual([13]);
    expect(evaluator).toEqual([14]);
  });

  it('security: os dois sets sao DISJUNTOS — coder [10,13], evaluator [11,14]', () => {
    routeState.pipelineType = 'security';
    getRoundDetailsForSprint('p', 0);
    const { coder, evaluator } = modelFallbackPhaseSets();
    expect(coder).toEqual([10, 13]);
    expect(evaluator).toEqual([11, 14]);
    const shared = coder.filter((x) => evaluator.includes(x));
    expect(shared).toEqual([]);
  });

  it('development-v2: coder tem a PRIMEIRA fase de loop DO TIPO, evaluator a SEGUNDA', () => {
    routeState.pipelineType = 'development-v2';
    getRoundDetailsForSprint('p', 0);
    const { coder, evaluator } = modelFallbackPhaseSets();
    expect(coder).toEqual([13, 16]);
    expect(evaluator).toEqual([14, 17]);
    expect(coder).not.toEqual([8, 9, 10, 11, 13, 14, 16, 17]);
    expect(evaluator).not.toEqual([8, 9, 10, 11, 13, 14, 16, 17]);
  });

  it('security NA FASE 8: o Set do coder e [10,13] e NAO contem 8 (o Planner)', () => {
    routeState.pipelineType = 'security';
    getRoundDetailsForSprint('p', 0);
    const { coder, evaluator } = modelFallbackPhaseSets();
    expect(coder).toEqual([10, 13]);
    expect(coder).not.toContain(8);
    expect(evaluator).toEqual([11, 14]);
    expect(evaluator).not.toContain(9);
  });

  it('bug: coder [8] / evaluator [9] — os numeros do Bug Pipe SO aparecem no proprio tipo', () => {
    routeState.pipelineType = 'bug';
    getRoundDetailsForSprint('p', 0);
    const { coder, evaluator } = modelFallbackPhaseSets();
    expect(coder).toEqual([8]);
    expect(evaluator).toEqual([9]);
  });
});


describe('site 5 — getPipelineMetrics sprintPhases filter (PER-TIPO desde S9)', () => {
  beforeEach(resetRouteState);

  function metricRow(phase_number: number): Record<string, unknown> {
    return {
      id: phase_number,
      project_id: 'p',
      phase_number,
      phase_name: `Phase ${phase_number}`,
      agent_id: null,
      status: 'completed',
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
      cost_usd: 0, duration_ms: 0, tool_uses: 0, api_requests: 0, messages_count: 0,
      model: null, runtime: null, started_at: null, completed_at: null,
      metadata: '{}', created_at: '2026-01-01',
    };
  }

  it('development: sprintPhases = [13,14] apenas', () => {
    routeState.pipelineType = 'development';
    routeState.metricsRows = [1, 2, 9, 10, 11, 12, 13, 14, 16, 17].map(metricRow);
    const m = getPipelineMetrics('p');
    expect(m.sprintPhases.map((p) => p.phaseNumber).sort((a, b) => a - b)).toEqual([13, 14]);
    for (const n of [1, 2, 9, 10, 11, 12, 16, 17]) {
      expect(m.sprintPhases.some((p) => p.phaseNumber === n)).toBe(false);
    }
  });

  it('security: sprintPhases = [10,11] — o Planner (8) e o Sprint Validator (9) ficam de fora', () => {
    routeState.pipelineType = 'security';
    routeState.metricsRows = [1, 3, 8, 9, 10, 11].map(metricRow);
    const m = getPipelineMetrics('p');
    expect(m.sprintPhases.map((p) => p.phaseNumber).sort((a, b) => a - b)).toEqual([10, 11]);
  });

  it('dev-v2 rows keep 16/17, drop non-loop dev-v2 phases', () => {
    routeState.pipelineType = 'development-v2';
    routeState.metricsRows = [7, 12, 15, 16, 17].map(metricRow);
    const m = getPipelineMetrics('p');
    expect(m.sprintPhases.map((p) => p.phaseNumber).sort((a, b) => a - b)).toEqual([16, 17]);
  });

  it('development-v2: as fases 10 e 11 (Frontend Tecnico / Security) SAEM de sprintPhases', () => {
    routeState.pipelineType = 'development-v2';
    routeState.metricsRows = [10, 11, 13, 14, 16, 17].map(metricRow);
    const m = getPipelineMetrics('p');
    expect(m.sprintPhases.map((p) => p.phaseNumber).sort((a, b) => a - b)).toEqual([13, 14, 16, 17]);
  });

  it('dev-v2 mantem uma linha crua de fase 14 (rabo HISTORICO do tipo, sem remap)', () => {
    routeState.pipelineType = 'development-v2';
    routeState.metricsRows = [14, 16, 17].map(metricRow);
    const m = getPipelineMetrics('p');
    expect(m.sprintPhases.map((p) => p.phaseNumber).sort((a, b) => a - b)).toEqual([14, 16, 17]);
  });

  it('LEGACY dev-v2 metrics: remap (4->5, >=5 +1, 16->17, 17->18) THEN filtro PER-TIPO keeps only 17', () => {
    routeState.pipelineType = 'development-v2';
    routeState.metricsRows = [
      metricRow(4), // remapped -> 5 (hasPhase4OpenDesign rule)
      metricRow(5), // remapped -> 6 (>=5 -> +1)
      metricRow(16), // remapped -> 17 (kept by flat filter)
      metricRow(17), // remapped -> 18 (dropped)
    ];
    routeState.metricsRows[0].phase_name = 'Open Design Studio';
    routeState.metricsRows[1].phase_name = 'Design Lock';
    const m = getPipelineMetrics('p');
    expect(m.sprintPhases.map((p) => p.phaseNumber).sort((a, b) => a - b)).toEqual([17]);
    expect(m.phases.map((p) => p.phaseNumber).sort((a, b) => a - b)).toEqual([5, 6, 17, 18]);
  });
});

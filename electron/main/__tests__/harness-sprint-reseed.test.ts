import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const h = vi.hoisted(() => {
  const state = {
    sprints: [] as Array<Record<string, unknown>>,
    project: null as Record<string, unknown> | null,
    roundsCount: 0,
  };
  return {
    state,
    replaceMock: vi.fn(),
    updatePendingMock: vi.fn(),
    mergeHashesMock: vi.fn(),
  };
});

vi.mock('../db', () => ({
  getHarnessSprints: vi.fn(() => h.state.sprints),
  getHarnessProject: vi.fn(() => h.state.project),
  getAllAgents: vi.fn(() => [{ id: 'backend-developer' }, { id: 'frontend-developer' }, { id: 'harness-evaluator' }]),
  replaceHarnessSprintsForProject: h.replaceMock,
  updateHarnessPendingSprintsFromReseed: h.updatePendingMock,
  mergeHarnessProjectSprintJsonHashes: h.mergeHashesMock,
  countHarnessRoundsForProject: vi.fn(() => h.state.roundsCount),
}));

import {
  reseedHarnessSprintsFromFile,
  checkHarnessSprintQueueIntegrity,
  computeSprintJsonHashes,
  validateSprintsJsonStructure,
} from '../harness-planner';
import { canonicalJsonStringify } from '../canonical-json';
import type { SprintsJson, SprintJsonEntry } from '../harness-planner';
import type { HarnessProject, HarnessSprint } from '../../../src/types';

let tmpDir: string;

function makeEntry(id: string, overrides: Partial<SprintJsonEntry> = {}): SprintJsonEntry {
  const n = id.replace(/\D/g, '');
  return {
    id,
    index: Number(n) - 1,
    name: `Sprint ${n}`,
    description: `Implementa ${id}`,
    coder_agent_id: 'backend-developer',
    stack: ['typescript'],
    features: [
      {
        id: `feat-${n}a`,
        name: `Feature ${n}a`,
        description: 'desc',
        acceptance_criteria: ['criterio 1'],
      },
    ],
    hints: { existing_files: [], key_interfaces: [], architecture_notes: '' },
    dependencies: [],
    complexity: 'low',
    estimated_rounds: 1,
    ...overrides,
  };
}

function makeSprintsJson(entries: SprintJsonEntry[]): SprintsJson {
  return {
    project: {
      id: 'proj-1',
      name: 'Demo',
      description: 'demo',
      path: tmpDir,
      stack: ['typescript'],
      config: {
        max_rounds_per_sprint: 3,
        use_playwright: false,
        evaluator_agent_id: 'harness-evaluator',
        planner_agent_id: 'harness-planner',
      },
    },
    sprints: entries,
    metadata: {
      version: 1,
      created_at: '2026-07-10T00:00:00.000Z',
      total_sprints: entries.length,
      total_features: entries.reduce((s, e) => s + e.features.length, 0),
    },
  };
}

function writeSprintsFile(json: SprintsJson): string {
  const docsDir = path.join(tmpDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const p = path.join(docsDir, 'sprints.json');
  fs.writeFileSync(p, JSON.stringify(json, null, 2), 'utf-8');
  return p;
}

function makeProject(overrides: Partial<HarnessProject> = {}): HarnessProject {
  return {
    id: 'proj-1',
    name: 'Demo',
    projectPath: tmpDir,
    specPath: path.join(tmpDir, 'SPEC.md'),
    status: 'reviewing',
    config: {
      maxRoundsPerSprint: 3,
      usePlaywright: false,
      evaluatorAgentId: 'harness-evaluator',
      plannerAgentId: 'harness-planner',
      stack: ['typescript'],
    },
    currentSprintIndex: 0,
    totalSprints: 2,
    totalFeatures: 2,
    plannerInputTokens: 0,
    plannerOutputTokens: 0,
    plannerCacheTokens: 0,
    plannerCostUsd: 0,
    plannerDurationMs: 0,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

function makeDbSprint(
  index: number,
  jsonId: string,
  status: HarnessSprint['status'] = 'pending',
  overrides: Partial<HarnessSprint> = {},
): HarnessSprint {
  const n = jsonId.replace(/\D/g, '');
  return {
    id: `row-${jsonId}`,
    projectId: 'proj-1',
    sprintIndex: index,
    sprintJsonId: jsonId,
    name: `Sprint ${n}`,
    status,
    coderAgentId: 'backend-developer',
    evaluatorAgentId: 'harness-evaluator',
    roundsUsed: 0,
    maxRounds: 3,
    ...overrides,
  };
}

function entryHash(entry: SprintJsonEntry): string {
  return createHash('sha256').update(canonicalJsonStringify(entry)).digest('hex');
}

function seedConsistent(
  entries: SprintJsonEntry[],
  statuses?: HarnessSprint['status'][],
  opts: { withHashMap?: boolean } = { withHashMap: true },
): SprintsJson {
  const json = makeSprintsJson(entries);
  writeSprintsFile(json);
  h.state.sprints = entries.map((e, i) => makeDbSprint(i, e.id, statuses?.[i] ?? 'pending')) as never;
  const project = makeProject();
  if (opts.withHashMap !== false) {
    project.config.sprintJsonHashes = computeSprintJsonHashes(json);
  }
  h.state.project = project as never;
  return json;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reseed-test-'));
  h.state.sprints = [];
  h.state.project = null;
  h.state.roundsCount = 0;
  h.replaceMock.mockClear();
  h.updatePendingMock.mockClear();
  h.mergeHashesMock.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('reseedHarnessSprintsFromFile (P1)', () => {
  it('(a) split: N -> N+1 chama replace com N+1 linhas + totals derivados na MESMA chamada', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')]);
    const edited = makeSprintsJson([
      makeEntry('sprint-001'),
      makeEntry('sprint-002', { description: 'emagrecido' }),
      makeEntry('sprint-003'),
    ]);
    writeSprintsFile(edited);

    const outcome = reseedHarnessSprintsFromFile(makeProject());

    expect(outcome.action).toBe('replaced');
    expect(h.replaceMock).toHaveBeenCalledTimes(1);
    const [projectId, rows, extras] = h.replaceMock.mock.calls[0];
    expect(projectId).toBe('proj-1');
    expect(rows).toHaveLength(3);
    expect(rows.map((r: { sprintJsonId: string }) => r.sprintJsonId)).toEqual([
      'sprint-001',
      'sprint-002',
      'sprint-003',
    ]);
    expect(extras.totals).toEqual({ totalSprints: 3, totalFeatures: 3 });
    expect(Object.keys(extras.sprintJsonHashes)).toEqual(['sprint-001', 'sprint-002', 'sprint-003']);
    expect(rows[0].evaluatorAgentId).toBe('harness-evaluator');
    expect(rows[0].maxRounds).toBe(3);
  });

  it('(b) merge: N -> N-1 chama replace com N-1 linhas', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002'), makeEntry('sprint-003')]);
    const edited = makeSprintsJson([makeEntry('sprint-001'), makeEntry('sprint-002', { name: 'Sprint 2+3' })]);
    writeSprintsFile(edited);

    const outcome = reseedHarnessSprintsFromFile(makeProject());

    expect(outcome.action).toBe('replaced');
    expect(h.replaceMock.mock.calls[0][1]).toHaveLength(2);
    expect(h.replaceMock.mock.calls[0][2].totals).toEqual({ totalSprints: 2, totalFeatures: 2 });
  });

  it('(c1) edicao de conteudo com IDs iguais e fila TODA pending -> replace completo', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')]);
    const edited = makeSprintsJson([
      makeEntry('sprint-001'),
      makeEntry('sprint-002', {
        features: [{ id: 'feat-2a', name: 'Feature 2a', description: 'desc', acceptance_criteria: ['criterio NOVO'] }],
      }),
    ]);
    writeSprintsFile(edited);

    const outcome = reseedHarnessSprintsFromFile(makeProject());

    expect(outcome.action).toBe('replaced');
    expect(h.replaceMock).toHaveBeenCalledTimes(1);
    expect(h.updatePendingMock).not.toHaveBeenCalled();
  });

  it('(c2) estado misto + IDs iguais + mudanca SO em pending -> update transacional das linhas pending', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')], ['passed', 'pending']);
    h.state.roundsCount = 2;
    const edited = makeSprintsJson([
      makeEntry('sprint-001'),
      makeEntry('sprint-002', { name: 'Sprint 2 renovado', coder_agent_id: 'frontend-developer' }),
    ]);
    writeSprintsFile(edited);

    const outcome = reseedHarnessSprintsFromFile(makeProject());

    expect(outcome.action).toBe('updated-pending');
    expect(h.replaceMock).not.toHaveBeenCalled();
    expect(h.updatePendingMock).toHaveBeenCalledTimes(1);
    const [projectId, updates, totals, hashes] = h.updatePendingMock.mock.calls[0];
    expect(projectId).toBe('proj-1');
    expect(updates).toEqual([
      { id: 'row-sprint-002', name: 'Sprint 2 renovado', coderAgentId: 'frontend-developer', maxRounds: 3 },
    ]);
    expect(totals).toEqual({ totalSprints: 2, totalFeatures: 2 });
    expect(Object.keys(hashes)).toEqual(['sprint-001', 'sprint-002']);
  });

  it('(d) estado misto + divergencia de ID -> lanca com playbook, sem nenhuma escrita', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')], ['passed', 'pending']);
    h.state.roundsCount = 1;
    const edited = makeSprintsJson([makeEntry('sprint-001'), makeEntry('sprint-002'), makeEntry('sprint-003')]);
    writeSprintsFile(edited);

    expect(() => reseedHarnessSprintsFromFile(makeProject())).toThrow(/Playbook de recuperacao/);
    expect(h.replaceMock).not.toHaveBeenCalled();
    expect(h.updatePendingMock).not.toHaveBeenCalled();
  });

  it('(e) re-confirm pos-reset sem edicao -> no-op sem erro (guard nao bloqueia o gate)', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')], ['passed', 'passed']);
    h.state.roundsCount = 4;

    const outcome = reseedHarnessSprintsFromFile(makeProject());

    expect(outcome.action).toBe('noop');
    expect(h.replaceMock).not.toHaveBeenCalled();
    expect(h.updatePendingMock).not.toHaveBeenCalled();
  });

  it('(h) index duplicado/nao-contiguo no arquivo -> renumeracao POSICIONAL 0..n-1', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')]);
    const edited = makeSprintsJson([
      makeEntry('sprint-001', { index: 0 }),
      makeEntry('sprint-002', { index: 0 }), // duplicado (estouraria o UNIQUE V80)
      makeEntry('sprint-003', { index: 7 }), // nao-contiguo (quebraria lookup posicional)
    ]);
    writeSprintsFile(edited);

    reseedHarnessSprintsFromFile(makeProject());

    const rows = h.replaceMock.mock.calls[0][1];
    expect(rows.map((r: { sprintIndex: number }) => r.sprintIndex)).toEqual([0, 1, 2]);
  });

  it('(i) schema invalido lanca ANTES de qualquer escrita', () => {
    seedConsistent([makeEntry('sprint-001')]);

    const noFeatureFields = makeSprintsJson([
      makeEntry('sprint-001'),
      makeEntry('sprint-002', { features: [{ id: '', name: '', description: '', acceptance_criteria: [] }] }),
    ]);
    writeSprintsFile(noFeatureFields);
    expect(() => reseedHarnessSprintsFromFile(makeProject())).toThrow(/sprints\.json invalido/);

    const badCoder = makeSprintsJson([
      makeEntry('sprint-001'),
      makeEntry('sprint-002', { coder_agent_id: 'agente-que-nao-existe' }),
    ]);
    writeSprintsFile(badCoder);
    expect(() => reseedHarnessSprintsFromFile(makeProject())).toThrow(/coder_agent_id inexistente/);

    const dupFeature = makeSprintsJson([
      makeEntry('sprint-001'),
      makeEntry('sprint-002', {
        features: [
          { id: 'feat-x', name: 'A', description: 'd', acceptance_criteria: [] },
          { id: 'feat-x', name: 'B', description: 'd', acceptance_criteria: [] },
        ],
      }),
    ]);
    writeSprintsFile(dupFeature);
    expect(() => reseedHarnessSprintsFromFile(makeProject())).toThrow(/id de feature duplicado/);

    expect(h.replaceMock).not.toHaveBeenCalled();
    expect(h.updatePendingMock).not.toHaveBeenCalled();
  });

  it('(j) edicao de criterios com IDs iguais e sprint passed -> fail-loud (bloqueador 1)', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')], ['passed', 'pending']);
    h.state.roundsCount = 2;
    const edited = makeSprintsJson([
      makeEntry('sprint-001', {
        features: [
          { id: 'feat-1a', name: 'Feature 1a', description: 'desc', acceptance_criteria: ['criterio REESCRITO'] },
        ],
      }),
      makeEntry('sprint-002'),
    ]);
    writeSprintsFile(edited);

    expect(() => reseedHarnessSprintsFromFile(makeProject())).toThrow(/ja executado.*Playbook de recuperacao/s);
    expect(h.replaceMock).not.toHaveBeenCalled();
    expect(h.updatePendingMock).not.toHaveBeenCalled();
  });

  it('(k) mapa de hashes AUSENTE (legado) + sem divergencia -> no-op e SEMEIA o mapa, nunca fail-loud', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')], undefined, { withHashMap: false });

    const outcome = reseedHarnessSprintsFromFile(makeProject());

    expect(outcome.action).toBe('noop');
    expect(h.mergeHashesMock).toHaveBeenCalledTimes(1);
    const [projectId, seeded] = h.mergeHashesMock.mock.calls[0];
    expect(projectId).toBe('proj-1');
    expect(Object.keys(seeded)).toEqual(['sprint-001', 'sprint-002']);
    expect(seeded['sprint-001']).toBe(entryHash(makeEntry('sprint-001')));
  });

  it('(P1a) arquivo canonico ausente -> lanca (nunca fallback de historico)', () => {
    const docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      path.join(docsDir, 'sprints.v1.json'),
      JSON.stringify(makeSprintsJson([makeEntry('sprint-001')])),
      'utf-8',
    );
    h.state.sprints = [makeDbSprint(0, 'sprint-001')] as never;
    h.state.project = makeProject() as never;

    expect(() => reseedHarnessSprintsFromFile(makeProject())).toThrow(/sprints\.json canonico nao encontrado/);
    expect(h.replaceMock).not.toHaveBeenCalled();
  });

  it('(P1) JSON ilegivel -> lanca com mensagem clara, sem escrita', () => {
    seedConsistent([makeEntry('sprint-001')]);
    fs.writeFileSync(path.join(tmpDir, 'docs', 'sprints.json'), '{ sprints: [truncado', 'utf-8');

    expect(() => reseedHarnessSprintsFromFile(makeProject())).toThrow(/ilegivel\/invalido/);
    expect(h.replaceMock).not.toHaveBeenCalled();
  });

  it('(P1c) fila all-pending mas com rounds registrados -> NAO faz replace (guard zero-rounds)', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')]);
    h.state.roundsCount = 1;
    const edited = makeSprintsJson([makeEntry('sprint-001'), makeEntry('sprint-002'), makeEntry('sprint-003')]);
    writeSprintsFile(edited);

    expect(() => reseedHarnessSprintsFromFile(makeProject())).toThrow(/Playbook de recuperacao/);
    expect(h.replaceMock).not.toHaveBeenCalled();
  });
});

describe('checkHarnessSprintQueueIntegrity (P3)', () => {
  it('(f1) sprint adicionado no arquivo -> fail added-removed com playbook', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')]);
    const edited = makeSprintsJson([makeEntry('sprint-001'), makeEntry('sprint-002'), makeEntry('sprint-003')]);
    writeSprintsFile(edited);

    const res = checkHarnessSprintQueueIntegrity(makeProject(), h.state.sprints as never);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('added-removed');
      expect(res.message).toMatch(/ADICIONADOS\/REMOVIDOS/);
      expect(res.message).toMatch(/Playbook de recuperacao/);
    }
  });

  it('(f2) reordenacao sem mudanca de IDs -> fail reordered (lookup posicional do dev-v2)', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')]);
    const edited = makeSprintsJson([makeEntry('sprint-002'), makeEntry('sprint-001')]);
    writeSprintsFile(edited);

    const res = checkHarnessSprintQueueIntegrity(makeProject(), h.state.sprints as never);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('reordered');
      expect(res.message).toMatch(/REORDENADOS/);
    }
  });

  it('(f3) edicao de conteudo mid-run com IDs iguais -> fail content-changed via hash', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')]);
    const edited = makeSprintsJson([
      makeEntry('sprint-001'),
      makeEntry('sprint-002', {
        features: [{ id: 'feat-2a', name: 'Feature 2a', description: 'desc', acceptance_criteria: ['mudou mid-run'] }],
      }),
    ]);
    writeSprintsFile(edited);

    const res = checkHarnessSprintQueueIntegrity(makeProject(), h.state.sprints as never);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('content-changed');
      expect(res.message).toMatch(/sprint-002/);
    }
  });

  it('(f4) fila == arquivo -> ok', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')]);
    const res = checkHarnessSprintQueueIntegrity(makeProject(), h.state.sprints as never);
    expect(res.ok).toBe(true);
  });

  it('(g) o check NUNCA reescreve a fila (resume pos-pause nao dispara replace)', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')]);
    const edited = makeSprintsJson([makeEntry('sprint-001'), makeEntry('sprint-002'), makeEntry('sprint-003')]);
    writeSprintsFile(edited);

    checkHarnessSprintQueueIntegrity(makeProject(), h.state.sprints as never);

    expect(h.replaceMock).not.toHaveBeenCalled();
    expect(h.updatePendingMock).not.toHaveBeenCalled();
  });

  it('(k) mapa ausente + IDs iguais -> ok e SEMEIA o mapa (primeira passagem do P3)', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')], undefined, { withHashMap: false });

    const res = checkHarnessSprintQueueIntegrity(makeProject(), h.state.sprints as never);

    expect(res.ok).toBe(true);
    expect(h.mergeHashesMock).toHaveBeenCalledTimes(1);
  });

  it('(k/escape-hatch) projeto legado divergente (mapa ausente, sprint adicionado) com sufixo pendente integro -> tolerado com warning', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')], ['passed', 'pending'], { withHashMap: false });
    const edited = makeSprintsJson([makeEntry('sprint-001'), makeEntry('sprint-002'), makeEntry('sprint-003')]);
    writeSprintsFile(edited);

    const res = checkHarnessSprintQueueIntegrity(makeProject(), h.state.sprints as never);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warning).toMatch(/projeto legado/);
    }
    expect(h.mergeHashesMock).not.toHaveBeenCalled();
  });

  it('(k/escape-hatch) legado divergente com sprint PENDENTE sumido do arquivo -> fail mesmo sem mapa', () => {
    seedConsistent([makeEntry('sprint-001'), makeEntry('sprint-002')], ['passed', 'pending'], { withHashMap: false });
    const edited = makeSprintsJson([makeEntry('sprint-001'), makeEntry('sprint-003')]);
    writeSprintsFile(edited);

    const res = checkHarnessSprintQueueIntegrity(makeProject(), h.state.sprints as never);
    expect(res.ok).toBe(false);
  });

  it('arquivo canonico ausente -> fail file-missing', () => {
    h.state.sprints = [makeDbSprint(0, 'sprint-001')] as never;
    h.state.project = makeProject() as never;

    const res = checkHarnessSprintQueueIntegrity(makeProject(), h.state.sprints as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('file-missing');
  });
});

describe('validateSprintsJsonStructure / hash canonico', () => {
  it('id de sprint duplicado e dependencia inexistente -> lancam', () => {
    tmpDir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'reseed-test-'));
    const dupIds = makeSprintsJson([makeEntry('sprint-001'), makeEntry('sprint-001')]);
    expect(() => validateSprintsJsonStructure(dupIds, [{ id: 'backend-developer' }])).toThrow(/duplicado/);

    const badDep = makeSprintsJson([makeEntry('sprint-001', { dependencies: ['sprint-999'] })]);
    expect(() => validateSprintsJsonStructure(badDep, [{ id: 'backend-developer' }])).toThrow(/inexistente/);
  });

  it('hash por sprint e canonico: reordenacao de chaves NAO muda o hash', () => {
    const entry = makeEntry('sprint-001');
    const reordered = Object.fromEntries(Object.entries(entry).reverse()) as unknown as SprintJsonEntry;
    expect(reordered).not.toEqual(undefined);
    expect(Object.keys(reordered)).not.toEqual(Object.keys(entry));
    expect(entryHash(reordered)).toBe(entryHash(entry));
  });
});

describe('wiring BUG 2 (source-level)', () => {
  const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'pipeline-engine', 'index.ts'), 'utf-8');
  const harnessSrc = fs.readFileSync(path.join(__dirname, '..', 'harness-engine.ts'), 'utf-8');

  it('confirmStartDevelopment reseeda, republica a fila para a UI e so entao avanca', () => {
    const confirmBody = engineSrc.slice(
      engineSrc.indexOf('async confirmStartDevelopment('),
      engineSrc.indexOf('// Helpers: metric accumulation across turns'),
    );
    const reseedAt = confirmBody.indexOf('reseedHarnessSprintsFromFile(');
    const emitAt = confirmBody.indexOf('emitPipelineSprintsLoaded(');
    const advanceAt = confirmBody.indexOf('this.advanceToNextPhase(');
    expect(reseedAt).toBeGreaterThan(-1);
    expect(emitAt).toBeGreaterThan(-1);
    expect(advanceAt).toBeGreaterThan(-1);
    expect(reseedAt).toBeLessThan(emitAt);
    expect(emitAt).toBeLessThan(advanceAt);
  });

  it('runSprint checa checkHarnessSprintQueueIntegrity e pausa via failPhase antes de runSingleSprint', () => {
    const runSprintBody = engineSrc.slice(
      engineSrc.indexOf('async runSprint('),
      engineSrc.indexOf('async acceptSprint('),
    );
    const checkAt = runSprintBody.indexOf('checkHarnessSprintQueueIntegrity(');
    const singleAt = runSprintBody.indexOf('runSingleSprint(');
    expect(checkAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(singleAt);
    const failBlock = runSprintBody.slice(checkAt, singleAt);
    expect(failBlock).toContain('this.failPhase(');
    expect(failBlock).toContain("statusUpdate: 'pure-paused'");
  });

  it('HarnessEngine.run() reseeda ANTES de getHarnessSprints e re-checa dentro do loop', () => {
    const runBody = harnessSrc.slice(
      harnessSrc.indexOf('async run(projectId: string'),
      harnessSrc.indexOf('async runSingleSprint('),
    );
    const reseedAt = runBody.indexOf('reseedHarnessSprintsFromFile(');
    const readQueueAt = runBody.indexOf('const sprints = getHarnessSprints(');
    const loopAt = runBody.indexOf('for (let i = 0; i < sprints.length; i++)');
    const checkAt = runBody.indexOf('checkHarnessSprintQueueIntegrity(');
    expect(reseedAt).toBeGreaterThan(-1);
    expect(reseedAt).toBeLessThan(readQueueAt);
    expect(checkAt).toBeGreaterThan(loopAt);
    expect(runBody.slice(checkAt, checkAt + 120)).toContain('getHarnessSprints(projectId)');
    expect(runBody).not.toMatch(
      /status: 'failed' \}\);\s*\n\s*this\.emitIPC\('harness:sprint-update', \{ projectId, sprintId: sprint\.id, status: 'failed' \}\);\s*\n\s*continue;/,
    );
  });
});

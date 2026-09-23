import { describe, it, expect } from 'vitest';
import type { DynamicWorkflowEvent } from '../dynamic-workflows/types';
import {
  deriveOutcome,
  deriveWakeSignal,
  deriveOutcomesSince,
  computeSinceStats,
  assessBoundary,
  computeBoundarySemaphore,
  buildFindingLedger,
  openP1Findings,
  findWindowStartSeq,
  eventsSince,
  findingKey,
  summarizeParsedOutput,
  extractRefuterVerdicts,
  extractValidatorFindings,
  buildWakePrompt,
  selectOutcomesForPrompt,
  checkWakeRunaway,
  worstWakeReason,
  isCodeFilePath,
  isCodeWriterPayload,
  type OutcomeDigest,
} from '../dynamic-workflows/workflow-outcome';

let seq = 0;
function ev(
  type: string,
  payload: Record<string, unknown> = {},
  extra: Partial<Pick<DynamicWorkflowEvent, 'nodeId' | 'phaseId' | 'runId'>> = {},
): DynamicWorkflowEvent {
  seq += 1;
  return {
    id: seq,
    runId: extra.runId ?? 'run-1',
    nodeId: extra.nodeId ?? null,
    phaseId: extra.phaseId ?? null,
    seq,
    type,
    payloadJson: JSON.stringify(payload),
    createdAt: `2026-09-02 04:${String(seq).padStart(2, '0')}:00`,
  };
}

const P1 = (where: string, problem: string) => ({ severity: 'P1', where, problem });
const P2 = (where: string, problem: string) => ({ severity: 'P2', where, problem });

function validatorCompleted(
  nodeId: string,
  findings: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) {
  const p1 = findings.filter((f) => f.severity === 'P1').length;
  return ev(
    'node-completed',
    {
      attempt: 1,
      agentId: 'dynamic-workflow-validator-spec',
      access: 'read-only',
      validatorVerdict: { verdict: p1 > 0 ? 'fail' : 'pass', findingsTotal: findings.length, blockers: p1 },
      p1Count: p1,
      p2Count: findings.filter((f) => f.severity === 'P2').length,
      p3Count: findings.filter((f) => f.severity === 'P3').length,
      findings,
      costUsd: 0.5,
      durationMs: 1000,
      ...extra,
    },
    { nodeId, phaseId: 'S1' },
  );
}

function writerCompleted(nodeId: string, extra: Record<string, unknown> = {}) {
  return ev(
    'node-completed',
    {
      attempt: 1,
      agentId: 'dynamic-workflow-coder',
      access: 'workspace-write',
      touchedFiles: ['src/a.ts'],
      touchedFilesTotal: 1,
      touchedFilesTruncated: false,
      worktreeCommitSha: 'abc123',
      costUsd: 1.5,
      durationMs: 60_000,
      ...extra,
    },
    { nodeId, phaseId: 'S1' },
  );
}

function refuterCompleted(nodeId: string, verdicts: Array<{ where: string; problem: string; verdict: string }>) {
  return ev(
    'node-completed',
    { attempt: 1, agentId: 'dynamic-workflow-refuter', access: 'read-only', refuterVerdicts: verdicts },
    { nodeId, phaseId: 'S1' },
  );
}

describe('deriveOutcome / deriveWakeSignal (tabela D1)', () => {
  it('node-completed sem shape de validador => green, nao acorda', () => {
    const o = deriveOutcome(
      ev('node-completed', { attempt: 1, agentId: 'scout', outputDigest: 'ok' }, { nodeId: 'n1' }),
    );
    expect(o).toMatchObject({ verdict: 'green', wakes: false, nodeId: 'n1', agentId: 'scout', outputDigest: 'ok' });
    expect(deriveWakeSignal(ev('node-completed', {}))).toBeNull();
  });

  it('node-completed de validador com >= 1 P1 => attention (nao acorda)', () => {
    const o = deriveOutcome(validatorCompleted('v1', [P1('a.ts:1', 'x')]));
    expect(o!.verdict).toBe('attention');
    expect(o!.wakes).toBe(false);
    expect(o!.p1Count).toBe(1);
  });

  it('node-completed de validador so com P2/P3 => green (P2/P3 NUNCA rebaixam)', () => {
    const o = deriveOutcome(
      validatorCompleted('v1', [P2('a.ts:1', 'x'), { severity: 'P3', where: 'b', problem: 'y' }]),
    );
    expect(o!.verdict).toBe('green');
  });

  it('node-completed com verdict:fail e blockers>0 mas ZERO P1 => green (blockers nao entra no semaforo)', () => {
    const e = ev('node-completed', {
      validatorVerdict: { verdict: 'fail', findingsTotal: 2, blockers: 2 },
      p1Count: 0,
      p2Count: 2,
      findings: [P2('a', 'b'), P2('c', 'd')],
    });
    expect(deriveOutcome(e)!.verdict).toBe('green');
  });

  it('node-cache-hit segue a MESMA regra do node-completed (P1 => attention)', () => {
    const hit = ev('node-cache-hit', { p1Count: 2, findings: [P1('a', 'b'), P1('c', 'd')] }, { nodeId: 'v1' });
    expect(deriveOutcome(hit)!.verdict).toBe('attention');
    const hitGreen = ev('node-cache-hit', { p1Count: 0 }, { nodeId: 'v1' });
    expect(deriveOutcome(hitGreen)!.verdict).toBe('green');
  });

  it('node-retry-scheduled => pending, nao acorda', () => {
    const o = deriveOutcome(
      ev('node-retry-scheduled', { failureClass: 'provider-limit', attempt: 1 }, { nodeId: 'c1' }),
    );
    expect(o).toMatchObject({ verdict: 'pending', wakes: false, failureClass: 'provider-limit' });
    expect(deriveWakeSignal(ev('node-retry-scheduled', {}))).toBeNull();
  });

  it('green-check ok:false inconclusive:false => attention; ok:true => green; inconclusivo => attention', () => {
    expect(
      deriveOutcome(ev('green-check', { ok: false, inconclusive: false, redChecks: [{ id: 'typecheck' }] })),
    ).toMatchObject({
      verdict: 'attention',
      wakes: false,
    });
    expect(deriveOutcome(ev('green-check', { ok: true, inconclusive: false }))!.verdict).toBe('green');
    expect(deriveOutcome(ev('green-check', { ok: false, inconclusive: true }))!.verdict).toBe('attention');
  });

  it('node-failed (qualquer classe) e sandbox-killed sao PRECURSORES: entram no digest, nunca acordam', () => {
    for (const cls of ['logic', 'schema', 'provider-limit', 'timeout']) {
      const o = deriveOutcome(ev('node-failed', { failureClass: cls, error: 'boom', attempt: 1 }, { nodeId: 'c1' }));
      expect(o).toMatchObject({
        verdict: 'attention',
        wakes: false,
        precursor: true,
        failureClass: cls,
        errorExcerpt: 'boom',
      });
      expect(deriveWakeSignal(ev('node-failed', { failureClass: cls }))).toBeNull();
    }
    const k = deriveOutcome(ev('sandbox-killed', { reason: 'wall-timeout' }));
    expect(k).toMatchObject({ verdict: 'attention', wakes: false, precursor: true, errorExcerpt: 'wall-timeout' });
    expect(deriveWakeSignal(ev('sandbox-killed', {}))).toBeNull();
  });

  it('run-blocked-provider => needs-decision com failureClass e nodeError reais (acorda)', () => {
    const e = ev(
      'run-blocked-provider',
      { failureClass: 'logic', retriesExhausted: false, attemptsMade: 1, nodeError: 'agentType inexistente' },
      { nodeId: 'c1' },
    );
    expect(deriveOutcome(e)).toMatchObject({
      verdict: 'needs-decision',
      wakes: true,
      failureClass: 'logic',
      errorExcerpt: 'agentType inexistente',
    });
    expect(deriveWakeSignal(e)).toEqual({ reason: 'needs-decision', nodeId: 'c1' });
  });

  it('node-stalled => PRECURSOR (L1.1: o watchdog aborta so o node; a falha segue retry -> gate failure:*), nao acorda', () => {
    const e = ev('node-stalled', { stalledForMs: 180000, message: 'sem progresso ha 3min' }, { nodeId: 'c1' });
    expect(deriveOutcome(e)).toMatchObject({
      verdict: 'attention',
      wakes: false,
      precursor: true,
      errorExcerpt: 'sem progresso ha 3min',
    });
    expect(deriveWakeSignal(e)).toBeNull();
  });

  it('run-blocked-provider COM gateId (failure:<node>) => PRECURSOR do gate-blocked failure:* (nao acorda); sem gateId continua terminal', () => {
    const withGate = ev(
      'run-blocked-provider',
      { failureClass: 'logic', nodeError: 'boom', gateId: 'failure:c1' },
      { nodeId: 'c1' },
    );
    expect(deriveOutcome(withGate)).toMatchObject({
      verdict: 'attention',
      wakes: false,
      precursor: true,
      gateId: 'failure:c1',
      failureClass: 'logic',
    });
    expect(deriveWakeSignal(withGate)).toBeNull();
    const gate = ev(
      'gate-blocked',
      {
        gateId: 'failure:c1',
        mode: 'orchestrator',
        failure: true,
        failureClass: 'logic',
        error: 'boom',
        actions: ['retry', 'switch-agent', 'skip', 'abort'],
      },
      { nodeId: 'c1' },
    );
    expect(deriveOutcome(gate)).toMatchObject({
      verdict: 'blocked',
      wakes: true,
      gateId: 'failure:c1',
      failureClass: 'logic',
      errorExcerpt: 'boom',
    });
    expect(deriveWakeSignal(gate)).toEqual({ reason: 'blocked', gateId: 'failure:c1' });
  });

  it('run-failed => needs-decision com sugestao resume (acorda)', () => {
    const e = ev('run-failed', { error: 'execucao falhou (wall-timeout)' });
    expect(deriveOutcome(e)).toMatchObject({ verdict: 'needs-decision', wakes: true, suggestion: 'resume' });
    expect(deriveWakeSignal(e)!.reason).toBe('needs-decision');
  });

  it("gate-blocked mode:'orchestrator' => blocked (acorda com gateId); mode:'human' nao acorda", () => {
    const e = ev('gate-blocked', { gateId: 'cc-delivery', mode: 'orchestrator' });
    expect(deriveOutcome(e)).toMatchObject({ verdict: 'blocked', wakes: true, gateId: 'cc-delivery' });
    expect(deriveWakeSignal(e)).toEqual({ reason: 'blocked', gateId: 'cc-delivery' });
    expect(deriveWakeSignal(ev('gate-blocked', { gateId: 'g', mode: 'human' }))).toBeNull();
    expect(deriveWakeSignal(ev('gate-blocked', { mode: 'orchestrator' }))).toBeNull();
  });

  it('wake-runaway => needs-human (acorda)', () => {
    const e = ev('wake-runaway', { wakesTotal: 7, wakesSinceProgress: 7 });
    expect(deriveOutcome(e)).toMatchObject({ verdict: 'needs-human', wakes: true });
    expect(deriveWakeSignal(e)).toEqual({ reason: 'needs-human' });
  });

  it('phase-changed / coordinator-finished sao fronteira (sinal boundary, sem desfecho)', () => {
    expect(deriveOutcome(ev('phase-changed', { phase: 'S2' }))).toBeNull();
    expect(deriveWakeSignal(ev('phase-changed', { phase: 'S2' }))).toEqual({ reason: 'boundary' });
    expect(deriveWakeSignal(ev('coordinator-finished', {}))).toEqual({ reason: 'boundary' });
  });

  it('nenhum outro tipo gera wake (run-delivered, run-finished, node-started, log, wake-planned...)', () => {
    for (const t of [
      'run-delivered',
      'run-finished',
      'node-started',
      'log',
      'checkpoint',
      'wake-planned',
      'wake-completed',
      'run-paused',
      'node-committed',
    ]) {
      expect(deriveWakeSignal(ev(t, {}))).toBeNull();
      expect(deriveOutcome(ev(t, {}))).toBeNull();
    }
  });

  it('payload corrompido nao lanca', () => {
    const bad: DynamicWorkflowEvent = { ...ev('node-completed'), payloadJson: '{ nao-json' };
    expect(deriveOutcome(bad)!.verdict).toBe('green');
  });
});

describe('janela (findWindowStartSeq / deriveOutcomesSince / computeSinceStats)', () => {
  it('reseta no ultimo wake-completed executed ou gate-approved de fronteira; discarded NAO reseta', () => {
    seq = 0;
    const events = [
      ev('node-completed', { agentId: 'a' }, { nodeId: 'n1' }), // 1
      ev('wake-planned', { driveTurnId: 't1' }), // 2
      ev('wake-completed', { driveTurnId: 't1', outcome: 'executed' }), // 3
      ev('node-completed', { agentId: 'b' }, { nodeId: 'n2' }), // 4
      ev('wake-completed', { driveTurnId: 't2', outcome: 'discarded' }), // 5
      ev('gate-approved', { gateId: 'gate-plan-review' }), // 6 (nao e fronteira)
    ];
    expect(findWindowStartSeq(events)).toBe(3);
    const outcomes = deriveOutcomesSince(events, 3);
    expect(outcomes.map((o) => o.nodeId)).toEqual(['n2']);
    events.push(ev('gate-approved', { gateId: 'boundary:S1' }));
    expect(findWindowStartSeq(events)).toBe(7);
    events.push(ev('gate-approved', { gateId: 'cc-delivery' }));
    expect(findWindowStartSeq(events)).toBe(8);
    expect(eventsSince(events, 7).map((e) => e.seq)).toEqual([8]);
  });

  it('gate-rejected de boundary:* CONGELA a janela: wake-completed executed posterior NAO reseta (reject + resume exige novo juizo)', () => {
    seq = 0;
    const events = [
      ev('wake-completed', { driveTurnId: 't0', outcome: 'executed' }), // 1 (marco anterior)
      writerCompleted('c1'), // 2
      ev('gate-blocked', { gateId: 'boundary:Validar', mode: 'orchestrator', semaphore: 'SEM VEREDITO' }), // 3
      ev('wake-planned', { driveTurnId: 't1', reason: 'blocked', gateId: 'boundary:Validar' }), // 4
      ev('gate-rejected', { gateId: 'boundary:Validar', decidedBy: 'orchestrator' }), // 5
      ev('run-paused', { gateId: 'boundary:Validar' }), // 6
      ev('wake-completed', { driveTurnId: 't1', outcome: 'executed' }), // 7: turno que rejeitou
      ev('resume-requested', {}), // 8: resume SEM acceptBoundary
    ];
    expect(findWindowStartSeq(events)).toBe(1);
    const win = eventsSince(events, findWindowStartSeq(events));
    const a = assessBoundary(win, { history: events });
    expect(a.since.nodes).toBe(1);
    expect(a.semaphore).toBe('SEM VEREDITO');
    expect(a.unresolvedDecisions).toHaveLength(0);

    const approved = [...events, ev('gate-approved', { gateId: 'boundary:Validar' })];
    expect(findWindowStartSeq(approved)).toBe(9);
    const after = [...approved, ev('wake-completed', { driveTurnId: 't2', outcome: 'executed' })];
    expect(findWindowStartSeq(after)).toBe(10);
  });

  it('resume-requested {acceptBoundary:true} descongela e reseta a janela (aceite explicito)', () => {
    seq = 0;
    const events = [
      writerCompleted('c1'), // 1
      ev('gate-rejected', { gateId: 'boundary:S1' }), // 2 (congela em 0)
      ev('wake-completed', { driveTurnId: 't1', outcome: 'executed' }), // 3 (ignorado)
    ];
    expect(findWindowStartSeq(events)).toBe(0);
    events.push(ev('resume-requested', { acceptBoundary: true }));
    expect(findWindowStartSeq(events)).toBe(4);
    expect(assessBoundary(eventsSince(events, 4), { history: events }).since.nodes).toBe(0);
    seq = 0;
    const plain = [
      ev('gate-rejected', { gateId: 'gate-plan-review' }), // 1
      ev('wake-completed', { driveTurnId: 't1', outcome: 'executed' }), // 2
    ];
    expect(findWindowStartSeq(plain)).toBe(2);
  });

  it('computeSinceStats conta nodes/verdes/atencao/falhas/pending/custo/tempo', () => {
    seq = 0;
    const outcomes = [
      validatorCompleted('v1', [P1('a', 'b')]),
      writerCompleted('c1'),
      ev('node-failed', { failureClass: 'logic', costUsd: 0.2, durationMs: 500 }, { nodeId: 'c2' }),
      ev('node-retry-scheduled', {}, { nodeId: 'c2' }),
      ev('green-check', { ok: false, inconclusive: false }),
    ]
      .map(deriveOutcome)
      .filter((o): o is OutcomeDigest => o !== null);
    expect(computeSinceStats(outcomes)).toEqual({
      nodes: 3,
      green: 1,
      attention: 2,
      pending: 1,
      failed: 1,
      costUsd: 2.2,
      durationMs: 61_500,
    });
  });
});

describe('semaforo de fronteira (D1b) - FAIL-CLOSED', () => {
  it('janela vazia => VERDE (since.nodes 0; o chamador pula a fronteira)', () => {
    seq = 0;
    const a = assessBoundary([]);
    expect(a.semaphore).toBe('VERDE');
    expect(a.since.nodes).toBe(0);
  });

  it('so nodes verdes read-only => VERDE', () => {
    seq = 0;
    expect(
      computeBoundarySemaphore([
        validatorCompleted('v1', []),
        ev('node-completed', { agentId: 'scout', access: 'read-only' }, { nodeId: 's1' }),
      ]),
    ).toBe('VERDE');
  });

  it('validador com P1 NUNCA produz VERDE (ATENCAO)', () => {
    seq = 0;
    const a = assessBoundary([validatorCompleted('v1', [P1('src/a.ts:10', 'faltou guard')])]);
    expect(a.semaphore).toBe('ATENCAO');
    expect(a.openP1).toHaveLength(1);
  });

  it('dois validadores em paralelo: o ULTIMO pass e o outro com P1 => ATENCAO (agregacao por chave, nunca "o ultimo")', () => {
    seq = 0;
    const events = [
      validatorCompleted('v-spec', [P1('src/a.ts:10', 'faltou guard')]),
      validatorCompleted('v-tests', []), // pass, veio depois
    ];
    expect(computeBoundarySemaphore(events)).toBe('ATENCAO');
  });

  it('P2/P3 apenas => VERDE', () => {
    seq = 0;
    expect(
      computeBoundarySemaphore([
        validatorCompleted('v1', [P2('a', 'b'), { severity: 'P3', where: 'c', problem: 'd' }]),
      ]),
    ).toBe('VERDE');
  });

  it("refuter verdict 'false' (ou 'ruido') fecha o P1 => VERDE; 'real' mantem => ATENCAO", () => {
    seq = 0;
    const base = [validatorCompleted('v1', [P1('src/a.ts:10', 'faltou guard')])];
    expect(
      computeBoundarySemaphore([
        ...base,
        refuterCompleted('r1', [{ where: 'src/a.ts:10', problem: 'faltou guard', verdict: 'false' }]),
      ]),
    ).toBe('VERDE');
    seq = 0;
    expect(
      computeBoundarySemaphore([
        ...base,
        refuterCompleted('r1', [{ where: 'src/a.ts:10', problem: 'faltou guard', verdict: 'ruido' }]),
      ]),
    ).toBe('VERDE');
    seq = 0;
    const real = assessBoundary([
      ...base,
      refuterCompleted('r1', [{ where: 'src/a.ts:10', problem: 'faltou guard', verdict: 'real' }]),
    ]);
    expect(real.semaphore).toBe('ATENCAO');
    expect(real.openP1[0]!.status).toBe('open-real');
  });

  it("re-refuter 'fixed' fecha (VERDE com green-check ok); 'still-real' mantem (ATENCAO)", () => {
    seq = 0;
    const events = [
      validatorCompleted('v1', [P1('src/a.ts:10', 'faltou guard')]),
      refuterCompleted('r1', [{ where: 'src/a.ts:10', problem: 'faltou guard', verdict: 'real' }]),
      writerCompleted('fixer'),
      ev('green-check', { ok: true, inconclusive: false, final: true }),
    ];
    expect(computeBoundarySemaphore(events)).toBe('ATENCAO');
    const fixed = [
      ...events,
      refuterCompleted('rr1', [{ where: 'src/a.ts:10', problem: 'faltou guard', verdict: 'fixed' }]),
    ];
    expect(computeBoundarySemaphore(fixed)).toBe('VERDE');
    const still = [
      ...events,
      refuterCompleted('rr1', [{ where: 'src/a.ts:10', problem: 'faltou guard', verdict: 'still-real' }]),
    ];
    expect(computeBoundarySemaphore(still)).toBe('ATENCAO');
  });

  it('L1.4: node-cache-hit NUNCA entra na janela do semaforo (replay de validador com P1 ou de writer => VERDE, since.nodes 0)', () => {
    seq = 0;
    const hit = ev('node-cache-hit', { access: 'read-only', p1Count: 1, findings: [P1('a', 'b')] }, { nodeId: 'v1' });
    const writerHit = ev(
      'node-cache-hit',
      { access: 'workspace-write', agentId: 'dynamic-workflow-coder' },
      { nodeId: 'u1' },
    );
    const a = assessBoundary([hit, writerHit]);
    expect(a.semaphore).toBe('VERDE');
    expect(a.since.nodes).toBe(0);
    expect(a.writerCount).toBe(0);
    expect(a.openP1).toHaveLength(0);
    expect(deriveOutcome(hit)!.verdict).toBe('attention');
  });

  it('pending aberto (retry sem node-completed posterior do MESMO node) => ATENCAO; resolvido pelo node-completed => VERDE', () => {
    seq = 0;
    const events = [
      ev('node-failed', { failureClass: 'provider-limit' }, { nodeId: 'c1' }),
      ev('node-retry-scheduled', { failureClass: 'provider-limit', attempt: 1 }, { nodeId: 'c1' }),
    ];
    expect(computeBoundarySemaphore(events)).toBe('ATENCAO');
    const resolved = [...events, ev('node-completed', { access: 'read-only', agentId: 'scout' }, { nodeId: 'c1' })];
    expect(computeBoundarySemaphore(resolved)).toBe('VERDE');
    seq = 0;
    const other = [...events, ev('node-completed', { access: 'read-only' }, { nodeId: 'c9' })];
    expect(computeBoundarySemaphore(other)).toBe('ATENCAO');
  });

  it('writer sem green-check => SEM VEREDITO', () => {
    seq = 0;
    const a = assessBoundary([writerCompleted('u1')]);
    expect(a.semaphore).toBe('SEM VEREDITO');
    expect(a.writerCount).toBe(1);
  });

  it('writer + ultimo green-check ok:false ainda aberto na fronteira => ATENCAO', () => {
    seq = 0;
    expect(
      computeBoundarySemaphore([
        writerCompleted('u1'),
        ev('green-check', { ok: false, inconclusive: false, redChecks: [{ id: 'test' }] }),
      ]),
    ).toBe('ATENCAO');
  });

  it('sequencia validador-fail(P1) -> refuter false -> writer -> green ok => VERDE', () => {
    seq = 0;
    const events = [
      validatorCompleted('v1', [P1('src/a.ts:10', 'faltou guard')]),
      refuterCompleted('r1', [{ where: 'src/a.ts:10', problem: 'faltou guard', verdict: 'false' }]),
      writerCompleted('u1'),
      ev('green-check', { ok: true, inconclusive: false }),
    ];
    expect(computeBoundarySemaphore(events)).toBe('VERDE');
  });

  it('writer + green-check ok:true NAO fecha P1 (so re-refuter fixed / refuter false)', () => {
    seq = 0;
    const events = [
      validatorCompleted('v1', [P1('src/a.ts:10', 'faltou guard')]),
      writerCompleted('fixer'),
      ev('green-check', { ok: true, inconclusive: false }),
    ];
    expect(computeBoundarySemaphore(events)).toBe('ATENCAO');
  });

  it('needs-decision nao resolvido na janela => DECISAO NECESSARIA; resolvido por resume-requested => avalia o resto', () => {
    seq = 0;
    const events = [
      ev('node-failed', { failureClass: 'logic' }, { nodeId: 'c1' }),
      ev('run-blocked-provider', { failureClass: 'logic', nodeError: 'x' }, { nodeId: 'c1' }),
    ];
    expect(computeBoundarySemaphore(events)).toBe('DECISAO NECESSARIA');
    const resumed = [
      ...events,
      ev('resume-requested', {}),
      ev('node-completed', { access: 'read-only' }, { nodeId: 'c1' }),
    ];
    expect(computeBoundarySemaphore(resumed)).toBe('VERDE');
  });

  it('gate-blocked orchestrator sem gate-approved => DECISAO NECESSARIA; aprovado => nao pesa', () => {
    seq = 0;
    const events = [
      ev('node-completed', { access: 'read-only' }, { nodeId: 'n1' }),
      ev('gate-blocked', { gateId: 'gate-x', mode: 'orchestrator' }),
    ];
    expect(computeBoundarySemaphore(events)).toBe('DECISAO NECESSARIA');
    expect(computeBoundarySemaphore([...events, ev('gate-approved', { gateId: 'gate-x' })])).toBe('VERDE');
  });

  it('wake-runaway na janela => DECISAO HUMANA', () => {
    seq = 0;
    expect(
      computeBoundarySemaphore([ev('node-completed', {}, { nodeId: 'n1' }), ev('wake-runaway', { wakesTotal: 7 })]),
    ).toBe('DECISAO HUMANA');
  });

  it('ledger: chave = sha8(where|problem); P1 de validadores distintos agregam por chave', () => {
    seq = 0;
    const ledger = buildFindingLedger([
      validatorCompleted('v1', [P1('a.ts:1', 'x'), P2('b.ts:2', 'y')]),
      validatorCompleted('v2', [P1('a.ts:1', 'x'), P1('c.ts:3', 'z')]),
    ]);
    expect(ledger.get(findingKey('a.ts:1', 'x'))!.status).toBe('open');
    expect(ledger.get(findingKey('b.ts:2', 'y'))!.status).toBe('advisory');
    expect(
      openP1Findings(ledger)
        .map((f) => f.where)
        .sort(),
    ).toEqual(['a.ts:1', 'c.ts:3']);
    expect(findingKey('a', 'b')).toHaveLength(8);
  });
});

describe('summarizeParsedOutput / shapes', () => {
  it('validador: verdict + contagem por severidade', () => {
    const s = summarizeParsedOutput({
      verdict: 'fail',
      findings: [P1('a', 'b'), P2('c', 'd'), { severity: 'P3', where: 'e', problem: 'f' }],
    });
    expect(s).toBe('verdict=fail findings=3 P1=1 P2=1 P3=1');
  });

  it('refuter em lote (REFUTE_SCHEMA): contagem por veredito; ruido normalizado para false', () => {
    const parsed = {
      refutations: [
        { where: 'a', problem: 'b', verdict: 'real' },
        { where: 'c', problem: 'd', verdict: 'ruido' },
        { ref: 'f2', verdict: 'real' },
      ],
    };
    expect(summarizeParsedOutput(parsed)).toBe('refutations=2 real=1 false=1');
    expect(extractRefuterVerdicts(parsed)).toEqual([
      { where: 'a', problem: 'b', verdict: 'real' },
      { where: 'c', problem: 'd', verdict: 'false' },
    ]);
    expect(extractRefuterVerdicts({ where: 'a', problem: 'b', verdict: 'fixed' })).toEqual([
      { where: 'a', problem: 'b', verdict: 'fixed' },
    ]);
    expect(extractRefuterVerdicts({ verdict: 'pass', findings: [] })).toBeNull();
    expect(extractRefuterVerdicts('texto')).toBeNull();
  });

  it('texto livre (envelope {output}) e string => tail 160; objeto => chaves; sempre <= 200 chars', () => {
    const long = 'x'.repeat(500);
    expect(summarizeParsedOutput({ output: long }).length).toBeLessThanOrEqual(200);
    expect(summarizeParsedOutput(long).length).toBeLessThanOrEqual(200);
    expect(summarizeParsedOutput({ output: 'ARQUIVOS TOCADOS: src/a.ts' })).toBe('ARQUIVOS TOCADOS: src/a.ts');
    expect(summarizeParsedOutput({ unidades: [], gates: [] })).toBe('{unidades, gates}');
    expect(summarizeParsedOutput(null)).toBe('');
    expect(summarizeParsedOutput(undefined)).toBe('');
  });

  it('extractValidatorFindings: cap 30 e contagens totais', () => {
    const findings = Array.from({ length: 40 }, (_, i) => P1(`f${i}`, 'p'));
    const out = extractValidatorFindings({ verdict: 'fail', findings });
    expect(out!.findings).toHaveLength(30);
    expect(out!.total).toBe(40);
    expect(out!.p1).toBe(40);
    expect(extractValidatorFindings({ output: 'x' })).toBeNull();
  });
});

describe('buildWakePrompt (D4)', () => {
  const since = { nodes: 3, green: 2, attention: 1, pending: 0, failed: 0, costUsd: 1.23, durationMs: 90_000 };

  it("VERDE: linha canonica, 'ok, seguindo', 'Nao chame tools', SEM inspect nem clausula de surpresa", () => {
    seq = 0;
    const outcomes = deriveOutcomesSince([validatorCompleted('v1', []), writerCompleted('u1')], 0);
    const p = buildWakePrompt({
      runId: 'run-9',
      reason: 'boundary',
      semaphore: 'VERDE',
      since,
      outcomes,
      pendingDecision: null,
    });
    expect(p).toContain('run-9');
    expect(p).toContain('SEMAFORO: VERDE');
    expect(p).toContain("responda 'ok, seguindo'. Nao chame tools.");
    expect(p).not.toContain('dynamic_workflow_inspect');
    expect(p.toLowerCase()).not.toContain('surpre');
    expect(p).toContain('DESDE O ULTIMO WAKE');
    expect(p).toContain('3 node(s): 2 verde(s), 1 com atencao, 0 falha(s)');
  });

  it('qualquer outro semaforo exige dynamic_workflow_inspect ANTES de agir e lista pendingDecision', () => {
    for (const sem of ['ATENCAO', 'SEM VEREDITO', 'DECISAO NECESSARIA', 'DECISAO HUMANA'] as const) {
      const p = buildWakePrompt({
        runId: 'run-9',
        reason: sem === 'DECISAO HUMANA' ? 'needs-human' : 'blocked',
        semaphore: sem,
        since,
        outcomes: [],
        pendingDecision: { type: 'gate', id: 'boundary:S1', prompt: 'fronteira S1' },
        gateId: 'boundary:S1',
      });
      expect(p).toContain(`SEMAFORO: ${sem}`);
      expect(p).toContain('dynamic_workflow_inspect("run-9")');
      expect(p).toContain('boundary:S1');
      expect(p).not.toContain("'ok, seguindo'");
      const inspectIdx = p.indexOf('dynamic_workflow_inspect');
      const approveIdx = p.toLowerCase().indexOf('aprov');
      if (approveIdx >= 0) expect(inspectIdx).toBeLessThan(approveIdx);
    }
    const human = buildWakePrompt({
      runId: 'r',
      reason: 'needs-human',
      semaphore: 'DECISAO HUMANA',
      since,
      outcomes: [],
      detail: 'wakes=7',
    });
    expect(human).toContain('So `dynamic_workflow_inspect` esta disponivel');
    expect(human).toContain('wakes=7');
  });

  it('cap de 12 desfechos: nao-verdes primeiro, depois os ULTIMOS verdes, excedente vira contador', () => {
    seq = 0;
    const events: DynamicWorkflowEvent[] = [];
    for (let i = 0; i < 20; i++)
      events.push(ev('node-completed', { access: 'read-only', agentId: `g${i}` }, { nodeId: `g${i}` }));
    events.push(validatorCompleted('bad', [P1('a', 'b')]));
    events.push(ev('node-failed', { failureClass: 'logic' }, { nodeId: 'f1' }));
    const outcomes = deriveOutcomesSince(events, 0);
    const { shown, omitted } = selectOutcomesForPrompt(outcomes);
    expect(shown).toHaveLength(12);
    expect(shown[0]!.verdict).not.toBe('green');
    expect(shown[1]!.verdict).not.toBe('green');
    expect(shown.slice(2).every((o) => o.verdict === 'green')).toBe(true);
    expect(shown.map((o) => o.nodeId)).toContain('g19');
    expect(shown.map((o) => o.nodeId)).not.toContain('g0');
    expect(omitted).toBe(22 - 12);
    const p = buildWakePrompt({ runId: 'r', reason: 'boundary', semaphore: 'ATENCAO', since, outcomes });
    expect(p).toContain('(+10 desfecho(s) verde(s) omitido(s))');
  });
});

describe('buildWakePrompt: bloco de acoes cita rerun-node (S2 implementa; o system prompt ja o cita)', () => {
  it('ATENCAO lista rerun-node {nodeId, instruction} entre as intervencoes', () => {
    const prompt = buildWakePrompt({
      runId: 'run-1',
      reason: 'blocked',
      gateId: 'boundary:S1',
      semaphore: 'ATENCAO',
      since: { nodes: 1, green: 0, attention: 1, pending: 0, failed: 0, costUsd: 0, durationMs: 0 },
      outcomes: [],
      pendingDecision: null,
    });
    expect(prompt).toContain('rerun-node {nodeId, instruction}');
  });
});

describe('checkWakeRunaway (D6)', () => {
  it('limites default: 120 por run, 6 sem progresso; estoura so ao ULTRAPASSAR', () => {
    expect(checkWakeRunaway({ wakesTotal: 120, wakesSinceProgress: 6 })).toEqual({ runaway: false });
    expect(checkWakeRunaway({ wakesTotal: 121, wakesSinceProgress: 1 })).toEqual({
      runaway: true,
      reason: 'max-wakes-per-run',
    });
    expect(checkWakeRunaway({ wakesTotal: 10, wakesSinceProgress: 7 })).toEqual({
      runaway: true,
      reason: 'max-wakes-sem-progresso',
    });
  });

  it('limites injetaveis', () => {
    expect(
      checkWakeRunaway({ wakesTotal: 3, wakesSinceProgress: 0 }, { maxWakesPerRun: 2, maxWakesSemProgresso: 6 }),
    ).toEqual({ runaway: true, reason: 'max-wakes-per-run' });
  });

  it('worstWakeReason: needs-human > blocked > needs-decision > boundary', () => {
    expect(worstWakeReason('boundary', 'needs-decision')).toBe('needs-decision');
    expect(worstWakeReason('blocked', 'needs-decision')).toBe('blocked');
    expect(worstWakeReason('blocked', 'needs-human')).toBe('needs-human');
    expect(worstWakeReason('boundary', 'boundary')).toBe('boundary');
  });
});

describe('L1.4: falha AGENDADA (rerun-requested / resume-requested / decisao do gate failure:*) nao rebaixa a fronteira', () => {
  it('node-failed seguido de rerun-requested do MESMO node => nao conta como "falhou sem conclusao"', () => {
    seq = 0;
    const events = [
      ev('node-failed', { failureClass: 'logic' }, { nodeId: 'u1' }),
      ev('rerun-requested', { nodeId: 'u1', fromCallIndex: 3 }, { nodeId: 'u1' }),
    ];
    const a = assessBoundary(events);
    expect(a.unresolvedFailures).toEqual([]);
    expect(a.semaphore).toBe('VERDE');
    seq = 0;
    const other = [
      ev('node-failed', { failureClass: 'logic' }, { nodeId: 'u1' }),
      ev('rerun-requested', { nodeId: 'u9' }, { nodeId: 'u9' }),
    ];
    expect(assessBoundary(other).unresolvedFailures).toEqual(['u1']);
  });

  it('node-failed seguido de resume-requested (replay re-executa o node) => agendado; falha NOVA apos o resume volta a contar', () => {
    seq = 0;
    const events = [ev('node-failed', { failureClass: 'logic' }, { nodeId: 'u1' }), ev('resume-requested', {})];
    expect(assessBoundary(events).unresolvedFailures).toEqual([]);
    const again = [...events, ev('node-failed', { failureClass: 'logic' }, { nodeId: 'u1' })];
    expect(assessBoundary(again).unresolvedFailures).toEqual(['u1']);
  });

  it('gate-approved do failure:<node> (retry/skip) agenda/resolve a falha daquele node; gate-blocked failure:* pendente = DECISAO NECESSARIA', () => {
    seq = 0;
    const pending = [
      ev('node-failed', { failureClass: 'logic' }, { nodeId: 'u1' }),
      ev('run-blocked-provider', { failureClass: 'logic', gateId: 'failure:u1' }, { nodeId: 'u1' }),
      ev('gate-blocked', { gateId: 'failure:u1', mode: 'orchestrator', failure: true }, { nodeId: 'u1' }),
    ];
    expect(assessBoundary(pending).semaphore).toBe('DECISAO NECESSARIA');
    const skipped = [...pending, ev('gate-approved', { gateId: 'failure:u1', action: 'skip' }, { nodeId: 'u1' })];
    const a = assessBoundary(skipped);
    expect(a.unresolvedDecisions).toEqual([]);
    expect(a.unresolvedFailures).toEqual([]);
    expect(a.semaphore).toBe('VERDE');
  });

  it('replay pos-approve de fronteira: so cache-hits na janela => since.nodes 0 (nao reabre gate)', () => {
    seq = 0;
    const events = [
      writerCompleted('u1'),
      ev('gate-blocked', { gateId: 'boundary:S2', mode: 'orchestrator' }),
      ev('gate-approved', { gateId: 'boundary:S2' }),
      ev('resume-requested', {}),
      ev('node-cache-hit', { access: 'workspace-write', agentId: 'dynamic-workflow-coder' }, { nodeId: 'u1' }),
      ev('node-cache-hit', { access: 'read-only', p1Count: 1, findings: [P1('a', 'b')] }, { nodeId: 'v1' }),
    ];
    const start = findWindowStartSeq(events);
    const a = assessBoundary(eventsSince(events, start), { history: events });
    expect(a.since.nodes).toBe(0);
    expect(a.semaphore).toBe('VERDE');
  });
});

describe('L1.5: regra (c) do semaforo so para writers de CODIGO', () => {
  it('janela so com doc-writer (arquivos .md em docs/) e SEM green-check => VERDE', () => {
    seq = 0;
    const doc = ev(
      'node-completed',
      {
        agentId: 'dynamic-workflow-doc-writer',
        access: 'workspace-write',
        touchedFiles: ['docs/PRD.md', 'docs/plan.json'],
      },
      { nodeId: 'd1' },
    );
    const a = assessBoundary([doc]);
    expect(a.writerCount).toBe(0);
    expect(a.semaphore).toBe('VERDE');
  });

  it('coder sem green-check => SEM VEREDITO; fixer idem; coder-codex/glm idem', () => {
    for (const agentId of [
      'dynamic-workflow-coder',
      'dynamic-workflow-coder-codex',
      'dynamic-workflow-coder-glm',
      'dynamic-workflow-fixer',
    ]) {
      seq = 0;
      const a = assessBoundary([writerCompleted('u1', { agentId, touchedFiles: [] })]);
      expect(a.semaphore).toBe('SEM VEREDITO');
    }
  });

  it('writer generico que tocou CODIGO (fora de docs/, nao .md/.txt/.json) exige green-check; so docs => nao', () => {
    seq = 0;
    const code = ev(
      'node-completed',
      { agentId: 'custom-writer', access: 'workspace-write', touchedFiles: ['docs/x.md', 'src/app.ts'] },
      { nodeId: 'w1' },
    );
    expect(assessBoundary([code]).semaphore).toBe('SEM VEREDITO');
    seq = 0;
    const docsOnly = ev(
      'node-completed',
      {
        agentId: 'custom-writer',
        access: 'workspace-write',
        touchedFiles: ['README.md', 'notes.txt', 'config/x.json'],
      },
      { nodeId: 'w1' },
    );
    expect(assessBoundary([docsOnly]).semaphore).toBe('VERDE');
    expect(isCodeFilePath('src/a.ts')).toBe(true);
    expect(isCodeFilePath('docs/a.ts')).toBe(false);
    expect(isCodeFilePath('a.md')).toBe(false);
    expect(isCodeFilePath('package.json')).toBe(false);
    expect(isCodeFilePath('Dockerfile')).toBe(true);
    expect(isCodeWriterPayload({ access: 'read-only', agentId: 'dynamic-workflow-coder' })).toBe(false);
  });
});


import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: { on: vi.fn() },
}));
vi.mock('fs', () => ({
  default: { existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn(() => ''), writeFileSync: vi.fn() },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
}));
vi.mock('path', () => ({ default: { join: (...a: string[]) => a.join('/') }, join: (...a: string[]) => a.join('/') }));
vi.mock('os', () => ({ default: { homedir: () => '/home/user', tmpdir: () => '/tmp' }, homedir: () => '/home/user', tmpdir: () => '/tmp' }));
vi.mock('../db', () => ({
  getHarnessProject: vi.fn(),
  getAgent: vi.fn(),
  getDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []), run: vi.fn(), get: vi.fn() })) })),
  savePipelinePhaseMetrics: vi.fn(),
  savePipelineMessage: vi.fn(),
  getPipelinePhaseMessages: vi.fn().mockReturnValue([]),
  getPipelinePhaseMessagesAsChatHistory: vi.fn().mockReturnValue([]),
  getPipelineMetrics: vi.fn().mockReturnValue({ phases: [] }),
  getHarnessSprints: vi.fn().mockReturnValue([]),
  updateHarnessProject: vi.fn(),
  updateHarnessSprint: vi.fn(),
  insertHarnessRound: vi.fn(),
  updateHarnessRound: vi.fn(),
  deletePipelineMessagesFromPhase: vi.fn(),
  deletePipelinePhaseMetricsFromPhase: vi.fn(),
  deletePipelineMessagesForSprint: vi.fn(),
  deletePipelinePhaseMetricsForSprint: vi.fn(),
  deleteHarnessRoundsForSprint: vi.fn(),
  resetHarnessSprintStatus: vi.fn(),
  deleteHarnessSprintsForProject: vi.fn(),
  getHarnessSprintByIndex: vi.fn(),
  patchSecuritySummaryJson: vi.fn(),
  getSecuritySummaryJson: vi.fn(),
  getSecurityAgentStatuses: vi.fn().mockReturnValue([]),
  setProjectStatus: vi.fn(),
}));
vi.mock('../agent-runtime', () => ({ executeAgent: vi.fn() }));vi.mock('../harness-engine', () => {
  const HarnessEngine = vi.fn();
  HarnessEngine.prototype.abort = vi.fn();
  HarnessEngine.prototype.runSingleSprint = vi.fn();
  return { HarnessEngine };
});
vi.mock('../security-audit-runner', () => ({ SecurityAuditRunner: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../repo-profiler', () => ({ runRepoProfiler: vi.fn() }));
vi.mock('../security-findings-parser', () => ({ parseSecurityFindings: vi.fn() }));
vi.mock('../pipeline-paths', () => ({
  generatePipelineDocsId: vi.fn(() => 'docs-id'),
  getPipelineDocsContext: vi.fn(() => null),
  migrateLegacyDocsToFolder: vi.fn(),
  findConsolidatedSecurityReport: vi.fn(),
}));
vi.mock('../pipeline-report', () => ({ generatePipelineReport: vi.fn(), exportPipelineReport: vi.fn() }));
vi.mock('../pipeline-metrics-report', () => ({}));

import {
  PIPELINE_PHASES,
  SECURITY_PIPELINE_PHASES,
  FEATURE_PIPELINE_PHASES,
  ARCHITECTURE_REVIEW_PIPELINE_PHASES,
  DEVELOPMENT_V2_PIPELINE_PHASES,
  BUG_PIPELINE_PHASES,
  DEVELOPMENT_V2_AUTO_PHASES,
  DEVELOPMENT_V2_LOOP_PHASES,
  DEVELOPMENT_V2_CONVERSATION_PHASES,
  DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK,
  DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK,
  autoPhasesOf,
  loopPhasesOf,
  conversationPhasesOf,
  resetablePhasesOf,
  maxPhaseOf,
  phaseOfAgent,
  allLoopPhases,
  allLoopPhasesWithHistory,
  loopPhasesByRoleWithHistoryOf,
  getPhaseNumberForAgent,
  LOOP_HISTORY_BY_TYPE,
  type PhaseDefinition,
} from '../../../src/types/pipeline';
import {
  getAutoPhases,
  getLoopPhases,
  getResetablePhases,
  getPhaseName,
  getPhaseAgentId,
  getPhaseArtifactMap,
} from '../pipeline-engine/registry';


const sorted = (s: Iterable<number>): number[] => [...s].sort((a, b) => a - b);

const ALL_BUG_PHASES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const GOLDEN = {
  development: {
    auto: [2, 4, 9, 11],
    loop: [13, 14],
    resetable: [1, 2, 4, 9, 11, 12],
    conversation: [1, 3, 5, 6, 7, 8, 9, 10, 12],
  },
  security: {
    auto: [1, 2, 3, 6, 8],
    loop: [10, 11],
    resetable: [1, 2, 3, 6, 8, 9],
    conversation: [4, 5, 6, 7, 9],
  },
  feature: {
    auto: [2, 4, 9, 11],
    loop: [13, 14],
    resetable: [1, 2, 4, 9, 11, 12],
    conversation: [1, 3, 5, 6, 7, 8, 9, 10, 12],
  },
  'architecture-review': {
    auto: [1, 3, 5, 8],
    loop: [10, 11],
    resetable: [1, 2, 3, 4, 5, 8, 9],
    conversation: [2, 4, 6, 7, 9],
  },
  'development-v2': {
    auto: [2, 4, 6, 7, 12, 14],
    loop: [16, 17],
    resetableBeforeLock: [1, 2, 3, 4, 5],
    resetableAfterLock: [7, 8, 9, 10, 11, 12, 13, 14, 15],
    conversation: [1, 3, 5, 8, 9, 10, 11, 12, 13, 15],
  },
  bug: {
    auto: [2, 4, 6],
    loop: [8, 9],
    resetable: [1, 2, 3, 4, 6, 7],
    conversation: [1, 3, 5, 7],
  },
} as const;


function deriveAuto(phases: readonly PhaseDefinition[]): number[] {
  return sorted(phases.filter((p) => p.type === 'auto').map((p) => p.number));
}
function deriveLoop(phases: readonly PhaseDefinition[]): number[] {
  return sorted(phases.filter((p) => p.type === 'loop').map((p) => p.number));
}
function deriveResetable(phases: readonly PhaseDefinition[]): number[] {
  return sorted(phases.filter((p) => p.resetable).map((p) => p.number));
}
function deriveConversation(
  phases: readonly PhaseDefinition[],
  overrides: number[],
): number[] {
  const auto = new Set(deriveAuto(phases));
  const loop = new Set(deriveLoop(phases));
  const base = phases.filter((p) => !auto.has(p.number) && !loop.has(p.number)).map((p) => p.number);
  return sorted(new Set([...base, ...overrides]));
}


describe('Layer A — golden literals derive from canonical *_PIPELINE_PHASES', () => {
  it('development: auto/loop/resetable derive by .type/.resetable', () => {
    expect(deriveAuto(PIPELINE_PHASES)).toEqual(GOLDEN.development.auto);
    expect(deriveLoop(PIPELINE_PHASES)).toEqual(GOLDEN.development.loop);
    expect(deriveResetable(PIPELINE_PHASES)).toEqual(GOLDEN.development.resetable);
  });

  it('security: auto/loop/resetable derive by .type/.resetable', () => {
    expect(deriveAuto(SECURITY_PIPELINE_PHASES)).toEqual(GOLDEN.security.auto);
    expect(deriveLoop(SECURITY_PIPELINE_PHASES)).toEqual(GOLDEN.security.loop);
    expect(deriveResetable(SECURITY_PIPELINE_PHASES)).toEqual(GOLDEN.security.resetable);
  });

  it('feature: auto/loop/resetable derive by .type/.resetable', () => {
    expect(deriveAuto(FEATURE_PIPELINE_PHASES)).toEqual(GOLDEN.feature.auto);
    expect(deriveLoop(FEATURE_PIPELINE_PHASES)).toEqual(GOLDEN.feature.loop);
    expect(deriveResetable(FEATURE_PIPELINE_PHASES)).toEqual(GOLDEN.feature.resetable);
  });

  it('architecture-review: auto/loop/resetable derive by .type/.resetable', () => {
    expect(deriveAuto(ARCHITECTURE_REVIEW_PIPELINE_PHASES)).toEqual(GOLDEN['architecture-review'].auto);
    expect(deriveLoop(ARCHITECTURE_REVIEW_PIPELINE_PHASES)).toEqual(GOLDEN['architecture-review'].loop);
    expect(deriveResetable(ARCHITECTURE_REVIEW_PIPELINE_PHASES)).toEqual(GOLDEN['architecture-review'].resetable);
  });

  it('bug: auto/loop/resetable derive by .type/.resetable (9 fases, secao 4.1)', () => {
    expect(deriveAuto(BUG_PIPELINE_PHASES)).toEqual(GOLDEN.bug.auto);
    expect(deriveLoop(BUG_PIPELINE_PHASES)).toEqual(GOLDEN.bug.loop);
    expect(deriveResetable(BUG_PIPELINE_PHASES)).toEqual(GOLDEN.bug.resetable);
  });

  it('development-v2: auto/loop derive by .type (resetable is lock-dependent, NOT .resetable)', () => {
    expect(deriveAuto(DEVELOPMENT_V2_PIPELINE_PHASES)).toEqual(GOLDEN['development-v2'].auto);
    expect(deriveLoop(DEVELOPMENT_V2_PIPELINE_PHASES)).toEqual(GOLDEN['development-v2'].loop);
    const flagDerived = deriveResetable(DEVELOPMENT_V2_PIPELINE_PHASES);
    expect(flagDerived).not.toEqual(GOLDEN['development-v2'].resetableBeforeLock);
    expect(flagDerived).not.toEqual(GOLDEN['development-v2'].resetableAfterLock);
  });

  it('conversation sets derive from .type + the FOUR overrides (dev-9, feature-9, dev-v2-12, security-6)', () => {
    expect(deriveConversation(PIPELINE_PHASES, [9])).toEqual(GOLDEN.development.conversation);
    expect(deriveConversation(FEATURE_PIPELINE_PHASES, [9])).toEqual(GOLDEN.feature.conversation);
    expect(deriveConversation(DEVELOPMENT_V2_PIPELINE_PHASES, [12])).toEqual(GOLDEN['development-v2'].conversation);
    expect(deriveConversation(SECURITY_PIPELINE_PHASES, [6])).toEqual(GOLDEN.security.conversation);
    expect(deriveConversation(ARCHITECTURE_REVIEW_PIPELINE_PHASES, [])).toEqual(GOLDEN['architecture-review'].conversation);
    expect(deriveConversation(BUG_PIPELINE_PHASES, [])).toEqual(GOLDEN.bug.conversation);
  });
});


describe('Layer B — conversationPhasesOf(type) equals the golden literals', () => {
  it('conversationPhasesOf(security) == golden', () => {
    expect(sorted(conversationPhasesOf('security'))).toEqual(GOLDEN.security.conversation);
  });

  it('conversationPhasesOf(architecture-review) == golden', () => {
    expect(sorted(conversationPhasesOf('architecture-review'))).toEqual(GOLDEN['architecture-review'].conversation);
  });

  it('conversationPhasesOf(development) == golden dev conversation', () => {
    expect(sorted(conversationPhasesOf('development'))).toEqual(GOLDEN.development.conversation);
  });

  it('conversationPhasesOf(feature) == golden feature conversation (R-1)', () => {
    expect(sorted(conversationPhasesOf('feature'))).toEqual(GOLDEN.feature.conversation);
    expect(sorted(conversationPhasesOf('feature'))).toEqual(sorted(conversationPhasesOf('development')));
  });

  it('conversationPhasesOf(development-v2) == canonical DEVELOPMENT_V2_CONVERSATION_PHASES == golden', () => {
    expect(sorted(conversationPhasesOf('development-v2'))).toEqual(sorted(DEVELOPMENT_V2_CONVERSATION_PHASES));
    expect(sorted(conversationPhasesOf('development-v2'))).toEqual(GOLDEN['development-v2'].conversation);
  });

  it('conversationPhasesOf(bug) == golden bug conversation [1,3,5,7]', () => {
    expect(sorted(conversationPhasesOf('bug'))).toEqual(GOLDEN.bug.conversation);
  });

  it('dev-v2 auto/loop/conversation/resetable Sets (pipeline.ts) == golden', () => {
    expect(sorted(DEVELOPMENT_V2_AUTO_PHASES)).toEqual(GOLDEN['development-v2'].auto);
    expect(sorted(DEVELOPMENT_V2_LOOP_PHASES)).toEqual(GOLDEN['development-v2'].loop);
    expect(sorted(DEVELOPMENT_V2_CONVERSATION_PHASES)).toEqual(GOLDEN['development-v2'].conversation);
    expect(sorted(DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK)).toEqual(GOLDEN['development-v2'].resetableBeforeLock);
    expect(sorted(DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK)).toEqual(GOLDEN['development-v2'].resetableAfterLock);
  });
});


describe('Layer C — four conversation-over-auto overrides (dev-9, feature-9, dev-v2-12, security-6)', () => {
  it('dev phase 9 is type:auto in the array yet IS in the dev conversation set', () => {
    expect(PIPELINE_PHASES.find((p) => p.number === 9)?.type).toBe('auto');
    expect(conversationPhasesOf('development').has(9)).toBe(true);
  });

  it('feature phase 9 is type:auto in the array yet IS in the feature conversation set (R-1)', () => {
    expect(FEATURE_PIPELINE_PHASES.find((p) => p.number === 9)?.type).toBe('auto');
    expect(conversationPhasesOf('feature').has(9)).toBe(true);
    expect(GOLDEN.feature.conversation).toContain(9);
  });

  it('dev-v2 phase 12 is type:auto in the array yet IS in the dev-v2 conversation set', () => {
    expect(DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 12)?.type).toBe('auto');
    expect(conversationPhasesOf('development-v2').has(12)).toBe(true);
  });

  it('security phase 6 is type:auto in the array yet IS in the security conversation set (SPEC-loop-fix §3 / fix B)', () => {
    expect(SECURITY_PIPELINE_PHASES.find((p) => p.number === 6)?.type).toBe('auto');
    expect(conversationPhasesOf('security').has(6)).toBe(true);
    expect(GOLDEN.security.conversation).toContain(6);
  });

  it('a NAIVE !auto derivation (no overrides) would WRONGLY drop 9/9/12/6 — proves overrides are load-bearing', () => {
    expect(deriveConversation(PIPELINE_PHASES, [])).not.toContain(9);
    expect(deriveConversation(FEATURE_PIPELINE_PHASES, [])).not.toContain(9);
    expect(deriveConversation(DEVELOPMENT_V2_PIPELINE_PHASES, [])).not.toContain(12);
    expect(deriveConversation(SECURITY_PIPELINE_PHASES, [])).not.toContain(6);
  });
});


describe('Layer D — real pipeline.ts derivations equal the golden literals', () => {
  it('development: autoPhasesOf/loopPhasesOf/resetablePhasesOf/conversationPhasesOf', () => {
    expect(sorted(autoPhasesOf('development'))).toEqual(GOLDEN.development.auto);
    expect(sorted(loopPhasesOf('development'))).toEqual(GOLDEN.development.loop);
    expect(sorted(resetablePhasesOf('development'))).toEqual(GOLDEN.development.resetable);
    expect(sorted(conversationPhasesOf('development'))).toEqual(GOLDEN.development.conversation);
  });

  it('security: autoPhasesOf/loopPhasesOf/resetablePhasesOf/conversationPhasesOf', () => {
    expect(sorted(autoPhasesOf('security'))).toEqual(GOLDEN.security.auto);
    expect(sorted(loopPhasesOf('security'))).toEqual(GOLDEN.security.loop);
    expect(sorted(resetablePhasesOf('security'))).toEqual(GOLDEN.security.resetable);
    expect(sorted(conversationPhasesOf('security'))).toEqual(GOLDEN.security.conversation);
  });

  it('feature: autoPhasesOf/loopPhasesOf/resetablePhasesOf/conversationPhasesOf', () => {
    expect(sorted(autoPhasesOf('feature'))).toEqual(GOLDEN.feature.auto);
    expect(sorted(loopPhasesOf('feature'))).toEqual(GOLDEN.feature.loop);
    expect(sorted(resetablePhasesOf('feature'))).toEqual(GOLDEN.feature.resetable);
    expect(sorted(conversationPhasesOf('feature'))).toEqual(GOLDEN.feature.conversation);
  });

  it('architecture-review: autoPhasesOf/loopPhasesOf/resetablePhasesOf/conversationPhasesOf', () => {
    expect(sorted(autoPhasesOf('architecture-review'))).toEqual(GOLDEN['architecture-review'].auto);
    expect(sorted(loopPhasesOf('architecture-review'))).toEqual(GOLDEN['architecture-review'].loop);
    expect(sorted(resetablePhasesOf('architecture-review'))).toEqual(GOLDEN['architecture-review'].resetable);
    expect(sorted(conversationPhasesOf('architecture-review'))).toEqual(GOLDEN['architecture-review'].conversation);
  });

  it('bug: autoPhasesOf/loopPhasesOf/resetablePhasesOf/conversationPhasesOf (TB-1/TB-2)', () => {
    expect(sorted(autoPhasesOf('bug'))).toEqual(GOLDEN.bug.auto);
    expect(sorted(loopPhasesOf('bug'))).toEqual(GOLDEN.bug.loop);
    expect(sorted(resetablePhasesOf('bug'))).toEqual(GOLDEN.bug.resetable);
    expect(sorted(conversationPhasesOf('bug'))).toEqual(GOLDEN.bug.conversation);
    expect(sorted(conversationPhasesOf('bug'))).toEqual([1, 3, 5, 7]);
    expect(sorted(autoPhasesOf('bug'))).toEqual([2, 4, 6]);
    expect(sorted(loopPhasesOf('bug'))).toEqual([8, 9]);
  });

  it('bug tem NENHUM conversation-over-auto override (as fases auto 2/4/6 ficam fora)', () => {
    expect(sorted(conversationPhasesOf('bug'))).toEqual(deriveConversation(BUG_PIPELINE_PHASES, []));
    for (const n of [2, 4, 6]) expect(conversationPhasesOf('bug').has(n)).toBe(false);
  });

  it('development-v2: autoPhasesOf/loopPhasesOf/conversationPhasesOf', () => {
    expect(sorted(autoPhasesOf('development-v2'))).toEqual(GOLDEN['development-v2'].auto);
    expect(sorted(loopPhasesOf('development-v2'))).toEqual(GOLDEN['development-v2'].loop);
    expect(sorted(conversationPhasesOf('development-v2'))).toEqual(GOLDEN['development-v2'].conversation);
  });

  it('development-v2 resetablePhasesOf is lock-aware (INV-9), NOT the .resetable flag', () => {
    expect(sorted(resetablePhasesOf('development-v2', false))).toEqual(
      GOLDEN['development-v2'].resetableBeforeLock,
    );
    expect(sorted(resetablePhasesOf('development-v2', true))).toEqual(
      GOLDEN['development-v2'].resetableAfterLock,
    );
    expect(sorted(resetablePhasesOf('development-v2'))).toEqual(
      GOLDEN['development-v2'].resetableBeforeLock,
    );
    expect(sorted(resetablePhasesOf('development-v2', false))).not.toEqual(
      deriveResetable(DEVELOPMENT_V2_PIPELINE_PHASES),
    );
  });

  it('conversationPhasesOf("feature").has(9) === true (R-1, anti-tautological)', () => {
    expect(conversationPhasesOf('feature').has(9)).toBe(true);
    expect(conversationPhasesOf('development').has(9)).toBe(true);
    expect(conversationPhasesOf('development-v2').has(12)).toBe(true);
    expect(FEATURE_PIPELINE_PHASES.find((p) => p.number === 9)?.type).toBe('auto');
    expect(PIPELINE_PHASES.find((p) => p.number === 9)?.type).toBe('auto');
    expect(DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 12)?.type).toBe('auto');
  });

  it('architecture-review has NO conversation-over-auto override', () => {
    expect(sorted(conversationPhasesOf('architecture-review'))).toEqual(
      deriveConversation(ARCHITECTURE_REVIEW_PIPELINE_PHASES, []),
    );
  });

  it('maxPhaseOf matches the highest number in each canonical array (replaces magic :14)', () => {
    expect(maxPhaseOf('development')).toBe(14);
    expect(maxPhaseOf('security')).toBe(11);
    expect(maxPhaseOf('feature')).toBe(14);
    expect(maxPhaseOf('architecture-review')).toBe(11);
    expect(maxPhaseOf('development-v2')).toBe(17);
    expect(maxPhaseOf('bug')).toBe(9);
    expect(maxPhaseOf(undefined)).toBe(14);
  });

  it('phaseOfAgent resolves loop agents per type (consistent with string-first getPhaseNumberForAgent)', () => {
    expect(phaseOfAgent('development', 'harness-coder')).toBe(13);
    expect(phaseOfAgent('development', 'harness-evaluator')).toBe(14);
    expect(phaseOfAgent('security', 'harness-coder')).toBe(10);
    expect(phaseOfAgent('security', 'harness-evaluator')).toBe(11);
    expect(phaseOfAgent('development-v2', 'harness-coder')).toBe(16);
    expect(phaseOfAgent('development-v2', 'harness-evaluator')).toBe(17);
    expect(phaseOfAgent('bug', 'harness-coder')).toBe(8);
    expect(phaseOfAgent('bug', 'harness-evaluator')).toBe(9);
    expect(phaseOfAgent('feature', 'spec-builder')).toBe(
      getPhaseNumberForAgent('feature', 'spec-builder'),
    );
  });
});


describe('Layer E — cross-type loop helpers (M-3 / RK-19)', () => {
  it('LOOP_HISTORY_BY_TYPE pins the legacy tails (db.ts:getSprintMessagePhaseNumbersForProject)', () => {
    expect(LOOP_HISTORY_BY_TYPE.development).toEqual([]);
    expect(LOOP_HISTORY_BY_TYPE.feature).toEqual([]);
    expect(LOOP_HISTORY_BY_TYPE.security).toEqual([13, 14]);
    expect(LOOP_HISTORY_BY_TYPE['architecture-review']).toEqual([13, 14]);
    expect(LOOP_HISTORY_BY_TYPE['development-v2']).toEqual([13, 14]);
    expect(LOOP_HISTORY_BY_TYPE.bug).toEqual([]);
  });

  it('allLoopPhases() is the FLAT union of canonical loop phases across all types', () => {
    expect(sorted(allLoopPhases())).toEqual([8, 9, 10, 11, 13, 14, 16, 17]);
  });

  it('allLoopPhasesWithHistory() == flat union ∪ history (db.ts deletes 5089/5099 + getPipelineMetrics)', () => {
    expect(sorted(allLoopPhasesWithHistory())).toEqual([8, 9, 10, 11, 13, 14, 16, 17]);
  });

  it('per-type loopPhasesOf ∪ LOOP_HISTORY_BY_TYPE matches getSprintMessagePhaseNumbersForProject tails', () => {
    const tail = (type: string) =>
      sorted(new Set([...loopPhasesOf(type), ...LOOP_HISTORY_BY_TYPE[type as keyof typeof LOOP_HISTORY_BY_TYPE]]));
    expect(tail('development')).toEqual([13, 14]);
    expect(tail('feature')).toEqual([13, 14]);
    expect(tail('security')).toEqual([10, 11, 13, 14]);
    expect(tail('architecture-review')).toEqual([10, 11, 13, 14]);
    expect(tail('development-v2')).toEqual([13, 14, 16, 17]);
    expect(tail('bug')).toEqual([8, 9]);
  });

  it('loopPhasesByRoleWithHistoryOf: goldens PER-TYPE dos 6 tipos (RK-19 / D24-bis (a).1+3)', () => {
    const byRole = (t: string) => ({
      coder: sorted(loopPhasesByRoleWithHistoryOf(t, 'coder')),
      evaluator: sorted(loopPhasesByRoleWithHistoryOf(t, 'evaluator')),
    });
    expect(byRole('development')).toEqual({ coder: [13], evaluator: [14] });
    expect(byRole('feature')).toEqual({ coder: [13], evaluator: [14] });
    expect(byRole('security')).toEqual({ coder: [10, 13], evaluator: [11, 14] });
    expect(byRole('architecture-review')).toEqual({ coder: [10, 13], evaluator: [11, 14] });
    expect(byRole('development-v2')).toEqual({ coder: [13, 16], evaluator: [14, 17] });
    expect(byRole('bug')).toEqual({ coder: [8], evaluator: [9] });
  });

  it('coder and evaluator role Sets are DISJOINT POR TIPO — os papeis nunca se misturam (RK-19)', () => {
    for (const type of [
      'development',
      'feature',
      'security',
      'architecture-review',
      'development-v2',
      'bug',
    ]) {
      const coder = loopPhasesByRoleWithHistoryOf(type, 'coder');
      const evaluator = loopPhasesByRoleWithHistoryOf(type, 'evaluator');
      for (const n of coder) expect(evaluator.has(n)).toBe(false);
      expect(sorted(new Set([...coder, ...evaluator]))).toEqual(
        sorted(
          new Set([
            ...loopPhasesOf(type),
            ...LOOP_HISTORY_BY_TYPE[type as keyof typeof LOOP_HISTORY_BY_TYPE],
          ]),
        ),
      );
    }
  });
});


describe('Layer F — engine dispatch wrappers (registry) equal the golden', () => {
  const p = (pipelineType: string) => ({ pipelineType });

  it('getAutoPhases delegates per type == golden auto Sets', () => {
    expect(sorted(getAutoPhases(p('development')))).toEqual(GOLDEN.development.auto);
    expect(sorted(getAutoPhases(p('security')))).toEqual(GOLDEN.security.auto);
    expect(sorted(getAutoPhases(p('feature')))).toEqual(GOLDEN.feature.auto);
    expect(sorted(getAutoPhases(p('architecture-review')))).toEqual(GOLDEN['architecture-review'].auto);
    expect(sorted(getAutoPhases(p('development-v2')))).toEqual(GOLDEN['development-v2'].auto);
    expect(sorted(getAutoPhases(p('bug')))).toEqual(GOLDEN.bug.auto);
    expect(sorted(getAutoPhases({}))).toEqual(GOLDEN.development.auto);
    expect(sorted(getAutoPhases(p('nonsense')))).toEqual(GOLDEN.development.auto);
  });

  it('getLoopPhases delegates per type == golden loop Sets', () => {
    expect(sorted(getLoopPhases(p('development')))).toEqual(GOLDEN.development.loop);
    expect(sorted(getLoopPhases(p('security')))).toEqual(GOLDEN.security.loop);
    expect(sorted(getLoopPhases(p('feature')))).toEqual(GOLDEN.feature.loop);
    expect(sorted(getLoopPhases(p('architecture-review')))).toEqual(GOLDEN['architecture-review'].loop);
    expect(sorted(getLoopPhases(p('development-v2')))).toEqual(GOLDEN['development-v2'].loop);
    expect(sorted(getLoopPhases(p('bug')))).toEqual(GOLDEN.bug.loop);
    expect(sorted(getLoopPhases({}))).toEqual(GOLDEN.development.loop);
  });

  it('getResetablePhases delegates per type == golden resetable Sets (dev-v2 lock-aware)', () => {
    expect(sorted(getResetablePhases(p('development')))).toEqual(GOLDEN.development.resetable);
    expect(sorted(getResetablePhases(p('security')))).toEqual(GOLDEN.security.resetable);
    expect(sorted(getResetablePhases(p('feature')))).toEqual(GOLDEN.feature.resetable);
    expect(sorted(getResetablePhases(p('architecture-review')))).toEqual(GOLDEN['architecture-review'].resetable);
    expect(sorted(getResetablePhases(p('bug')))).toEqual(GOLDEN.bug.resetable);
    expect(
      sorted(getResetablePhases({ pipelineType: 'development-v2' })),
    ).toEqual(GOLDEN['development-v2'].resetableBeforeLock);
    expect(
      sorted(getResetablePhases({ pipelineType: 'development-v2', config: { openDesign: { locked: false } } })),
    ).toEqual(GOLDEN['development-v2'].resetableBeforeLock);
    expect(
      sorted(getResetablePhases({ pipelineType: 'development-v2', config: { openDesign: { locked: true } } })),
    ).toEqual(GOLDEN['development-v2'].resetableAfterLock);
    expect(sorted(getResetablePhases({}))).toEqual(GOLDEN.development.resetable);
  });

  it('getPhaseName dispatches per type (canonical .name, dev-legacy Record for development)', () => {
    expect(getPhaseName(1, p('development'))).toBe('Discovery');
    expect(getPhaseName(9, p('development'))).toBe('Spec Generation');
    expect(getPhaseName(13, p('development'))).toBe('Coder');
    expect(getPhaseName(1, undefined)).toBe('Discovery');
    for (const type of ['security', 'feature', 'architecture-review', 'development-v2', 'bug'] as const) {
      const phases =
        type === 'security'
          ? SECURITY_PIPELINE_PHASES
          : type === 'feature'
            ? FEATURE_PIPELINE_PHASES
            : type === 'architecture-review'
              ? ARCHITECTURE_REVIEW_PIPELINE_PHASES
              : type === 'development-v2'
                ? DEVELOPMENT_V2_PIPELINE_PHASES
                : BUG_PIPELINE_PHASES;
      for (const def of phases) {
        expect(getPhaseName(def.number, p(type))).toBe(def.name);
      }
    }
  });

  it('getPhaseAgentId dispatches per type (canonical .agentId, dev-legacy Record for development)', () => {
    expect(getPhaseAgentId(1, p('development'))).toBe('discovery-agent');
    expect(getPhaseAgentId(13, p('development'))).toBe('harness-coder');
    expect(getPhaseAgentId(14, p('development'))).toBe('harness-evaluator');
    expect(getPhaseAgentId(91, p('development'))).toBe('spec-validator');
    for (const type of ['security', 'feature', 'architecture-review', 'development-v2', 'bug'] as const) {
      const phases =
        type === 'security'
          ? SECURITY_PIPELINE_PHASES
          : type === 'feature'
            ? FEATURE_PIPELINE_PHASES
            : type === 'architecture-review'
              ? ARCHITECTURE_REVIEW_PIPELINE_PHASES
              : type === 'development-v2'
                ? DEVELOPMENT_V2_PIPELINE_PHASES
                : BUG_PIPELINE_PHASES;
      for (const def of phases) {
        expect(getPhaseAgentId(def.number, p(type))).toBe(def.agentId);
      }
    }
    expect(getPhaseAgentId(99, p('development'))).toBeUndefined();
  });

  it('getPhaseAgentId(2, bug) === "bug-analysis-multi" — ROTULO AGREGADO, nao seed agent', () => {
    expect(getPhaseAgentId(2, p('bug'))).toBe('bug-analysis-multi');
    expect(getPhaseAgentId(2, p('security'))).toBe('multi-agent');
    expect(getPhaseAgentId(4, p('bug'))).toBe('spec-builder');
    expect(getPhaseAgentId(6, p('bug'))).toBe('harness-planner');
    expect(getPhaseAgentId(7, p('bug'))).toBe('sprint-validator');
    expect(getPhaseAgentId(8, p('bug'))).toBe('harness-coder');
    expect(getPhaseAgentId(9, p('bug'))).toBe('harness-evaluator');
    expect(getPhaseAgentId(10, p('bug'))).toBeUndefined();
  });

  it('getPhaseArtifactMap dispatches per type == hand-written golden reset entries', () => {
    expect(getPhaseArtifactMap(1, p('development'))).toEqual({
      files: ['discovery-notes.md', 'stories-requisitos.md', 'PRD.md', 'SPEC.md'],
      fromPhase: 1,
      wipeSprints: true,
    });
    expect(getPhaseArtifactMap(9, p('development'))).toEqual({
      files: ['SPEC.md'],
      fromPhase: 9,
      wipeSprints: true,
    });
    expect(getPhaseArtifactMap(12, p('development'))).toEqual({
      files: [],
      fromPhase: 12,
      wipeSprints: false,
    });
    expect(getPhaseArtifactMap(1, p('security'))).toEqual({
      files: ['.lionclaw/manifest.json'],
      fromPhase: 1,
      wipeSprints: true,
    });
    expect(getPhaseArtifactMap(9, p('security'))).toEqual({ files: [], fromPhase: 9, wipeSprints: false });
    expect(getPhaseArtifactMap(1, p('feature'))).toEqual({
      files: ['stories-requisitos.md', 'PRD.md', 'SPEC.md'],
      fromPhase: 1,
      wipeSprints: true,
    });
    expect(getPhaseArtifactMap(1, p('architecture-review'))).toEqual({
      files: ['*'],
      fromPhase: 1,
      wipeSprints: true,
    });
    expect(getPhaseArtifactMap(5, p('architecture-review'))).toEqual({
      files: ['SPEC', 'sprints'],
      fromPhase: 5,
      wipeSprints: true,
    });
    expect(getPhaseArtifactMap(5, p('development-v2'))).toEqual({ files: [], fromPhase: 5, wipeSprints: true });
    expect(getPhaseArtifactMap(6, p('development-v2'))).toEqual({ files: [], fromPhase: 5, wipeSprints: true });
    expect(getPhaseArtifactMap(12, p('development-v2'))).toEqual({ files: [], fromPhase: 12, wipeSprints: true });
    expect(getPhaseArtifactMap(99, p('development'))).toBeUndefined();
  });

  it('getPhaseArtifactMap(bug) == as 6 entradas literais da secao 4.14.1', () => {
    expect(getPhaseArtifactMap(1, p('bug'))).toEqual({
      files: ['*'],
      fromPhase: 1,
      wipeSprints: true,
    });
    expect(getPhaseArtifactMap(2, p('bug'))).toEqual({
      files: [
        'analise-01-root-cause',
        'analise-02-historian',
        'analise-03-refuter',
        'plano-de-correcao',
        'SPEC',
        'sprints',
      ],
      fromPhase: 2,
      wipeSprints: true,
    });
    expect(getPhaseArtifactMap(3, p('bug'))).toEqual({
      files: ['plano-de-correcao', 'SPEC', 'sprints'],
      fromPhase: 3,
      wipeSprints: true,
    });
    expect(getPhaseArtifactMap(4, p('bug'))).toEqual({
      files: ['SPEC', 'sprints'],
      fromPhase: 4,
      wipeSprints: true,
    });
    expect(getPhaseArtifactMap(6, p('bug'))).toEqual({
      files: ['sprints'],
      fromPhase: 6,
      wipeSprints: true,
    });
    expect(getPhaseArtifactMap(7, p('bug'))).toEqual({
      files: [],
      fromPhase: 7,
      wipeSprints: false,
    });
    for (const n of [5, 8, 9]) {
      expect(getPhaseArtifactMap(n, p('bug'))).toBeUndefined();
    }
    const mappedPhases = ALL_BUG_PHASES.filter((n) => getPhaseArtifactMap(n, p('bug')) !== undefined);
    expect(mappedPhases).toEqual(GOLDEN.bug.resetable);
  });
});

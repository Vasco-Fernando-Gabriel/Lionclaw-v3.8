
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  generateBugRunId,
  getBugContext,
  ensureBugContext,
  patchBugManifest,
  readBugManifest,
  resolveBugPhaseDocument,
  BUG_PHASE2_SECTIONS,
} from '../bug-paths';


let tmpRoot: string;

const RUN_ID = '20260101_120000-abcdef';

const ALL_PHASES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

function makeProject(
  overrides: Partial<{ id: string; runId?: string; outcome?: 'pending' | 'fix' | 'no-bug' }> = {},
) {
  return {
    id: overrides.id ?? 'project-test-bug-1',
    projectPath: tmpRoot,
    config: {
      maxRoundsPerSprint: 3,
      usePlaywright: false,
      evaluatorAgentId: 'harness-evaluator',
      plannerAgentId: 'harness-planner',
      stack: [],
      bug: overrides.runId
        ? { runId: overrides.runId, outcome: overrides.outcome }
        : undefined,
    },
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-paths-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
  }
});


describe('generateBugRunId', () => {
  it('matches format YYYYMMDD_HHmmss-<hex6>', () => {
    expect(generateBugRunId()).toMatch(/^\d{8}_\d{6}-[0-9a-f]{6}$/);
  });

  it('returns unique values across sequential calls (random hex suffix)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(generateBugRunId());
    expect(ids.size).toBe(50);
  });
});

describe('getBugContext', () => {
  it('returns null when project.config.bug.runId is absent', () => {
    expect(getBugContext(makeProject())).toBeNull();
  });

  it('returns the context with the 10 fields when runId is present', () => {
    const ctx = getBugContext(makeProject({ runId: RUN_ID }));
    expect(ctx).not.toBeNull();
    expect(ctx!.runId).toBe(RUN_ID);
    expect(ctx!.runDir).toContain(`.lionclaw/pipelines/bug/${RUN_ID}`);
    expect(ctx!.manifestPath).toBe(path.join(ctx!.runDir, 'manifest.json'));
    expect(ctx!.diagnosticoPath).toBe(path.join(ctx!.runDir, `diagnostico-${RUN_ID}.md`));
    expect(ctx!.analise01Path).toBe(path.join(ctx!.runDir, `analise-01-root-cause-${RUN_ID}.md`));
    expect(ctx!.analise02Path).toBe(path.join(ctx!.runDir, `analise-02-historian-${RUN_ID}.md`));
    expect(ctx!.analise03Path).toBe(path.join(ctx!.runDir, `analise-03-refuter-${RUN_ID}.md`));
    expect(ctx!.planoPath).toBe(path.join(ctx!.runDir, `plano-de-correcao-${RUN_ID}.md`));
    expect(ctx!.specPath).toBe(path.join(ctx!.runDir, `SPEC-${RUN_ID}.md`));
    expect(ctx!.sprintsPath).toBe(path.join(ctx!.runDir, `sprints-${RUN_ID}.json`));
  });

  it('has NO specValidationPath field (removido na rodada 3 — nao havia produtor)', () => {
    const ctx = getBugContext(makeProject({ runId: RUN_ID }));
    expect(Object.keys(ctx!).sort()).toEqual([
      'analise01Path',
      'analise02Path',
      'analise03Path',
      'diagnosticoPath',
      'manifestPath',
      'planoPath',
      'runDir',
      'runId',
      'specPath',
      'sprintsPath',
    ]);
  });

  it('does NOT create files on disk (read-only)', () => {
    getBugContext(makeProject({ runId: RUN_ID }));
    expect(fs.existsSync(path.join(tmpRoot, '.lionclaw'))).toBe(false);
  });
});

describe('ensureBugContext', () => {
  it('creates runDir + manifest when none exist; runIdGenerated=true', () => {
    const project = makeProject();
    const result = ensureBugContext(project);
    expect(result.runIdGenerated).toBe(true);
    expect(result.context.runId).toMatch(/^\d{8}_\d{6}-[0-9a-f]{6}$/);
    expect(fs.existsSync(result.context.runDir)).toBe(true);
    expect(fs.existsSync(result.context.manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(result.context.manifestPath, 'utf-8'));
    expect(manifest.pipelineType).toBe('bug');
    expect(manifest.runId).toBe(result.context.runId);
    expect(manifest.projectId).toBe('project-test-bug-1');
    expect(manifest.outcome).toBe('pending');
    expect(manifest.graphAvailable).toBe(false);
    expect(manifest.documents.diagnosticoMd).toBe(result.context.diagnosticoPath);
    expect(manifest.documents.analise01Md).toBe(result.context.analise01Path);
    expect(manifest.documents.analise02Md).toBe(result.context.analise02Path);
    expect(manifest.documents.analise03Md).toBe(result.context.analise03Path);
    expect(manifest.documents.planoMd).toBe(result.context.planoPath);
    expect(manifest.documents.specMd).toBe(result.context.specPath);
    expect(manifest.documents.sprintsJson).toBe(result.context.sprintsPath);
  });

  it('is idempotent on re-call with the same runId (no new runId, no manifest overwrite)', () => {
    const result1 = ensureBugContext(makeProject());
    const createdAt1 = JSON.parse(
      fs.readFileSync(result1.context.manifestPath, 'utf-8'),
    ).createdAt as string;

    const result2 = ensureBugContext(makeProject({ runId: result1.context.runId }));
    expect(result2.runIdGenerated).toBe(false);
    expect(result2.context.runId).toBe(result1.context.runId);
    const createdAt2 = JSON.parse(
      fs.readFileSync(result2.context.manifestPath, 'utf-8'),
    ).createdAt as string;
    expect(createdAt2).toBe(createdAt1);
  });
});

describe('patchBugManifest', () => {
  it('deep-merges the patch preserving untouched fields and bumps updatedAt', async () => {
    const { context } = ensureBugContext(makeProject());
    const projectWithRunId = makeProject({ runId: context.runId });

    const before = readBugManifest(projectWithRunId)!;
    expect(before.outcome).toBe('pending');

    await new Promise((resolve) => setTimeout(resolve, 5));

    const patched = patchBugManifest(projectWithRunId, {
      outcome: 'no-bug',
      graphAvailable: false,
      graphUnavailableReason: 'usuario recusou indexar o repo',
    });
    expect(patched).not.toBeNull();
    expect(patched!.outcome).toBe('no-bug');
    expect(patched!.graphUnavailableReason).toBe('usuario recusou indexar o repo');
    expect(patched!.updatedAt).not.toBe(before.updatedAt);
    expect(patched!.runId).toBe(context.runId);
    expect(patched!.projectId).toBe(before.projectId);
    expect(patched!.createdAt).toBe(before.createdAt);
    expect(patched!.documents).toEqual(before.documents);
  });

  it('returns null when no context exists for the project', () => {
    expect(patchBugManifest(makeProject(), { outcome: 'fix' })).toBeNull();
  });
});


describe('resolveBugPhaseDocument — valores esperados FASE A FASE (secao 4.9.1)', () => {
  it('fase 1 -> diagnosticoPath', () => {
    const project = makeProject({ runId: RUN_ID });
    const ctx = getBugContext(project)!;
    expect(resolveBugPhaseDocument(project, 1)).toBe(ctx.diagnosticoPath);
  });

  it('fase 2 -> [analise01, analise02, analise03] NESSA ORDEM', () => {
    const project = makeProject({ runId: RUN_ID });
    const ctx = getBugContext(project)!;
    expect(resolveBugPhaseDocument(project, 2)).toEqual([
      ctx.analise01Path,
      ctx.analise02Path,
      ctx.analise03Path,
    ]);
  });

  it('fase 3 -> planoPath', () => {
    const project = makeProject({ runId: RUN_ID });
    const ctx = getBugContext(project)!;
    expect(resolveBugPhaseDocument(project, 3)).toBe(ctx.planoPath);
  });

  it('fases 4, 5, 6, 7, 8 e 9 -> a MESMA specPath (divergencia deliberada do molde)', () => {
    const project = makeProject({ runId: RUN_ID });
    const ctx = getBugContext(project)!;
    for (const phase of [4, 5, 6, 7, 8, 9]) {
      expect(resolveBugPhaseDocument(project, phase)).toBe(ctx.specPath);
    }
    expect(resolveBugPhaseDocument(project, 6)).not.toBe(ctx.sprintsPath);
    expect(resolveBugPhaseDocument(project, 8)).not.toBeNull();
    expect(resolveBugPhaseDocument(project, 9)).not.toBeNull();
  });

  it('getBugContext === null -> devolve null nas 9 fases', () => {
    const project = makeProject(); // sem runId
    expect(getBugContext(project)).toBeNull();
    for (const phase of ALL_PHASES) {
      expect(resolveBugPhaseDocument(project, phase)).toBeNull();
    }
  });

  it('fase fora do intervalo (0, 10) -> null mesmo com contexto valido', () => {
    const project = makeProject({ runId: RUN_ID });
    expect(resolveBugPhaseDocument(project, 0)).toBeNull();
    expect(resolveBugPhaseDocument(project, 10)).toBeNull();
  });
});

describe('BUG_PHASE2_SECTIONS', () => {
  it('tem exatamente 3 entradas, na ordem root-cause -> historian -> refuter', () => {
    expect(BUG_PHASE2_SECTIONS).toHaveLength(3);
    expect(BUG_PHASE2_SECTIONS.map((s) => s.key)).toEqual([
      'analise01Path',
      'analise02Path',
      'analise03Path',
    ]);
    expect(BUG_PHASE2_SECTIONS[0].heading).toBe('## Analise 1 - Causa raiz (bug-root-cause-analyst)');
    expect(BUG_PHASE2_SECTIONS[1].heading).toBe('## Analise 2 - Historico e contexto (bug-context-historian)');
    expect(BUG_PHASE2_SECTIONS[2].heading).toBe('## Analise 3 - Refutacao adversarial (bug-hypothesis-refuter)');
  });

  it('a ordem das secoes casa com a ordem do array devolvido pela fase 2', () => {
    const project = makeProject({ runId: RUN_ID });
    const ctx = getBugContext(project)!;
    const phase2 = resolveBugPhaseDocument(project, 2) as string[];
    expect(BUG_PHASE2_SECTIONS.map((s) => ctx[s.key])).toEqual(phase2);
  });
});

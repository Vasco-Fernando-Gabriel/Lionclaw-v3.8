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
  generateArchitectureReviewRunId,
  getArchitectureReviewContext,
  ensureArchitectureReviewContext,
  patchArchitectureReviewManifest,
  resolveArchitecturePhaseDocument,
  readArchitectureReviewManifest,
} from '../architecture-review-paths';

let tmpRoot: string;

function makeProject(overrides: Partial<{ id: string; runId?: string; selectedCandidateId?: string | null }> = {}) {
  return {
    id: overrides.id ?? 'project-test-1',
    projectPath: tmpRoot,
    config: {
      maxRoundsPerSprint: 3,
      usePlaywright: false,
      evaluatorAgentId: 'harness-evaluator',
      plannerAgentId: 'harness-planner',
      stack: [],
      architectureReview: overrides.runId
        ? {
            runId: overrides.runId,
            selectedCandidateId: overrides.selectedCandidateId ?? null,
          }
        : undefined,
    },
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-review-paths-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe('generateArchitectureReviewRunId', () => {
  it('matches format YYYYMMDD_HHmmss-<hex6>', () => {
    const id = generateArchitectureReviewRunId();
    expect(id).toMatch(/^\d{8}_\d{6}-[0-9a-f]{6}$/);
  });

  it('returns unique values across sequential calls (random hex suffix)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(generateArchitectureReviewRunId());
    expect(ids.size).toBe(50);
  });
});

describe('getArchitectureReviewContext', () => {
  it('returns null when project.config.architectureReview.runId is absent', () => {
    const project = makeProject();
    expect(getArchitectureReviewContext(project)).toBeNull();
  });

  it('returns context with all 14 fields when runId is present', () => {
    const project = makeProject({ runId: '20260101_120000-abcdef' });
    const ctx = getArchitectureReviewContext(project);
    expect(ctx).not.toBeNull();
    expect(ctx!.runId).toBe('20260101_120000-abcdef');
    expect(ctx!.runDir).toContain('.lionclaw/pipelines/architecture-review/20260101_120000-abcdef');
    expect(ctx!.mapMdPath).toContain('ArchitectureMap-20260101_120000-abcdef.md');
    expect(ctx!.mapJsonPath).toContain('ArchitectureMap-20260101_120000-abcdef.json');
    expect(ctx!.candidatesMdPath).toContain('ArchitectureCandidates-20260101_120000-abcdef.md');
    expect(ctx!.diagnosisMdPath).toContain('ArchitectureDiagnosis-20260101_120000-abcdef.md');
    expect(ctx!.decisionsMdPath).toContain('ArchitectureDecisions-20260101_120000-abcdef.md');
    expect(ctx!.specPath).toContain('SPEC-20260101_120000-abcdef.md');
    expect(ctx!.sprintsPath).toContain('sprints-20260101_120000-abcdef.json');
  });

  it('does NOT create files on disk (read-only)', () => {
    const project = makeProject({ runId: '20260101_120000-abcdef' });
    getArchitectureReviewContext(project);
    expect(fs.existsSync(path.join(tmpRoot, '.lionclaw'))).toBe(false);
  });
});

describe('ensureArchitectureReviewContext', () => {
  it('creates runDir + manifest when none exist; runIdGenerated=true', () => {
    const project = makeProject();
    const result = ensureArchitectureReviewContext(project);
    expect(result.runIdGenerated).toBe(true);
    expect(fs.existsSync(result.context.runDir)).toBe(true);
    expect(fs.existsSync(result.context.manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(result.context.manifestPath, 'utf-8'));
    expect(manifest.pipelineType).toBe('architecture-review');
    expect(manifest.runId).toBe(result.context.runId);
    expect(manifest.projectId).toBe('project-test-1');
    expect(manifest.selectedCandidateId).toBeNull();
    expect(manifest.documents.mapMd).toBe(result.context.mapMdPath);
  });

  it('is idempotent on re-call with the same project (returns same runId, no manifest overwrite)', () => {
    const project = makeProject();
    const result1 = ensureArchitectureReviewContext(project);
    const manifest1 = readArchitectureReviewManifest({
      ...project,
      config: {
        ...project.config,
        architectureReview: { runId: result1.context.runId },
      },
    });
    expect(manifest1).not.toBeNull();

    const projectWithRunId = makeProject({ runId: result1.context.runId });
    const result2 = ensureArchitectureReviewContext(projectWithRunId);
    expect(result2.runIdGenerated).toBe(false);
    expect(result2.context.runId).toBe(result1.context.runId);
  });
});

describe('patchArchitectureReviewManifest', () => {
  it('deep-merges patch preserving untouched fields and bumps updatedAt', async () => {
    const project = makeProject();
    const { context } = ensureArchitectureReviewContext(project);
    const projectWithRunId = makeProject({ runId: context.runId });

    const before = readArchitectureReviewManifest(projectWithRunId)!;
    const beforeUpdatedAt = before.updatedAt;
    expect(before.selectedCandidateId).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const patched = patchArchitectureReviewManifest(projectWithRunId, {
      selectedCandidateId: 'C1',
    });
    expect(patched).not.toBeNull();
    expect(patched!.selectedCandidateId).toBe('C1');
    expect(patched!.updatedAt).not.toBe(beforeUpdatedAt);
    expect(patched!.runId).toBe(context.runId);
    expect(patched!.projectId).toBe(project.id);
    expect(patched!.documents.mapMd).toBe(before.documents.mapMd);
    expect(patched!.createdAt).toBe(before.createdAt);
  });

  it('returns null when no context exists for the project', () => {
    const project = makeProject();
    expect(patchArchitectureReviewManifest(project, { selectedCandidateId: 'C2' })).toBeNull();
  });
});

describe('resolveArchitecturePhaseDocument', () => {
  it('returns null for any phase when no context exists', () => {
    const project = makeProject();
    expect(resolveArchitecturePhaseDocument(project, 1)).toBeNull();
  });

  it('returns correct path per phase 1-8', () => {
    const project = makeProject({ runId: '20260101_120000-abcdef' });
    expect(resolveArchitecturePhaseDocument(project, 1)).toContain('ArchitectureMap-');
    expect(resolveArchitecturePhaseDocument(project, 2)).toContain('ArchitectureCandidates-');
    expect(resolveArchitecturePhaseDocument(project, 3)).toContain('ArchitectureDiagnosis-');
    expect(resolveArchitecturePhaseDocument(project, 4)).toContain('ArchitectureDecisions-');
    expect(resolveArchitecturePhaseDocument(project, 5)).toContain('SPEC-');
    expect(resolveArchitecturePhaseDocument(project, 6)).toContain('SPEC-');
    expect(resolveArchitecturePhaseDocument(project, 7)).toContain('SPEC-');
    expect(resolveArchitecturePhaseDocument(project, 8)).toContain('sprints-');
  });

  it('returns null for phases 9, 10, 11 (sprint runtime artefacts live elsewhere)', () => {
    const project = makeProject({ runId: '20260101_120000-abcdef' });
    expect(resolveArchitecturePhaseDocument(project, 9)).toBeNull();
    expect(resolveArchitecturePhaseDocument(project, 10)).toBeNull();
    expect(resolveArchitecturePhaseDocument(project, 11)).toBeNull();
  });
});

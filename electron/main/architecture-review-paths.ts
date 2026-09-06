
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createLogger } from './logger';
import type { HarnessProject } from '../../src/types';
import type { PipelinePhaseNumber } from '../../src/types/pipeline';

const logger = createLogger('architecture-review-paths');


export interface ArchitectureReviewContext {
  runId: string;
  runDir: string;
  manifestPath: string;
  mapMdPath: string;
  mapJsonPath: string;
  candidatesMdPath: string;
  candidatesJsonPath: string;
  diagnosisMdPath: string;
  diagnosisJsonPath: string;
  decisionsMdPath: string;
  decisionsJsonPath: string;
  specSourcePath: string;
  specPath: string;
  sprintsPath: string;
}

export interface ArchitectureReviewManifest {
  pipelineType: 'architecture-review';
  runId: string;
  projectId: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  selectedCandidateId: string | null;
  documents: {
    mapMd: string;
    mapJson: string;
    candidatesMd: string;
    candidatesJson: string;
    diagnosisMd: string;
    diagnosisJson: string;
    decisionsMd: string;
    decisionsJson: string;
    specSourceMd: string;
    specMd: string;
    sprintsJson: string;
  };
}

type ProjectInfo = Pick<HarnessProject, 'id' | 'projectPath' | 'config'>;


export function generateArchitectureReviewRunId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const hex = crypto.randomBytes(3).toString('hex'); // 6 chars
  return `${ts}-${hex}`;
}


function buildContextFromRunId(projectPath: string, runId: string): ArchitectureReviewContext {
  const root = path.resolve(projectPath);
  const runDir = path.join(root, '.lionclaw', 'pipelines', 'architecture-review', runId);
  const docName = (kind: string, ext: string) =>
    path.join(runDir, `Architecture${kind}-${runId}.${ext}`);
  return {
    runId,
    runDir,
    manifestPath: path.join(runDir, 'manifest.json'),
    mapMdPath: docName('Map', 'md'),
    mapJsonPath: docName('Map', 'json'),
    candidatesMdPath: docName('Candidates', 'md'),
    candidatesJsonPath: docName('Candidates', 'json'),
    diagnosisMdPath: docName('Diagnosis', 'md'),
    diagnosisJsonPath: docName('Diagnosis', 'json'),
    decisionsMdPath: docName('Decisions', 'md'),
    decisionsJsonPath: docName('Decisions', 'json'),
    specSourcePath: path.join(runDir, `ArchitectureSpecSource-${runId}.md`),
    specPath: path.join(runDir, `SPEC-${runId}.md`),
    sprintsPath: path.join(runDir, `sprints-${runId}.json`),
  };
}

export function getArchitectureReviewContext(
  project: ProjectInfo,
): ArchitectureReviewContext | null {
  const runId = project.config?.architectureReview?.runId;
  if (!runId) return null;
  return buildContextFromRunId(project.projectPath, runId);
}

export function ensureArchitectureReviewContext(
  project: ProjectInfo,
): { context: ArchitectureReviewContext; runIdGenerated: boolean } {
  let runId = project.config?.architectureReview?.runId;
  let runIdGenerated = false;
  if (!runId) {
    runId = generateArchitectureReviewRunId();
    runIdGenerated = true;
  }
  const ctx = buildContextFromRunId(project.projectPath, runId);
  fs.mkdirSync(ctx.runDir, { recursive: true });
  if (!fs.existsSync(ctx.manifestPath)) {
    const now = new Date().toISOString();
    const manifest: ArchitectureReviewManifest = {
      pipelineType: 'architecture-review',
      runId,
      projectId: project.id,
      projectPath: path.resolve(project.projectPath),
      createdAt: now,
      updatedAt: now,
      selectedCandidateId:
        project.config?.architectureReview?.selectedCandidateId ?? null,
      documents: {
        mapMd: ctx.mapMdPath,
        mapJson: ctx.mapJsonPath,
        candidatesMd: ctx.candidatesMdPath,
        candidatesJson: ctx.candidatesJsonPath,
        diagnosisMd: ctx.diagnosisMdPath,
        diagnosisJson: ctx.diagnosisJsonPath,
        decisionsMd: ctx.decisionsMdPath,
        decisionsJson: ctx.decisionsJsonPath,
        specSourceMd: ctx.specSourcePath,
        specMd: ctx.specPath,
        sprintsJson: ctx.sprintsPath,
      },
    };
    fs.writeFileSync(ctx.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    logger.info(
      { projectId: project.id, runId, runDir: ctx.runDir },
      'Created architecture-review run dir + manifest',
    );
  }
  return { context: ctx, runIdGenerated };
}


export function readArchitectureReviewManifest(
  project: ProjectInfo,
): ArchitectureReviewManifest | null {
  const ctx = getArchitectureReviewContext(project);
  if (!ctx || !fs.existsSync(ctx.manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(ctx.manifestPath, 'utf-8')) as ArchitectureReviewManifest;
  } catch (err) {
    logger.error(
      { err, projectId: project.id, manifestPath: ctx.manifestPath },
      'Failed to parse architecture-review manifest',
    );
    return null;
  }
}

export function patchArchitectureReviewManifest(
  project: ProjectInfo,
  patch: Partial<Omit<ArchitectureReviewManifest, 'documents'>> & {
    documents?: Partial<ArchitectureReviewManifest['documents']>;
  },
): ArchitectureReviewManifest | null {
  const ctx = getArchitectureReviewContext(project);
  if (!ctx) {
    logger.warn(
      { projectId: project.id },
      'patchArchitectureReviewManifest called without an existing context',
    );
    return null;
  }
  const current = readArchitectureReviewManifest(project);
  if (!current) {
    logger.warn(
      { projectId: project.id, manifestPath: ctx.manifestPath },
      'patchArchitectureReviewManifest called but manifest does not exist',
    );
    return null;
  }
  const merged: ArchitectureReviewManifest = {
    ...current,
    ...patch,
    documents: {
      ...current.documents,
      ...(patch.documents ?? {}),
    },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(ctx.manifestPath, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}


export function resolveArchitecturePhaseDocument(
  project: ProjectInfo,
  phase: PipelinePhaseNumber,
): string | null {
  const ctx = getArchitectureReviewContext(project);
  if (!ctx) return null;
  switch (phase) {
    case 1: return ctx.mapMdPath;
    case 2: return ctx.candidatesMdPath;
    case 3: return ctx.diagnosisMdPath;
    case 4: return ctx.decisionsMdPath;
    case 5: return ctx.specPath;
    case 6: return ctx.specPath;
    case 7: return ctx.specPath;
    case 8: return ctx.sprintsPath;
    default: return null; // 9, 10, 11
  }
}

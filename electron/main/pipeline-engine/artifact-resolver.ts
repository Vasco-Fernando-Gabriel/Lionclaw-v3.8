import * as path from 'path';
import type { PhaseArtifactMapEntry } from './registry';

export interface ArchReviewContextLike {
  runDir: string;
  candidatesMdPath: string;
  candidatesJsonPath: string;
  diagnosisMdPath: string;
  diagnosisJsonPath: string;
  decisionsMdPath: string;
  decisionsJsonPath: string;
  specPath: string;
  specSourcePath: string;
  sprintsPath: string;
}

export interface BugContextLike {
  runDir: string;
  analise01Path: string;
  analise02Path: string;
  analise03Path: string;
  planoPath: string;
  specPath: string;
  sprintsPath: string;
}

export interface ResetProjectLike {
  projectPath: string;
  pipelineType?: string;
}

export function resolveArchitectureStemPaths(ctx: ArchReviewContextLike): Record<string, string[]> {
  return {
    ArchitectureCandidates: [ctx.candidatesMdPath, ctx.candidatesJsonPath],
    ArchitectureDiagnosis: [ctx.diagnosisMdPath, ctx.diagnosisJsonPath],
    ArchitectureDecisions: [ctx.decisionsMdPath, ctx.decisionsJsonPath],
    SPEC: [ctx.specPath, ctx.specSourcePath],
    sprints: [ctx.sprintsPath],
  };
}

export function resolveBugStemPaths(ctx: BugContextLike): Record<string, string[]> {
  return {
    'analise-01-root-cause': [ctx.analise01Path],
    'analise-02-historian': [ctx.analise02Path],
    'analise-03-refuter': [ctx.analise03Path],
    'plano-de-correcao': [ctx.planoPath],
    SPEC: [ctx.specPath],
    sprints: [ctx.sprintsPath],
  };
}

function asBugContext(ctx: ArchReviewContextLike | BugContextLike | null): BugContextLike | null {
  return ctx && 'analise01Path' in ctx ? ctx : null;
}

function asArchContext(ctx: ArchReviewContextLike | BugContextLike | null): ArchReviewContextLike | null {
  return ctx && 'candidatesMdPath' in ctx ? ctx : null;
}

export function resolveExecutorFiles(
  project: ResetProjectLike,
  mapping: PhaseArtifactMapEntry,
  typeCtx: ArchReviewContextLike | BugContextLike | null,
): string[] {
  if (project.pipelineType === 'architecture-review') {
    const archCtx = asArchContext(typeCtx);
    if (!archCtx) return [];
    if (mapping.files.includes('*')) {
      return [archCtx.runDir];
    }
    const stemToPaths = resolveArchitectureStemPaths(archCtx);
    const out: string[] = [];
    for (const stem of mapping.files) {
      for (const p of stemToPaths[stem] ?? []) {
        out.push(p);
      }
    }
    return out;
  }
  if (project.pipelineType === 'bug') {
    const bugCtx = asBugContext(typeCtx);
    if (!bugCtx) return [];
    if (mapping.files.includes('*')) {
      return [bugCtx.runDir];
    }
    const stemToPaths = resolveBugStemPaths(bugCtx);
    const out: string[] = [];
    for (const stem of mapping.files) {
      for (const p of stemToPaths[stem] ?? []) {
        out.push(p);
      }
    }
    return out;
  }
  return mapping.files.map((f) => path.join(project.projectPath, f));
}

export function resolvePreviewFiles(
  project: ResetProjectLike,
  mapping: PhaseArtifactMapEntry,
  typeCtx: ArchReviewContextLike | BugContextLike | null,
): string[] {
  return resolveExecutorFiles(project, mapping, typeCtx);
}

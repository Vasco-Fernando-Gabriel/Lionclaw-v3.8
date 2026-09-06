
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createLogger } from './logger';
import type { HarnessProject } from '../../src/types';
import type { PipelinePhaseNumber } from '../../src/types/pipeline';

const logger = createLogger('bug-paths');


export interface BugContext {
  runId: string;
  runDir: string;
  manifestPath: string;
  diagnosticoPath: string;
  analise01Path: string;
  analise02Path: string;
  analise03Path: string;
  planoPath: string;
  specPath: string;
  sprintsPath: string;
}

export type BugOutcome = 'pending' | 'fix' | 'no-bug';

export interface BugManifest {
  pipelineType: 'bug';
  runId: string;
  projectId: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  outcome: BugOutcome;
  graphAvailable: boolean;
  graphUnavailableReason?: string;
  documents: {
    diagnosticoMd: string;
    analise01Md: string;
    analise02Md: string;
    analise03Md: string;
    planoMd: string;
    specMd: string;
    sprintsJson: string;
  };
}

type ProjectInfo = Pick<HarnessProject, 'id' | 'projectPath' | 'config'>;

export const BUG_PHASE2_SECTIONS = [
  { heading: '## Analise 1 - Causa raiz (bug-root-cause-analyst)',              key: 'analise01Path' },
  { heading: '## Analise 2 - Historico e contexto (bug-context-historian)',     key: 'analise02Path' },
  { heading: '## Analise 3 - Refutacao adversarial (bug-hypothesis-refuter)',   key: 'analise03Path' },
] as const;


export function generateBugRunId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const hex = crypto.randomBytes(3).toString('hex'); // 6 chars
  return `${ts}-${hex}`;
}


function buildContextFromRunId(projectPath: string, runId: string): BugContext {
  const root = path.resolve(projectPath);
  const runDir = path.join(root, '.lionclaw', 'pipelines', 'bug', runId);
  const docName = (stem: string, ext: string) => path.join(runDir, `${stem}-${runId}.${ext}`);
  return {
    runId,
    runDir,
    manifestPath: path.join(runDir, 'manifest.json'),
    diagnosticoPath: docName('diagnostico', 'md'),
    analise01Path: docName('analise-01-root-cause', 'md'),
    analise02Path: docName('analise-02-historian', 'md'),
    analise03Path: docName('analise-03-refuter', 'md'),
    planoPath: docName('plano-de-correcao', 'md'),
    specPath: docName('SPEC', 'md'),
    sprintsPath: docName('sprints', 'json'),
  };
}

export function getBugContext(project: ProjectInfo): BugContext | null {
  const runId = project.config?.bug?.runId;
  if (!runId) return null;
  return buildContextFromRunId(project.projectPath, runId);
}

export function ensureBugContext(
  project: ProjectInfo,
): { context: BugContext; runIdGenerated: boolean } {
  let runId = project.config?.bug?.runId;
  let runIdGenerated = false;
  if (!runId) {
    runId = generateBugRunId();
    runIdGenerated = true;
  }
  const ctx = buildContextFromRunId(project.projectPath, runId);
  fs.mkdirSync(ctx.runDir, { recursive: true });
  if (!fs.existsSync(ctx.manifestPath)) {
    const now = new Date().toISOString();
    const manifest: BugManifest = {
      pipelineType: 'bug',
      runId,
      projectId: project.id,
      projectPath: path.resolve(project.projectPath),
      createdAt: now,
      updatedAt: now,
      outcome: project.config?.bug?.outcome ?? 'pending',
      graphAvailable: false,
      documents: {
        diagnosticoMd: ctx.diagnosticoPath,
        analise01Md: ctx.analise01Path,
        analise02Md: ctx.analise02Path,
        analise03Md: ctx.analise03Path,
        planoMd: ctx.planoPath,
        specMd: ctx.specPath,
        sprintsJson: ctx.sprintsPath,
      },
    };
    fs.writeFileSync(ctx.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    logger.info(
      { projectId: project.id, runId, runDir: ctx.runDir },
      'Created bug run dir + manifest',
    );
  }
  return { context: ctx, runIdGenerated };
}


export function readBugManifest(project: ProjectInfo): BugManifest | null {
  const ctx = getBugContext(project);
  if (!ctx || !fs.existsSync(ctx.manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(ctx.manifestPath, 'utf-8')) as BugManifest;
  } catch (err) {
    logger.error(
      { err, projectId: project.id, manifestPath: ctx.manifestPath },
      'Failed to parse bug manifest',
    );
    return null;
  }
}

export function patchBugManifest(
  project: ProjectInfo,
  patch: Partial<Omit<BugManifest, 'documents'>> & {
    documents?: Partial<BugManifest['documents']>;
  },
): BugManifest | null {
  const ctx = getBugContext(project);
  if (!ctx) {
    logger.warn({ projectId: project.id }, 'patchBugManifest called without an existing context');
    return null;
  }
  const current = readBugManifest(project);
  if (!current) {
    logger.warn(
      { projectId: project.id, manifestPath: ctx.manifestPath },
      'patchBugManifest called but manifest does not exist',
    );
    return null;
  }
  const merged: BugManifest = {
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


export function resolveBugPhaseDocument(
  project: ProjectInfo,
  phase: PipelinePhaseNumber,
): string | string[] | null {
  const ctx = getBugContext(project);
  if (!ctx) return null;
  switch (phase) {
    case 1: return ctx.diagnosticoPath;
    case 2: return [ctx.analise01Path, ctx.analise02Path, ctx.analise03Path];
    case 3: return ctx.planoPath;
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
    case 9: return ctx.specPath;
    default: return null;
  }
}

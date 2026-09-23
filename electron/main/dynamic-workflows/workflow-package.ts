import { mkdirSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sha256Hex } from './workflow-context-bundle';
import { VALIDATOR_SCHEMA, REFUTE_SCHEMA } from './dev-loop-schemas';
import { REFUTE_SCHEMA_FILE } from './dev-loop-ids';

export const VALIDATOR_SCHEMA_FILE = 'validator.schema.json';

const DEV_LOOP_DEFAULT_SCHEMAS: Record<string, unknown> = {
  [VALIDATOR_SCHEMA_FILE]: VALIDATOR_SCHEMA,
  [REFUTE_SCHEMA_FILE]: REFUTE_SCHEMA,
};

export const WORKFLOW_JS_FILE = 'workflow.js';
export const WORKFLOW_MANIFEST_FILE = 'workflow.manifest.json';
export const BUILDER_REPORT_FILE = 'builder-report.md';
export const COST_ESTIMATE_FILE = 'cost-estimate.json';
export const SCHEMAS_SUBDIR = 'schemas';

export interface BuilderPackage {
  workflowJs: string;
  manifest: unknown;
  schemas?: Record<string, unknown>;
  builderReport?: string;
  costEstimate?: unknown;
}

export interface RunBuilderResult {
  workflowJsPath: string;
  manifestPath: string;
  builderReportPath: string | null;
  costEstimatePath: string | null;
  schemaPaths: string[];
  manifestJson: string;
  manifestHash: string;
  builderModel: string;
  costUsd: number;
}

function resolveWithinRunDir(runDir: string, fileName: string): string {
  const canonicalRoot = existsSync(runDir) ? realpathSync(runDir) : resolve(runDir);
  const absoluteTarget = resolve(canonicalRoot, fileName);
  const canonicalTarget = existsSync(absoluteTarget) ? realpathSync(absoluteTarget) : absoluteTarget;
  const rel = relative(canonicalRoot, canonicalTarget);
  const within = canonicalTarget === canonicalRoot || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel));
  if (!within) {
    throw new Error(`artefato do builder fora do run dir (runDir=${canonicalRoot}, alvo=${fileName})`);
  }
  return canonicalTarget;
}

function writeFileWithinRunDir(runDir: string, fileName: string, content: string): string {
  const abs = resolveWithinRunDir(runDir, fileName);
  const parentDir = abs.slice(0, abs.lastIndexOf(sep)) || sep;
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

export function materializeBuilderPackage(
  runDir: string,
  pkg: BuilderPackage,
  builderModel: string,
  costUsd: number,
): RunBuilderResult {
  const workflowJsPath = writeFileWithinRunDir(runDir, WORKFLOW_JS_FILE, pkg.workflowJs);

  const manifestJson = JSON.stringify(pkg.manifest, null, 2);
  const manifestPath = writeFileWithinRunDir(runDir, WORKFLOW_MANIFEST_FILE, manifestJson);

  let builderReportPath: string | null = null;
  if (typeof pkg.builderReport === 'string' && pkg.builderReport.length > 0) {
    builderReportPath = writeFileWithinRunDir(runDir, BUILDER_REPORT_FILE, pkg.builderReport);
  }

  let costEstimatePath: string | null = null;
  if (pkg.costEstimate !== undefined) {
    costEstimatePath = writeFileWithinRunDir(runDir, COST_ESTIMATE_FILE, JSON.stringify(pkg.costEstimate, null, 2));
  }

  const schemaPaths: string[] = [];
  if (pkg.schemas) {
    for (const [fileName, schema] of Object.entries(pkg.schemas)) {
      const rel = join(SCHEMAS_SUBDIR, fileName);
      const abs = writeFileWithinRunDir(runDir, rel, JSON.stringify(schema, null, 2));
      schemaPaths.push(abs);
    }
  }

  for (const [fileName, schema] of Object.entries(DEV_LOOP_DEFAULT_SCHEMAS)) {
    if (pkg.schemas && fileName in pkg.schemas) continue;
    const rel = join(SCHEMAS_SUBDIR, fileName);
    const abs = resolveWithinRunDir(runDir, rel);
    if (existsSync(abs)) {
      schemaPaths.push(abs);
      continue;
    }
    schemaPaths.push(writeFileWithinRunDir(runDir, rel, JSON.stringify(schema, null, 2)));
  }

  return {
    workflowJsPath,
    manifestPath,
    builderReportPath,
    costEstimatePath,
    schemaPaths,
    manifestJson,
    manifestHash: sha256Hex(manifestJson),
    builderModel,
    costUsd,
  };
}

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { createLogger } from '../logger';
import type {
  DynamicWorkflowAgentSummary,
  DynamicWorkflowAutonomyMode,
  DynamicWorkflowDefinition,
  DynamicWorkflowDefinitionCreateInput,
  DynamicWorkflowManifest,
  DynamicWorkflowManifestNode,
  DynamicWorkflowNodeCreateInput,
  DynamicWorkflowRetryPolicy,
  DynamicWorkflowRun,
  DynamicWorkflowRunCreateInput,
  DynamicWorkflowValidationReport,
} from './types';
import { materializeBuilderPackage, type RunBuilderResult } from './workflow-package';
import { validateWorkflowPackage } from './workflow-validator';
import { compileWorkflowJs } from './workflow-js-compiler';
import { validateAuthoredAgentTypes, type AuthoredAgentLookup } from './authored-agent-validation';

const logger = createLogger('dynamic-workflow-create');

export const WORKFLOWS_SUBDIR = join('.lionclaw', 'workflows');

export const DEFAULT_RETRY_POLICY: DynamicWorkflowRetryPolicy = {
  maxAutoRetries: 3,
  backoff: 'exponential-jitter',
  retryOn: ['provider-limit', 'provider-error', 'timeout'],
  blockOn: ['provider-auth'],
  escalateAfterRetries: true,
};

export const CLAUDE_CODE_DEFAULT_MAX_CONCURRENT_AGENTS = 8;
export const CLAUDE_CODE_DEFAULT_MAX_USD = 30;

export interface CreateWorkflowDeps {
  createDefinition: (input: DynamicWorkflowDefinitionCreateInput) => DynamicWorkflowDefinition;
  createRun: (input: DynamicWorkflowRunCreateInput) => DynamicWorkflowRun;
  loadAgentCatalog: () => DynamicWorkflowAgentSummary[];
  getAgent?: AuthoredAgentLookup;
  readTextFile?: (path: string) => string;
  pathExists?: (path: string) => boolean;
  generateRunId?: () => string;
  generateId?: (prefix: string) => string;
  now?: () => string;
}

export type WorkflowCreateOrigin = 'orchestrator' | 'manual';

export interface CreateWorkflowInput {
  projectPath: string;
  workflowPath?: string;
  workflowSource?: string;
  name?: string;
  chatSessionId?: string;
  autonomy?: DynamicWorkflowAutonomyMode;
  origin: WorkflowCreateOrigin;
  pendingStart?: boolean;
}

export interface CreateWorkflowSuccess {
  ok: true;
  runId: string;
  definitionId: string;
  report: DynamicWorkflowValidationReport;
  runDir: string;
}

export interface CreateWorkflowFailure {
  ok: false;
  error: string;
  report?: DynamicWorkflowValidationReport;
}

export type CreateWorkflowResult = CreateWorkflowSuccess | CreateWorkflowFailure;

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultGenerateId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function defaultGenerateRunId(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

function defaultReadTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}

export function runDirFor(projectPath: string, runId: string): string {
  return join(projectPath, WORKFLOWS_SUBDIR, runId);
}

export function manifestNodeToCreateInput(
  node: DynamicWorkflowManifestNode,
  definitionId: string,
  nodeRowId: string,
): DynamicWorkflowNodeCreateInput {
  const extra = node as DynamicWorkflowManifestNode & {
    gateConfig?: Record<string, unknown>;
    checks?: unknown;
    gate?: Record<string, unknown>;
    retryPolicy?: DynamicWorkflowRetryPolicy | Record<string, unknown>;
    riskLevel?: string | null;
    dependencies?: string[];
  };

  let gateConfig: Record<string, unknown> = {};
  if (node.type === 'gate') {
    if (extra.gateConfig && typeof extra.gateConfig === 'object') {
      gateConfig = extra.gateConfig;
    } else if (extra.gate && typeof extra.gate === 'object') {
      gateConfig = extra.gate;
    } else if (extra.checks !== undefined) {
      gateConfig = { checks: extra.checks };
    }
  }

  const retryPolicy: DynamicWorkflowRetryPolicy | Record<string, unknown> =
    extra.retryPolicy && typeof extra.retryPolicy === 'object' ? extra.retryPolicy : DEFAULT_RETRY_POLICY;

  return {
    id: nodeRowId,
    definitionId,
    nodeId: node.id,
    phaseId: node.phaseId,
    type: node.type,
    agentId: node.agentId ?? null,
    label: node.label ?? null,
    access: node.access ?? null,
    readSet: node.readSet ?? [],
    writeSet: node.writeSet ?? [],
    isolation: node.isolation ?? null,
    allowedTools: node.allowedTools ?? [],
    allowedMcp: {
      servers: node.allowedMcpServers ?? [],
      tools: node.allowedMcpTools ?? [],
    },
    timeoutMs: node.timeoutMs ?? null,
    costCeilingUsd: node.costCeilingUsd ?? null,
    dependencies: extra.dependencies ?? [],
    retryPolicy,
    gateConfig,
    riskLevel: extra.riskLevel ?? null,
    schemaRef: node.schemaRef ?? null,
    produces: node.produces ?? [],
    consumes: node.consumes ?? [],
  };
}

function fail(error: string, report?: DynamicWorkflowValidationReport): CreateWorkflowFailure {
  return { ok: false, error, ...(report ? { report } : {}) };
}

export function deriveClaudeCodeManifest(meta: {
  name: string;
  description?: string;
  phases: string[];
}): DynamicWorkflowManifest {
  return {
    version: 1,
    name: meta.name,
    description: meta.description,
    phases: (meta.phases ?? []).map((id, order) => ({ id, name: id, order })),
    nodes: [],
    gates: [],
    parallelism: {
      maxConcurrentAgents: CLAUDE_CODE_DEFAULT_MAX_CONCURRENT_AGENTS,
      parallelWritersAllowed: false,
    },
    estimate: { minUsd: 0, maxUsd: CLAUDE_CODE_DEFAULT_MAX_USD, unknownCostNodes: [] },
  };
}

export async function createWorkflow(
  input: CreateWorkflowInput,
  deps: CreateWorkflowDeps,
): Promise<CreateWorkflowResult> {
  const now = deps.now ?? defaultNow;
  const generateId = deps.generateId ?? defaultGenerateId;
  const generateRunId = deps.generateRunId ?? defaultGenerateRunId;
  const readTextFile = deps.readTextFile ?? defaultReadTextFile;
  const pathExists = deps.pathExists ?? ((p: string) => existsSync(p));

  if (!isAbsolute(input.projectPath)) {
    return fail(`projectPath deve ser absoluto: ${input.projectPath}`);
  }

  let workflowJs: string;
  if (typeof input.workflowSource === 'string' && input.workflowSource.length > 0) {
    workflowJs = input.workflowSource;
  } else if (typeof input.workflowPath === 'string' && input.workflowPath.length > 0) {
    if (!isAbsolute(input.workflowPath)) {
      return fail(`workflowPath deve ser absoluto: ${input.workflowPath}`);
    }
    if (!pathExists(input.workflowPath)) {
      return fail(`workflowPath nao existe: ${input.workflowPath}`);
    }
    try {
      workflowJs = readTextFile(input.workflowPath);
    } catch (err) {
      return fail(`falha ao ler workflowPath: ${(err as Error).message}`);
    }
  } else {
    return fail('workflow.js obrigatorio no modo claude-code: forneca workflowSource ou workflowPath');
  }

  if (deps.getAgent) {
    const authoredVerdict = validateAuthoredAgentTypes(workflowJs, {
      getAgent: deps.getAgent,
    });
    if (!authoredVerdict.ok) {
      return fail(authoredVerdict.error);
    }
  }

  const compiled = compileWorkflowJs(workflowJs);
  if (!compiled.ok) {
    const reasons = compiled.errors.map((e) => e.message).join('; ');
    return fail(`workflow.js (claude-code) nao compila: ${reasons}`);
  }

  const runId = generateRunId();
  const runDir = runDirFor(input.projectPath, runId);

  const manifest = deriveClaudeCodeManifest({
    name: input.name ?? compiled.meta.name,
    description: typeof compiled.meta.description === 'string' ? compiled.meta.description : undefined,
    phases: compiled.meta.phases,
  });

  let pkg: RunBuilderResult;
  try {
    pkg = materializeBuilderPackage(runDir, { workflowJs, manifest }, 'claude-code', 0);
  } catch (err) {
    return fail(`falha ao materializar o pacote claude-code: ${(err as Error).message}`);
  }

  let workflowJsSource: string;
  try {
    workflowJsSource = readTextFile(pkg.workflowJsPath);
  } catch (err) {
    return fail(`falha ao reler workflow.js: ${(err as Error).message}`);
  }
  const report = validateWorkflowPackage(
    {
      workflowJsSource,
      manifest,
      catalogAgentIds: deps.loadAgentCatalog().map((a) => a.id),
      schemaFileNames: pkg.schemaPaths.map((p) => basename(p)),
    },
    now,
  );
  if (!report.ok) {
    const reasons = report.issues.filter((i) => i.severity === 'error').map((i) => i.message);
    const detail = reasons.length > 0 ? `: ${reasons.join('; ')}` : '';
    return fail(`pacote do workflow invalido (secao 15)${detail}`, report);
  }

  const definitionId = generateId('dwfd');
  const inputJson = JSON.stringify({
    name: input.name ?? manifest.name,
    autonomy: input.autonomy ?? 'auto',
    pendingStart: input.pendingStart === true,
  });

  let definition: DynamicWorkflowDefinition;
  let run: DynamicWorkflowRun;
  try {
    definition = deps.createDefinition({
      id: definitionId,
      name: input.name ?? manifest.name,
      sourceType: 'claude-code',
      projectPath: input.projectPath,
      specPath: null,
      specSha256: null,
      workflowJsPath: pkg.workflowJsPath,
      manifestPath: pkg.manifestPath,
      manifestJson: pkg.manifestJson,
      manifestHash: pkg.manifestHash,
      contextBundlePath: null,
      builderModel: null,
      status: 'validated',
    });

    run = deps.createRun({
      id: runId,
      definitionId,
      chatSessionId: input.chatSessionId ?? null,
      status: 'created',
      createdBy: input.origin,
      inputJson,
    });
  } catch (err) {
    return fail(`falha ao persistir definition/run: ${(err as Error).message}`);
  }

  logger.info(
    {
      runId: run.id,
      definitionId: definition.id,
      origin: input.origin,
      chatSessionId: input.chatSessionId ?? null,
      pendingStart: input.pendingStart === true,
    },
    'workflow claude-code criado (definition + run; nodes implicitos em runtime)',
  );

  return {
    ok: true,
    runId: run.id,
    definitionId: definition.id,
    report,
    runDir,
  };
}

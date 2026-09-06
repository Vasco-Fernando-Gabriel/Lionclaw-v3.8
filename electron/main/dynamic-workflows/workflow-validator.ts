
import { compileWorkflowJs } from './workflow-js-compiler';
import type {
  DynamicWorkflowManifest,
  DynamicWorkflowManifestNode,
  DynamicWorkflowValidationIssue,
  DynamicWorkflowValidationReport,
} from './types';
import { sha256Hex } from './workflow-context-bundle';

const VALID_ACCESS = new Set(['read-only', 'workspace-write']);
const VALID_NODE_TYPES = new Set([
  'agent',
  'parallel',
  'gate',
  'artifact',
  'checkpoint',
]);

export interface ValidateWorkflowPackageInput {
  workflowJsSource: string;
  manifest: unknown;
  catalogAgentIds?: string[];
  schemaFileNames?: string[];
}

function issue(
  code: string,
  message: string,
  severity: 'error' | 'warning' = 'error',
  nodeId?: string,
): DynamicWorkflowValidationIssue {
  return { code, message, severity, ...(nodeId ? { nodeId } : {}) };
}

function schemaBasename(ref: string): string {
  const slash = ref.lastIndexOf('/');
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

export function validateWorkflowPackage(
  input: ValidateWorkflowPackageInput,
  now: () => string = () => new Date().toISOString(),
): DynamicWorkflowValidationReport {
  const issues: DynamicWorkflowValidationIssue[] = [];

  const compiled = compileWorkflowJs(input.workflowJsSource);
  if (!compiled.ok) {
    for (const e of compiled.errors) {
      issues.push(issue(e.code, e.message));
    }
  }

  const m = input.manifest as DynamicWorkflowManifest | null;
  if (typeof m !== 'object' || m === null || !Array.isArray(m.nodes)) {
    issues.push(issue('manifest-invalid', 'manifest ausente/invalido (nodes deve ser array)'));
    return finalize(issues, now, input.manifest);
  }

  const schemaSet = new Set((input.schemaFileNames ?? []).map(schemaBasename));
  const catalogSet = input.catalogAgentIds
    ? new Set(input.catalogAgentIds)
    : null;

  for (const node of m.nodes) {
    validateNode(node, { schemaSet, catalogSet, issues });
  }

  const parallelWritersAllowed = m.parallelism
    ? (m.parallelism as { parallelWritersAllowed?: unknown }).parallelWritersAllowed
    : undefined;
  if (parallelWritersAllowed === true) {
    issues.push(
      issue(
        'parallel-writer-forbidden',
        'parallelWritersAllowed=true proibido (15/7.4)',
      ),
    );
  }

  if (!catalogSet) {
    issues.push(
      issue(
        'agent-catalog-absent',
        'catalogo de agentes nao fornecido: existencia de agentId nao verificada (risco 10)',
        'warning',
      ),
    );
  }

  return finalize(issues, now, m);
}

interface NodeValidationCtx {
  schemaSet: Set<string>;
  catalogSet: Set<string> | null;
  issues: DynamicWorkflowValidationIssue[];
}

function validateNode(
  node: DynamicWorkflowManifestNode,
  ctx: NodeValidationCtx,
): void {
  const { issues } = ctx;
  if (!node.id || typeof node.id !== 'string') {
    issues.push(issue('node-id-missing', 'node sem id valido'));
    return;
  }
  if (!VALID_NODE_TYPES.has(node.type)) {
    issues.push(
      issue('node-type-invalid', `node '${node.id}' com type invalido: ${node.type}`, 'error', node.id),
    );
  }
  if (node.access !== undefined && !VALID_ACCESS.has(node.access)) {
    issues.push(
      issue('access-invalid', `node '${node.id}' com access invalido: ${node.access}`, 'error', node.id),
    );
  }
  if (node.type === 'agent') {
    if (!node.agentId || typeof node.agentId !== 'string') {
      issues.push(
        issue('agent-id-missing', `node agent '${node.id}' sem agentId (15)`, 'error', node.id),
      );
    } else if (ctx.catalogSet && !ctx.catalogSet.has(node.agentId)) {
      issues.push(
        issue(
          'agent-missing',
          `agentId '${node.agentId}' do node '${node.id}' nao existe no catalogo (risco 10)`,
          'error',
          node.id,
        ),
      );
    }
  }
  if (node.access === 'workspace-write') {
    if (!Array.isArray(node.writeSet) || node.writeSet.length === 0) {
      issues.push(
        issue('writeset-missing', `node writer '${node.id}' sem writeSet (7.4)`, 'error', node.id),
      );
    }
    if (node.isolation !== 'run-workspace') {
      issues.push(
        issue(
          'isolation-invalid',
          `node writer '${node.id}' deve declarar isolation 'run-workspace' (7.4)`,
          'error',
          node.id,
        ),
      );
    }
    if (node.schemaRef) {
      issues.push(
        issue(
          'writer-schema-forbidden',
          `node writer '${node.id}' (workspace-write) NUNCA pode declarar schemaRef; ` +
            `schema forcado num produtor de codigo trava o run (3.1/D-7)`,
          'error',
          node.id,
        ),
      );
    }
  }
  if (node.schemaRef) {
    const base = schemaBasename(node.schemaRef);
    if (!ctx.schemaSet.has(base)) {
      issues.push(
        issue(
          'schema-missing',
          `schemaRef '${node.schemaRef}' do node '${node.id}' nao existe no pacote (15)`,
          'error',
          node.id,
        ),
      );
    }
  }
}

function finalize(
  issues: DynamicWorkflowValidationIssue[],
  now: () => string,
  manifest: unknown,
): DynamicWorkflowValidationReport {
  const ok = !issues.some((i) => i.severity === 'error');
  let manifestHash: string | undefined;
  if (manifest && typeof manifest === 'object') {
    try {
      manifestHash = sha256Hex(JSON.stringify(manifest));
    } catch {
      manifestHash = undefined;
    }
  }
  return { ok, issues, manifestHash, checkedAt: now() };
}

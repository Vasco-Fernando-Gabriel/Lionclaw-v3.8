import { describe, it, expect } from 'vitest';
import { validateWorkflowPackage, type ValidateWorkflowPackageInput } from '../dynamic-workflows/workflow-validator';
import type { DynamicWorkflowManifest } from '../dynamic-workflows/types';

const VALID_WORKFLOW_JS = `export const meta = {
  name: 'demo',
  description: 'demo claude-code',
  phases: ['scout', 'build'],
};

const plan = await agent({ agentType: 'dynamic-workflow-scout', prompt: 'map' });
const impl = await agent({ agentType: 'dynamic-workflow-coder', prompt: 'do it' });
return { plan, impl };
`;

function graphManifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'demo',
    phases: [
      { id: 'scout', name: 'Scout', order: 0 },
      { id: 'build', name: 'Build', order: 1 },
    ],
    nodes: [
      {
        id: 'scout-node',
        type: 'agent',
        phaseId: 'scout',
        agentId: 'dynamic-workflow-scout',
        access: 'read-only',
        canResume: true,
        produces: ['plan'],
        consumes: [],
      },
      {
        id: 'coder-node',
        type: 'agent',
        phaseId: 'build',
        agentId: 'dynamic-workflow-coder',
        access: 'workspace-write',
        writeSet: ['src/**'],
        isolation: 'run-workspace',
        canResume: true,
        produces: ['code'],
        consumes: ['plan'],
      },
    ],
    parallelism: { maxConcurrentAgents: 3, parallelWritersAllowed: false },
    gates: [],
    estimate: { minUsd: 1, maxUsd: 5, unknownCostNodes: [] },
  };
}

const CATALOG = ['dynamic-workflow-scout', 'dynamic-workflow-coder', 'dynamic-workflow-validator-spec'];

function baseInput(over: Partial<ValidateWorkflowPackageInput> = {}): ValidateWorkflowPackageInput {
  return {
    workflowJsSource: VALID_WORKFLOW_JS,
    manifest: graphManifest(),
    catalogAgentIds: CATALOG,
    schemaFileNames: [],
    ...over,
  };
}

const FIXED_NOW = (): string => '2026-06-12T00:00:00.000Z';

describe('workflow-validator: pacote valido', () => {
  it('aprova um pacote coerente (sem erros, checkedAt e manifestHash presentes)', () => {
    const report = validateWorkflowPackage(baseInput(), FIXED_NOW);
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checkedAt).toBe('2026-06-12T00:00:00.000Z');
    expect(report.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('aprova um pacote claude-code com o manifest DERIVADO (nodes/gates/phases vazios)', () => {
    const derived: DynamicWorkflowManifest = {
      version: 1,
      name: 'cc-demo',
      description: 'derivado',
      phases: [],
      nodes: [],
      gates: [],
      parallelism: { maxConcurrentAgents: 8, parallelWritersAllowed: false },
      estimate: { minUsd: 0, maxUsd: 30, unknownCostNodes: [] },
    };
    const report = validateWorkflowPackage(baseInput({ manifest: derived }), FIXED_NOW);
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe('workflow-validator: subset ESM / compiler (secao 15)', () => {
  it('reprova workflow.js com API proibida (process)', () => {
    const bad = VALID_WORKFLOW_JS.replace(
      "const plan = await agent({ agentType: 'dynamic-workflow-scout', prompt: 'map' });",
      'const plan = process.cwd();',
    );
    const report = validateWorkflowPackage(baseInput({ workflowJsSource: bad }), FIXED_NOW);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'forbidden-api')).toBe(true);
  });

  it('reprova meta sem description (gramatica unica claude-code)', () => {
    const bad = VALID_WORKFLOW_JS.replace("  description: 'demo claude-code',\n", '');
    const report = validateWorkflowPackage(baseInput({ workflowJsSource: bad }), FIXED_NOW);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'invalid-meta')).toBe(true);
  });

  it('reprova Date.now() (quebra resume; nao deterministico)', () => {
    const bad = VALID_WORKFLOW_JS.replace('return { plan, impl };', 'const t = Date.now(); return { plan, impl, t };');
    const report = validateWorkflowPackage(baseInput({ workflowJsSource: bad }), FIXED_NOW);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'nondeterministic')).toBe(true);
  });

  it('demonstracao do LEGADO: um .js do modo manifest antigo reprova com erro normal de compile', () => {
    const legacyJs =
      "export const meta = { name: 'demo', phases: ['scout'] };\n" +
      'export default async function run(ctx) { return {}; }\n';
    const report = validateWorkflowPackage(baseInput({ workflowJsSource: legacyJs }), FIXED_NOW);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'invalid-meta')).toBe(true);
  });
});

describe('workflow-validator: manifest derivado (guarda minima)', () => {
  it('reprova manifest que nao e objeto', () => {
    const report = validateWorkflowPackage(baseInput({ manifest: 'nope' }), FIXED_NOW);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'manifest-invalid')).toBe(true);
  });
});

describe('workflow-validator: grafo runtime por node (agentId, access, writer, schema)', () => {
  it('reprova node agent sem agentId', () => {
    const m = graphManifest();
    delete (m.nodes[0] as { agentId?: string }).agentId;
    const report = validateWorkflowPackage(baseInput({ manifest: m }), FIXED_NOW);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'agent-id-missing')).toBe(true);
  });

  it('reprova agentId inexistente no catalogo (risco 10)', () => {
    const m = graphManifest();
    m.nodes[0].agentId = 'agente-fantasma';
    const report = validateWorkflowPackage(baseInput({ manifest: m }), FIXED_NOW);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'agent-missing')).toBe(true);
  });

  it('reprova access invalido', () => {
    const m = graphManifest();
    (m.nodes[0] as unknown as { access: string }).access = 'danger-full-access';
    const report = validateWorkflowPackage(baseInput({ manifest: m }), FIXED_NOW);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'access-invalid')).toBe(true);
  });

  it('reprova node workspace-write sem writeSet', () => {
    const m = graphManifest();
    delete (m.nodes[1] as { writeSet?: string[] }).writeSet;
    const report = validateWorkflowPackage(baseInput({ manifest: m }), FIXED_NOW);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'writeset-missing')).toBe(true);
  });

  it('reprova node workspace-write sem isolation run-workspace', () => {
    const m = graphManifest();
    delete (m.nodes[1] as { isolation?: string }).isolation;
    const report = validateWorkflowPackage(baseInput({ manifest: m }), FIXED_NOW);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'isolation-invalid')).toBe(true);
  });

  it('reprova writer com schemaRef (writer-schema-forbidden, D-7)', () => {
    const m = graphManifest();
    m.nodes[1].schemaRef = 'schemas/impl.schema.json';
    const report = validateWorkflowPackage(
      baseInput({ manifest: m, schemaFileNames: ['impl.schema.json'] }),
      FIXED_NOW,
    );
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'writer-schema-forbidden')).toBe(true);
  });

  it('reprova schemaRef que nao existe no pacote', () => {
    const m = graphManifest();
    m.nodes[0].schemaRef = 'schemas/scout.schema.json';
    const report = validateWorkflowPackage(baseInput({ manifest: m }), FIXED_NOW);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'schema-missing')).toBe(true);
  });

  it('aceita schemaRef quando o schema esta presente (match por basename)', () => {
    const m = graphManifest();
    m.nodes[0].schemaRef = 'schemas/scout.schema.json';
    const report = validateWorkflowPackage(
      baseInput({ manifest: m, schemaFileNames: ['scout.schema.json'] }),
      FIXED_NOW,
    );
    expect(report.issues.some((i) => i.code === 'schema-missing')).toBe(false);
  });
});

describe('workflow-validator: writer paralelo (15)', () => {
  it('reprova parallelWritersAllowed=true (proibido fora do Apendice A)', () => {
    const m = graphManifest();
    (m.parallelism as unknown as { parallelWritersAllowed: boolean }).parallelWritersAllowed = true;
    const report = validateWorkflowPackage(baseInput({ manifest: m }), FIXED_NOW);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'parallel-writer-forbidden')).toBe(true);
  });

  it('NAO reprova por custo: nenhum issue budget-exceeded mesmo com estimate alto', () => {
    const report = validateWorkflowPackage(baseInput(), FIXED_NOW);
    expect(report.issues.some((i) => i.code === 'budget-exceeded')).toBe(false);
  });
});

describe('workflow-validator: catalogo ausente (risco 10)', () => {
  it('sinaliza warning quando catalogo nao foi fornecido (nao reprova sozinho)', () => {
    const report = validateWorkflowPackage(
      { workflowJsSource: VALID_WORKFLOW_JS, manifest: graphManifest() },
      FIXED_NOW,
    );
    expect(report.issues.some((i) => i.code === 'agent-catalog-absent')).toBe(true);
    expect(report.ok).toBe(true);
  });
});

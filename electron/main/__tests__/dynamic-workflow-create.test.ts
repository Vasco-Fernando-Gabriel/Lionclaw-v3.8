
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createWorkflow,
  manifestNodeToCreateInput,
  DEFAULT_RETRY_POLICY,
  type CreateWorkflowDeps,
  type CreateWorkflowInput,
} from '../dynamic-workflows/workflow-create';
import type {
  DynamicWorkflowAgentSummary,
  DynamicWorkflowDefinition,
  DynamicWorkflowDefinitionCreateInput,
  DynamicWorkflowManifest,
  DynamicWorkflowRun,
  DynamicWorkflowRunCreateInput,
} from '../dynamic-workflows/types';

function graphManifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'demo',
    phases: [
      { id: 'scout', name: 'Scout', order: 0 },
      { id: 'gate', name: 'Gate', order: 1 },
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
        id: 'final-gate',
        type: 'gate',
        phaseId: 'gate',
        canResume: false,
        produces: [],
        consumes: ['plan'],
        gateConfig: {
          checks: [{ kind: 'command', id: 'tests', command: 'npm test' }],
        },
      } as DynamicWorkflowManifest['nodes'][number],
    ],
    parallelism: { maxConcurrentAgents: 3, parallelWritersAllowed: false },
    gates: [{ id: 'final-gate', mode: 'orchestrator', blocks: [] }],
    estimate: { minUsd: 1, maxUsd: 5, unknownCostNodes: [] },
  };
}

const CATALOG: DynamicWorkflowAgentSummary[] = [
  { id: 'dynamic-workflow-scout', name: 'Scout', runtime: 'cloud' },
  { id: 'dynamic-workflow-coder', name: 'Coder', runtime: 'cloud' },
];

interface Captured {
  definitions: DynamicWorkflowDefinitionCreateInput[];
  runs: DynamicWorkflowRunCreateInput[];
}

function makeDeps(captured: Captured): CreateWorkflowDeps {
  let seq = 0;
  return {
    loadAgentCatalog: () => CATALOG,
    createDefinition: (input): DynamicWorkflowDefinition => {
      captured.definitions.push(input);
      return { ...stubDefinition(input) };
    },
    createRun: (input): DynamicWorkflowRun => {
      captured.runs.push(input);
      return { ...stubRun(input) };
    },
    generateRunId: () => `run_${(seq += 1)}`,
    generateId: (prefix: string) => `${prefix}_${(seq += 1)}`,
    now: () => '2026-06-12T00:00:00.000Z',
  };
}

function stubDefinition(
  input: DynamicWorkflowDefinitionCreateInput,
): DynamicWorkflowDefinition {
  return {
    id: input.id,
    name: input.name,
    definitionVersion: input.definitionVersion ?? 1,
    authoringModel: 'claude-code',
    parentDefinitionId: input.parentDefinitionId ?? null,
    supersedesDefinitionId: input.supersedesDefinitionId ?? null,
    sourceType: input.sourceType,
    projectPath: input.projectPath,
    specPath: input.specPath ?? null,
    specSha256: input.specSha256 ?? null,
    workflowJsPath: input.workflowJsPath,
    manifestPath: input.manifestPath,
    manifestJson: input.manifestJson,
    manifestHash: input.manifestHash,
    contextBundlePath: input.contextBundlePath ?? null,
    builderModel: input.builderModel ?? null,
    status: input.status,
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
  };
}

function stubRun(input: DynamicWorkflowRunCreateInput): DynamicWorkflowRun {
  return {
    id: input.id,
    definitionId: input.definitionId,
    chatSessionId: input.chatSessionId ?? null,
    status: input.status ?? 'created',
    currentPhaseId: null,
    currentNodeId: null,
    workspaceMode: input.workspaceMode ?? null,
    baseBranch: input.baseBranch ?? null,
    baseCommitSha: input.baseCommitSha ?? null,
    baseWorktreeHash: input.baseWorktreeHash ?? null,
    worktreePath: input.worktreePath ?? null,
    worktreeBranch: input.worktreeBranch ?? null,
    deliveredAt: null,
    finalizedAt: null,
    closerSessionId: null,
    closerStatus: null,
    inputJson: input.inputJson ?? '{}',
    outputJson: null,
    checkpointJson: '{}',
    error: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
    createdBy: input.createdBy,
    startedAt: null,
    updatedAt: '2026-06-12T00:00:00.000Z',
    completedAt: null,
  };
}

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'dwf-create-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const CLAUDE_CODE_WORKFLOW_JS = `export const meta = {
  name: 'cc-demo',
  description: 'Workflow claude-code de teste',
};

const plan = await agent({ agentType: 'dynamic-workflow-scout', prompt: 'mapeie o repo' });
const impl = await agent({ agentType: 'dynamic-workflow-coder', prompt: 'implemente' });
return { plan, impl };
`;

function baseInput(over: Partial<CreateWorkflowInput> = {}): CreateWorkflowInput {
  return {
    projectPath: projectDir,
    workflowSource: CLAUDE_CODE_WORKFLOW_JS,
    origin: 'manual',
    ...over,
  };
}

describe('workflow-create: criacao claude-code (o .js E o workflow)', () => {
  it('cria a partir de um .js valido SEM SPEC e SEM manifesto -> manifesto derivado, nodes:[]', async () => {
    const captured: Captured = { definitions: [], runs: [] };
    const result = await createWorkflow(baseInput(), makeDeps(captured));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(existsSync(join(result.runDir, 'workflow.js'))).toBe(true);
    expect(existsSync(join(result.runDir, 'workflow.manifest.json'))).toBe(true);

    expect(captured.definitions).toHaveLength(1);
    const def = captured.definitions[0]!;
    expect(def.sourceType).toBe('claude-code');
    expect(def.specPath).toBeNull();
    expect(def.specSha256).toBeNull();
    expect(def.status).toBe('validated');

    const manifest = JSON.parse(def.manifestJson) as DynamicWorkflowManifest;
    expect(manifest.name).toBe('cc-demo');
    expect(manifest.description).toBe('Workflow claude-code de teste');
    expect(manifest.nodes).toEqual([]);
    expect(manifest.gates).toEqual([]);
    expect(manifest.phases).toEqual([]); // meta sem phases -> phases vazias
    expect(manifest.parallelism.maxConcurrentAgents).toBe(8);
    expect(manifest.estimate.maxUsd).toBe(30);

    expect(captured.runs).toHaveLength(1);
    expect(captured.runs[0]!.status).toBe('created');

    expect(result.report.ok).toBe(true);
  });

  it('FIX FUNCIONAL: os schemas do dev-loop entram no pacote na criacao', async () => {
    const captured: Captured = { definitions: [], runs: [] };
    const result = await createWorkflow(baseInput(), makeDeps(captured));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(result.runDir, 'schemas', 'validator.schema.json'))).toBe(true);
    expect(existsSync(join(result.runDir, 'schemas', 'refute.schema.json'))).toBe(true);
  });

  it('aceita workflowPath (arquivo em disco) como fonte do .js claude-code', async () => {
    const jsPath = join(projectDir, 'my-workflow.js');
    writeFileSync(jsPath, CLAUDE_CODE_WORKFLOW_JS, 'utf8');
    const captured: Captured = { definitions: [], runs: [] };
    const result = await createWorkflow(
      { projectPath: projectDir, origin: 'manual', workflowPath: jsPath },
      makeDeps(captured),
    );
    expect(result.ok).toBe(true);
    expect(captured.definitions).toHaveLength(1);
  });

  it('deriva phases do meta.phases quando presente (advisory)', async () => {
    const jsWithPhases = `export const meta = {
  name: 'cc-phases',
  description: 'com fases advisory',
  phases: ['scout', 'build'],
};

await agent({ agentType: 'dynamic-workflow-scout', prompt: 'x' });
return 'ok';
`;
    const captured: Captured = { definitions: [], runs: [] };
    const result = await createWorkflow(
      baseInput({ workflowSource: jsWithPhases }),
      makeDeps(captured),
    );
    expect(result.ok).toBe(true);
    const manifest = JSON.parse(
      captured.definitions[0]!.manifestJson,
    ) as DynamicWorkflowManifest;
    expect(manifest.phases.map((p) => p.id)).toEqual(['scout', 'build']);
    expect(manifest.nodes).toEqual([]); // nodes ainda vazios (implicitos)
  });

  it('falha com motivo REAL quando o .js claude-code nao compila', async () => {
    const badJs = `export const meta = {
  name: 'bad',
  description: 'usa API proibida',
};

const home = process.env.HOME;
return home;
`;
    const captured: Captured = { definitions: [], runs: [] };
    const result = await createWorkflow(
      baseInput({ workflowSource: badJs }),
      makeDeps(captured),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/nao compila/);
    expect(result.error).toMatch(/process/);
    expect(captured.definitions).toHaveLength(0);
    expect(captured.runs).toHaveLength(0);
  });

  it('demonstracao do LEGADO: .js do modo manifest antigo falha com erro normal de compile', async () => {
    const legacyJs = `export const meta = {
  name: 'demo',
  phases: ['scout', 'gate'],
};

export default async function run(ctx) {
  await ctx.agent('scout-node');
  return {};
}
`;
    const captured: Captured = { definitions: [], runs: [] };
    const result = await createWorkflow(
      baseInput({ workflowSource: legacyJs }),
      makeDeps(captured),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/nao compila/);
    expect(result.error).toMatch(/description/);
    expect(captured.runs).toHaveLength(0);
  });

  it('falha quando nem workflowSource nem workflowPath foram fornecidos', async () => {
    const captured: Captured = { definitions: [], runs: [] };
    const result = await createWorkflow(
      { projectPath: projectDir, origin: 'manual' },
      makeDeps(captured),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/workflow\.js obrigatorio/);
    expect(captured.runs).toHaveLength(0);
  });
});


describe('workflow-create: D-F4a enforcement no create', () => {
  const AUTHORED_CATALOG: Record<string, { access: string; squad: string }> = {
    'dynamic-workflow-scout': { access: 'read-only', squad: 'dynamic-workflow' },
    'dynamic-workflow-coder': { access: 'workspace-write', squad: 'dynamic-workflow' },
    'dynamic-workflow-doc-writer': { access: 'workspace-write', squad: 'dynamic-workflow' },
    'dynamic-workflow-builder': { access: 'read-only', squad: 'dynamic-workflow' },
    'security-auditor': { access: 'read-only', squad: 'security' },
  };
  function makeDepsWithGetAgent(captured: Captured): CreateWorkflowDeps {
    return { ...makeDeps(captured), getAgent: (id: string) => AUTHORED_CATALOG[id] };
  }

  it('rejeita .js com agentType de squad FORA da allowlist', async () => {
    const jsWrongSquad = `export const meta = {
  name: 'cc-wrong-squad',
  description: 'referencia agente de outra squad',
};

const out = await agent({ agentType: 'security-auditor', prompt: 'audite' });
return out;
`;
    const captured: Captured = { definitions: [], runs: [] };
    const result = await createWorkflow(
      baseInput({ workflowSource: jsWrongSquad }),
      makeDepsWithGetAgent(captured),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/squad "security"/);
    expect(result.error).toMatch(/D-F4a/);
    expect(captured.definitions).toHaveLength(0);
    expect(captured.runs).toHaveLength(0);
  });

  it('DENYLIST: rejeita .js que referencia dynamic-workflow-builder (row orfa inerte)', async () => {
    const jsBuilder = `export const meta = {
  name: 'cc-builder',
  description: 'tenta invocar o builder morto',
};

return await agent({ agentType: 'dynamic-workflow-builder', prompt: 'gere um pacote' });
`;
    const captured: Captured = { definitions: [], runs: [] };
    const result = await createWorkflow(
      baseInput({ workflowSource: jsBuilder }),
      makeDepsWithGetAgent(captured),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/denylist/);
    expect(result.error).toMatch(/dynamic-workflow-builder/);
    expect(captured.runs).toHaveLength(0);
  });

  it('rejeita agentType INEXISTENTE no catalogo e agentType nao-literal', async () => {
    const captured: Captured = { definitions: [], runs: [] };
    const ghost = await createWorkflow(
      baseInput({
        workflowSource:
          "export const meta = { name: 'g', description: 'd' };\nreturn agent({ agentType: 'agente-fantasma', prompt: 'x' });\n",
      }),
      makeDepsWithGetAgent(captured),
    );
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error).toMatch(/nao existe no catalogo/);

    const dynamic = await createWorkflow(
      baseInput({
        workflowSource:
          "export const meta = { name: 'd', description: 'd' };\nconst t = 'x';\nreturn agent({ agentType: t, prompt: 'x' });\n",
      }),
      makeDepsWithGetAgent(captured),
    );
    expect(dynamic.ok).toBe(false);
    if (!dynamic.ok) expect(dynamic.error).toMatch(/nao-literal/);
    expect(captured.runs).toHaveLength(0);
  });

  it('ACEITA writers da squad dynamic-workflow (coder + doc-writer) com getAgent presente', async () => {
    const jsWriters = `export const meta = {
  name: 'cc-writers',
  description: 'dev + documento sob cc-delivery',
};

const impl = await agent({ agentType: 'dynamic-workflow-coder', prompt: 'implemente' });
const doc = await agent({ agentType: 'dynamic-workflow-doc-writer', prompt: 'escreva a spec' });
return { impl, doc };
`;
    const captured: Captured = { definitions: [], runs: [] };
    const result = await createWorkflow(
      baseInput({ workflowSource: jsWriters }),
      makeDepsWithGetAgent(captured),
    );
    expect(result.ok).toBe(true);
    expect(captured.definitions).toHaveLength(1);
    expect(captured.runs).toHaveLength(1);
  });
});

describe('workflow-create: vinculo chat-bound (R4-F1)', () => {
  it('persiste chat_session_id no insert do run quando chatSessionId vem do chat', async () => {
    const captured: Captured = { definitions: [], runs: [] };
    const result = await createWorkflow(
      baseInput({ chatSessionId: 'chat-123', origin: 'orchestrator' }),
      makeDeps(captured),
    );
    expect(result.ok).toBe(true);
    expect(captured.runs[0]!.chatSessionId).toBe('chat-123');
  });

  it('deixa chat_session_id null quando criado pelo menu (sem chatSessionId)', async () => {
    const captured: Captured = { definitions: [], runs: [] };
    const result = await createWorkflow(baseInput(), makeDeps(captured));
    expect(result.ok).toBe(true);
    expect(captured.runs[0]!.chatSessionId ?? null).toBeNull();
  });
});

describe('workflow-create: pendingStart + autonomia (input_json)', () => {
  it('marca pendingStart em input_json quando pedido (start real e da S11)', async () => {
    const captured: Captured = { definitions: [], runs: [] };
    const result = await createWorkflow(
      baseInput({ pendingStart: true }),
      makeDeps(captured),
    );
    expect(result.ok).toBe(true);
    const inputJson = JSON.parse(captured.runs[0]!.inputJson ?? '{}');
    expect(inputJson.pendingStart).toBe(true);
    expect(inputJson.autonomy).toBe('auto');
  });

  it('cai em `auto` quando autonomy ausente (modo unico)', async () => {
    const captured: Captured = { definitions: [], runs: [] };
    const result = await createWorkflow(baseInput(), makeDeps(captured));
    expect(result.ok).toBe(true);
    const inputJson = JSON.parse(captured.runs[0]!.inputJson ?? '{}');
    expect(inputJson.autonomy).toBe('auto');
  });
});

describe('workflow-create: manifestNodeToCreateInput (R3-F2, mapper da materializacao)', () => {
  it('nunca deixa produces/consumes/gate_config orfaos', () => {
    const m = graphManifest();
    const gateInput = manifestNodeToCreateInput(m.nodes[1], 'def1', 'row1');
    expect((gateInput.gateConfig as { checks?: unknown[] }).checks).toBeDefined();
    const agentInput = manifestNodeToCreateInput(m.nodes[0], 'def1', 'row2');
    expect(agentInput.produces).toEqual(['plan']);
    expect(agentInput.retryPolicy).toEqual(DEFAULT_RETRY_POLICY);
  });
});

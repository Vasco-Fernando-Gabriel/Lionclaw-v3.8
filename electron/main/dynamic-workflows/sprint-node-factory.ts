import type {
  DynamicWorkflowManifestNode,
  DynamicWorkflowNodeCreateInput,
  DynamicWorkflowSprintPlan,
  PlannedSprint,
} from './types';
import { manifestNodeToCreateInput } from './workflow-create';
import { VALIDATOR_SCHEMA_FILE } from './workflow-package';
import {
  DEV_DEFAULT_FIXER_AGENT_ID,
  DEV_DEFAULT_VALIDATOR_AGENT_IDS,
  DEV_REFUTER_AGENT_ID,
  REFUTE_SCHEMA_FILE,
  devCoderNodeId,
  devFixNodeId,
  devFixerNodeId,
  devRedevCoderNodeId,
  devRedevFixNodeId,
  devRedevFixerNodeId,
  devRedevRefuterNodeId,
  devRedevTag,
  devRedevValidatorGroupId,
  devRedevValidatorNodeId,
  devRefuterNodeId,
  devSprintId,
  devValidatorGroupId,
  devValidatorNodeId,
} from './dev-loop-ids';

const DEV_WRITE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] as const;
const DEV_READ_TOOLS = ['Read', 'Glob', 'Grep'] as const;
const DEV_COMMANDS = ['npm run typecheck', 'npm run test', 'npm install', 'npm ci'] as const;

const DEV_WRITER_TIMEOUT_MS = 20 * 60 * 1000;

const DEV_VALIDATOR_TIMEOUT_MS = 10 * 60 * 1000;

const DEV_VALIDATOR_SCHEMA_REF = `schemas/${VALIDATOR_SCHEMA_FILE}`;

const DEV_REFUTER_SCHEMA_REF = `schemas/${REFUTE_SCHEMA_FILE}`;

const DEV_PHASE_ID = 'Desenvolvimento';

const ALWAYS_WRITABLE_TEST_GLOBS = [
  'tests/**',
  'test/**',
  '**/tests/**',
  '**/test/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
];

function writerWriteSet(sprint: PlannedSprint): string[] {
  const base = sprint.writeSetHint.length > 0 ? [...sprint.writeSetHint] : ['**'];
  if (base.includes('**')) return base;
  const merged = [...base];
  for (const glob of ALWAYS_WRITABLE_TEST_GLOBS) {
    if (!merged.includes(glob)) merged.push(glob);
  }
  return merged;
}

function coderIdFor(sprintIndex: number, redevRound: number, round: number): string {
  return redevRound > 0 ? devRedevCoderNodeId(sprintIndex, redevRound, round) : devCoderNodeId(sprintIndex, round);
}
function fixIdFor(sprintIndex: number, redevRound: number, round: number): string {
  return redevRound > 0 ? devRedevFixNodeId(sprintIndex, redevRound, round) : devFixNodeId(sprintIndex, round);
}
function fixerIdFor(sprintIndex: number, redevRound: number, round: number): string {
  return redevRound > 0 ? devRedevFixerNodeId(sprintIndex, redevRound, round) : devFixerNodeId(sprintIndex, round);
}
function validatorIdFor(validatorIndex: number, sprintIndex: number, redevRound: number, round: number): string {
  return redevRound > 0
    ? devRedevValidatorNodeId(validatorIndex, sprintIndex, redevRound, round)
    : devValidatorNodeId(validatorIndex, sprintIndex, round);
}
function validatorGroupIdFor(sprintIndex: number, redevRound: number, round: number): string {
  return redevRound > 0
    ? devRedevValidatorGroupId(sprintIndex, redevRound, round)
    : devValidatorGroupId(sprintIndex, round);
}
function refuterIdFor(sprintIndex: number, redevRound: number, round: number): string {
  return redevRound > 0 ? devRedevRefuterNodeId(sprintIndex, redevRound, round) : devRefuterNodeId(sprintIndex, round);
}

function buildCoderNode(sprint: PlannedSprint, round: number, redevRound = 0): DynamicWorkflowManifestNode {
  const tag = devRedevTag(redevRound);
  const id = coderIdFor(sprint.index, redevRound, round);
  return {
    id,
    type: 'agent',
    phaseId: DEV_PHASE_ID,
    agentId: sprint.coderAgentId,
    label: `coder ${devSprintId(sprint.index)}${tag} r${round}`,
    sprintId: devSprintId(sprint.index),
    roundIndex: round,
    access: 'workspace-write',
    readSet: ['**'],
    writeSet: writerWriteSet(sprint),
    isolation: 'run-workspace',
    allowedTools: [...DEV_WRITE_TOOLS],
    allowedCommands: [...DEV_COMMANDS],
    allowBash: true,
    allowNetwork: true,
    timeoutMs: DEV_WRITER_TIMEOUT_MS,
    interruptible: 'before-start',
    canResume: true,
    produces: [`impl-${id}`],
    consumes: ['spec', 'sprint-plan'],
  };
}

function buildFixNode(sprint: PlannedSprint, round: number, redevRound = 0): DynamicWorkflowManifestNode {
  const tag = devRedevTag(redevRound);
  const id = fixIdFor(sprint.index, redevRound, round);
  const coderId = coderIdFor(sprint.index, redevRound, round);
  return {
    id,
    type: 'agent',
    phaseId: DEV_PHASE_ID,
    agentId: sprint.coderAgentId,
    label: `fix ${devSprintId(sprint.index)}${tag} r${round}`,
    sprintId: devSprintId(sprint.index),
    roundIndex: round,
    access: 'workspace-write',
    readSet: ['**'],
    writeSet: writerWriteSet(sprint),
    isolation: 'run-workspace',
    allowedTools: [...DEV_WRITE_TOOLS],
    allowedCommands: [...DEV_COMMANDS],
    allowBash: true,
    allowNetwork: true,
    timeoutMs: DEV_WRITER_TIMEOUT_MS,
    interruptible: 'before-start',
    canResume: true,
    produces: [`fix-${id}`],
    consumes: [`impl-${coderId}`],
  };
}

function buildFixerNode(
  sprint: PlannedSprint,
  round: number,
  fixerAgentId: string,
  redevRound = 0,
): DynamicWorkflowManifestNode {
  const tag = devRedevTag(redevRound);
  const id = fixerIdFor(sprint.index, redevRound, round);
  const coderId = coderIdFor(sprint.index, redevRound, round);
  return {
    id,
    type: 'agent',
    phaseId: DEV_PHASE_ID,
    agentId: fixerAgentId,
    label: `fixer ${devSprintId(sprint.index)}${tag} r${round}`,
    sprintId: devSprintId(sprint.index),
    roundIndex: round,
    access: 'workspace-write',
    readSet: ['**'],
    writeSet: writerWriteSet(sprint),
    isolation: 'run-workspace',
    allowedTools: [...DEV_WRITE_TOOLS],
    allowedCommands: [...DEV_COMMANDS],
    allowBash: true,
    allowNetwork: true,
    timeoutMs: DEV_WRITER_TIMEOUT_MS,
    interruptible: 'before-start',
    canResume: true,
    produces: [`fixer-${id}`],
    consumes: [`impl-${coderId}`],
  };
}

function buildValidatorNode(
  sprint: PlannedSprint,
  round: number,
  validatorIndex: number,
  validatorAgentId: string,
  redevRound = 0,
): DynamicWorkflowManifestNode {
  const tag = devRedevTag(redevRound);
  const id = validatorIdFor(validatorIndex, sprint.index, redevRound, round);
  const coderId = coderIdFor(sprint.index, redevRound, round);
  return {
    id,
    type: 'agent',
    phaseId: DEV_PHASE_ID,
    agentId: validatorAgentId,
    label: `validador ${validatorIndex} ${devSprintId(sprint.index)}${tag} r${round}`,
    sprintId: devSprintId(sprint.index),
    roundIndex: round,
    access: 'read-only',
    readSet: ['**'],
    allowedTools: [...DEV_READ_TOOLS],
    schemaRef: DEV_VALIDATOR_SCHEMA_REF,
    timeoutMs: DEV_VALIDATOR_TIMEOUT_MS,
    interruptible: 'before-start',
    canResume: true,
    produces: [`validator-${id}`],
    consumes: [`impl-${coderId}`],
  };
}

function buildRefuterNode(sprint: PlannedSprint, round: number, redevRound = 0): DynamicWorkflowManifestNode {
  const tag = devRedevTag(redevRound);
  const id = refuterIdFor(sprint.index, redevRound, round);
  const coderId = coderIdFor(sprint.index, redevRound, round);
  return {
    id,
    type: 'agent',
    phaseId: DEV_PHASE_ID,
    agentId: DEV_REFUTER_AGENT_ID,
    label: `refuter ${devSprintId(sprint.index)}${tag} r${round}`,
    sprintId: devSprintId(sprint.index),
    roundIndex: round,
    access: 'read-only',
    readSet: ['**'],
    allowedTools: [...DEV_READ_TOOLS],
    schemaRef: DEV_REFUTER_SCHEMA_REF,
    timeoutMs: DEV_VALIDATOR_TIMEOUT_MS,
    interruptible: 'before-start',
    canResume: true,
    produces: [`refuter-${id}`],
    consumes: [`impl-${coderId}`],
  };
}

function effectiveValidatorAgentIds(sprint: PlannedSprint): string[] {
  return sprint.validatorAgentIds.length > 0 ? [...sprint.validatorAgentIds] : [...DEV_DEFAULT_VALIDATOR_AGENT_IDS];
}

function buildValidatorGroupNode(sprint: PlannedSprint, round: number, redevRound = 0): DynamicWorkflowManifestNode {
  const tag = devRedevTag(redevRound);
  const id = validatorGroupIdFor(sprint.index, redevRound, round);
  const coderId = coderIdFor(sprint.index, redevRound, round);
  return {
    id,
    type: 'parallel',
    phaseId: DEV_PHASE_ID,
    label: `Validadores ${devSprintId(sprint.index)}${tag} r${round}`,
    sprintId: devSprintId(sprint.index),
    roundIndex: round,
    canResume: false,
    produces: [`dev-validators-${devSprintId(sprint.index)}${tag}-r${round}`],
    consumes: [`impl-${coderId}`],
  };
}

export interface BuildSprintNodesResult {
  manifestNodes: DynamicWorkflowManifestNode[];
  createInputs: DynamicWorkflowNodeCreateInput[];
  sprintNodeIds: Array<{ sprintId: string; nodeIds: string[] }>;
}

export function buildDevSprintNodes(
  plan: DynamicWorkflowSprintPlan,
  config: {
    maxDevRounds: number;
    fixerAgentId?: string | null;
  },
  genNodeRowId: (prefix: string) => string,
): BuildSprintNodesResult {
  const maxDevRounds = Math.max(1, Math.floor(config.maxDevRounds));
  const resolvedFixerAgentId =
    config.fixerAgentId === null ? null : (config.fixerAgentId ?? DEV_DEFAULT_FIXER_AGENT_ID);
  const manifestNodes: DynamicWorkflowManifestNode[] = [];
  const createInputs: DynamicWorkflowNodeCreateInput[] = [];
  const sprintNodeIds: Array<{ sprintId: string; nodeIds: string[] }> = [];

  for (const sprint of plan.sprints) {
    const sprintId = devSprintId(sprint.index);
    const executableIds: string[] = [];
    const validatorAgentIds = effectiveValidatorAgentIds(sprint);

    const sprintMaxRounds = Math.max(
      1,
      Math.min(sprint.maxRounds && sprint.maxRounds > 0 ? Math.floor(sprint.maxRounds) : maxDevRounds, maxDevRounds),
    );

    const expandRounds = (redevRound: number, collectExecutable: boolean): void => {
      for (let round = 0; round < sprintMaxRounds; round++) {
        const coder = buildCoderNode(sprint, round, redevRound);
        const group = buildValidatorGroupNode(sprint, round, redevRound);
        const validators = validatorAgentIds.map((validatorAgentId, vi) =>
          buildValidatorNode(sprint, round, vi, validatorAgentId, redevRound),
        );
        const refuter = buildRefuterNode(sprint, round, redevRound);
        const fix = buildFixNode(sprint, round, redevRound);
        const fixer = buildFixerNode(sprint, round, resolvedFixerAgentId ?? sprint.coderAgentId, redevRound);

        manifestNodes.push(coder, group, ...validators, refuter, fix, fixer);

        if (collectExecutable) {
          executableIds.push(coder.id);
          for (const v of validators) executableIds.push(v.id);
          executableIds.push(refuter.id);
          executableIds.push(fix.id);
        }
      }
    };

    expandRounds(0, true);

    for (let redevRound = 1; redevRound <= maxDevRounds; redevRound++) {
      expandRounds(redevRound, false);
    }

    sprintNodeIds.push({ sprintId, nodeIds: executableIds });
  }

  for (const node of manifestNodes) {
    createInputs.push(manifestNodeToCreateInput(node, '', genNodeRowId('dwfn')));
  }

  return { manifestNodes, createInputs, sprintNodeIds };
}

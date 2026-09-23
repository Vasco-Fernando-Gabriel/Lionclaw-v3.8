import { DYNAMIC_WORKFLOW_FIXER_ID } from '../seed-agents/dynamic-workflow-fixer';
import { DYNAMIC_WORKFLOW_VALIDATOR_SPEC_ID } from '../seed-agents/dynamic-workflow-validator-spec';
import { DYNAMIC_WORKFLOW_VALIDATOR_REGRESSION_ID } from '../seed-agents/dynamic-workflow-validator-regression';
import { DYNAMIC_WORKFLOW_VALIDATOR_TESTS_ID } from '../seed-agents/dynamic-workflow-validator-tests';
import { DYNAMIC_WORKFLOW_REFUTER_ID } from '../seed-agents/dynamic-workflow-refuter';

export const DEV_DEFAULT_VALIDATOR_AGENT_IDS: readonly string[] = [
  DYNAMIC_WORKFLOW_VALIDATOR_SPEC_ID,
  DYNAMIC_WORKFLOW_VALIDATOR_REGRESSION_ID,
  DYNAMIC_WORKFLOW_VALIDATOR_TESTS_ID,
] as const;

export const DEV_DEFAULT_FIXER_AGENT_ID = DYNAMIC_WORKFLOW_FIXER_ID;

export const DEV_FRESH_FIXER_STUCK_THRESHOLD = 2;

export const DEV_REFUTER_AGENT_ID = DYNAMIC_WORKFLOW_REFUTER_ID;

export function devSprintId(sprintIndex: number): string {
  return `s${sprintIndex}`;
}

export function devCoderNodeId(sprintIndex: number, round: number): string {
  return `coder-${devSprintId(sprintIndex)}-r${round}`;
}

export function devRedevTag(redevRound: number): string {
  return redevRound > 0 ? `-redev${redevRound}` : '';
}

export function devRedevCoderNodeId(sprintIndex: number, redevRound: number, round: number): string {
  return `coder-${devSprintId(sprintIndex)}${devRedevTag(redevRound)}-r${round}`;
}

export function devRedevValidatorNodeId(
  validatorIndex: number,
  sprintIndex: number,
  redevRound: number,
  round: number,
): string {
  return `validator-${validatorIndex}-${devSprintId(sprintIndex)}${devRedevTag(redevRound)}-r${round}`;
}

export function devRedevFixNodeId(sprintIndex: number, redevRound: number, round: number): string {
  return `fix-${devSprintId(sprintIndex)}${devRedevTag(redevRound)}-r${round}`;
}

export function devRedevValidatorGroupId(sprintIndex: number, redevRound: number, round: number): string {
  return `dev-validators-${devSprintId(sprintIndex)}${devRedevTag(redevRound)}-r${round}`;
}

export function devRedevRefuterNodeId(sprintIndex: number, redevRound: number, round: number): string {
  return `refuter-${devSprintId(sprintIndex)}${devRedevTag(redevRound)}-r${round}`;
}

export function devValidatorNodeId(validatorIndex: number, sprintIndex: number, round: number): string {
  return `validator-${validatorIndex}-${devSprintId(sprintIndex)}-r${round}`;
}

export function devRoundValidatorNodeIds(sprintIndex: number, round: number, validatorCount: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < validatorCount; i++) {
    ids.push(devValidatorNodeId(i, sprintIndex, round));
  }
  return ids;
}

export function devFixNodeId(sprintIndex: number, round: number): string {
  return `fix-${devSprintId(sprintIndex)}-r${round}`;
}

export function devFixerNodeId(sprintIndex: number, round: number): string {
  return `fixer-${devSprintId(sprintIndex)}-r${round}`;
}

export function devRedevFixerNodeId(sprintIndex: number, redevRound: number, round: number): string {
  return `fixer-${devSprintId(sprintIndex)}${devRedevTag(redevRound)}-r${round}`;
}

export function devValidatorGroupId(sprintIndex: number, round: number): string {
  return `dev-validators-${devSprintId(sprintIndex)}-r${round}`;
}

export function devRefuterNodeId(sprintIndex: number, round: number): string {
  return `refuter-${devSprintId(sprintIndex)}-r${round}`;
}

export const REFUTE_SCHEMA_FILE = 'refute.schema.json';

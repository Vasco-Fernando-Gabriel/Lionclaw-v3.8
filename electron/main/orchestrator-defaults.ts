
import { CLAUDE_DEFAULT_MODEL } from '../../src/constants/claude-models';
import type { OrchestratorProvider, OrchestratorRuntime } from '../../src/types';

export const PRODUCT_DEFAULT_ORCHESTRATOR: {
  readonly runtime: OrchestratorRuntime;
  readonly provider: OrchestratorProvider;
  readonly model: string;
} = {
  runtime: 'claude-sdk',
  provider: 'anthropic',
  model: CLAUDE_DEFAULT_MODEL,
} as const;

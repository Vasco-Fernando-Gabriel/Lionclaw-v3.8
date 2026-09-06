import { PipelinePausedError } from '../agent-runtime/types';

export function rethrowPipelinePause(error: unknown): void {
  if (error instanceof PipelinePausedError) throw error;
}

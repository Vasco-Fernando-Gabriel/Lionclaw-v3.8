import type { HarnessEngine } from '../harness-engine';
import type { PipelineEngine } from '../pipeline-engine';

export async function withHarnessEngine<T>(
  getEngine: () => HarnessEngine | null,
  fn: (engine: HarnessEngine) => Promise<T> | T,
): Promise<T | { error: string }> {
  const engine = getEngine();
  if (!engine) return { error: 'HarnessEngine nao inicializado' };
  try {
    return await fn(engine);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function withPipelineEngine<T>(
  getEngine: () => PipelineEngine | null,
  fn: (engine: PipelineEngine) => Promise<T> | T,
): Promise<T | { error: string }> {
  const engine = getEngine();
  if (!engine) return { error: 'PipelineEngine nao inicializado' };
  try {
    return await fn(engine);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

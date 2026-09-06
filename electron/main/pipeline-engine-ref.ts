
import type { PipelineEngine } from './pipeline-engine';

let _getEngine: (() => PipelineEngine | null) | null = null;

export function registerPipelineEngineRef(
  getter: () => PipelineEngine | null,
): void {
  _getEngine = getter;
}

export function getPipelineEngineRef(): PipelineEngine | null {
  return _getEngine ? _getEngine() : null;
}

export function _resetPipelineEngineRefForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error(
      '_resetPipelineEngineRefForTesting can only be called in test environment',
    );
  }
  _getEngine = null;
}

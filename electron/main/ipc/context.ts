import type { BrowserWindow } from 'electron';
import type { HarnessEngine } from '../harness-engine';
import type { PipelineEngine } from '../pipeline-engine';

export interface IpcContext {
  getMainWindow: () => BrowserWindow | null;
  getHarnessEngine: () => HarnessEngine | null;
  getPipelineEngine: () => PipelineEngine | null;
}

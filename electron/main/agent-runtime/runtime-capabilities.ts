
import type { OrchestratorRuntime } from '../../../src/types';

export interface RuntimeCapabilities {
  supportsImageInput: boolean;
  supportsDocumentInput: boolean;
  supportsEffort: boolean;
}

export const RUNTIME_CAPABILITIES: Record<OrchestratorRuntime, RuntimeCapabilities> = {
  'claude-sdk':        { supportsImageInput: true,  supportsDocumentInput: true,  supportsEffort: true  },
  'claude-compat-sdk': { supportsImageInput: true,  supportsDocumentInput: false, supportsEffort: false },
  'codex-sdk':         { supportsImageInput: false, supportsDocumentInput: false, supportsEffort: true  },
  'kimi-sdk':          { supportsImageInput: false, supportsDocumentInput: false, supportsEffort: true  },
  'grok-sdk':          { supportsImageInput: false, supportsDocumentInput: false, supportsEffort: true  },
  'cursor-sdk':        { supportsImageInput: false, supportsDocumentInput: false, supportsEffort: false },
  'lion-sdk':          { supportsImageInput: false, supportsDocumentInput: false, supportsEffort: false },
};

const RUNTIME_LABELS: Record<OrchestratorRuntime, string> = {
  'claude-sdk': 'Claude SDK',
  'claude-compat-sdk': 'Claude-compat',
  'codex-sdk': 'Codex',
  'kimi-sdk': 'Kimi',
  'grok-sdk': 'Grok Build',
  'cursor-sdk': 'Cursor',
  'lion-sdk': 'Lion',
};

export function runtimeLabel(runtime: OrchestratorRuntime): string {
  return RUNTIME_LABELS[runtime] ?? runtime;
}

export function runtimeSupportsImageInput(runtime: OrchestratorRuntime): boolean {
  return RUNTIME_CAPABILITIES[runtime]?.supportsImageInput ?? false;
}

export function runtimeSupportsEffort(runtime: OrchestratorRuntime): boolean {
  return RUNTIME_CAPABILITIES[runtime]?.supportsEffort ?? false;
}

export function imageUnsupportedNotice(runtime: OrchestratorRuntime): string {
  return `O orquestrador atual (${runtimeLabel(runtime)}) nao processa imagens; o texto foi considerado.`;
}

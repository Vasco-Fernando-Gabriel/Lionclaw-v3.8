
import type { OrchestratorProvider } from '../../../src/types';
import {
  CLAUDE_COMPAT_PRESETS as RENDERER_CLAUDE_COMPAT_PRESETS,
  type ClaudeCompatPreset as RendererClaudeCompatPreset,
} from '../../../src/constants/claude-compat-presets';

export type ClaudeCompatPreset = RendererClaudeCompatPreset;

export const CLAUDE_COMPAT_PRESETS: ClaudeCompatPreset[] = RENDERER_CLAUDE_COMPAT_PRESETS;

export function getClaudeCompatPreset(
  provider: OrchestratorProvider,
): ClaudeCompatPreset {
  const preset = CLAUDE_COMPAT_PRESETS.find((p) => p.id === provider);
  if (!preset) {
    throw new Error(
      `Unknown Claude-compat provider "${provider}". ` +
        `Registered ids: ${CLAUDE_COMPAT_PRESETS.map((p) => p.id).join(', ') || '(none)'}.`,
    );
  }
  return preset;
}

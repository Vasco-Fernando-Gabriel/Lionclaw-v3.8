import type { AgentConfig, CodexChatReasoningEffort, OrchestratorRuntime } from '../../../src/types';

export type ClaudeReasoningEffort = AgentConfig['effort'];

export interface ChatInheritedEffort {
  claude: ClaudeReasoningEffort;
  codex: CodexChatReasoningEffort;
  kimi?: 'low' | 'high' | 'max';
  grok?: 'low' | 'medium' | 'high';
}

const CLAUDE_EFFORTS: readonly ClaudeReasoningEffort[] = ['low', 'medium', 'high', 'max'];
const CODEX_EFFORTS: readonly CodexChatReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function claudeEffortToCodex(effort: ClaudeReasoningEffort): CodexChatReasoningEffort {
  return effort === 'max' ? 'max' : effort;
}

export function codexEffortToClaude(effort: CodexChatReasoningEffort): ClaudeReasoningEffort {
  if (effort === 'xhigh' || effort === 'max' || effort === 'ultra') return 'max';
  return effort;
}

export { clampCodexEffortForModel } from '../../../src/constants/codex-models';

export function resolveChatInheritedEffort(
  runtime: OrchestratorRuntime | string | undefined,
  effort: string | undefined,
): ChatInheritedEffort | undefined {
  const raw = (effort ?? '').trim();
  if (runtime === 'claude-sdk') {
    const claude: ClaudeReasoningEffort = CLAUDE_EFFORTS.includes(raw as ClaudeReasoningEffort)
      ? (raw as ClaudeReasoningEffort)
      : 'high';
    return {
      claude,
      codex: claudeEffortToCodex(claude),
      kimi: claude === 'low' ? 'low' : claude === 'max' ? 'max' : 'high',
      grok: claude === 'low' ? 'low' : claude === 'medium' ? 'medium' : 'high',
    };
  }
  if (runtime === 'codex-sdk') {
    const configured: CodexChatReasoningEffort = CODEX_EFFORTS.includes(raw as CodexChatReasoningEffort)
      ? (raw as CodexChatReasoningEffort)
      : 'high';
    const codex: CodexChatReasoningEffort = configured === 'ultra' ? 'max' : configured;
    const claude = codexEffortToClaude(codex);
    return {
      claude,
      codex,
      kimi: claude === 'low' ? 'low' : claude === 'max' ? 'max' : 'high',
      grok: claude === 'low' ? 'low' : claude === 'medium' ? 'medium' : 'high',
    };
  }
  if (runtime === 'kimi-sdk') {
    const kimi: 'low' | 'high' | 'max' = raw === 'low' || raw === 'high' || raw === 'max' ? raw : 'max';
    const claude: ClaudeReasoningEffort = kimi === 'max' ? 'max' : kimi;
    return {
      claude,
      codex: claudeEffortToCodex(claude),
      kimi,
      grok: kimi === 'low' ? 'low' : 'high',
    };
  }
  if (runtime === 'grok-sdk') {
    const grok: 'low' | 'medium' | 'high' = raw === 'low' || raw === 'medium' || raw === 'high' ? raw : 'high';
    const claude: ClaudeReasoningEffort = grok;
    return {
      claude,
      codex: claudeEffortToCodex(claude),
      kimi: grok === 'low' ? 'low' : 'high',
      grok,
    };
  }
  return undefined;
}

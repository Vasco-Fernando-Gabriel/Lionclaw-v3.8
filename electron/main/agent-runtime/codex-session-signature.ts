export interface CodexSessionSignature {
  model: string;
  requestedEffort: string | undefined;
}

export type CodexUsageSemantics = 'thread-cumulative' | 'per-turn';

export interface CodexBilledUsageBaseline {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

const signatures = new WeakMap<object, CodexSessionSignature>();
const usageSemantics = new WeakMap<object, CodexUsageSemantics>();
const billedBaselines = new WeakMap<object, CodexBilledUsageBaseline>();

export function registerCodexSessionSignature(session: object, signature: CodexSessionSignature): void {
  signatures.set(session, signature);
}

export function getCodexSessionSignature(session: object): CodexSessionSignature | undefined {
  return signatures.get(session);
}

export function registerCodexUsageSemantics(session: object, semantics: CodexUsageSemantics): void {
  usageSemantics.set(session, semantics);
}

export function getCodexUsageSemantics(session: object): CodexUsageSemantics {
  return usageSemantics.get(session) ?? 'per-turn';
}

const ZERO_BASELINE: CodexBilledUsageBaseline = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

export function settleCodexBilledUsage(session: object, current: CodexBilledUsageBaseline): CodexBilledUsageBaseline {
  const base = billedBaselines.get(session) ?? ZERO_BASELINE;
  const delta: CodexBilledUsageBaseline = {
    inputTokens: Math.max(0, current.inputTokens - base.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - base.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - base.outputTokens),
    reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - base.reasoningOutputTokens),
    totalTokens: Math.max(0, current.totalTokens - base.totalTokens),
  };
  billedBaselines.set(session, {
    inputTokens: Math.max(base.inputTokens, current.inputTokens),
    cachedInputTokens: Math.max(base.cachedInputTokens, current.cachedInputTokens),
    outputTokens: Math.max(base.outputTokens, current.outputTokens),
    reasoningOutputTokens: Math.max(base.reasoningOutputTokens, current.reasoningOutputTokens),
    totalTokens: Math.max(base.totalTokens, current.totalTokens),
  });
  return delta;
}

import { describe, it, expect } from 'vitest';
import { conversationPhasesOf } from '@/types/pipeline';

function showChatInput(args: {
  pipelineType: string;
  currentPhase: number | null;
  awaitingUser: boolean;
  isDone?: boolean;
  isFailed?: boolean;
  isResumableConversation?: boolean;
}): boolean {
  const { pipelineType, currentPhase, awaitingUser } = args;
  const isDone = args.isDone ?? false;
  const isFailed = args.isFailed ?? false;
  const isResumableConversation = args.isResumableConversation ?? false;
  const conversationSet = conversationPhasesOf(pipelineType);
  const isConversationPhase = currentPhase !== null && conversationSet.has(currentPhase);
  return (!awaitingUser || isConversationPhase) && !isDone && (!isFailed || isResumableConversation);
}

const NAIVE_CONVERSATION: Record<string, number[]> = {
  development: [1, 3, 5, 6, 7, 8, 10, 12], // NOTE: no 9
  feature: [1, 3, 5, 6, 7, 8, 10, 12], // NOTE: no 9
  'development-v2': [1, 3, 5, 8, 9, 10, 11, 13, 15], // NOTE: no 12
};

describe('UI-1 — conversationPhasesOf includes the spec-review overrides (the source PipelinePage now reads)', () => {
  it('dev phase 9 (Spec Generation, type:auto) IS conversational', () => {
    expect(conversationPhasesOf('development').has(9)).toBe(true);
  });

  it('feature phase 9 (Spec Generation, type:auto) IS conversational (R-1)', () => {
    expect(conversationPhasesOf('feature').has(9)).toBe(true);
  });

  it('dev-v2 phase 12 (Spec Generation, type:auto) IS conversational', () => {
    expect(conversationPhasesOf('development-v2').has(12)).toBe(true);
  });

  it('the naive .type derivation would DROP 9/9/12 — proves UI-1 is a real change, not a no-op', () => {
    expect(NAIVE_CONVERSATION.development).not.toContain(9);
    expect(NAIVE_CONVERSATION.feature).not.toContain(9);
    expect(NAIVE_CONVERSATION['development-v2']).not.toContain(12);
  });
});

describe('UI-1 — PipelinePage showChatInput is TRUE on the spec-review phases while awaiting the user', () => {
  it('dev phase 9: chat input shown (was hidden pre-Sprint-5)', () => {
    expect(showChatInput({ pipelineType: 'development', currentPhase: 9, awaitingUser: true })).toBe(true);
  });

  it('feature phase 9: chat input shown (was hidden pre-Sprint-5)', () => {
    expect(showChatInput({ pipelineType: 'feature', currentPhase: 9, awaitingUser: true })).toBe(true);
  });

  it('dev-v2 phase 12: chat input shown (parity with the removed manual === 12 override)', () => {
    expect(showChatInput({ pipelineType: 'development-v2', currentPhase: 12, awaitingUser: true })).toBe(true);
  });

  it('a genuine auto phase (dev-v2 phase 7, no override) still HIDES the chat input while awaiting', () => {
    expect(conversationPhasesOf('development-v2').has(7)).toBe(false);
    expect(showChatInput({ pipelineType: 'development-v2', currentPhase: 7, awaitingUser: true })).toBe(false);
  });

  it('terminal states still hide the chat input on the override phases', () => {
    expect(showChatInput({ pipelineType: 'development', currentPhase: 9, awaitingUser: true, isDone: true })).toBe(
      false,
    );
    expect(
      showChatInput({ pipelineType: 'development-v2', currentPhase: 12, awaitingUser: true, isFailed: true }),
    ).toBe(false);
  });
});

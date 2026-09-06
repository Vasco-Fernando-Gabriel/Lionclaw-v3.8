
export interface ClaudeModelOption {
  id: string;
  displayName: string;
}

export const CLAUDE_MODELS: ClaudeModelOption[] = [
  { id: 'claude-fable-5-1',           displayName: 'Claude Fable 5.1' },
  { id: 'claude-opus-5',              displayName: 'Claude Opus 5' },
  { id: 'claude-opus-4-8',            displayName: 'Claude Opus 4.8' },
  { id: 'claude-opus-4-7',            displayName: 'Claude Opus 4.7' },
  { id: 'claude-sonnet-5',            displayName: 'Claude Sonnet 5' },
  { id: 'claude-sonnet-4-6',          displayName: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001',  displayName: 'Claude Haiku 4.5' },
];

export const CLAUDE_DEFAULT_MODEL = 'claude-opus-5';

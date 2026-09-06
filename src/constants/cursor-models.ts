
export type CursorEffortTier = 'low' | 'medium' | 'high' | 'xhigh';

export interface CursorModelOption {
  slug: string;
  label: string;
  description?: string;
  contextWindow: number;
  effortTiers?: readonly CursorEffortTier[];
}

export const CURSOR_MODELS: readonly CursorModelOption[] = [
  {
    slug: 'composer-2.5',
    label: 'Composer 2.5',
    description: 'Modelo agentic first-party do Cursor',
    contextWindow: 200_000,
  },
  { slug: 'claude-fable-5', label: 'Claude Fable 5 (via Cursor)', contextWindow: 1_000_000 },
  { slug: 'claude-opus-5', label: 'Claude Opus 5 (via Cursor)', contextWindow: 1_000_000 },
  { slug: 'claude-opus-4-8', label: 'Claude Opus 4.8 (via Cursor)', contextWindow: 1_000_000 },
  { slug: 'claude-sonnet-5', label: 'Claude Sonnet 5 (via Cursor)', contextWindow: 1_000_000 },
  { slug: 'gpt-5.6-sol', label: 'GPT-5.6 Sol (via Cursor)', contextWindow: 1_050_000 },
  { slug: 'gpt-5.6-terra', label: 'GPT-5.6 Terra (via Cursor)', contextWindow: 1_050_000 },
  { slug: 'gpt-5.5', label: 'GPT-5.5 (via Cursor)', contextWindow: 1_050_000 },
  { slug: 'grok-4.6', label: 'Grok 4.6 (via Cursor)', contextWindow: 500_000 },
  { slug: 'grok-4.5', label: 'Grok 4.5 (via Cursor)', contextWindow: 500_000 },
  { slug: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash (via Cursor)', contextWindow: 1_048_576 },
];

export const CURSOR_DEFAULT_MODEL = 'composer-2.5';

export function getCursorModel(model: string): CursorModelOption | undefined {
  return CURSOR_MODELS.find((entry) => entry.slug === model);
}

export function cursorEffortTiersForModel(model: string): readonly CursorEffortTier[] {
  return getCursorModel(model)?.effortTiers ?? [];
}

const CURSOR_EFFORT_RANK: readonly CursorEffortTier[] = ['low', 'medium', 'high', 'xhigh'];

export function clampCursorEffortForModel(
  effort: string,
  model: string,
): CursorEffortTier | null {
  return clampCursorEffort(effort, cursorEffortTiersForModel(model));
}

export function clampCursorEffort(
  effort: string,
  tiers: readonly CursorEffortTier[],
): CursorEffortTier | null {
  if (tiers.length === 0) return null;
  const requested: CursorEffortTier =
    effort === 'max' || effort === 'ultra'
      ? 'xhigh'
      : CURSOR_EFFORT_RANK.includes(effort as CursorEffortTier)
        ? (effort as CursorEffortTier)
        : 'xhigh';
  const requestedRank = CURSOR_EFFORT_RANK.indexOf(requested);
  const sorted = [...tiers].sort(
    (a, b) => CURSOR_EFFORT_RANK.indexOf(a) - CURSOR_EFFORT_RANK.indexOf(b),
  );
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (CURSOR_EFFORT_RANK.indexOf(sorted[i]) <= requestedRank) return sorted[i];
  }
  return sorted[0];
}

export type GrokReasoningEffort = 'low' | 'medium' | 'high';

export interface GrokModelOption {
  slug: string;
  label: string;
  description: string;
  contextWindow: number;
  efforts: readonly GrokReasoningEffort[];
}

export const GROK_MODELS: readonly GrokModelOption[] = [
  {
    slug: 'grok-4.6',
    label: 'Grok 4.6',
    description: 'Flagship (Ago/2026), motor atual do Grok Build por assinatura via CLI oficial',
    contextWindow: 500_000,
    efforts: ['low', 'medium', 'high'],
  },
  {
    slug: 'grok-4.5',
    label: 'Grok 4.5',
    description: 'Grok Build por assinatura via CLI oficial',
    contextWindow: 500_000,
    efforts: ['low', 'medium', 'high'],
  },
];

export const GROK_DEFAULT_MODEL = 'grok-4.6';
export const GROK_DEFAULT_EFFORT: GrokReasoningEffort = 'high';

export function grokEffortsForModel(model: string): readonly GrokReasoningEffort[] {
  return GROK_MODELS.find((entry) => entry.slug === model)?.efforts ?? [];
}

export function clampGrokEffortForModel(
  effort: GrokReasoningEffort,
  model: string,
): GrokReasoningEffort {
  const supported = grokEffortsForModel(model);
  return supported.includes(effort) ? effort : GROK_DEFAULT_EFFORT;
}

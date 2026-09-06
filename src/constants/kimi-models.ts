
export interface KimiModelOption {
  slug: string;
  label: string;
  description?: string;
  contextWindow: number;
  thinkingMode: 'always' | 'toggle' | 'none';
  efforts: readonly KimiEffort[];
  defaultEffort?: KimiEffort;
}

export type KimiEffort = 'low' | 'high' | 'max';
export type KimiEffortSource = 'explicit' | 'inherited';

export class KimiEffortUnsupportedError extends Error {
  constructor(model: string, requested: string) {
    super(`Modelo ${model} usa reasoning booleano e nao aceita effort explicito "${requested}".`);
    this.name = 'KimiEffortUnsupportedError';
  }
}

export type KimiEffectiveThinking =
  | { mode: 'none'; effective: 'thinking-off'; envEffort: undefined }
  | { mode: 'boolean'; effective: 'thinking-on'; envEffort: undefined }
  | {
      mode: 'tiered';
      requested: KimiEffort;
      effective: KimiEffort;
      envEffort: KimiEffort;
    };

export const KIMI_MODELS: KimiModelOption[] = [
  {
    slug: 'kimi-code/kimi-for-coding',
    label: 'Kimi K2.7 Code',
    description: 'Assinatura via CLI (base_url api.kimi.com/coding/v1, ctx 262144)',
    contextWindow: 262_144,
    thinkingMode: 'always',
    efforts: [],
  },
  {
    slug: 'kimi-code/k3',
    label: 'Kimi K3',
    description: 'Flagship (Jul/2026), ctx 1048576. Requer tier Moderato+ da assinatura (Adagio nao inclui K3).',
    contextWindow: 1_048_576,
    thinkingMode: 'always',
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'max',
  },
];

export const KIMI_DEFAULT_MODEL = 'kimi-code/kimi-for-coding';

export function getKimiModel(model: string): KimiModelOption | undefined {
  return KIMI_MODELS.find((entry) => entry.slug === model);
}

export function normalizeKimiModelSelection(model: string): string {
  return getKimiModel(model)?.slug ?? KIMI_DEFAULT_MODEL;
}

export function resolveKimiStoredEffort(
  model: string,
  stored?: string,
): KimiEffort | undefined {
  const metadata = getKimiModel(model);
  if (!metadata || metadata.efforts.length === 0) return undefined;
  return isKimiEffort(stored) && metadata.efforts.includes(stored)
    ? stored
    : metadata.defaultEffort ?? metadata.efforts[metadata.efforts.length - 1];
}

export function isKimiEffort(value: string | undefined): value is KimiEffort {
  return value === 'low' || value === 'high' || value === 'max';
}

export function resolveKimiEffectiveThinking(
  model: string,
  requested?: string,
  thinking = true,
  effortSource: KimiEffortSource = 'explicit',
): KimiEffectiveThinking {
  const metadata = getKimiModel(model);
  if (!metadata) {
    throw new Error(`Modelo Kimi nao suportado: ${model}`);
  }
  if (metadata.thinkingMode === 'none' || (metadata.thinkingMode === 'toggle' && !thinking)) {
    return { mode: 'none', effective: 'thinking-off', envEffort: undefined };
  }
  if (metadata.efforts.length === 0) {
    if (requested !== undefined && effortSource === 'explicit') {
      throw new KimiEffortUnsupportedError(model, requested);
    }
    return { mode: 'boolean', effective: 'thinking-on', envEffort: undefined };
  }
  const fallback = metadata.defaultEffort ?? metadata.efforts[metadata.efforts.length - 1];
  if (requested !== undefined
    && (!isKimiEffort(requested) || !metadata.efforts.includes(requested))
    && effortSource === 'explicit') {
    throw new KimiEffortUnsupportedError(model, requested);
  }
  const effective = isKimiEffort(requested) && metadata.efforts.includes(requested)
    ? requested
    : fallback;
  return { mode: 'tiered', requested: isKimiEffort(requested) ? requested : fallback, effective, envEffort: effective };
}

export const KIMI_MODELS_BY_AUTH: Record<'subscription', KimiModelOption[]> = {
  subscription: KIMI_MODELS,
};

export function filterManagedKimiModels(availableModels: readonly string[]): KimiModelOption[] {
  const available = new Set(availableModels);
  return KIMI_MODELS_BY_AUTH.subscription.filter((model) => available.has(model.slug));
}

export function isManagedKimiSelectionUsable(
  status: { usable: boolean; availableModels: readonly string[] } | null,
  model: string,
): boolean {
  return status?.usable === true && filterManagedKimiModels(status.availableModels)
    .some((available) => available.slug === model);
}

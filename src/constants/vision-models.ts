
export interface VisionModelOption {
  provider: 'openai' | 'anthropic';
  id: string;
  displayName: string;
}

export const VISION_MODELS: VisionModelOption[] = [
  { provider: 'openai',    id: 'gpt-5.5',         displayName: 'GPT-5.5' },
  { provider: 'openai',    id: 'gpt-5.4-mini',    displayName: 'GPT-5.4 Mini' },
  { provider: 'anthropic', id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8' },
  { provider: 'anthropic', id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
];

export const VISION_DEFAULT: VisionModelOption = VISION_MODELS[0];

export type VisionProvider = VisionModelOption['provider'];

const MODEL_IDS = new Set<string>(VISION_MODELS.map((model) => model.id));

export function isVisionModel(value: string): boolean {
  return MODEL_IDS.has(value);
}

export function isVisionModelForProvider(provider: string, id: string): boolean {
  return VISION_MODELS.some((model) => model.provider === provider && model.id === id);
}

export function visionModelsForProvider(provider: VisionProvider): VisionModelOption[] {
  return VISION_MODELS.filter((model) => model.provider === provider);
}

export function defaultVisionModelForProvider(provider: VisionProvider): string {
  return visionModelsForProvider(provider)[0]?.id ?? VISION_DEFAULT.id;
}

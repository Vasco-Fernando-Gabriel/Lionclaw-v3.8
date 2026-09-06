import type { CodexChatReasoningEffort } from '../types';

export interface CodexModelOption {
  slug: string;
  label: string;
  description: string;
}

export const CODEX_MODELS: CodexModelOption[] = [
  { slug: 'gpt-6-astra',   label: 'GPT-6-Astra',   description: 'Frontier GPT-6 (recomendado)' },
  { slug: 'gpt-5.6-sol',   label: 'GPT-5.6-Sol',   description: 'Frontier agentic da geracao 5.6' },
  { slug: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', description: 'Equilibrado, ~5.5 pela metade do preco' },
  { slug: 'gpt-5.6-luna',  label: 'GPT-5.6-Luna',  description: 'Rapido e barato' },
  { slug: 'gpt-5.5',       label: 'GPT-5.5',       description: 'Frontier, codex-tuned' },
  { slug: 'gpt-5.4',       label: 'GPT-5.4',       description: 'Generalista frontier' },
  { slug: 'gpt-5.4-mini',  label: 'GPT-5.4-Mini',  description: 'Mais barato e rapido' },
  { slug: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', description: 'Variante codex-tuned (legado)' },
  { slug: 'gpt-5.2',       label: 'GPT-5.2',       description: 'Anterior, generalista' },
];

export const CODEX_DEFAULT_MODEL = 'gpt-6-astra';

export const CODEX_SANDBOX_OPTIONS = ['workspace-write', 'read-only', 'danger-full-access'] as const;


export const CODEX_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

const CODEX_CHAT_BASE_EFFORTS: readonly CodexChatReasoningEffort[] = ['low', 'medium', 'high'];
export const CODEX_CHAT_EFFORTS_WITH_XHIGH: readonly CodexChatReasoningEffort[] =
  ['low', 'medium', 'high', 'xhigh'];
export const CODEX_CHAT_EFFORTS_WITH_MAX: readonly CodexChatReasoningEffort[] =
  ['low', 'medium', 'high', 'xhigh', 'max'];
export const CODEX_CHAT_EFFORTS_FULL: readonly CodexChatReasoningEffort[] =
  ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const STATIC_MODEL_EFFORTS: Record<string, readonly CodexChatReasoningEffort[]> = {
  'gpt-6-astra': CODEX_CHAT_EFFORTS_FULL,
  'gpt-5.6-sol': CODEX_CHAT_EFFORTS_FULL,
  'gpt-5.6-terra': CODEX_CHAT_EFFORTS_FULL,
  'gpt-5.6-luna': CODEX_CHAT_EFFORTS_WITH_MAX,
  'gpt-5.5': CODEX_CHAT_EFFORTS_WITH_XHIGH,
  'gpt-5.4': CODEX_CHAT_EFFORTS_WITH_XHIGH,
  'gpt-5.4-mini': CODEX_CHAT_EFFORTS_WITH_XHIGH,
  'gpt-5.3-codex': CODEX_CHAT_EFFORTS_WITH_XHIGH,
  'gpt-5.3-codex-spark': CODEX_CHAT_EFFORTS_WITH_XHIGH,
  'gpt-5.2-codex': CODEX_CHAT_EFFORTS_WITH_XHIGH,
  'codex-max': CODEX_CHAT_EFFORTS_WITH_XHIGH,
  'gpt-5.2': CODEX_CHAT_BASE_EFFORTS,
};

export function isKnownStaticCodexModel(model: string): boolean {
  const slug = (model || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(STATIC_MODEL_EFFORTS, slug);
}

export function staticEffortsFor(model: string): readonly CodexChatReasoningEffort[] {
  const slug = (model || '').trim().toLowerCase();
  return STATIC_MODEL_EFFORTS[slug] ?? CODEX_CHAT_BASE_EFFORTS;
}

export function codexModelSupportsXhigh(model: string): boolean {
  return staticEffortsFor(model).includes('xhigh');
}

export function codexModelRequiresOfficial(model: string): boolean {
  const slug = (model || '').trim().toLowerCase();
  return (
    slug === 'gpt-5.6' ||
    slug.startsWith('gpt-5.6-') ||
    slug === 'gpt-6' ||
    slug.startsWith('gpt-6-')
  );
}

export function codexEffortRequiresOfficial(
  effort: CodexChatReasoningEffort | undefined,
): boolean {
  return effort === 'max' || effort === 'ultra';
}

export function clampCodexEffortToSupported(
  requested: CodexChatReasoningEffort,
  supported: readonly CodexChatReasoningEffort[],
): CodexChatReasoningEffort {
  if (supported.includes(requested)) return requested;
  const reqIdx = CODEX_EFFORT_ORDER.indexOf(requested);
  for (let i = reqIdx - 1; i >= 0; i--) {
    const candidate = CODEX_EFFORT_ORDER[i];
    if (supported.includes(candidate)) return candidate;
  }
  return 'high';
}

export const CODEX_EFFORT_LABELS: Record<CodexChatReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High (padrao)',
  xhigh: 'Xhigh',
  max: 'Max (raciocinio maximo)',
  ultra: 'Ultra (delega a subagentes internos, consumo 2 a 3x)',
};

export function clampCodexEffortForModel(
  effort: CodexChatReasoningEffort,
  model: string,
): CodexChatReasoningEffort {
  return clampCodexEffortToSupported(effort, staticEffortsFor(model));
}

export function CODEX_CHAT_EFFORT_BY_MODEL(
  model: string,
): readonly CodexChatReasoningEffort[] {
  return staticEffortsFor(model);
}

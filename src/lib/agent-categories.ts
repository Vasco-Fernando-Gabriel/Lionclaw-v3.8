export interface AgentCategory {
  value: string;
  label: string;
  kind: 'workflow' | 'library';
}

export const AGENT_CATEGORIES: AgentCategory[] = [
  { value: 'harness', label: 'Harness', kind: 'workflow' },
  { value: 'pipeline', label: 'Pipeline', kind: 'workflow' },
  { value: 'feature', label: 'Feature', kind: 'workflow' },
  { value: 'enrich', label: 'Enrich', kind: 'workflow' },
  { value: 'security', label: 'Segurança', kind: 'workflow' },
  { value: 'dynamic-workflow', label: 'Workflow Dinamico', kind: 'workflow' },
  { value: 'backend', label: 'Backend', kind: 'library' },
  { value: 'frontend', label: 'Frontend', kind: 'library' },
  { value: 'database', label: 'Banco', kind: 'library' },
  { value: 'data-ai', label: 'Dados e IA', kind: 'library' },
  { value: 'infra', label: 'Infra', kind: 'library' },
  { value: 'quality', label: 'Qualidade', kind: 'library' },
  { value: 'tooling', label: 'Ferramentas', kind: 'library' },
];

const LABEL_BY_VALUE = new Map(AGENT_CATEGORIES.map((c) => [c.value, c.label]));
const KIND_BY_VALUE = new Map(AGENT_CATEGORIES.map((c) => [c.value, c.kind]));
const ORDER = AGENT_CATEGORIES.map((c) => c.value);

const ALIASES: Record<string, string> = {
  infraestrutura: 'infra',
  devops: 'infra',
  banco: 'database',
  'banco-de-dados': 'database',
  qualidade: 'quality',
  ferramentas: 'tooling',
};

export function normalizeCategory(value: string | null | undefined): string {
  const v = (value ?? '').trim().toLowerCase();
  return ALIASES[v] ?? v;
}

export function categoryKind(value: string): 'workflow' | 'library' {
  return KIND_BY_VALUE.get(normalizeCategory(value)) ?? 'library';
}

export const CANONICAL_CATEGORY_VALUES: string[] = ORDER;

export function categoryLabel(value: string): string {
  return LABEL_BY_VALUE.get(value) ?? (value.charAt(0).toUpperCase() + value.slice(1));
}

export function sortCategories(values: string[]): string[] {
  return [...values].sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.localeCompare(b);
  });
}

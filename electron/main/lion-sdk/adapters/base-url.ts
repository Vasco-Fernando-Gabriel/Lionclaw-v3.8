export function normalizeBaseUrl(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  return trimmed.replace(/\/+$/, '').replace(/\/v1$/, '');
}

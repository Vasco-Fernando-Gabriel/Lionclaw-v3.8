export function buildDevV2StoryCoverageMap(stories: string | null): string {
  if (!stories?.trim()) return '- (user stories ausentes)';
  const lines = stories.split(/\r?\n/);
  const result: string[] = [];
  for (const line of lines) {
    const match = line.match(/\b(US|UC)-?\d{1,3}\b/i);
    if (!match) continue;
    const id = match[0].toUpperCase().replace(/^([A-Z]+)-?(\d+)$/, (_m, p, n) => `${p}-${String(n).padStart(2, '0')}`);
    const title = line
      .replace(/^#+\s*/, '')
      .replace(/\*\*/g, '')
      .replace(new RegExp(`^${id.replace('-', '[- ]?')}\\s*[—\\-:]*\\s*`, 'i'), '')
      .trim();
    if (title) result.push(`- ${id}: ${title}`);
  }
  return result.length > 0 ? Array.from(new Set(result)).join('\n') : '- (sem IDs de user story detectados)';
}

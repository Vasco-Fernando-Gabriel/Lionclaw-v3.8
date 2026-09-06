
export const INDEX_PIPELINE_INTERNAL_SQUADS = new Set<string>([
  'harness',
  'pipeline',
  'security',
  'feature',
  'enrich',
]);

export function summarizeAgentDescription(
  description: string | undefined | null,
  name: string,
): string {
  const flat = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return name;
  const sentenceEnd = flat.search(/[.!?]/);
  const firstSentence = sentenceEnd === -1 ? flat : flat.slice(0, sentenceEnd + 1);
  if (firstSentence.length <= 80) return firstSentence;
  return firstSentence.slice(0, 80).trimEnd();
}

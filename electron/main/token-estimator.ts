export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function excerptStartEnd(text: string, totalChars: number): string {
  if (text.length <= totalChars) return text;
  const omitted = text.length - totalChars;
  const marker = `\n[trecho central omitido: ~${omitted} chars]\n`;
  const room = totalChars - marker.length;
  if (room <= 0) return text.slice(0, Math.max(0, totalChars));
  const head = Math.min(1000, Math.ceil(room / 2));
  const tail = room - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : '');
}

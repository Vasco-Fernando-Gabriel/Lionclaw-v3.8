
export interface MdSectionBlock {
  header: string | null;
  lines: string[];
}

export function countNonEmptyLines(content: string): number {
  return content.split('\n').filter(l => l.trim().length > 0).length;
}

export function splitIntoSections(content: string): MdSectionBlock[] {
  const lines = content.split('\n');
  const blocks: MdSectionBlock[] = [];
  let current: MdSectionBlock = { header: null, lines: [] };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      blocks.push(current);
      current = { header: line, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  blocks.push(current);
  return blocks;
}

export function joinSections(blocks: MdSectionBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const bodyLines = block.lines;
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
      bodyLines.pop();
    }

    if (block.header !== null) {
      parts.push(block.header);
    }
    if (bodyLines.length > 0) {
      parts.push(...bodyLines);
    }
    parts.push('');
  }
  while (parts.length > 0 && parts[parts.length - 1].trim() === '') {
    parts.pop();
  }
  return parts.join('\n') + '\n';
}

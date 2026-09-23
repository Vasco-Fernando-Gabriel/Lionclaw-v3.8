import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const COMPAT_SRC = path.join(__dirname, '..', 'claude-compat-sdk', 'index.ts');

interface SplitSource {
  code: string[];
  comments: string[];
}

function splitCodeAndComments(source: string): SplitSource {
  const code: string[] = [];
  const comments: string[] = [];
  let inBlock = false;

  for (const rawLine of source.replace(/\r\n/g, '\n').split('\n')) {
    let rest = rawLine;
    let codePart = '';

    while (rest.length > 0) {
      if (inBlock) {
        const end = rest.indexOf('*/');
        if (end === -1) {
          comments.push(rest);
          rest = '';
        } else {
          comments.push(rest.slice(0, end));
          rest = rest.slice(end + 2);
          inBlock = false;
        }
        continue;
      }

      const lineComment = rest.search(/(^|\s)\/\//);
      const blockStart = rest.indexOf('/*');
      const lineIdx = lineComment === -1 ? -1 : rest.indexOf('//', lineComment);

      if (blockStart !== -1 && (lineIdx === -1 || blockStart < lineIdx)) {
        codePart += rest.slice(0, blockStart);
        rest = rest.slice(blockStart + 2);
        inBlock = true;
        continue;
      }
      if (lineIdx !== -1) {
        codePart += rest.slice(0, lineIdx);
        comments.push(rest.slice(lineIdx + 2));
        rest = '';
        continue;
      }
      codePart += rest;
      rest = '';
    }

    code.push(codePart);
  }

  return { code, comments };
}

describe('claude-compat-sdk: sufixo [1m] removido do codigo executavel (D9 / VA-11)', () => {
  const source = fs.readFileSync(COMPAT_SRC, 'utf8');
  const { code } = splitCodeAndComments(source);
  const codeOnly = code.join('\n');

  it('nenhuma ocorrencia de [1m] em codigo executavel', () => {
    const offending = code.map((line, idx) => ({ line, n: idx + 1 })).filter(({ line }) => line.includes('[1m]'));
    expect(offending).toEqual([]);
  });

  it('nao ha derivacao de sdkModel: se existir, e apenas `const sdkModel = model;`', () => {
    const assignments = codeOnly.match(/sdkModel\s*=[^=][^;]*;/g) ?? [];
    for (const assignment of assignments) {
      expect(assignment.replace(/\s+/g, ' ').trim()).toBe('sdkModel = model;');
    }
    expect(codeOnly).not.toMatch(/\$\{model\}\[/);
    expect(codeOnly).not.toMatch(/sdkModel\s*=\s*`/);
  });

  it('options.model do query() compat e o slug limpo (model / model: model / model: sdkModel)', () => {
    const match = codeOnly.match(/cwd: getAgentCwd\(isOnboarding\),\n\s+model(?:: (?:model|sdkModel))?,\n/);
    expect(match).not.toBeNull();
  });

  it('buildCompatEnv injeta CLAUDE_CODE_MAX_CONTEXT_TOKENS a partir de getContextWindow', () => {
    expect(codeOnly).toMatch(/CLAUDE_CODE_MAX_CONTEXT_TOKENS: String\(contextWindow\)/);
    expect(codeOnly).toMatch(/getContextWindow\(selection\.model, selection\.provider\)/);
  });
});

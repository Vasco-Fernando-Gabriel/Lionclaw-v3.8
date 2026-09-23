import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCAN_DIRS = ['electron/main', 'src'];

const MODEL_ID_WHOLE =
  /^(claude|gpt|glm|kimi|minimax|gemini|o1|o3|o4|deepseek|llama|mistral|qwen|command|nova)-[a-z0-9.-]+$/i;

const RUNTIME_EXCLUSIONS = new Set<string>([
  'claude-sdk',
  'claude-compat-sdk',
  'codex-sdk',
  'kimi-sdk',
  'lion-sdk',
  'claude-code',
  'claude-agent-sdk',
  'claude-compatible',
  'claude-anthropic',
  'claude-compat',
  'minimax-tp',
  'minimax-payg',
  'kimi-cn',
  'kimi-code',
  'kimi-acp',
  'gemini-agent-platform',
]);

const ALLOWLIST: RegExp[] = [
  /(^|\/)pricing\.ts$/,
  /(^|\/)src\/constants\//,
  /(^|\/)orchestrator-defaults\.ts$/,
  /(^|\/)db-migrations\//,
  /(^|\/)seed-agents\//,
  /(^|\/)__tests__\//,
  /\.test\.tsx?$/,
];

const EXPECTED_SUPPRESSIONS = 9;

function isAllowlisted(relPath: string): boolean {
  const norm = relPath.split('\\').join('/');
  return ALLOWLIST.some((re) => re.test(norm));
}

function listTsFiles(absDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) {
        if (entry === 'node_modules' || entry === 'vendor' || entry === 'dist') continue;
        walk(p);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(p);
      }
    }
  };
  walk(absDir);
  return out;
}

const STRING_LITERAL = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\$]*)`?/g;

interface Violation {
  file: string;
  line: number;
  reason: string;
  text: string;
}

function scanFile(absPath: string, relPath: string): { violations: Violation[]; suppressions: number } {
  const violations: Violation[] = [];
  let suppressions = 0;
  const lines = readFileSync(absPath, 'utf8').split('\n');
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let line = raw;

    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const blockStart = line.indexOf('/*');
    if (blockStart !== -1 && line.indexOf('*/', blockStart) === -1) {
      line = line.slice(0, blockStart);
      inBlockComment = true;
    }

    if (/\/\/\s*gate-allow:/.test(line)) {
      suppressions++;
      continue;
    }

    const lineComment = line.indexOf('//');
    if (lineComment !== -1) line = line.slice(0, lineComment);

    if (/getSetting\(\s*['"]default_model['"]\s*\)/.test(line)) {
      violations.push({ file: relPath, line: i + 1, reason: "getSetting('default_model')", text: raw.trim() });
      continue;
    }

    STRING_LITERAL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STRING_LITERAL.exec(line)) !== null) {
      if (m[0] === '') {
        STRING_LITERAL.lastIndex++;
        continue;
      }
      const lit = m[1] ?? m[2] ?? m[3] ?? '';
      if (!MODEL_ID_WHOLE.test(lit)) continue;
      const normalized = lit.endsWith('-') ? lit.slice(0, -1) : lit;
      if (RUNTIME_EXCLUSIONS.has(lit) || RUNTIME_EXCLUSIONS.has(normalized)) continue;
      const before = line.slice(0, m.index);
      const inExecContext = /\bmodel\s*[:=]\s*$/i.test(before) || /\|\|\s*$/.test(before) || /\?\?\s*$/.test(before);
      if (!inExecContext) continue;
      violations.push({ file: relPath, line: i + 1, reason: `model literal '${lit}'`, text: raw.trim() });
    }
  }

  return { violations, suppressions };
}

describe('gate anti-hardcode de modelos (SPEC orquestrador-fonte-unica secao 6, AC-2)', () => {
  const allViolations: Violation[] = [];
  let totalSuppressions = 0;

  for (const dir of SCAN_DIRS) {
    for (const abs of listTsFiles(join(REPO_ROOT, dir))) {
      const rel = relative(REPO_ROOT, abs);
      if (isAllowlisted(rel)) continue;
      const { violations, suppressions } = scanFile(abs, rel);
      allViolations.push(...violations);
      totalSuppressions += suppressions;
    }
  }

  it('nao ha literal de modelo hardcoded fora da allowlist (AC-2)', () => {
    if (allViolations.length > 0) {
      const report = allViolations.map((v) => `  ${v.file}:${v.line}  [${v.reason}]  ${v.text}`).join('\n');
      throw new Error(
        `Gate anti-hardcode: ${allViolations.length} violacao(oes) de literal de modelo em ` +
          `contexto de execucao fora da allowlist.\n` +
          `Rote pela selection (fonte unica) ou, se for DADO legitimo, adicione a allowlist ` +
          `no proprio teste; caso arriscado, use // gate-allow: <motivo>.\n${report}`,
      );
    }
    expect(allViolations).toEqual([]);
  });

  it('o total de supressoes // gate-allow: e exatamente o esperado (crescimento aparece no diff)', () => {
    expect(totalSuppressions).toBe(EXPECTED_SUPPRESSIONS);
  });
});

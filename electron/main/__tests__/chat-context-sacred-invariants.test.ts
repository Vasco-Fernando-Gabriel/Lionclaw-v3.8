import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

let REPO_ROOT = '';
let BASE_REF: string | null = null;
try {
  REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  try {
    BASE_REF = execFileSync('git', ['merge-base', 'HEAD', 'main'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    BASE_REF = 'main';
  }
} catch {
  REPO_ROOT = '';
  BASE_REF = null;
}
const gitAvailable = REPO_ROOT !== '' && BASE_REF !== null;

function sourceRoot(): string {
  if (REPO_ROOT) return REPO_ROOT;
  return path.resolve(__dirname, '..', '..', '..');
}

const FROZEN_PATHS: string[] = [];

function frozenDiff(p: string): string {
  return execFileSync('git', ['diff', '--stat', BASE_REF as string, '--', p], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
}

describe('chat-context invariantes GENUINOS: frozen paths (parte A, git)', () => {
  for (const frozen of FROZEN_PATHS) {
    (gitAvailable ? it : it.skip)(`byte-identico vs base: ${frozen}`, () => {
      const diff = frozenDiff(frozen);
      expect(diff, `zona sagrada tocada pela campanha chat-context: ${frozen}\n${diff}`).toBe('');
    });
  }

  (gitAvailable && FROZEN_PATHS.length > 0 ? it : it.skip)(
    'o conjunto frozen inteiro mostra diff vazio vs base',
    () => {
      const diff = execFileSync('git', ['diff', '--stat', BASE_REF as string, '--', ...FROZEN_PATHS], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim();
      expect(diff, `um ou mais frozen paths mudaram:\n${diff}`).toBe('');
    },
  );
});

const ORCHESTRATOR = 'electron/main/orchestrator.ts';

const FORBIDDEN_IN_REMOVED: string[] = [
  'query({', // a invocacao do SDK
  'q.toggleMcpServer', // toggle de MCP no thread vivo
  'resume: sdkThreadId', // replay/thread resume
  '_forceNewSession', // controle de replay de sessao
];

function diffLines(p: string): { removed: string[]; added: string[] } {
  const diff = execFileSync('git', ['diff', BASE_REF as string, '--', p], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).split('\n');
  return {
    removed: diff.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1)),
    added: diff.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)),
  };
}

function countWith(lines: string[], token: string): number {
  return lines.filter((line) => line.includes(token)).length;
}

describe('chat-context orchestrator.ts ADITIVO (parte B, git)', () => {
  (gitAvailable ? it : it.skip)('nenhuma linha REMOVIDA toca a zona sagrada de executeClaudeSdkQuery', () => {
    const { removed, added } = diffLines(ORCHESTRATOR);
    const lostTokens = FORBIDDEN_IN_REMOVED.filter((tok) => countWith(removed, tok) > countWith(added, tok));
    const offenders = removed.filter((line) => lostTokens.some((tok) => line.includes(tok)));
    expect(
      offenders,
      `linhas removidas do orchestrator tocam a zona sagrada (query/replay/thread):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

const SACRED_ANCHORS: string[] = [
  'export async function executeClaudeSdkQuery(',
  'const q = query({',
  '{ resume: sdkThreadId }',
  'q.toggleMcpServer',
];

describe('chat-context ancoras sagradas presentes (parte C, estatica)', () => {
  it('orchestrator.ts ainda contem os marcadores verbatim de query()/replay/thread', () => {
    const abs = path.join(sourceRoot(), ORCHESTRATOR);
    const src = readFileSync(abs, 'utf8');
    for (const anchor of SACRED_ANCHORS) {
      expect(src.includes(anchor), `ancora sagrada sumiu do orchestrator: ${anchor}`).toBe(true);
    }
  });
});

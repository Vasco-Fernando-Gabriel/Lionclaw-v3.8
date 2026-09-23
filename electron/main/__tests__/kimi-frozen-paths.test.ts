import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

const FROZEN_PATHS: string[] = [
  'electron/main/agent-config-resolver.ts',
  'mcp-servers/lionclaw-agents',
  'mcp-servers/lionclaw-user-question',
  'mcp-servers/skills',
];

function frozenDiff(p: string): string {
  return execFileSync('git', ['diff', '--stat', 'HEAD', '--', p], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
}

describe('S6 FROZEN paths (SPRINT-S6 §3.2, GROUND-TRUTH §0)', () => {
  for (const frozen of FROZEN_PATHS) {
    it(`is byte-identical: ${frozen}`, () => {
      const abs = path.join(REPO_ROOT, frozen);
      const exists = (() => {
        try {
          execFileSync('git', ['ls-files', '--error-unmatch', frozen], {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'ignore', 'ignore'],
          });
          return true;
        } catch {
          try {
            const tracked = execFileSync('git', ['ls-files', frozen], {
              cwd: REPO_ROOT,
              encoding: 'utf8',
            }).trim();
            return tracked.length > 0;
          } catch {
            return false;
          }
        }
      })();
      expect(exists, `frozen path not tracked by git: ${abs}`).toBe(true);

      const diff = frozenDiff(frozen);
      expect(diff, `FROZEN path changed (S6 must be additive): ${frozen}\n${diff}`).toBe('');
    });
  }

  it('the whole frozen set together shows an empty diff vs HEAD', () => {
    const diff = execFileSync('git', ['diff', '--stat', 'HEAD', '--', ...FROZEN_PATHS], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    expect(diff, `One or more frozen paths changed:\n${diff}`).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';


interface CallerExpectation {
  file: string;
  expectedExecuteAgentCalls: number;
  expectedProfile: 'PERM_BYPASS_NO_GUARD' | 'PERM_DEFAULT_WITH_GUARD' | 'PERM_DEFAULT_NO_BYPASS';
}

const CALLERS: CallerExpectation[] = [
  {
    file: 'electron/main/harness-engine.ts',
    expectedExecuteAgentCalls: 0,
    expectedProfile: 'PERM_BYPASS_NO_GUARD',
  },
  {
    file: 'electron/main/pipeline-engine/index.ts',
    expectedExecuteAgentCalls: 1,
    expectedProfile: 'PERM_BYPASS_NO_GUARD',
  },
];

const repoRoot = path.resolve(__dirname, '../../..');

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

describe('R8 caller permission snapshot — pipeline-engine, harness-engine, codex-agents-mcp', () => {
  for (const caller of CALLERS) {
    it(`${caller.file} calls executeAgent ${caller.expectedExecuteAgentCalls}x with ${caller.expectedProfile}`, () => {
      const fullPath = path.join(repoRoot, caller.file);
      const source = readFileSync(fullPath, 'utf-8');

      const executeAgentCalls = countOccurrences(source, 'executeAgent({');
      const profileUses = countOccurrences(source, caller.expectedProfile);

      expect(executeAgentCalls).toBe(caller.expectedExecuteAgentCalls);
      if (caller.file.endsWith('harness-engine.ts')) {
        expect(source).toContain('const result = await executeAgent(request);');
      }
      expect(profileUses).toBeGreaterThanOrEqual(2);
    });
  }

  it('S1.1 enrich uses PERM_DEFAULT_WITH_GUARD + createEnrichPermissionGuard in harness-engine', () => {
    const source = readFileSync(path.join(repoRoot, 'electron/main/harness-engine.ts'), 'utf-8');
    const guardUses = countOccurrences(source, 'PERM_DEFAULT_WITH_GUARD');
    expect(guardUses, 'harness-engine should reference PERM_DEFAULT_WITH_GUARD at least 2x (1 import + 1 callsite)').toBeGreaterThanOrEqual(2);
    expect(source.includes("import { setActiveEnrichSpecPath, createEnrichPermissionGuard } from './permission-guard'"), 'harness-engine should import createEnrichPermissionGuard').toBe(true);
    expect(countOccurrences(source, 'createEnrichPermissionGuard('), 'harness-engine should call createEnrichPermissionGuard()').toBeGreaterThanOrEqual(1);
  });

  it('codex-agents-mcp preserva o caminho dedicado com ownership host-side', () => {
    const source = readFileSync(path.join(repoRoot, 'electron/main/codex-agents-mcp.ts'), 'utf-8');
    expect(source).not.toContain('dispatchLionSubagent');
    expect(source).toContain('executeAgent({');
    expect(source).toContain('permission: PERM_BYPASS_NO_GUARD');
    expect(source).toContain('cwd: host.workspace.cwd');
  });

  it('no caller uses PERM_DEFAULT_NO_BYPASS by mistake (D11:339-342)', () => {
    for (const caller of CALLERS) {
      const fullPath = path.join(repoRoot, caller.file);
      const source = readFileSync(fullPath, 'utf-8');
      const wrongProfile = countOccurrences(source, 'PERM_DEFAULT_NO_BYPASS');
      expect(wrongProfile, `${caller.file} should NOT use PERM_DEFAULT_NO_BYPASS`).toBe(0);
    }
  });
});

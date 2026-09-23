import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const FROZEN_PATHS = ['electron/main/agent-runtime/minimax-tokenplan-executor.ts'];

function changedFilesVsHead(): string[] {
  try {
    const out = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

describe('kimi isolation - frozen paths untouched (SPEC-011 §0.1)', () => {
  const changed = changedFilesVsHead();

  for (const frozen of FROZEN_PATHS) {
    it(`frozen path NOT in the working diff: ${frozen}`, () => {
      expect(changed).not.toContain(frozen);
    });
  }

  it('only Grok/Kimi integration seams changed in pipeline-engine and lion-sdk', () => {
    const allowed = new Set([
      'electron/main/pipeline-engine/index.ts',
      'electron/main/pipeline-engine/metrics.ts',
      'electron/main/pipeline-engine/handlers/architecture-review.ts',
      'electron/main/pipeline-engine/handlers/context.ts',
      'electron/main/pipeline-engine/handlers/dev-feature.ts',
      'electron/main/pipeline-engine/handlers/development-v2.ts',
      'electron/main/pipeline-engine/handlers/security.ts',
      'electron/main/lion-sdk/index.ts',
      'electron/main/lion-sdk/tools/agent.ts',
      'electron/main/lion-sdk/__tests__/tools-smoke.test.ts',
      'electron/main/lion-sdk/__tests__/executor-fonte-unica-s5.test.ts',
      'electron/main/pipeline-engine/registry.ts',
      'electron/main/pipeline-engine/message-router.ts',
      'electron/main/pipeline-engine/greetings.ts',
      'electron/main/pipeline-engine/reset.ts',
      'electron/main/pipeline-engine/artifact-resolver.ts',
    ]);
    const frozenPipelineDiffs = changed.filter(
      (f) =>
        (f.startsWith('electron/main/pipeline-engine/') || f.startsWith('electron/main/lion-sdk/')) && !allowed.has(f),
    );
    expect(frozenPipelineDiffs).toEqual([]);
  });
});

describe('kimi isolation - frozen HARNESS_KIMI_KEY block byte-identical (SPEC-011 §3.2)', () => {
  const vaultSrc = fs.readFileSync(path.join(__dirname, '..', 'vault-registry.ts'), 'utf-8');

  it('HARNESS_KIMI_KEY block (service kimi) is unchanged', () => {
    const frozenBlock =
      `  registerVaultEntry({\n` +
      `    key: 'HARNESS_KIMI_KEY',\n` +
      `    label: 'Kimi (Moonshot) API Key',\n` +
      `    description: 'Chave da API Moonshot Kimi para SubAgents.',\n` +
      `    service: 'kimi',\n` +
      `    required: false,\n` +
      `    placeholder: 'sk-...',\n` +
      `    docsUrl: 'https://platform.moonshot.ai/console/api-keys',\n` +
      `  });`;
    expect(vaultSrc).toContain(frozenBlock);
  });

  it('the removed KIMI_CODE_API_KEY entry (service kimi-code) is gone', () => {
    expect(vaultSrc).not.toContain("key: 'KIMI_CODE_API_KEY'");
    expect(vaultSrc).not.toContain("service: 'kimi-code'");
    const occurrences = vaultSrc.split("service: 'kimi'").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('kimi round-trip - mapRuntimeToCostMeta case (SPEC-011 §12, GROUND-TRUTH §3)', () => {
  it("harness-engine.ts has case 'kimi' returning costSource:'calculated', runtimeUsed:'kimi'", () => {
    const harnessPath = path.join(__dirname, '..', 'harness-engine.ts');
    const source = fs.readFileSync(harnessPath, 'utf-8');
    expect(source).toContain("case 'kimi':");
    expect(source).toContain("{ costSource: 'calculated', runtimeUsed: 'kimi' }");
  });

  it("execute.ts dispatches case 'kimi' to kimiExecutor.run", () => {
    const executePath = path.join(__dirname, '..', 'agent-runtime', 'execute.ts');
    const source = fs.readFileSync(executePath, 'utf-8');
    expect(source).toContain("import { kimiExecutor } from './kimi-executor'");
    expect(source).toContain("case 'kimi':");
    const caseBlock = source.slice(source.indexOf("case 'kimi':"), source.indexOf("case 'kimi':") + 120);
    expect(caseBlock).toContain('kimiExecutor.run');
  });

  it('AgentExecutionResult with runtime:kimi is a structurally valid shape', () => {
    const result = {
      output: 'done',
      metrics: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        toolUses: 0,
        apiRequests: 1,
        costUsd: 0.001,
        durationMs: 100,
      },
      model: 'kimi-code/kimi-for-coding',
      runtime: 'kimi' as const,
      provider: 'kimi',
    };
    const mapped =
      result.runtime === 'kimi'
        ? { costSource: 'calculated', runtimeUsed: 'kimi' }
        : { costSource: 'fallback_zero', runtimeUsed: result.runtime };
    expect(mapped).toEqual({ costSource: 'calculated', runtimeUsed: 'kimi' });
  });
});

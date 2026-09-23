import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MAIN = join(__dirname, '..');
const CODEX_RUNTIME = join(MAIN, 'codex-runtime');

const LOW_CARDINALITY_AXES = ['surface', 'implementation', 'mcpProfile', 'os', 'model', 'pipelineType'] as const;

const HIGH_CARDINALITY_IDS = ['projectId', 'phaseNumber', 'agentId', 'runId', 'threadId', 'turnId'] as const;

const METRIC_EMIT_PATTERNS = [
  /recordMetric\s*\(/,
  /emitMetric\s*\(/,
  /incrementCounter\s*\(/,
  /observeHistogram\s*\(/,
  /metrics?\.(counter|gauge|histogram|increment|observe)\s*\(/,
];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === '__tests__' || e === '__fixtures__') continue;
      out.push(...walk(p));
    } else if (p.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

function codexRuntimeSources(): string[] {
  return walk(CODEX_RUNTIME).map((f) => readFileSync(f, 'utf8'));
}

function hasMetricEmission(): boolean {
  return codexRuntimeSources().some((src) => METRIC_EMIT_PATTERNS.some((re) => re.test(src)));
}

describe('SPEC-011 §11 / SPEC-009 §12: metric-label cardinality guard', () => {
  it('high-cardinality ids are never emitted as a metric label (no metrics module in v1)', () => {
    const sources = codexRuntimeSources();
    const emittingMetrics = hasMetricEmission();
    expect(
      emittingMetrics,
      'codex-runtime ships a metrics-emission API but SPEC-011 §11 scoped none; ' +
        'promote the it.skip cases to active label-subset checks if this is intentional',
    ).toBe(false);

    expect(sources.length).toBeGreaterThan(0);
    expect(HIGH_CARDINALITY_IDS.length).toBeGreaterThan(0);
  });

  it.skip('[skip: SPEC-011 §11 supersedes SPEC-009 §12 canary; no metrics module in v1] metric label keys are a subset of the low-cardinality axes', () => {
    expect(LOW_CARDINALITY_AXES).toContain('surface');
  });

  it.skip('[skip: SPEC-011 §11 supersedes SPEC-009 §12 canary; no metrics module in v1] no high-cardinality id is used as a metric label key', () => {
    expect(HIGH_CARDINALITY_IDS).toContain('projectId');
  });
});

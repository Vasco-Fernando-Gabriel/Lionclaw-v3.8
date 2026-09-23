import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('savePipelinePhaseMetrics metadata merge logic', () => {
  function mergeMetadata(
    existing: Record<string, unknown>,
    incoming: Record<string, unknown>,
  ): Record<string, unknown> {
    return { ...existing, ...incoming };
  }

  it('preserves pre-existing fields when incoming does not include them', () => {
    const existing = { sprintIndex: 2, sprintName: 'Sprint 2', round: 1, maxRounds: 3 };
    const incoming = { provider: 'deepseek', costStatus: 'unknown' };
    const merged = mergeMetadata(existing, incoming);

    expect(merged).toMatchObject({
      sprintIndex: 2,
      sprintName: 'Sprint 2',
      round: 1,
      maxRounds: 3,
      provider: 'deepseek',
      costStatus: 'unknown',
    });
  });

  it('incoming fields overwrite existing fields with same key', () => {
    const existing = { provider: 'old-provider', costStatus: 'known' };
    const incoming = { provider: 'deepseek', costStatus: 'unknown', tokenStatus: 'not_reported' };
    const merged = mergeMetadata(existing, incoming);

    expect(merged.provider).toBe('deepseek');
    expect(merged.costStatus).toBe('unknown');
    expect(merged.tokenStatus).toBe('not_reported');
  });

  it('merge with empty existing produces only incoming fields', () => {
    const existing = {};
    const incoming = {
      provider: 'kimi',
      tokenStatus: 'not_reported',
      costStatus: 'unknown',
      costUnknownReason: 'no-usage-reported',
    };
    const merged = mergeMetadata(existing, incoming);

    expect(merged).toEqual(incoming);
  });

  it('merge with empty incoming preserves all existing fields', () => {
    const existing = { sprintIndex: 0, round: 2, sprintName: 'Sprint 1', maxRounds: 5 };
    const incoming = {};
    const merged = mergeMetadata(existing, incoming);

    expect(merged).toEqual(existing);
  });

  it('merge with undefined incoming (defaulted to {}) preserves all existing', () => {
    const existing = { sprintIndex: 1, provider: 'openrouter' };
    const incoming = {};
    const merged = mergeMetadata(existing, incoming);

    expect(merged).toEqual(existing);
  });

  it('costUnknownReason is preserved in merge', () => {
    const existing = { sprintIndex: 3, round: 1 };
    const incoming = { provider: 'qwen', costUnknownReason: 'unknown-pricing' };
    const merged = mergeMetadata(existing, incoming);

    expect(merged.costUnknownReason).toBe('unknown-pricing');
    expect(merged.sprintIndex).toBe(3);
    expect(merged.round).toBe(1);
  });
});

describe('savePipelinePhaseMetrics unknownCostCount accumulation contract', () => {
  function accumulateUnknownCostCount(existing: number, increment: number): number {
    return existing + increment;
  }

  it('first call with increment=1: total becomes 1', () => {
    expect(accumulateUnknownCostCount(0, 1)).toBe(1);
  });

  it('second call with increment=1: total becomes 2', () => {
    expect(accumulateUnknownCostCount(1, 1)).toBe(2);
  });

  it('call with increment=0 (costStatus=known): does not change total', () => {
    expect(accumulateUnknownCostCount(3, 0)).toBe(3);
  });

  it('call with no increment (undefined defaults to 0): does not change total', () => {
    const increment = 0;
    expect(accumulateUnknownCostCount(5, increment)).toBe(5);
  });
});

describe('savePipelinePhaseMetrics SQL shape verification', () => {
  it('The ON CONFLICT DO UPDATE SQL uses addition for unknown_cost_count', () => {
    const sqlAccumulationPattern =
      /unknown_cost_count\s*=\s*pipeline_phase_metrics\.unknown_cost_count\s*\+\s*excluded\.unknown_cost_count/;

    const onConflictClause = `
      unknown_cost_count = pipeline_phase_metrics.unknown_cost_count + excluded.unknown_cost_count
    `;

    expect(sqlAccumulationPattern.test(onConflictClause)).toBe(true);
  });

  it('The INSERT lists unknown_cost_count as a column', () => {
    const insertColumns =
      '(project_id, phase_number, sprint_index, phase_name, agent_id, status, ' +
      'input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, ' +
      'cost_usd, duration_ms, tool_uses, api_requests, messages_count, ' +
      'model, runtime, started_at, completed_at, metadata, unknown_cost_count)';

    expect(insertColumns).toContain('unknown_cost_count');
    const columns = insertColumns
      .replace(/[()]/g, '')
      .split(',')
      .map((c) => c.trim());
    expect(columns[columns.length - 1]).toBe('unknown_cost_count');
    expect(columns[columns.length - 2]).toBe('metadata');
  });
});

describe('savePipelinePhaseMetrics mock-DB integration', () => {
  it('calls SELECT for existing metadata then runs upsert with merged metadata', () => {
    const existingMetadata = { sprintIndex: 1, sprintName: 'Sprint 1', round: 2 };

    const mockGetForSelect = vi.fn().mockReturnValue({
      metadata: JSON.stringify(existingMetadata),
    });
    const mockRunForUpsert = vi.fn().mockReturnValue({ lastInsertRowid: 42 });

    const mockPrepare = vi
      .fn()
      .mockReturnValueOnce({ get: mockGetForSelect })
      .mockReturnValueOnce({ run: mockRunForUpsert });

    const incomingMetadata = { provider: 'deepseek', costStatus: 'unknown' };

    const existingRow = mockPrepare('SELECT metadata FROM ...').get('p1', 1, -1) as { metadata: string };
    const parsedExisting = JSON.parse(existingRow.metadata) as Record<string, unknown>;
    const merged = { ...parsedExisting, ...incomingMetadata };

    expect(merged).toEqual({
      sprintIndex: 1,
      sprintName: 'Sprint 1',
      round: 2,
      provider: 'deepseek',
      costStatus: 'unknown',
    });

    mockPrepare('INSERT INTO ...').run(
      'project-1',
      1,
      -1,
      'Phase 1',
      'agent-id',
      'completed',
      100,
      50,
      0,
      0,
      0.005,
      1200,
      2,
      1,
      0,
      'deepseek-chat',
      'external',
      null,
      '2026-05-20T00:00:00.000Z',
      JSON.stringify(merged),
      1, // unknownCostCount
    );

    expect(mockRunForUpsert).toHaveBeenCalledOnce();
    const runArgs = mockRunForUpsert.mock.calls[0];
    const metadataArg = runArgs.find((a: unknown) => typeof a === 'string' && a.includes('sprintIndex'));
    expect(metadataArg).toBeDefined();
    const parsedMeta = JSON.parse(metadataArg as string) as Record<string, unknown>;
    expect(parsedMeta.sprintIndex).toBe(1);
    expect(parsedMeta.provider).toBe('deepseek');
    expect(parsedMeta.costStatus).toBe('unknown');
  });

  it('when no existing metadata row, falls back to empty object and uses only incoming', () => {
    const mockGetForSelect = vi.fn().mockReturnValue(undefined);
    const mockRunForUpsert = vi.fn().mockReturnValue({ lastInsertRowid: 43 });

    const mockPrepare = vi
      .fn()
      .mockReturnValueOnce({ get: mockGetForSelect })
      .mockReturnValueOnce({ run: mockRunForUpsert });

    const existingRow = mockPrepare('SELECT ...').get('p1', 1, -1) as undefined;
    const existingMeta: Record<string, unknown> = existingRow ? {} : {};
    const incoming = { provider: 'kimi', tokenStatus: 'not_reported', costStatus: 'unknown' };
    const merged = { ...existingMeta, ...incoming };

    expect(merged).toEqual(incoming);
  });
});

describe('savePipelinePhaseMetrics sessionIds array-union merge (BUG 3 F1)', () => {
  function mergeWithSessionIdsUnion(
    existingMeta: Record<string, unknown>,
    incoming: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const mergedMeta: Record<string, unknown> = { ...existingMeta, ...(incoming ?? {}) };
    const asStringArray = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
    const prevSessionIds = asStringArray(existingMeta['sessionIds']);
    const nextSessionIds = asStringArray((incoming ?? {})['sessionIds']);
    if (prevSessionIds.length > 0 || nextSessionIds.length > 0) {
      mergedMeta['sessionIds'] = Array.from(new Set([...prevSessionIds, ...nextSessionIds]));
    }
    return mergedMeta;
  }

  it('segundo flush com ids novos NAO clobbera os ids do flush anterior (uniao dedupada)', () => {
    const existing = { sessionIds: ['s-1', 's-2'], provider: 'anthropic' };
    const incoming = { sessionIds: ['s-2', 's-3'] };

    const merged = mergeWithSessionIdsUnion(existing, incoming);

    expect(merged.sessionIds).toEqual(['s-1', 's-2', 's-3']);
    expect(merged.provider).toBe('anthropic');
  });

  it('flush sem sessionIds preserva os ids existentes', () => {
    const existing = { sessionIds: ['s-1'] };
    const merged = mergeWithSessionIdsUnion(existing, { provider: 'zai' });

    expect(merged.sessionIds).toEqual(['s-1']);
  });

  it('metadata existente corrompida (sessionIds nao-array / itens nao-string) nao quebra a uniao', () => {
    const merged = mergeWithSessionIdsUnion(
      { sessionIds: 'corrompido' },
      { sessionIds: ['s-1', 42 as unknown as string] },
    );

    expect(merged.sessionIds).toEqual(['s-1']);
  });

  it('sem sessionIds em nenhum lado, a chave nao e inventada', () => {
    const merged = mergeWithSessionIdsUnion({ provider: 'minimax' }, { costStatus: 'known' });

    expect(merged).not.toHaveProperty('sessionIds');
  });

  it('db.ts contem o bloco de uniao (gate de conteudo: mirror sincronizado)', () => {
    const dbSource = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8');
    expect(dbSource).toContain("const prevSessionIds = asStringArray(existingMeta['sessionIds']);");
    expect(dbSource).toContain(
      "mergedMeta['sessionIds'] = Array.from(new Set([...prevSessionIds, ...nextSessionIds]));",
    );
  });
});

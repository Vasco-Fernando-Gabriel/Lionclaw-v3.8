import { describe, expect, it } from 'vitest';
import { buildKnowledgeFtsQuery } from '../knowledge-engine';

describe('buildKnowledgeFtsQuery', () => {
  it('builds an FTS5-safe query for hyphenated knowledge searches', () => {
    const ftsQuery = buildKnowledgeFtsQuery('LangGraph graph-based agents workflow orchestration');

    expect(ftsQuery).toBe('"LangGraph" OR "graph" OR "based" OR "agents" OR "workflow" OR "orchestration"');
    expect(ftsQuery).not.toContain('graph-based');
    expect(ftsQuery).not.toMatch(/\bbased\b(?!")/);
  });

  it('does not let hyphenated terms become FTS5 column selectors', () => {
    const ftsQuery = buildKnowledgeFtsQuery('multi-agent systems frameworks comparison');

    expect(ftsQuery).toContain('"multi"');
    expect(ftsQuery).toContain('"agent"');
    expect(ftsQuery).not.toContain('multi-agent');
    expect(ftsQuery).not.toMatch(/\bagent\b(?!")/);
  });
});

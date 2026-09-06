
import { describe, it, expect } from 'vitest';
import {
  buildDynamicWorkflowEventsQuery,
  DEFAULT_EVENTS_QUERY_LIMIT,
} from '../dynamic-workflows/events-query';
import { COCKPIT_STRUCTURAL_EVENT_TYPES } from '../../../src/types/dynamic-workflow';

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

describe('buildDynamicWorkflowEventsQuery (D23)', () => {
  it('sem opts: run_id + ORDER BY seq ASC + LIMIT 1000 (comportamento legado)', () => {
    const q = buildDynamicWorkflowEventsQuery('run-1');
    expect(norm(q.sql)).toBe('SELECT * FROM dynamic_workflow_events WHERE run_id = ? ORDER BY seq ASC LIMIT ?');
    expect(q.params).toEqual(['run-1', DEFAULT_EVENTS_QUERY_LIMIT]);
    expect(q.backwards).toBe(false);
  });

  it('afterSeq: tail incremental (seq > ?) em ordem ASC', () => {
    const q = buildDynamicWorkflowEventsQuery('run-1', { afterSeq: 42, limit: 10 });
    expect(norm(q.sql)).toBe('SELECT * FROM dynamic_workflow_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?');
    expect(q.params).toEqual(['run-1', 42, 10]);
  });

  it('beforeSeq SEM afterSeq: pagina para TRAS (DESC LIMIT re-ordenado ASC)', () => {
    const q = buildDynamicWorkflowEventsQuery('run-1', { beforeSeq: 500, limit: 200 });
    expect(q.backwards).toBe(true);
    expect(norm(q.sql)).toBe(
      'SELECT * FROM ( SELECT * FROM dynamic_workflow_events WHERE run_id = ? AND seq < ? ORDER BY seq DESC LIMIT ? ) ORDER BY seq ASC',
    );
    expect(q.params).toEqual(['run-1', 500, 200]);
  });

  it('afterSeq + beforeSeq: janela fechada em ordem ASC (nao e paginacao para tras)', () => {
    const q = buildDynamicWorkflowEventsQuery('run-1', { afterSeq: 10, beforeSeq: 20 });
    expect(q.backwards).toBe(false);
    expect(norm(q.sql)).toBe(
      'SELECT * FROM dynamic_workflow_events WHERE run_id = ? AND seq > ? AND seq < ? ORDER BY seq ASC LIMIT ?',
    );
    expect(q.params).toEqual(['run-1', 10, 20, DEFAULT_EVENTS_QUERY_LIMIT]);
  });

  it('types: IN (?, ?) por IGUALDADE EXATA, um placeholder por tipo, sem glob/prefixo', () => {
    const q = buildDynamicWorkflowEventsQuery('run-1', { types: ['node-completed', 'gate-blocked'] });
    expect(norm(q.sql)).toBe(
      'SELECT * FROM dynamic_workflow_events WHERE run_id = ? AND type IN (?, ?) ORDER BY seq ASC LIMIT ?',
    );
    expect(q.params).toEqual(['run-1', 'node-completed', 'gate-blocked', DEFAULT_EVENTS_QUERY_LIMIT]);
    expect(q.sql).not.toMatch(/LIKE|GLOB/);
  });

  it('types vazio / entradas invalidas: sem filtro (nao gera IN ())', () => {
    for (const types of [[], ['', 3, null] as unknown as string[]]) {
      const q = buildDynamicWorkflowEventsQuery('run-1', { types });
      expect(q.sql).not.toContain('IN (');
      expect(q.params).toEqual(['run-1', DEFAULT_EVENTS_QUERY_LIMIT]);
    }
  });

  it('limit: inteiro >= 1; invalido/0/negativo cai no default ou no piso', () => {
    expect(buildDynamicWorkflowEventsQuery('r', { limit: 0 }).params.at(-1)).toBe(1);
    expect(buildDynamicWorkflowEventsQuery('r', { limit: -5 }).params.at(-1)).toBe(1);
    expect(buildDynamicWorkflowEventsQuery('r', { limit: 7.9 }).params.at(-1)).toBe(7);
    expect(buildDynamicWorkflowEventsQuery('r', { limit: Number.NaN }).params.at(-1)).toBe(DEFAULT_EVENTS_QUERY_LIMIT);
  });

  it('COCKPIT_STRUCTURAL_EVENT_TYPES cabe como `types` e contem os tipos exigidos pela SPEC D23', () => {
    const q = buildDynamicWorkflowEventsQuery('run-1', { types: [...COCKPIT_STRUCTURAL_EVENT_TYPES], beforeSeq: 9000 });
    expect(q.backwards).toBe(true);
    expect(q.params).toHaveLength(2 + COCKPIT_STRUCTURAL_EVENT_TYPES.length + 1);
    for (const t of [
      'node-started',
      'node-completed',
      'node-failed',
      'node-cache-hit',
      'node-retry-scheduled',
      'node-stalled',
      'phase-changed',
      'gate-blocked',
      'gate-approved',
      'gate-rejected',
      'green-check',
      'wake-planned',
      'wake-completed',
      'wake-runaway',
      'coordinator-finished',
      'gate-orphan-discarded',
      'rerun-requested',
      'run-failed',
      'run-aborted',
      'run-delivered',
      'run-finished',
    ]) {
      expect(COCKPIT_STRUCTURAL_EVENT_TYPES, t).toContain(t);
    }
    expect(COCKPIT_STRUCTURAL_EVENT_TYPES.some((t) => t.includes('*'))).toBe(false);
  });
});

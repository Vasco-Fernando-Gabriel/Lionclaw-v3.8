import type { DynamicWorkflowEventsQuery } from './types';

export const DEFAULT_EVENTS_QUERY_LIMIT = 1000;

export interface BuiltEventsQuery {
  sql: string;
  params: unknown[];
  backwards: boolean;
}

export function buildDynamicWorkflowEventsQuery(runId: string, opts?: DynamicWorkflowEventsQuery): BuiltEventsQuery {
  const rawLimit = opts?.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.max(1, Math.floor(rawLimit))
      : DEFAULT_EVENTS_QUERY_LIMIT;
  const types = Array.isArray(opts?.types)
    ? opts.types.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : [];
  const where: string[] = ['run_id = ?'];
  const params: unknown[] = [runId];
  const hasAfter = typeof opts?.afterSeq === 'number' && Number.isFinite(opts.afterSeq);
  const hasBefore = typeof opts?.beforeSeq === 'number' && Number.isFinite(opts.beforeSeq);
  if (hasAfter) {
    where.push('seq > ?');
    params.push(opts!.afterSeq);
  }
  if (hasBefore) {
    where.push('seq < ?');
    params.push(opts!.beforeSeq);
  }
  if (types.length > 0) {
    where.push(`type IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }
  const whereSql = where.join(' AND ');
  const backwards = hasBefore && !hasAfter;
  const sql = backwards
    ? `SELECT * FROM (
         SELECT * FROM dynamic_workflow_events WHERE ${whereSql} ORDER BY seq DESC LIMIT ?
       ) ORDER BY seq ASC`
    : `SELECT * FROM dynamic_workflow_events WHERE ${whereSql} ORDER BY seq ASC LIMIT ?`;
  params.push(limit);
  return { sql, params, backwards };
}

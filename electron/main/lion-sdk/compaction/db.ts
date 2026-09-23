import { getDb } from '../../db';

export type SummaryMode = 'text' | 'tools';

export interface SummaryRow {
  session_id: string;
  summary_text: string;
  covers_until_message_id: number;
  mode: SummaryMode;
  selection_hash: string;
  model_used: string;
  provider_used: string;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: number;
}

export interface SaveSummaryUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export function getCachedSummary(
  sessionId: string,
  coversUntilMessageId: number,
  mode: SummaryMode,
  selectionHash: string,
): SummaryRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM lion_session_summaries
       WHERE session_id = ? AND covers_until_message_id = ?
         AND mode = ? AND selection_hash = ?
       LIMIT 1`,
    )
    .get(sessionId, coversUntilMessageId, mode, selectionHash) as SummaryRow | undefined;
  return row ?? null;
}

export function saveCachedSummary(
  sessionId: string,
  coversUntilMessageId: number,
  mode: SummaryMode,
  selectionHash: string,
  summary: string,
  model: string,
  provider: string,
  usage: SaveSummaryUsage,
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO lion_session_summaries
       (session_id, covers_until_message_id, mode, selection_hash, summary_text, model_used,
        provider_used, input_tokens, output_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    coversUntilMessageId,
    mode,
    selectionHash,
    summary,
    model,
    provider,
    usage.inputTokens ?? null,
    usage.outputTokens ?? null,
    Date.now(),
  );
}

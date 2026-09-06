import { getDb } from '../../db';

export interface SummaryRow {
  session_id: string;
  summary_text: string;
  covers_until_message_id: number;
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
): SummaryRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM lion_session_summaries
       WHERE session_id = ? AND covers_until_message_id = ?
       LIMIT 1`,
    )
    .get(sessionId, coversUntilMessageId) as SummaryRow | undefined;
  return row ?? null;
}

export function saveCachedSummary(
  sessionId: string,
  coversUntilMessageId: number,
  summary: string,
  model: string,
  provider: string,
  usage: SaveSummaryUsage,
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO lion_session_summaries
       (session_id, covers_until_message_id, summary_text, model_used, provider_used,
        input_tokens, output_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    coversUntilMessageId,
    summary,
    model,
    provider,
    usage.inputTokens ?? null,
    usage.outputTokens ?? null,
    Date.now(),
  );
}

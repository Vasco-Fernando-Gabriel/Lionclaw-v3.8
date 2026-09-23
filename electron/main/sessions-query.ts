export const ALL_SESSIONS_SQL = `
  SELECT * FROM sessions
  WHERE type IN ('chat', 'manual', 'telegram')
    AND status != 'trashed'
    AND task_id IS NULL
    AND (title IS NULL OR title NOT LIKE '[Scheduler]%')
    AND id NOT LIKE 'dw-drive-%'
  ORDER BY updated_at DESC, created_at DESC
`;

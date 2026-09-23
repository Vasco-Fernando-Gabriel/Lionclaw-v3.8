import type Database from 'better-sqlite3';
import {
  TOOL_SCRIPT_DEFAULT_TOOLS,
  TOOL_SCRIPT_DEFAULT_TIMEOUT_MS,
  TOOL_SCRIPT_DEFAULT_MAX_STDOUT_BYTES,
  TOOL_SCRIPT_DEFAULT_MAX_STDERR_BYTES,
  TOOL_SCRIPT_DEFAULT_MAX_TOOL_CALLS,
} from '../tool-script/tool-script-types';

const TOOL_SCRIPT_SETTING_SEEDS: ReadonlyArray<readonly [string, string]> = [
  ['tool_script_enabled', 'true'],
  ['tool_script_tools', JSON.stringify(TOOL_SCRIPT_DEFAULT_TOOLS)],
  ['tool_script_timeout_ms', String(TOOL_SCRIPT_DEFAULT_TIMEOUT_MS)],
  ['tool_script_max_stdout_bytes', String(TOOL_SCRIPT_DEFAULT_MAX_STDOUT_BYTES)],
  ['tool_script_max_stderr_bytes', String(TOOL_SCRIPT_DEFAULT_MAX_STDERR_BYTES)],
  ['tool_script_max_tool_calls', String(TOOL_SCRIPT_DEFAULT_MAX_TOOL_CALLS)],
];

export function applyMigrationV128(db: Database.Database): void {
  const insert = db.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))");
  for (const [key, value] of TOOL_SCRIPT_SETTING_SEEDS) {
    insert.run(key, value);
  }
}

export const __V128_INTERNAL = {
  TOOL_SCRIPT_SETTING_SEEDS,
};

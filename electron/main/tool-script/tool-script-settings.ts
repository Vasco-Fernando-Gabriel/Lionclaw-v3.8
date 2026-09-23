import { createLogger } from '../logger';
import { getSetting } from '../db';
import {
  TOOL_SCRIPT_DEFAULT_TOOLS,
  TOOL_SCRIPT_DEFAULT_TIMEOUT_MS,
  TOOL_SCRIPT_DEFAULT_MAX_STDOUT_BYTES,
  TOOL_SCRIPT_DEFAULT_MAX_STDERR_BYTES,
  TOOL_SCRIPT_DEFAULT_MAX_TOOL_CALLS,
} from './tool-script-types';

const logger = createLogger('tool-script-settings');

export interface ToolScriptEffectiveSettings {
  enabled: boolean;
  enabledTools: readonly string[];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxToolCalls: number;
}

function safeGetSetting(key: string): string | undefined {
  try {
    return getSetting(key);
  } catch (err) {
    logger.warn({ err, key }, 'falha ao ler setting do tool-script; usando default');
    return undefined;
  }
}

function positiveIntSetting(key: string, defaultValue: number): number {
  const raw = safeGetSetting(key);
  if (raw === undefined || raw.trim().length === 0) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn({ key, raw }, 'setting do tool-script invalido; usando default');
    return defaultValue;
  }
  return parsed;
}

function enabledToolsSetting(): readonly string[] {
  const raw = safeGetSetting('tool_script_tools');
  if (raw === undefined || raw.trim().length === 0) return TOOL_SCRIPT_DEFAULT_TOOLS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('nao e array');
    const known = new Set(TOOL_SCRIPT_DEFAULT_TOOLS);
    const requested = new Set(parsed.filter((t): t is string => typeof t === 'string'));
    const tools = TOOL_SCRIPT_DEFAULT_TOOLS.filter((t) => known.has(t) && requested.has(t));
    if (tools.length === 0) {
      logger.warn({ raw }, 'tool_script_tools sem tool conhecida; usando as default');
      return TOOL_SCRIPT_DEFAULT_TOOLS;
    }
    return tools;
  } catch (err) {
    logger.warn({ err, raw }, 'tool_script_tools invalido (JSON); usando as default');
    return TOOL_SCRIPT_DEFAULT_TOOLS;
  }
}

export function isToolScriptSettingEnabled(): boolean {
  return safeGetSetting('tool_script_enabled') !== 'false';
}

export function readToolScriptSettings(): ToolScriptEffectiveSettings {
  return {
    enabled: isToolScriptSettingEnabled(),
    enabledTools: enabledToolsSetting(),
    timeoutMs: positiveIntSetting('tool_script_timeout_ms', TOOL_SCRIPT_DEFAULT_TIMEOUT_MS),
    maxStdoutBytes: positiveIntSetting('tool_script_max_stdout_bytes', TOOL_SCRIPT_DEFAULT_MAX_STDOUT_BYTES),
    maxStderrBytes: positiveIntSetting('tool_script_max_stderr_bytes', TOOL_SCRIPT_DEFAULT_MAX_STDERR_BYTES),
    maxToolCalls: positiveIntSetting('tool_script_max_tool_calls', TOOL_SCRIPT_DEFAULT_MAX_TOOL_CALLS),
  };
}

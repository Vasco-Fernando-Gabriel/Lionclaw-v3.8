import { describe, it, expect, beforeEach, vi } from 'vitest';

const settingsState = vi.hoisted(() => ({
  values: new Map<string, string>(),
  throwOnGet: false,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../db', () => ({
  getSetting: (key: string) => {
    if (settingsState.throwOnGet) throw new Error('db quebrado');
    return settingsState.values.get(key);
  },
}));

import { readToolScriptSettings, isToolScriptSettingEnabled } from '../tool-script/tool-script-settings';
import {
  TOOL_SCRIPT_DEFAULT_TOOLS,
  TOOL_SCRIPT_DEFAULT_TIMEOUT_MS,
  TOOL_SCRIPT_DEFAULT_MAX_STDOUT_BYTES,
  TOOL_SCRIPT_DEFAULT_MAX_STDERR_BYTES,
  TOOL_SCRIPT_DEFAULT_MAX_TOOL_CALLS,
} from '../tool-script/tool-script-types';

beforeEach(() => {
  settingsState.values = new Map();
  settingsState.throwOnGet = false;
});

describe('readToolScriptSettings - defaults (chaves ausentes)', () => {
  it('tudo ausente -> enabled true + as 7 tools + limites default', () => {
    const s = readToolScriptSettings();
    expect(s.enabled).toBe(true);
    expect(s.enabledTools).toEqual([...TOOL_SCRIPT_DEFAULT_TOOLS]);
    expect(s.timeoutMs).toBe(TOOL_SCRIPT_DEFAULT_TIMEOUT_MS);
    expect(s.maxStdoutBytes).toBe(TOOL_SCRIPT_DEFAULT_MAX_STDOUT_BYTES);
    expect(s.maxStderrBytes).toBe(TOOL_SCRIPT_DEFAULT_MAX_STDERR_BYTES);
    expect(s.maxToolCalls).toBe(TOOL_SCRIPT_DEFAULT_MAX_TOOL_CALLS);
  });
});

describe('readToolScriptSettings - valores validos honrados', () => {
  it('numeros customizados e subset de tools valem', () => {
    settingsState.values.set('tool_script_enabled', 'true');
    settingsState.values.set('tool_script_tools', JSON.stringify(['read_file', 'grep']));
    settingsState.values.set('tool_script_timeout_ms', '120000');
    settingsState.values.set('tool_script_max_stdout_bytes', '20000');
    settingsState.values.set('tool_script_max_stderr_bytes', '5000');
    settingsState.values.set('tool_script_max_tool_calls', '10');

    const s = readToolScriptSettings();
    expect(s.enabled).toBe(true);
    expect(s.enabledTools).toEqual(['read_file', 'grep']);
    expect(s.timeoutMs).toBe(120000);
    expect(s.maxStdoutBytes).toBe(20000);
    expect(s.maxStderrBytes).toBe(5000);
    expect(s.maxToolCalls).toBe(10);
  });

  it('tool_script_enabled=false desliga; qualquer outro valor liga', () => {
    settingsState.values.set('tool_script_enabled', 'false');
    expect(isToolScriptSettingEnabled()).toBe(false);
    expect(readToolScriptSettings().enabled).toBe(false);

    settingsState.values.set('tool_script_enabled', 'banana');
    expect(isToolScriptSettingEnabled()).toBe(true);
  });

  it('ordem canonica das tools preservada, independente da ordem no setting', () => {
    settingsState.values.set('tool_script_tools', JSON.stringify(['mcp_invoke', 'read_file']));
    expect(readToolScriptSettings().enabledTools).toEqual(['read_file', 'mcp_invoke']);
  });
});

describe('readToolScriptSettings - valores invalidos caem no default', () => {
  it('tools: JSON quebrado / nao-array / lista vazia / so nomes desconhecidos', () => {
    for (const bad of ['{nao-json', '"string"', '[]', '["tool_inventada"]', '[42]']) {
      settingsState.values.set('tool_script_tools', bad);
      expect(readToolScriptSettings().enabledTools).toEqual([...TOOL_SCRIPT_DEFAULT_TOOLS]);
    }
  });

  it('tools: nomes desconhecidos sao FILTRADOS quando ha conhecidos junto', () => {
    settingsState.values.set('tool_script_tools', JSON.stringify(['read_file', 'tool_inventada', 'run_command']));
    expect(readToolScriptSettings().enabledTools).toEqual(['read_file', 'run_command']);
  });

  it('numeros: NaN / negativo / zero / vazio caem no default', () => {
    for (const bad of ['abc', '-5', '0', '', '   ']) {
      settingsState.values.set('tool_script_timeout_ms', bad);
      settingsState.values.set('tool_script_max_stdout_bytes', bad);
      settingsState.values.set('tool_script_max_stderr_bytes', bad);
      settingsState.values.set('tool_script_max_tool_calls', bad);
      const s = readToolScriptSettings();
      expect(s.timeoutMs).toBe(TOOL_SCRIPT_DEFAULT_TIMEOUT_MS);
      expect(s.maxStdoutBytes).toBe(TOOL_SCRIPT_DEFAULT_MAX_STDOUT_BYTES);
      expect(s.maxStderrBytes).toBe(TOOL_SCRIPT_DEFAULT_MAX_STDERR_BYTES);
      expect(s.maxToolCalls).toBe(TOOL_SCRIPT_DEFAULT_MAX_TOOL_CALLS);
    }
  });
});

describe('readToolScriptSettings - getSetting lancando NUNCA propaga', () => {
  it('db quebrado -> defaults completos, sem throw (turno nao cai)', () => {
    settingsState.throwOnGet = true;
    let s: ReturnType<typeof readToolScriptSettings> | undefined;
    expect(() => {
      s = readToolScriptSettings();
    }).not.toThrow();
    expect(s?.enabled).toBe(true);
    expect(s?.enabledTools).toEqual([...TOOL_SCRIPT_DEFAULT_TOOLS]);
    expect(s?.timeoutMs).toBe(TOOL_SCRIPT_DEFAULT_TIMEOUT_MS);
  });
});

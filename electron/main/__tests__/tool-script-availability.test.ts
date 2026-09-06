
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  pythonAvailable: true,
  pythonReason: undefined as string | undefined,
  settings: new Map<string, string>(),
  servers: [] as Array<{ id: string; isActive: boolean }>,
}));

const updateMCPServerMock = vi.hoisted(() => vi.fn());
const startServerMock = vi.hoisted(() => vi.fn(async () => undefined));
const stopServerMock = vi.hoisted(() => vi.fn());
const syncCodexMcpConfigMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../db', () => ({
  getSetting: (key: string) => state.settings.get(key),
}));
vi.mock('../tool-script/tool-script-engine', () => ({
  isToolScriptAvailable: () => state.pythonAvailable,
  getToolScriptPythonPath: () =>
    state.pythonAvailable ? '/opt/homebrew/bin/python3' : undefined,
  getToolScriptAvailabilityReason: () =>
    state.pythonAvailable ? undefined : (state.pythonReason ?? 'python3 nao encontrado'),
}));
vi.mock('../mcp-manager', () => ({
  getAllMCPServers: () => state.servers,
  updateMCPServer: updateMCPServerMock,
  startServer: startServerMock,
  stopServer: stopServerMock,
}));
vi.mock('../codex-sdk/mcp-config-sync', () => ({
  syncCodexMcpConfig: syncCodexMcpConfigMock,
}));

import {
  resolveToolScriptRegistration,
  applyToolScriptEnabledChange,
} from '../tool-script/tool-script-availability';

beforeEach(() => {
  vi.clearAllMocks();
  state.pythonAvailable = true;
  state.pythonReason = undefined;
  state.settings = new Map();
  state.servers = [];
});


describe('resolveToolScriptRegistration', () => {
  it('python3 presente + setting habilitado (default) -> registra', () => {
    const d = resolveToolScriptRegistration();
    expect(d).toMatchObject({ register: true, available: true, enabled: true });
    expect(d.reason).toBeUndefined();
  });

  it('sem python3 -> NAO registra, razao cita python3 (AC-B10)', () => {
    state.pythonAvailable = false;
    state.pythonReason = 'python3 nao encontrado';
    const d = resolveToolScriptRegistration();
    expect(d.register).toBe(false);
    expect(d.available).toBe(false);
    expect(d.reason).toContain('python3 nao encontrado');
  });

  it('setting tool_script_enabled=false -> NAO registra, razao cita o setting (AC-B12)', () => {
    state.settings.set('tool_script_enabled', 'false');
    const d = resolveToolScriptRegistration();
    expect(d.register).toBe(false);
    expect(d.available).toBe(true);
    expect(d.enabled).toBe(false);
    expect(d.reason).toContain('tool_script_enabled=false');
  });

  it('sem python3 E setting false -> NAO registra; python3 domina a razao', () => {
    state.pythonAvailable = false;
    state.settings.set('tool_script_enabled', 'false');
    const d = resolveToolScriptRegistration();
    expect(d.register).toBe(false);
    expect(d.reason).toContain('python3');
  });
});


describe('applyToolScriptEnabledChange - desligar', () => {
  it('server registrado: stop + isActive=false + re-sync do codex', async () => {
    state.servers = [{ id: 'lionclaw-toolscript', isActive: true }];
    await applyToolScriptEnabledChange(false);

    expect(stopServerMock).toHaveBeenCalledWith('lionclaw-toolscript');
    expect(updateMCPServerMock).toHaveBeenCalledWith('lionclaw-toolscript', {
      isActive: false,
    });
    expect(syncCodexMcpConfigMock).toHaveBeenCalledTimes(1);
  });

  it('server NAO registrado: nenhum stop/update, mas re-sync roda (idempotente)', async () => {
    await applyToolScriptEnabledChange(false);
    expect(stopServerMock).not.toHaveBeenCalled();
    expect(updateMCPServerMock).not.toHaveBeenCalled();
    expect(syncCodexMcpConfigMock).toHaveBeenCalledTimes(1);
  });

  it('stop lancando NAO impede a desativacao nem o re-sync', async () => {
    state.servers = [{ id: 'lionclaw-toolscript', isActive: true }];
    stopServerMock.mockImplementationOnce(() => {
      throw new Error('stop falhou');
    });
    await expect(applyToolScriptEnabledChange(false)).resolves.toBeUndefined();
    expect(updateMCPServerMock).toHaveBeenCalledWith('lionclaw-toolscript', {
      isActive: false,
    });
    expect(syncCodexMcpConfigMock).toHaveBeenCalledTimes(1);
  });
});

describe('applyToolScriptEnabledChange - ligar', () => {
  it('linha presente: isActive=true + start + re-sync', async () => {
    state.servers = [{ id: 'lionclaw-toolscript', isActive: false }];
    await applyToolScriptEnabledChange(true);

    expect(updateMCPServerMock).toHaveBeenCalledWith('lionclaw-toolscript', {
      isActive: true,
    });
    expect(startServerMock).toHaveBeenCalledWith('lionclaw-toolscript');
    expect(syncCodexMcpConfigMock).toHaveBeenCalledTimes(1);
  });

  it('sem python3: no-op seguro (nada ativado, nada startado)', async () => {
    state.pythonAvailable = false;
    state.servers = [{ id: 'lionclaw-toolscript', isActive: false }];
    await applyToolScriptEnabledChange(true);

    expect(updateMCPServerMock).not.toHaveBeenCalled();
    expect(startServerMock).not.toHaveBeenCalled();
  });

  it('linha AUSENTE (boot pulou o registro): no-op logado, exige restart (v1)', async () => {
    await applyToolScriptEnabledChange(true);
    expect(updateMCPServerMock).not.toHaveBeenCalled();
    expect(startServerMock).not.toHaveBeenCalled();
  });

  it('start lancando NAO propaga (isActive gravado; restart resolve)', async () => {
    state.servers = [{ id: 'lionclaw-toolscript', isActive: false }];
    startServerMock.mockRejectedValueOnce(new Error('spawn falhou'));
    await expect(applyToolScriptEnabledChange(true)).resolves.toBeUndefined();
    expect(updateMCPServerMock).toHaveBeenCalledWith('lionclaw-toolscript', {
      isActive: true,
    });
    expect(syncCodexMcpConfigMock).toHaveBeenCalledTimes(1);
  });
});

describe('applyToolScriptEnabledChange - best-effort total', () => {
  it('re-sync do codex lancando NAO propaga', async () => {
    state.servers = [{ id: 'lionclaw-toolscript', isActive: true }];
    syncCodexMcpConfigMock.mockRejectedValueOnce(new Error('toml travado'));
    await expect(applyToolScriptEnabledChange(false)).resolves.toBeUndefined();
  });
});

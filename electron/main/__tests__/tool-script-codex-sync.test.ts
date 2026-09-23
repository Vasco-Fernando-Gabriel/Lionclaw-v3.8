import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  servers: [] as Array<Record<string, unknown>>,
}));

const generateWrapperMock = vi.hoisted(() => vi.fn());
const writeWrapperMock = vi.hoisted(() => vi.fn());
const listWrappersMock = vi.hoisted(() => vi.fn());
const deleteWrapperMock = vi.hoisted(() => vi.fn());

vi.mock('../db', () => ({
  getAllMCPServers: () => state.servers,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../mcp-manager', () => ({
  resolveGatewayScriptPath: () => '/opt/lionclaw/mcp-servers/gateway/dist/gateway/src/index.js',
}));

vi.mock('../codex-sdk/mcp-wrapper-generator', () => ({
  generateWrapper: generateWrapperMock,
  writeWrapper: writeWrapperMock,
  listWrappers: listWrappersMock,
  deleteWrapper: deleteWrapperMock,
}));

vi.mock('fs', () => {
  const promises = {
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  };
  return { default: { promises }, promises };
});

import { syncCodexMcpConfig } from '../codex-sdk/mcp-config-sync';
import { TOOL_SCRIPT_HELPER_ID } from '../mcp-risk-patterns';
import { CHAT_GATED_HELPER_IDS } from '../helper-identity';

function mcpServer(id: string, envKeys: string[] = []): Record<string, unknown> {
  return {
    id,
    name: `Server ${id}`,
    command: 'node',
    args: [`/path/${id}.js`],
    envKeys,
    isActive: true,
  };
}

function fetchTokenFlagFor(id: string): boolean | undefined {
  const call = generateWrapperMock.mock.calls.find((c) => c[0] === id);
  if (call === undefined) return undefined;
  const opts = call[5] as { fetchHelperToken?: boolean } | undefined;
  return opts?.fetchHelperToken;
}

beforeEach(() => {
  vi.clearAllMocks();
  generateWrapperMock.mockReturnValue('// wrapper source');
  writeWrapperMock.mockImplementation(async (id: string) => `/wrappers/${id}.js`);
  listWrappersMock.mockResolvedValue([]);
  deleteWrapperMock.mockResolvedValue(undefined);
});

describe('mcp-config-sync (codex): fetchHelperToken cobre o toolscript', () => {
  it('o helper always-on do Tool Script recebe wrapper com fetchHelperToken:true (mesmo sem envKeys)', async () => {
    state.servers = [mcpServer(TOOL_SCRIPT_HELPER_ID)];
    await syncCodexMcpConfig();
    expect(fetchTokenFlagFor(TOOL_SCRIPT_HELPER_ID)).toBe(true);
  });

  it('gated e toolscript ambos com fetchHelperToken:true; negocio sem envKeys NAO ganha wrapper', async () => {
    const gatedId = [...CHAT_GATED_HELPER_IDS][0];
    state.servers = [
      mcpServer(gatedId), // gated, sem envKeys
      mcpServer(TOOL_SCRIPT_HELPER_ID), // always-on, sem envKeys
      mcpServer('google-gmail', ['GMAIL_TOKEN']), // negocio COM envKeys
      mcpServer('shopify'), // negocio SEM envKeys -> sem wrapper
    ];
    await syncCodexMcpConfig();

    expect(fetchTokenFlagFor(gatedId)).toBe(true);
    expect(fetchTokenFlagFor(TOOL_SCRIPT_HELPER_ID)).toBe(true);
    expect(fetchTokenFlagFor('google-gmail')).toBe(false);
    expect(fetchTokenFlagFor('shopify')).toBeUndefined();
  });

  it('toolscript NAO e um gated helper (o branch `|| id === TOOL_SCRIPT_HELPER_ID` e load-bearing)', () => {
    expect(CHAT_GATED_HELPER_IDS.has(TOOL_SCRIPT_HELPER_ID)).toBe(false);
  });
});

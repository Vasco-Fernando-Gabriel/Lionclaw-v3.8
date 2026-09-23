import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const getSettingMock = vi.fn();
vi.mock('../db', () => ({
  getSetting: (k: string) => getSettingMock(k),
  setSetting: vi.fn(),
}));

const recordSystemActivityMock = vi.fn();
vi.mock('../activity-log', () => ({
  recordSystemActivity: (arg: unknown) => recordSystemActivityMock(arg),
}));

const queryMock = vi.fn((_args: unknown) => {
  throw new Error('query() do claude-agent-sdk NAO deveria rodar com orquestrador != claude-sdk');
});
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: unknown) => queryMock(args),
}));

import { discoverSDKMcpServers } from '../mcp-discovery';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mcp-discovery capability-gate (SPEC 4.4)', () => {
  it('orquestrador != claude-sdk -> pula query() e registra skip no Activity Log', async () => {
    getSettingMock.mockImplementation((k: string) => (k === 'orchestrator_runtime' ? 'kimi-sdk' : ''));

    const result = await discoverSDKMcpServers();

    expect(queryMock).not.toHaveBeenCalled();
    expect(recordSystemActivityMock).toHaveBeenCalledTimes(1);
    const arg = recordSystemActivityMock.mock.calls[0][0] as {
      label: string;
      description: string;
    };
    expect(arg.label).toContain('mcp-discovery');
    expect(arg.description).toContain('kimi-sdk');
    expect(Array.isArray(result)).toBe(true);
  });

  it('orquestrador vazio (nao configurado) -> tambem pula e registra skip', async () => {
    getSettingMock.mockReturnValue('');

    await discoverSDKMcpServers();

    expect(queryMock).not.toHaveBeenCalled();
    expect(recordSystemActivityMock).toHaveBeenCalledTimes(1);
  });
});

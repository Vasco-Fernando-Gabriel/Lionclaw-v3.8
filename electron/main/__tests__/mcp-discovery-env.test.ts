
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: unknown) => queryMock(args),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

const settings: Record<string, string | undefined> = {
  orchestrator_runtime: 'claude-sdk',
  orchestrator_model: 'claude-opus-5',
};
vi.mock('../db', () => ({
  getSetting: (key: string) => settings[key],
  setSetting: vi.fn(),
}));

const PROCESS_OPTIONS = {
  pathToClaudeCodeExecutable: '/tmp/native/claude.exe',
  executable: 'node' as const,
};
vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  getClaudeSdkProcessOptions: () => ({ ...PROCESS_OPTIONS }),
}));

import { SDK_DISALLOWED_TOOLS } from '../agent-runtime/sdk-tool-names';

type DiscoverFn = typeof import('../mcp-discovery').discoverSDKMcpServers;
let discoverSDKMcpServers: DiscoverFn;

function makeFakeQuery(statuses: unknown[]) {
  const iter = (async function* () {
  })();
  return Object.assign(iter, {
    mcpServerStatus: vi.fn(async () => statuses),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  ({ discoverSDKMcpServers } = await import('../mcp-discovery'));
  queryMock.mockImplementation(() => makeFakeQuery([{ name: 'srv', status: 'connected', tools: [] }]));
});

describe('mcp-discovery — query() do SDK (F22/D5, D16, D7)', () => {
  it('passa pathToClaudeCodeExecutable vindo de getClaudeSdkProcessOptions()', async () => {
    await discoverSDKMcpServers();
    expect(queryMock).toHaveBeenCalledTimes(1);
    const { options } = queryMock.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(options.pathToClaudeCodeExecutable).toBe(PROCESS_OPTIONS.pathToClaudeCodeExecutable);
    expect(options.executable).toBe('node');
  });

  it('env = process.env COMPLETA + MCP_CONNECTION_NONBLOCKING=0 (nunca parcial)', async () => {
    process.env.LIONCLAW_TEST_DISCOVERY_MARKER = 'marker-1';
    try {
      await discoverSDKMcpServers();
      const { options } = queryMock.mock.calls[0]![0] as { options: { env: Record<string, string | undefined> } };
      expect(options.env.MCP_CONNECTION_NONBLOCKING).toBe('0');
      expect(options.env.LIONCLAW_TEST_DISCOVERY_MARKER).toBe('marker-1');
      for (const [key, value] of Object.entries(process.env)) {
        if (key === 'MCP_CONNECTION_NONBLOCKING') continue;
        expect(options.env[key]).toBe(value);
      }
    } finally {
      delete process.env.LIONCLAW_TEST_DISCOVERY_MARKER;
    }
  });

  it('disallowedTools = SDK_DISALLOWED_TOOLS; allowedTools = []; sem lista positiva `tools`', async () => {
    await discoverSDKMcpServers();
    const { options } = queryMock.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(options.disallowedTools).toEqual([...SDK_DISALLOWED_TOOLS]);
    expect(options.allowedTools).toEqual([]);
    expect('tools' in options).toBe(false);
    expect(options.model).toBe('claude-opus-5');
    expect(options.maxTurns).toBe(1);
    expect(options.settingSources).toEqual(['project', 'user']);
  });

  it('devolve os statuses do mcpServerStatus()', async () => {
    const result = await discoverSDKMcpServers();
    expect(result).toEqual([{ name: 'srv', status: 'connected', tools: [] }]);
  });
});

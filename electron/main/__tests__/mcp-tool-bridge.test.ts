import { describe, it, expect, vi } from 'vitest';
import type { McpSessionClient } from '../mcp-tool-bridge';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  mcpToolToOpenAISchema,
  callMCPTool,
  classifyMcpStderr,
  setupMCPsForSession,
  teardownMCPsForSession,
} from '../mcp-tool-bridge';

function makeFakeClient(
  serverId: string,
  overrides?: Partial<{
    ownedBySession: boolean;
    proc: { kill: ReturnType<typeof vi.fn> } | undefined;
    pending: Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>;
    sendJsonRpc: ReturnType<typeof vi.fn>;
  }>,
): McpSessionClient {
  const pending = overrides?.pending ?? new Map();
  const proc = overrides?.proc ?? { kill: vi.fn() };

  return {
    connections: [
      {
        serverId,
        proc: proc as unknown as import('child_process').ChildProcess | undefined,
        ownedBySession: overrides?.ownedBySession ?? true,
        stdoutBuf: '',
        pending,
        nextId: 1,
        stdin: {
          write: vi.fn(),
        } as unknown as NodeJS.WritableStream,
      },
    ],
  };
}

describe('classifyMcpStderr', () => {
  it('downgrades routine MCP/proxy lifecycle stderr to debug', () => {
    expect(classifyMcpStderr('[233090] [Local->Remote] tools/list\n')).toBe('debug');
    expect(classifyMcpStderr('[233090] Local STDIO server running\n')).toBe('debug');
    expect(classifyMcpStderr('[233090] Shutting down...\n')).toBe('debug');
    expect(classifyMcpStderr('[skills] MCP server running on stdio\n')).toBe('debug');
    expect(classifyMcpStderr('[233090] {"jsonrpc":"2.0","method":"initialize"}\n')).toBe('debug');
  });

  it('keeps actual-looking failures as warn', () => {
    expect(classifyMcpStderr('Error: invalid token')).toBe('warn');
    expect(classifyMcpStderr('spawn failed: ENOENT')).toBe('warn');
  });
});

describe('mcpToolToOpenAISchema', () => {
  it('retorna type "function"', () => {
    const schema = mcpToolToOpenAISchema('knowledge-base', {
      name: 'search',
      description: 'Search the knowledge base',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    });
    expect(schema.type).toBe('function');
  });

  it('gera nome no formato mcp__<serverId>__<toolName>', () => {
    const schema = mcpToolToOpenAISchema('knowledge-base', { name: 'search' });
    expect(schema.function.name).toBe('mcp__knowledge-base__search');
  });

  it('preserva descricao original da tool', () => {
    const schema = mcpToolToOpenAISchema('google-drive', {
      name: 'list_files',
      description: 'Lista arquivos no Google Drive',
    });
    expect(schema.function.description).toBe('Lista arquivos no Google Drive');
  });

  it('usa descricao padrao quando description e undefined', () => {
    const schema = mcpToolToOpenAISchema('excalidraw', { name: 'draw' });
    expect(schema.function.description).toContain('draw');
    expect(schema.function.description).toContain('excalidraw');
  });

  it('copia properties do inputSchema', () => {
    const schema = mcpToolToOpenAISchema('knowledge-base', {
      name: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    });
    expect(schema.function.parameters.properties).toHaveProperty('query');
    expect(schema.function.parameters.properties).toHaveProperty('limit');
  });

  it('inclui "required" quando presente e nao-vazio', () => {
    const schema = mcpToolToOpenAISchema('srv', {
      name: 'tool',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
      },
    });
    expect(schema.function.parameters.required).toEqual(['a']);
  });

  it('omite "required" quando lista e vazia', () => {
    const schema = mcpToolToOpenAISchema('srv', {
      name: 'tool',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    });
    expect(schema.function.parameters.required).toBeUndefined();
  });

  it('funciona sem inputSchema (usa properties vazio)', () => {
    const schema = mcpToolToOpenAISchema('srv', { name: 'noop' });
    expect(schema.function.parameters.type).toBe('object');
    expect(schema.function.parameters.properties).toEqual({});
  });

  it('suporta serverId com hifens e underscores', () => {
    const schema = mcpToolToOpenAISchema('my-mcp_server', { name: 'my_tool' });
    expect(schema.function.name).toBe('mcp__my-mcp_server__my_tool');
  });

  it('suporta toolName com duplo underscore (remonta corretamente no callMCPTool)', () => {
    const schema = mcpToolToOpenAISchema('srv', { name: 'list__files' });
    expect(schema.function.name).toBe('mcp__srv__list__files');
  });
});

describe('callMCPTool: validacao de formato do nome', () => {
  it('lanca erro para tool sem prefixo mcp__', async () => {
    const client = makeFakeClient('srv');
    await expect(callMCPTool(client, 'plain_tool_name', {})).rejects.toThrow('nome de tool invalido');
  });

  it('lanca erro para tool com apenas 2 segmentos (mcp__srv)', async () => {
    const client = makeFakeClient('srv');
    await expect(callMCPTool(client, 'mcp__srv', {})).rejects.toThrow('nome de tool invalido');
  });

  it('lanca erro quando serverId nao tem conexao ativa', async () => {
    const client = makeFakeClient('knowledge-base');
    await expect(callMCPTool(client, 'mcp__google-drive__search', {})).rejects.toThrow(
      'nenhuma conexao ativa para servidor google-drive',
    );
  });
});

describe('callMCPTool: roteamento correto', () => {
  it('roteia para o server correto quando ha multiplas conexoes', async () => {
    const client: McpSessionClient = {
      connections: [
        {
          serverId: 'knowledge-base',
          proc: undefined,
          ownedBySession: true,
          stdoutBuf: '',
          pending: new Map(),
          nextId: 1,
          stdin: null,
        },
        {
          serverId: 'google-drive',
          proc: undefined,
          ownedBySession: true,
          stdoutBuf: '',
          pending: new Map(),
          nextId: 1,
          stdin: {
            write: vi.fn((data: string) => {
              const parsed = JSON.parse(data) as { id: number };
              const id = parsed.id;
              setImmediate(() => {
                const conn = client.connections.find((c) => c.serverId === 'google-drive');
                const cb = conn?.pending.get(id);
                if (cb) {
                  cb.resolve({ result: { content: [{ type: 'text', text: 'file-list' }] }, id });
                }
              });
            }),
          } as unknown as NodeJS.WritableStream,
        },
      ],
    };

    const result = await callMCPTool(client, 'mcp__google-drive__list_files', { folderId: 'root' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'file-list' }] });
  });
});

describe('callMCPTool: timeout por chamada (opts.timeoutMs, SPEC mcp-index-invoke 4.5)', () => {
  it('rejeita citando o valor quando o server nao responde dentro de opts.timeoutMs', async () => {
    const client = makeFakeClient('srv');
    await expect(callMCPTool(client, 'mcp__srv__slow_tool', {}, { timeoutMs: 50 })).rejects.toThrow(
      /timeout aguardando resposta para tools\/call \(50ms\)/,
    );
  });

  it('remove a requisicao pendente e rejeita imediatamente ao abortar', async () => {
    const client = makeFakeClient('srv');
    const abort = new AbortController();
    const call = callMCPTool(client, 'mcp__srv__slow_tool', {}, { timeoutMs: 5_000, signal: abort.signal });
    expect(client.connections[0]!.pending.size).toBe(1);
    abort.abort();

    await expect(call).rejects.toThrow(/tools\/call cancelada/);
    expect(client.connections[0]!.pending.size).toBe(0);
  });
});

describe('setupMCPsForSession', () => {
  it('retorna client com conexoes vazias e tools vazias para servers = {}', async () => {
    const { client, tools } = await setupMCPsForSession({});
    expect(client.connections).toHaveLength(0);
    expect(tools).toHaveLength(0);
  });
});

describe('teardownMCPsForSession', () => {
  it('chama kill() no proc quando ownedBySession = true', async () => {
    const killFn = vi.fn();
    const client = makeFakeClient('srv', {
      ownedBySession: true,
      proc: { kill: killFn },
    });

    await teardownMCPsForSession(client);
    expect(killFn).toHaveBeenCalledOnce();
  });

  it('NAO chama kill() quando ownedBySession = false', async () => {
    const killFn = vi.fn();
    const client = makeFakeClient('srv', {
      ownedBySession: false,
      proc: { kill: killFn },
    });

    await teardownMCPsForSession(client);
    expect(killFn).not.toHaveBeenCalled();
  });

  it('rejeita todos os callbacks pendentes com mensagem de teardown', async () => {
    const rejectFn = vi.fn();
    const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    pending.set(1, { resolve: vi.fn(), reject: rejectFn });
    pending.set(2, { resolve: vi.fn(), reject: rejectFn });

    const client = makeFakeClient('srv', { pending, proc: { kill: vi.fn() } });
    await teardownMCPsForSession(client);

    expect(rejectFn).toHaveBeenCalledTimes(2);
    const errorArg = rejectFn.mock.calls[0][0] as Error;
    expect(errorArg.message).toContain('srv');
  });

  it('limpa o mapa de pendentes apos teardown', async () => {
    const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    pending.set(1, { resolve: vi.fn(), reject: vi.fn() });

    const client = makeFakeClient('srv', { pending });
    await teardownMCPsForSession(client);

    expect(pending.size).toBe(0);
  });

  it('nao lanca erro quando proc e undefined', async () => {
    const client = makeFakeClient('srv', {
      proc: undefined,
      ownedBySession: true,
    });

    await expect(teardownMCPsForSession(client)).resolves.not.toThrow();
  });
});

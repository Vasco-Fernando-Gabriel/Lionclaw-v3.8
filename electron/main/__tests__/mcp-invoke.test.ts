
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';


interface RegistryRow {
  mcpId: string;
  toolName: string;
  description: string | null;
  inputSchema: string | null;
  lastDiscoveredAt: string | null;
}

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  registry: [] as Array<{
    mcpId: string;
    toolName: string;
    description: string | null;
    inputSchema: string | null;
    lastDiscoveredAt: string | null;
  }>,
  surfaceConfig: {} as Record<string, { command: string; args: string[]; env?: Record<string, string> }>,
  guardDecision: { behavior: 'allow' } as
    | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
    | { behavior: 'deny'; message: string },
}));

const guardFn = vi.hoisted(() => vi.fn());
const createPermissionGuardMock = vi.hoisted(() => vi.fn());
const getMCPConfigForAgentMock = vi.hoisted(() => vi.fn());
const getMcpToolRegistryEntriesMock = vi.hoisted(() => vi.fn());
const discoverMock = vi.hoisted(() => vi.fn());
const setupMock = vi.hoisted(() => vi.fn());
const callMock = vi.hoisted(() => vi.fn());
const teardownMock = vi.hoisted(() => vi.fn());

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../db', () => ({
  getSetting: vi.fn((key: string) => state.settings[key]),
}));

vi.mock('../permission-guard', () => ({
  createPermissionGuard: createPermissionGuardMock,
}));

vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: getMCPConfigForAgentMock,
  getMcpToolRegistryEntries: getMcpToolRegistryEntriesMock,
  discoverAndSaveMCPTools: discoverMock,
}));

vi.mock('../mcp-tool-bridge', () => ({
  setupMCPsForSession: setupMock,
  callMCPTool: callMock,
  teardownMCPsForSession: teardownMock,
}));

import {
  initMcpInvoke,
  invokeMcpTool,
  getMcpToolSchema,
  _resetMcpInvokeForTesting,
  type McpInvokeRequest,
} from '../mcp-invoke';


const CALENDAR_SCHEMA = JSON.stringify({
  type: 'object',
  required: ['calendar'],
  properties: { calendar: { type: 'string' }, max: { type: 'number' } },
});

function row(mcpId: string, toolName: string, overrides?: Partial<RegistryRow>): RegistryRow {
  return {
    mcpId,
    toolName,
    description: `Descricao de ${toolName}`,
    inputSchema: CALENDAR_SCHEMA,
    lastDiscoveredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeReq(overrides?: Partial<McpInvokeRequest>): McpInvokeRequest {
  return {
    serverId: 'srv',
    toolName: 'get_events',
    args: { calendar: 'primary' },
    surface: 'lion-sdk',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    allowedServerIds: ['srv', 'other', 'empty'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetMcpInvokeForTesting();

  state.settings = {};
  state.registry = [
    row('srv', 'get_events', { description: 'Lista eventos do calendario' }),
    row('srv', 'list_calendars', { description: 'Lista calendarios disponiveis' }),
    row('srv', 'delete_file', { description: 'Deleta um arquivo' }),
    row('other', 'send_email', { description: 'Envia um email' }),
  ];
  state.surfaceConfig = {
    srv: { command: 'node', args: ['srv.js'] },
    other: { command: 'node', args: ['other.js'] },
    empty: { command: 'node', args: ['empty.js'] },
  };
  state.guardDecision = { behavior: 'allow' };

  createPermissionGuardMock.mockImplementation(() => guardFn);
  guardFn.mockImplementation(async () => state.guardDecision);
  getMCPConfigForAgentMock.mockImplementation(async () => state.surfaceConfig);
  getMcpToolRegistryEntriesMock.mockImplementation((mcpId?: string) =>
    mcpId === undefined ? [...state.registry] : state.registry.filter((e) => e.mcpId === mcpId),
  );
  discoverMock.mockResolvedValue([]);
  setupMock.mockImplementation(async (servers: Record<string, unknown>) => ({
    client: { connections: Object.keys(servers).map((serverId) => ({ serverId })) },
    tools: [],
  }));
  callMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  teardownMock.mockResolvedValue(undefined);

  initMcpInvoke({ getWindow: () => null });
});

afterEach(() => {
  vi.useRealTimers();
});


describe('initMcpInvoke', () => {
  it('instancia createPermissionGuard com o supplier de janela injetado', () => {
    const getWindow = () => null;
    initMcpInvoke({ getWindow });
    expect(createPermissionGuardMock).toHaveBeenCalledWith(getWindow);
  });

  it('fail-closed: sem init, tool de risco NAO executa (isError, sem invoke)', async () => {
    _resetMcpInvokeForTesting(); // remove o guard instanciado no beforeEach
    const result = await invokeMcpTool(makeReq({ toolName: 'delete_file' }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('nao inicializado');
    expect(callMock).not.toHaveBeenCalled();
    expect(setupMock).not.toHaveBeenCalled();
  });
});


describe('escopo: allowedServerIds', () => {
  it('server fora do escopo -> erro claro SEM spawn e SEM guard', async () => {
    const result = await invokeMcpTool(
      makeReq({ serverId: 'forbidden', toolName: 'delete_file', allowedServerIds: ['srv'] }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('fora do escopo');
    expect(result.content).toContain('srv'); // lista os permitidos
    expect(result.displayName).toBe('mcp__forbidden__delete_file');
    expect(setupMock).not.toHaveBeenCalled();
    expect(callMock).not.toHaveBeenCalled();
    expect(guardFn).not.toHaveBeenCalled();
  });
});


describe('guard AC-13', () => {
  it('tool destrutiva consulta o guard com o nome REAL mcp__srv__delete_file e os args', async () => {
    const args = { path: '/tmp/x.txt' };
    await invokeMcpTool(makeReq({ toolName: 'delete_file', args }));
    expect(guardFn).toHaveBeenCalledTimes(1);
    expect(guardFn).toHaveBeenCalledWith('mcp__srv__delete_file', args);
  });

  it('guard deny -> resultado isError com a mensagem de negacao, SEM invocar', async () => {
    state.guardDecision = { behavior: 'deny', message: 'usuario negou no popup' };
    const result = await invokeMcpTool(makeReq({ toolName: 'delete_file' }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('negada pelo guard');
    expect(result.content).toContain('usuario negou no popup');
    expect(callMock).not.toHaveBeenCalled();
    expect(setupMock).not.toHaveBeenCalled();
  });

  it('guard allow -> executa normalmente', async () => {
    const result = await invokeMcpTool(makeReq({ toolName: 'delete_file' }));
    expect(guardFn).toHaveBeenCalledTimes(1);
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('ok');
  });

  it('tool safe (get_events) NAO consulta o guard', async () => {
    const result = await invokeMcpTool(makeReq({ toolName: 'get_events' }));
    expect(guardFn).not.toHaveBeenCalled();
    expect(result.content).toBe('ok');
    expect(result.displayName).toBe('mcp__srv__get_events');
  });
});


describe('classe (a): erro JSON-RPC / excecao do bridge', () => {
  it('retorna o erro original + schema truncado (required + tipos) + dica', async () => {
    callMock.mockRejectedValue(new Error('MCP JSON-RPC error: invalid params'));
    const result = await invokeMcpTool(makeReq());
    expect(result.isError).toBe(true);
    expect(result.displayName).toBe('mcp__srv__get_events');
    expect(result.content).toContain('invalid params');
    expect(result.content).toContain('Schema resumido de get_events');
    expect(result.content).toContain('required: calendar');
    expect(result.content).toContain('calendar: string');
    expect(result.content).toContain('max: number');
    expect(result.content).toContain('Dica:');
  });

  it('NAO dispara re-discovery em erro de validacao de args', async () => {
    callMock.mockRejectedValue(new Error('MCP JSON-RPC error: invalid params'));
    await invokeMcpTool(makeReq());
    expect(discoverMock).not.toHaveBeenCalled();
  });
});


describe('classe (b): result.isError do tools/call', () => {
  it('detecta isError=true no result (hoje passa como sucesso no bridge) e anexa schema', async () => {
    callMock.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'args invalidos: falta calendar' }],
    });
    const result = await invokeMcpTool(makeReq());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('args invalidos: falta calendar');
    expect(result.content).toContain('Schema resumido de get_events');
  });
});


describe('classe (c): did-you-mean', () => {
  it('tool inexistente retorna os 3 candidatos mais proximos DO MESMO server com descriptions, sem spawn', async () => {
    const result = await invokeMcpTool(makeReq({ toolName: 'get_event' }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Voce quis dizer');
    expect(result.content).toContain('- get_events: Lista eventos do calendario');
    expect(result.content).toContain('list_calendars');
    expect(result.content).toContain('delete_file');
    expect(result.content).not.toContain('send_email'); // fallback nao usado
    expect(setupMock).not.toHaveBeenCalled();
    expect(callMock).not.toHaveBeenCalled();
  });

  it('cap de 3 por turno: 4a tentativa retorna erro de cap', async () => {
    const r1 = await invokeMcpTool(makeReq({ toolName: 'ghost_a' }));
    const r2 = await invokeMcpTool(makeReq({ toolName: 'ghost_b' }));
    const r3 = await invokeMcpTool(makeReq({ toolName: 'ghost_c' }));
    const r4 = await invokeMcpTool(makeReq({ toolName: 'ghost_d' }));
    expect(r1.content).toContain('Voce quis dizer');
    expect(r2.content).toContain('Voce quis dizer');
    expect(r3.content).toContain('Voce quis dizer');
    expect(r4.isError).toBe(true);
    expect(r4.content).toContain('limite de 3');
    expect(r4.content).not.toContain('Voce quis dizer');
  });

  it('fallback: registry do server vazio + server respondeu tool desconhecida -> candidatos dos outros servers permitidos', async () => {
    callMock.mockRejectedValue(new Error('Unknown tool: foo'));
    const result = await invokeMcpTool(makeReq({ serverId: 'empty', toolName: 'foo' }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Voce quis dizer');
    expect(result.content).toContain('(servidor other)');
    expect(result.content).toContain('send_email');
  });
});


describe('classe (d): timeout', () => {
  it('usa mcp_invoke_timeout_ms do settings e cita o valor na mensagem', async () => {
    state.settings['mcp_invoke_timeout_ms'] = '1234';
    callMock.mockRejectedValue(
      new Error('MCP server srv: timeout aguardando resposta para tools/call (1234ms)'),
    );
    const result = await invokeMcpTool(makeReq());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Timeout de 1234ms');
    expect(result.content).toContain('mcp_invoke_timeout_ms');
    expect(result.content).toContain('Schema resumido de get_events');
    expect(callMock).toHaveBeenCalledWith(
      expect.anything(),
      'mcp__srv__get_events',
      { calendar: 'primary' },
      { timeoutMs: 1234 },
    );
  });

  it('default de 60_000ms quando o setting nao existe', async () => {
    await invokeMcpTool(makeReq());
    expect(callMock).toHaveBeenCalledWith(
      expect.anything(),
      'mcp__srv__get_events',
      { calendar: 'primary' },
      { timeoutMs: 60_000 },
    );
  });
});


describe('schema-on-error', () => {
  it('schema gigante e truncado no teto (~1200 chars) com marcador', async () => {
    const bigProps: Record<string, { type: string }> = {};
    for (let i = 0; i < 200; i++) {
      bigProps[`propriedade_com_nome_bem_comprido_${i}`] = { type: 'string' };
    }
    state.registry = [
      row('srv', 'get_events', {
        inputSchema: JSON.stringify({ type: 'object', required: ['a'], properties: bigProps }),
      }),
    ];
    callMock.mockRejectedValue(new Error('MCP JSON-RPC error: boom'));
    const result = await invokeMcpTool(makeReq());
    expect(result.content).toContain('[schema truncado]');
    const hint = result.content.slice(result.content.indexOf('Schema resumido'));
    expect(hint.length).toBeLessThanOrEqual(1200);
  });

  it('registro ausente (transicao pos-V126) -> mensagem transicional, nunca silencio', async () => {
    callMock.mockRejectedValue(new Error('MCP JSON-RPC error: boom'));
    const result = await invokeMcpTool(makeReq({ serverId: 'empty', toolName: 'foo' }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('schema indisponivel, re-discovery em andamento');
  });
});


describe('pool: lock por server', () => {
  it('2 invokes concorrentes do mesmo server -> 1 spawn so (promise cache)', async () => {
    callMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setImmediate(() => resolve({ content: [{ type: 'text', text: 'ok' }] }));
        }),
    );
    const [r1, r2] = await Promise.all([invokeMcpTool(makeReq()), invokeMcpTool(makeReq())]);
    expect(setupMock).toHaveBeenCalledTimes(1);
    expect(r1.content).toBe('ok');
    expect(r2.content).toBe('ok');
  });

  it('falha de spawn identifica o server e NAO envenena o lock (retry re-spawna)', async () => {
    setupMock.mockResolvedValueOnce({ client: { connections: [] }, tools: [] });
    const r1 = await invokeMcpTool(makeReq());
    expect(r1.isError).toBe(true);
    expect(r1.content).toContain('srv');
    const r2 = await invokeMcpTool(makeReq());
    expect(r2.content).toBe('ok');
    expect(setupMock).toHaveBeenCalledTimes(2);
  });
});

describe('pool: TTL de idle', () => {
  it('uso reseta o timer; expiracao chama o teardown limpo', async () => {
    vi.useFakeTimers();
    state.settings['mcp_pool_idle_ttl_ms'] = '1000';

    await invokeMcpTool(makeReq());
    expect(teardownMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);
    await invokeMcpTool(makeReq());
    await vi.advanceTimersByTimeAsync(600);
    expect(teardownMock).not.toHaveBeenCalled();
    expect(setupMock).toHaveBeenCalledTimes(1); // conexao reusada, sem re-spawn

    await vi.advanceTimersByTimeAsync(500);
    expect(teardownMock).toHaveBeenCalledTimes(1);

    await invokeMcpTool(makeReq());
    expect(setupMock).toHaveBeenCalledTimes(2);
  });
});


describe('re-discovery on-demand', () => {
  it('tool desconhecida dispara discovery 1x; segunda tool desconhecida do mesmo server no mesmo turno NAO redescobre', async () => {
    await invokeMcpTool(makeReq({ toolName: 'ghost_a' }));
    expect(discoverMock).toHaveBeenCalledTimes(1);
    expect(discoverMock).toHaveBeenCalledWith('srv');
    await invokeMcpTool(makeReq({ toolName: 'ghost_b' }));
    expect(discoverMock).toHaveBeenCalledTimes(1);
  });

  it('re-discovery que encontra a tool permite a execucao na MESMA chamada', async () => {
    state.registry = state.registry.filter((e) => e.toolName !== 'get_events');
    discoverMock.mockImplementation(async () => {
      state.registry.push(row('srv', 'get_events', { description: 'Lista eventos' }));
      return ['get_events'];
    });
    const result = await invokeMcpTool(makeReq({ toolName: 'get_events' }));
    expect(discoverMock).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('ok');
  });
});

describe('turn reset', () => {
  it('turnId novo zera os caps de did-you-mean e de re-discovery', async () => {
    await invokeMcpTool(makeReq({ toolName: 'ghost_a' }));
    await invokeMcpTool(makeReq({ toolName: 'ghost_b' }));
    await invokeMcpTool(makeReq({ toolName: 'ghost_c' }));
    const capped = await invokeMcpTool(makeReq({ toolName: 'ghost_d' }));
    expect(capped.content).toContain('limite de 3');
    expect(discoverMock).toHaveBeenCalledTimes(1);

    const fresh = await invokeMcpTool(makeReq({ toolName: 'ghost_e', turnId: 'turn-2' }));
    expect(fresh.content).toContain('Voce quis dizer');
    expect(discoverMock).toHaveBeenCalledTimes(2);
  });
});


describe('flatten do result', () => {
  it('content blocks [{type:text}] viram texto puro (nunca envelope JSON cru)', async () => {
    callMock.mockResolvedValue({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ],
    });
    const result = await invokeMcpTool(makeReq());
    expect(result.content).toBe('hello\nworld');
    expect(result.isError).toBeUndefined();
    expect(result.displayName).toBe('mcp__srv__get_events');
  });

  it('objeto sem content blocks vira JSON.stringify; null vira string vazia', async () => {
    callMock.mockResolvedValue({ items: [1, 2] });
    const r1 = await invokeMcpTool(makeReq());
    expect(r1.content).toBe('{"items":[1,2]}');

    callMock.mockResolvedValue(null);
    const r2 = await invokeMcpTool(makeReq());
    expect(r2.content).toBe('');
    expect(r2.displayName).toBe('mcp__srv__get_events');
  });
});


describe('getMcpToolSchema', () => {
  it('retorna o schema completo formatado legivel (descricao + JSON identado)', () => {
    const result = getMcpToolSchema('srv', 'get_events');
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Tool: get_events');
    expect(result.content).toContain('Servidor: srv');
    expect(result.content).toContain('Descricao: Lista eventos do calendario');
    expect(result.content).toContain('Input schema (JSON):');
    expect(result.content).toContain('"calendar"');
    expect(result.content).toContain('Descoberto em: 2026-01-01T00:00:00.000Z');
  });

  it('registro ausente (server sem linhas) -> mensagem transicional', () => {
    const result = getMcpToolSchema('empty', 'foo');
    expect(result.isError).toBe(true);
    expect(result.content).toContain('schema indisponivel, re-discovery em andamento');
  });

  it('tool inexistente com registry populado -> did-you-mean', () => {
    const result = getMcpToolSchema('srv', 'get_event');
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Tools proximas');
    expect(result.content).toContain('get_events');
  });
});

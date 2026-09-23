import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => undefined),
  insertAuditEntry: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getPermissionBypass: vi.fn(() => true),
  getCompletedDocsCount: vi.fn(() => 0),
}));

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: vi.fn(() => []),
  getMCPConfigForAgent: vi.fn(),
}));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(() => null) }));
vi.mock('../skills', () => ({
  listSkills: vi.fn(() => []),
  getSkill: vi.fn(() => null),
  buildSkillsPromptSection: vi.fn(() => ''),
  buildAgentSkillsPromptSection: vi.fn(() => ''),
}));
vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));

vi.mock('../mcp-invoke', () => ({
  invokeMcpTool: vi.fn(),
  getMcpToolSchema: vi.fn(),
}));

import { getMCPConfigForAgent } from '../mcp-manager';
import { invokeMcpTool, getMcpToolSchema } from '../mcp-invoke';
import { dispatch, type JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import { setActiveChatTurn, __resetChatCapabilityContextForTests } from '../chat-capability-context';

const GATEWAY_SESSION = 'gateway-123-abc';
const GATEWAY_TURN = '4';
const GATEWAY_BINDING = { sessionId: GATEWAY_SESSION, turnId: GATEWAY_TURN };

const mockGetConfig = getMCPConfigForAgent as ReturnType<typeof vi.fn>;
const mockInvoke = invokeMcpTool as ReturnType<typeof vi.fn>;
const mockGetSchema = getMcpToolSchema as ReturnType<typeof vi.fn>;

const ctx: JsonRpcContext = { getWindow: () => null };

function rpc(method: string, params: Record<string, unknown>) {
  return dispatch(ctx, { jsonrpc: '2.0', id: 7, method, params });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetChatCapabilityContextForTests();
  setActiveChatTurn({ sessionId: GATEWAY_SESSION, lane: 'desktop', turnId: GATEWAY_TURN });
  mockGetConfig.mockResolvedValue({
    'google-gmail': { command: 'node', args: ['/x/gmail.js'] },
    shopify: { command: 'node', args: ['/x/shopify.js'] },
    'lionclaw-pipeline-control': { command: 'node', args: ['/x/pc.js'] },
    'repo-graph': { command: 'node', args: ['/x/rg.js'] },
  });
  mockInvoke.mockResolvedValue({
    content: 'ok',
    displayName: 'mcp__google-gmail__send_email',
  });
  mockGetSchema.mockReturnValue({ content: 'schema aqui' });
});

describe('mcp_invoke — despacho pro wrapper central', () => {
  it('repassa server/tool/args + surface/sessionId/turnId e resolve o escopo (negocio - helpers)', async () => {
    const res = await rpc('mcp_invoke', {
      server: 'google-gmail',
      tool: 'send_email',
      args: { to: 'a@b.c' },
      surface: 'claude-compat-sdk',
      sessionId: 'gateway-123-abc',
      turnId: '4',
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      content: 'ok',
      displayName: 'mcp__google-gmail__send_email',
    });

    expect(mockGetConfig).toHaveBeenCalledWith(undefined, {
      surface: 'claude-compat-sdk',
      fullCatalog: true,
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith({
      serverId: 'google-gmail',
      toolName: 'send_email',
      args: { to: 'a@b.c' },
      surface: 'claude-compat-sdk',
      sessionId: 'gateway-123-abc',
      turnId: '4',
      allowedServerIds: ['google-gmail', 'shopify'],
      context: { surface: 'chat', sessionId: 'gateway-123-abc', turnId: '4', lane: 'desktop' },
    });
  });

  it('args ausente vira {}; surface desconhecido normaliza p/ claude-sdk; binding do turno real', async () => {
    await rpc('mcp_invoke', { server: 'shopify', tool: 'list_products', ...GATEWAY_BINDING });
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'shopify',
        toolName: 'list_products',
        args: {},
        surface: 'claude-sdk',
        sessionId: GATEWAY_SESSION,
        turnId: GATEWAY_TURN,
      }),
    );
  });

  it('sem binding de turno valido no desktop -> turn_binding_required e a tool NAO executa', async () => {
    const res = await rpc('mcp_invoke', { server: 'shopify', tool: 'list_products' });
    expect(res.error).toBeUndefined();
    expect((res.result as { isError?: boolean; content: string }).isError).toBe(true);
    expect((res.result as { content: string }).content).toContain('turn_binding_required');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('normaliza args serializado uma vez como JSON antes do wrapper central', async () => {
    const res = await rpc('mcp_invoke', {
      server: 'shopify',
      tool: 'list_products',
      args: '{"limit":25,"active":true}',
      ...GATEWAY_BINDING,
    });

    expect(res.error).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { limit: 25, active: true },
      }),
    );
  });

  it('rejeita args string invalido ou JSON que nao seja objeto', async () => {
    const invalidJson = await rpc('mcp_invoke', {
      ...GATEWAY_BINDING,
      server: 'shopify',
      tool: 'list_products',
      args: '{invalido',
    });
    expect(invalidJson.error).toEqual({
      code: -32000,
      message: expect.stringContaining('objeto JSON valido'),
    });

    const arrayJson = await rpc('mcp_invoke', {
      ...GATEWAY_BINDING,
      server: 'shopify',
      tool: 'list_products',
      args: '[]',
    });
    expect(arrayJson.error).toEqual({
      code: -32000,
      message: expect.stringContaining('deve ser um objeto JSON'),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('binding com turnId defasado para a sessao -> turn_binding_required (par atomico validado no main)', async () => {
    setActiveChatTurn({ sessionId: 'sess-real', lane: 'desktop', turnId: 'turn-real' });
    const res = await rpc('mcp_invoke', {
      server: 'shopify',
      tool: 'list_products',
      sessionId: 'sess-real',
      turnId: 'turn-velho',
    });
    expect((res.result as { isError?: boolean }).isError).toBe(true);
    expect(mockInvoke).not.toHaveBeenCalled();
    await rpc('mcp_invoke', { server: 'shopify', tool: 'list_products', sessionId: 'sess-real' });
    expect(mockInvoke).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-real', turnId: 'turn-real' }));
  });

  it('config vazio do surface -> allowedServerIds [] (o wrapper bloqueia por escopo)', async () => {
    mockGetConfig.mockResolvedValue(undefined);
    await rpc('mcp_invoke', { server: 'google-gmail', tool: 'send_email', ...GATEWAY_BINDING });
    expect(mockInvoke).toHaveBeenCalledWith(expect.objectContaining({ allowedServerIds: [] }));
  });

  it('param obrigatorio ausente -> RPC error -32000 (shape padrao do dispatch)', async () => {
    const semTool = await rpc('mcp_invoke', { server: 'google-gmail' });
    expect(semTool.result).toBeUndefined();
    expect(semTool.error).toEqual({
      code: -32000,
      message: expect.stringContaining('mcp_invoke'),
    });

    const semServer = await rpc('mcp_invoke', { tool: 'send_email' });
    expect(semServer.error?.code).toBe(-32000);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('excecao inesperada do wrapper -> RPC error -32000 com a mensagem real', async () => {
    mockInvoke.mockRejectedValue(new Error('boom interno'));
    const res = await rpc('mcp_invoke', { server: 'shopify', tool: 'x', ...GATEWAY_BINDING });
    expect(res.error).toEqual({ code: -32000, message: 'boom interno' });
  });
});

describe('mcp_get_schema — despacho pro getMcpToolSchema', () => {
  it('repassa server/tool e devolve o result do wrapper', async () => {
    const res = await rpc('mcp_get_schema', { server: 'google-gmail', tool: 'send_email' });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ content: 'schema aqui' });
    expect(mockGetSchema).toHaveBeenCalledWith('google-gmail', 'send_email');
  });

  it('isError do wrapper passa como RESULT (erro de fluxo normal, nao RPC error)', async () => {
    mockGetSchema.mockReturnValue({ content: 'tool nao existe', isError: true });
    const res = await rpc('mcp_get_schema', { server: 'google-gmail', tool: 'nope' });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ content: 'tool nao existe', isError: true });
  });

  it('param obrigatorio ausente -> RPC error -32000', async () => {
    const res = await rpc('mcp_get_schema', { server: 'google-gmail' });
    expect(res.error?.code).toBe(-32000);
    expect(mockGetSchema).not.toHaveBeenCalled();
  });
});

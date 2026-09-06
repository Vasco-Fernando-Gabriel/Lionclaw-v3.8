
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

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
import {
  setActiveChatTurn,
  __resetChatCapabilityContextForTests,
} from '../chat-capability-context';
import {
  createAccumulator,
  translateEvent,
} from '../codex-runtime/official-event-translator';
import { CODEX_GATEWAY_SERVER_ID } from '../mcp-display';

const mockGetConfig = getMCPConfigForAgent as ReturnType<typeof vi.fn>;
const mockInvoke = invokeMcpTool as ReturnType<typeof vi.fn>;
const mockGetSchema = getMcpToolSchema as ReturnType<typeof vi.fn>;

const ctx: JsonRpcContext = { getWindow: () => null };
const REPO_ROOT = path.resolve(__dirname, '../../..');

function rpc(method: string, params: Record<string, unknown>) {
  return dispatch(ctx, { jsonrpc: '2.0', id: 9, method, params });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockResolvedValue({
    'google-gmail': { command: 'node', args: ['/x/gmail.js'] },
    shopify: { command: 'node', args: ['/x/shopify.js'] },
    'repo-graph': { command: 'node', args: ['/x/rg.js'] },
  });
  mockInvoke.mockResolvedValue({
    content: 'ok',
    displayName: 'mcp__google-gmail__send_email',
  });
  mockGetSchema.mockReturnValue({ content: 'schema aqui' });
});

afterEach(() => {
  __resetChatCapabilityContextForTests();
});


describe('mcp_invoke — surface codex-sdk', () => {
  it('chega INTEGRO ao wrapper central e ao resolve de escopo (nunca coagido p/ claude-sdk)', async () => {
    const res = await rpc('mcp_invoke', {
      server: 'google-gmail',
      tool: 'send_email',
      args: { to: 'a@b.c' },
      surface: 'codex-sdk',
      sessionId: 'gateway-1-aa',
      turnId: '2',
    });

    expect(res.error).toBeUndefined();
    expect(mockGetConfig).toHaveBeenCalledWith(undefined, {
      surface: 'codex-sdk',
      fullCatalog: true,
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'codex-sdk',
        allowedServerIds: ['google-gmail', 'shopify'],
      }),
    );
  });

  it('surface desconhecido segue normalizando para claude-sdk (comportamento historico)', async () => {
    await rpc('mcp_invoke', { server: 'shopify', tool: 'list_products', surface: 'bogus' });
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'claude-sdk' }),
    );
  });
});

describe('visibilidade codex (wiring-audit de mcp-manager.ts)', () => {
  it("surface 'codex-sdk' cai no branch ['all','codex-lion-only']", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'electron/main/mcp-manager.ts'),
      'utf8',
    );
    expect(src).toMatch(
      /includeCodexLionOnly\s*=\s*surface === 'codex-sdk'[^;]*'lion-sdk'[^;]*'kimi-sdk'/,
    );
    expect(src).toContain("? ['all', 'codex-lion-only']");
  });
});


describe('mcp_get_schema — escopo por surface (gap da fase 1 corrigido)', () => {
  const SURFACES = ['claude-sdk', 'claude-compat-sdk', 'codex-sdk'] as const;

  for (const surface of SURFACES) {
    it(`[${surface}] server no catalogo => schema; escopo resolvido com o surface certo`, async () => {
      const res = await rpc('mcp_get_schema', {
        server: 'google-gmail',
        tool: 'send_email',
        surface,
      });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ content: 'schema aqui' });
      expect(mockGetSchema).toHaveBeenCalledWith('google-gmail', 'send_email');
      expect(mockGetConfig).toHaveBeenCalledWith(undefined, {
        surface,
        fullCatalog: true,
      });
    });

    it(`[${surface}] server FORA do catalogo => erro de catalogo, NUNCA o schema`, async () => {
      const res = await rpc('mcp_get_schema', {
        server: 'fora-do-escopo',
        tool: 'qualquer',
        surface,
      });
      expect(res.error).toBeUndefined();
      const result = res.result as { content: string; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content).toContain('nao esta no catalogo');
      expect(result.content).toContain('fora-do-escopo');
      expect(mockGetSchema).not.toHaveBeenCalled();
    });
  }

  it('helper DIRECT (repo-graph) fica fora do catalogo do schema tambem (P4)', async () => {
    const res = await rpc('mcp_get_schema', {
      server: 'repo-graph',
      tool: 'repo_graph_search',
      surface: 'codex-sdk',
    });
    const result = res.result as { content: string; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(mockGetSchema).not.toHaveBeenCalled();
  });

  it('sem surface no call => default claude-sdk (comportamento atual preservado)', async () => {
    await rpc('mcp_get_schema', { server: 'google-gmail', tool: 'send_email' });
    expect(mockGetConfig).toHaveBeenCalledWith(undefined, {
      surface: 'claude-sdk',
      fullCatalog: true,
    });
    expect(mockGetSchema).toHaveBeenCalled();
  });
});


describe('lane no dispatch do mcp_invoke', () => {
  beforeEach(() => {
    setActiveChatTurn({ sessionId: 'sess-desktop', lane: 'desktop', turnId: 'turn-d' });
    setActiveChatTurn({ sessionId: 'sess-telegram', lane: 'telegram', turnId: 'turn-t' });
  });

  it("lane 'telegram' resolve o turno da lane telegram (fecha a misatribuicao)", async () => {
    await rpc('mcp_invoke', {
      server: 'shopify',
      tool: 'list_products',
      surface: 'codex-sdk',
      lane: 'telegram',
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-telegram', turnId: 'turn-t' }),
    );
  });

  it('param lane AUSENTE => fallback desktop byte-identico (gateway claude/compat)', async () => {
    await rpc('mcp_invoke', { server: 'shopify', tool: 'list_products' });
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-desktop', turnId: 'turn-d' }),
    );
  });

  it('lane desconhecida normaliza para desktop (nunca lane inventada)', async () => {
    await rpc('mcp_invoke', { server: 'shopify', tool: 'list_products', lane: 'marte' });
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-desktop', turnId: 'turn-d' }),
    );
  });

  it('mcp_get_schema aceita o param lane sem quebrar (read puro, sem turno)', async () => {
    const res = await rpc('mcp_get_schema', {
      server: 'google-gmail',
      tool: 'send_email',
      surface: 'codex-sdk',
      lane: 'telegram',
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ content: 'schema aqui' });
  });
});


describe('gateway/src/index.ts — contrato dos calls (audit da fonte)', () => {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'mcp-servers/gateway/src/index.ts'),
    'utf8',
  );

  it("union do SURFACE ganha 'codex-sdk' (via env LIONCLAW_MCP_SURFACE)", () => {
    expect(src).toContain("'claude-sdk' | 'claude-compat-sdk' | 'codex-sdk'");
    expect(src).toContain("process.env['LIONCLAW_MCP_SURFACE'] === 'codex-sdk'");
  });

  it('mcp_get_schema envia surface (e lane) como o invoke — nunca so server+tool', () => {
    const schemaCall = src.slice(src.indexOf("callMethod('mcp_get_schema'"));
    const schemaParams = schemaCall.slice(0, schemaCall.indexOf(');'));
    expect(schemaParams).toContain('surface: SURFACE');
    expect(schemaParams).toContain('LANE !== undefined');
  });

  it('lane vem do env LIONCLAW_MCP_LANE e so vira param quando presente', () => {
    expect(src).toContain("process.env['LIONCLAW_MCP_LANE']");
    const occurrences = src.split("...(LANE !== undefined ? { lane: LANE } : {})").length - 1;
    expect(occurrences).toBe(2);
  });
});


describe('translator do app-server — alvo real da meta-tool do gateway', () => {
  function itemEvent(item: Record<string, unknown>, method = 'item/started') {
    return { method, params: { item } };
  }

  it('mcp_invoke via lionclaw-gateway com args {server,tool} => label do alvo real', () => {
    const acc = createAccumulator();
    const onToolUse = vi.fn();
    translateEvent(
      itemEvent({
        type: 'mcpToolCall',
        id: 'c1',
        server: CODEX_GATEWAY_SERVER_ID,
        tool: 'mcp_invoke',
        arguments: { server: 'google-gmail', tool: 'send_email', args: {} },
      }),
      acc,
      { callbacks: { onToolUse } },
    );
    expect(onToolUse).toHaveBeenCalledWith('mcp:google-gmail.send_email', {
      callId: 'c1',
      kind: 'mcp',
    });
  });

  it('arguments como JSON string tambem deriva; completed usa o mesmo label', () => {
    const acc = createAccumulator();
    const onToolUseComplete = vi.fn();
    translateEvent(
      itemEvent(
        {
          type: 'mcpToolCall',
          id: 'c2',
          server: CODEX_GATEWAY_SERVER_ID,
          tool: 'mcp_schema',
          arguments: JSON.stringify({ server: 'shopify', tool: 'list_products' }),
          result: { content: [{ type: 'text', text: 'ok' }] },
        },
        'item/completed',
      ),
      acc,
      { callbacks: { onToolUseComplete } },
    );
    expect(onToolUseComplete).toHaveBeenCalledWith(
      'mcp:shopify.list_products',
      expect.anything(),
      { callId: 'c2' },
    );
  });

  it('args parciais/malformados mantem o label do gateway (nunca token mentiroso)', () => {
    const acc = createAccumulator();
    const onToolUse = vi.fn();
    translateEvent(
      itemEvent({
        type: 'mcpToolCall',
        id: 'c3',
        server: CODEX_GATEWAY_SERVER_ID,
        tool: 'mcp_invoke',
        arguments: '{corrompido',
      }),
      acc,
      { callbacks: { onToolUse } },
    );
    expect(onToolUse).toHaveBeenCalledWith(`mcp:${CODEX_GATEWAY_SERVER_ID}.mcp_invoke`, {
      callId: 'c3',
      kind: 'mcp',
    });
  });

  it('MCP call comum (nao-gateway) fica byte-identico ao label atual', () => {
    const acc = createAccumulator();
    const onToolUse = vi.fn();
    translateEvent(
      itemEvent({
        type: 'mcpToolCall',
        id: 'c4',
        server: 'google-gmail',
        tool: 'send_email',
        arguments: { to: 'a@b.c' },
      }),
      acc,
      { callbacks: { onToolUse } },
    );
    expect(onToolUse).toHaveBeenCalledWith('mcp:google-gmail.send_email', {
      callId: 'c4',
      kind: 'mcp',
    });
  });
});

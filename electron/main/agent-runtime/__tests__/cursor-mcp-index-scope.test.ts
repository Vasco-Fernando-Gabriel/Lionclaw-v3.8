import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMcpToolSchema, invokeMcpTool } = vi.hoisted(() => ({
  getMcpToolSchema: vi.fn(),
  invokeMcpTool: vi.fn(),
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: async () => ({ allowed: { command: 'node', args: ['allowed.js'] } }),
  getMcpToolRegistryEntries: () => [
    {
      mcpId: 'allowed',
      toolName: 'visible',
      description: 'Tool permitida',
      inputSchema: JSON.stringify({ type: 'object', properties: {}, additionalProperties: false }),
    },
  ],
}));
vi.mock('../../mcp-invoke', () => ({
  getMcpToolSchema,
  invokeMcpTool,
}));

import { buildCursorSessionTools } from '../cursor-session-config';
import type { CursorToolInvocation } from '../cursor-sidecar/sidecar-manager';

function invocation(name: string, args: Record<string, unknown>): CursorToolInvocation {
  return { executionId: 'exec-scope', toolName: name, args };
}

beforeEach(() => {
  getMcpToolSchema.mockReset();
  getMcpToolSchema.mockReturnValue({ isError: false, content: 'schema permitido' });
  invokeMcpTool.mockReset();
  invokeMcpTool.mockResolvedValue({ isError: false, content: 'ok', displayName: 'allowed/visible' });
});

describe('Cursor MCP index scope (paridade grok)', () => {
  it('mcp_schema nao consulta o registry para server fora de allowedServerIds', async () => {
    const abort = new AbortController();
    const built = await buildCursorSessionTools({
      profile: 'chat',
      systemPrompt: '',
      scope: { sessionId: 'sess-scope', turnId: 'turn-scope' },
      abortSignal: abort.signal,
    });
    const schema = built.handlers['mcp_schema'];
    expect(schema).toBeDefined();

    await expect(
      schema!(invocation('mcp_schema', { server: 'hidden', tool: 'secret' }), { signal: abort.signal }),
    ).rejects.toThrow('nao pertence ao escopo');
    expect(getMcpToolSchema).not.toHaveBeenCalled();

    const allowed = await schema!(invocation('mcp_schema', { server: 'allowed', tool: 'visible' }), {
      signal: abort.signal,
    });
    expect(allowed).toBe('schema permitido');
    expect(getMcpToolSchema).toHaveBeenCalledWith('allowed', 'visible');
  });

  it('nega tool fora da allowlist exata mesmo dentro de server permitido', async () => {
    const abort = new AbortController();
    const built = await buildCursorSessionTools({
      profile: 'chat',
      systemPrompt: '',
      scope: { sessionId: 'sess-scope', turnId: 'turn-scope' },
      abortSignal: abort.signal,
    });
    const invoke = built.handlers['mcp_invoke']!;
    const schema = built.handlers['mcp_schema']!;

    await expect(
      invoke(invocation('mcp_invoke', { server: 'allowed', tool: 'secret', args: {} }), { signal: abort.signal }),
    ).rejects.toThrow('nao pertence ao escopo');
    await expect(
      schema(invocation('mcp_schema', { server: 'allowed', tool: 'secret' }), { signal: abort.signal }),
    ).rejects.toThrow('nao pertence ao escopo');
    expect(invokeMcpTool).not.toHaveBeenCalled();
    expect(getMcpToolSchema).not.toHaveBeenCalled();
  });
});

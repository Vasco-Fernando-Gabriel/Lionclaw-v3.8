import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { callTool, KIMI_MCP_MAX_ERROR_CHARS, toListItem } from '../mcp-bridge-tools';
import type { KimiExternalTool } from '../../agent-runtime/kimi-external-tools';

describe('toListItem (pure adapter, AC-B2.1)', () => {
  it('passes a populated parameters schema through as inputSchema verbatim', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: { agentId: { type: 'string' }, prompt: { type: 'string' } },
      required: ['agentId', 'prompt'],
    };
    const tool: KimiExternalTool = {
      name: 'lion_run_subagent',
      description: 'run a subagent',
      parameters: schema,
      handler: vi.fn(async () => ({ output: 'x', message: 'ok' })),
    };
    const item = toListItem(tool);
    expect(item).toEqual({
      name: 'lion_run_subagent',
      description: 'run a subagent',
      inputSchema: schema,
    });
    expect(item.inputSchema).toBe(schema);
  });

  it('defaults inputSchema to an empty object schema when parameters is an empty object', () => {
    const tool: KimiExternalTool = {
      name: 'lion_noargs',
      description: 'no args',
      parameters: {},
      handler: vi.fn(async () => ({ output: 'x', message: 'ok' })),
    };
    expect(toListItem(tool).inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('preserves the materialized name verbatim, including a catalog mcp__server__tool name (DB4)', () => {
    const tool: KimiExternalTool = {
      name: 'mcp__google_calendar__list_events',
      description: 'list events',
      parameters: { type: 'object', properties: {} },
      handler: vi.fn(async () => ({ output: 'x', message: 'ok' })),
    };
    expect(toListItem(tool).name).toBe('mcp__google_calendar__list_events');
  });
});

describe('callTool (handler reuse + never-rethrow, AC-B2.2 / DB3)', () => {
  it('wraps a {output, message} return as {content:[{type:text,text:output}]} with isError unset', async () => {
    const tool: KimiExternalTool = {
      name: 'lion_run_subagent',
      description: 'run a subagent',
      parameters: { type: 'object', properties: {} },
      handler: vi.fn(async () => ({ output: 'the answer', message: 'ok' })),
    };
    const result = await callTool(tool, { agentId: 'x', prompt: 'y' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'the answer' }] });
    expect(result.isError).toBeUndefined();
    expect(tool.handler).toHaveBeenCalledTimes(1);
    expect(tool.handler).toHaveBeenCalledWith({ agentId: 'x', prompt: 'y' });
  });

  it('catches a hand-thrown handler error as isError:true and NEVER rethrows', async () => {
    const tool: KimiExternalTool = {
      name: 'lion_boom',
      description: 'boom',
      parameters: { type: 'object', properties: {} },
      handler: vi.fn(async () => {
        throw new Error('kaboom');
      }),
    };
    const result = await callTool(tool, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/bridge tool error/);
    expect(result.content[0].text).toMatch(/kaboom/);
  });

  it('preserva isError de uma falha tratada pelo handler', async () => {
    const tool: KimiExternalTool = {
      name: 'lion_run_subagent',
      description: 'run a subagent',
      parameters: { type: 'object', properties: {} },
      handler: vi.fn(async () => ({ output: 'child failed', message: 'subagent failed', isError: true })),
    };
    expect(await callTool(tool, {})).toEqual({
      content: [{ type: 'text', text: 'bridge tool error: child failed' }],
      isError: true,
    });
  });

  it('redige secrets e paths e trunca erros antes de devolve-los ao modelo', async () => {
    const tool: KimiExternalTool = {
      name: 'lion_secret_failure',
      description: 'fail',
      parameters: { type: 'object', properties: {} },
      handler: vi.fn(async () => {
        throw new Error(
          `Bearer bearer-secret token=token-secret https://user:pass@example.com/private /home/user/private.txt C:\\Users\\user\\secret.txt ${'x'.repeat(1_000)}`,
        );
      }),
    };
    const result = await callTool(tool, {});
    const text = result.content[0]!.text;
    expect(result.isError).toBe(true);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('bearer-secret');
    expect(text).not.toContain('token-secret');
    expect(text).not.toContain('user:pass');
    expect(text).not.toContain('/home/user');
    expect(text).not.toContain('C:\\Users');
    expect(text.length).toBeLessThanOrEqual('bridge tool error: '.length + KIMI_MCP_MAX_ERROR_CHARS);
    expect(text.endsWith('…')).toBe(true);
  });

  it('catches the SDK .parse() throw on schema-invalid args (createExternalTool) as isError:true', async () => {
    const sdk = await import('@moonshot-ai/kimi-agent-sdk');
    const builderBodyRan = vi.fn();
    const tool = sdk.createExternalTool({
      name: 'lion_run_subagent',
      description: 'run a subagent',
      parameters: z.object({ agentId: z.string(), prompt: z.string() }),
      handler: async (params: { agentId: string; prompt: string }) => {
        try {
          builderBodyRan();
          return { output: params.agentId, message: 'ok' };
        } catch {
          return { output: 'inner-caught', message: 'failed' };
        }
      },
    }) as unknown as KimiExternalTool;

    const result = await callTool(tool, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/bridge tool error/);
    expect(builderBodyRan).not.toHaveBeenCalled();
  });
});

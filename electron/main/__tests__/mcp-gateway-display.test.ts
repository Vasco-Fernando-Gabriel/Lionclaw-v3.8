
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  upsertActivityLog: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  deriveMcpGatewayDisplayName,
  GATEWAY_INVOKE_TOOL_NAME,
  GATEWAY_SCHEMA_TOOL_NAME,
} from '../mcp-display';
import { processAgentStream } from '../stream-processor';
import { deriveToolDetail, recordActivity } from '../activity-log';
import { upsertActivityLog } from '../db';
import type { LiveActivityEvent, StreamChunk } from '../../../src/types';

const mockUpsert = upsertActivityLog as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});


describe('deriveMcpGatewayDisplayName', () => {
  it('mapeia invoke e schema do gateway para o alvo real', () => {
    expect(
      deriveMcpGatewayDisplayName(GATEWAY_INVOKE_TOOL_NAME, {
        server: 'gmail',
        tool: 'send_email',
        args: { to: 'a@b.c' },
      }),
    ).toBe('mcp__gmail__send_email');
    expect(
      deriveMcpGatewayDisplayName(GATEWAY_SCHEMA_TOOL_NAME, {
        server: 'google-drive',
        tool: 'delete_file',
      }),
    ).toBe('mcp__google-drive__delete_file');
  });

  it('tool normal (nao-gateway) -> null (caller mantem o nome)', () => {
    expect(deriveMcpGatewayDisplayName('mcp__google-gmail__send_email', { server: 'x', tool: 'y' })).toBeNull();
    expect(deriveMcpGatewayDisplayName('Bash', { command: 'ls' })).toBeNull();
    expect(deriveMcpGatewayDisplayName(undefined, { server: 'x', tool: 'y' })).toBeNull();
  });

  it('args invalidos/incompletos/malformados -> null', () => {
    expect(deriveMcpGatewayDisplayName(GATEWAY_INVOKE_TOOL_NAME, null)).toBeNull();
    expect(deriveMcpGatewayDisplayName(GATEWAY_INVOKE_TOOL_NAME, {})).toBeNull();
    expect(deriveMcpGatewayDisplayName(GATEWAY_INVOKE_TOOL_NAME, { server: 'gmail' })).toBeNull();
    expect(deriveMcpGatewayDisplayName(GATEWAY_INVOKE_TOOL_NAME, { server: '', tool: 'x' })).toBeNull();
    expect(
      deriveMcpGatewayDisplayName(GATEWAY_INVOKE_TOOL_NAME, { server: 'a b', tool: 'x' }),
    ).toBeNull();
  });
});


async function* fakeStream(events: Array<Record<string, unknown>>) {
  for (const e of events) yield e;
}

function toolUseEvents(toolName: string, input: Record<string, unknown>) {
  return [
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: toolName, input: {} },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    },
  ];
}

describe('processAgentStream — AC-9 no complete da tool', () => {
  it('gateway invoke com args {server, tool} -> onToolUseComplete recebe o alvo real', async () => {
    const onToolUse = vi.fn();
    const onToolUseComplete = vi.fn();
    await processAgentStream(
      fakeStream(
        toolUseEvents(GATEWAY_INVOKE_TOOL_NAME, {
          server: 'gmail',
          tool: 'send_email',
          args: { to: 'a@b.c' },
        }),
      ),
      { onToolUse, onToolUseComplete },
    );

    expect(onToolUse).toHaveBeenCalledWith(GATEWAY_INVOKE_TOOL_NAME);
    expect(onToolUseComplete).toHaveBeenCalledTimes(1);
    expect(onToolUseComplete).toHaveBeenCalledWith('mcp__gmail__send_email', {
      server: 'gmail',
      tool: 'send_email',
      args: { to: 'a@b.c' },
    });
  });

  it('tool MCP normal -> display atual (nome inalterado)', async () => {
    const onToolUseComplete = vi.fn();
    await processAgentStream(
      fakeStream(toolUseEvents('mcp__google-gmail__send_email', { to: 'a@b.c' })),
      { onToolUseComplete },
    );
    expect(onToolUseComplete).toHaveBeenCalledWith('mcp__google-gmail__send_email', {
      to: 'a@b.c',
    });
  });

  it('gateway invoke com input imprestavel -> mantem o nome da meta-tool', async () => {
    const onToolUseComplete = vi.fn();
    await processAgentStream(
      fakeStream(toolUseEvents(GATEWAY_INVOKE_TOOL_NAME, { foo: 'bar' })),
      { onToolUseComplete },
    );
    expect(onToolUseComplete).toHaveBeenCalledWith(GATEWAY_INVOKE_TOOL_NAME, { foo: 'bar' });
  });
});


describe('deriveToolDetail — meta-tool do gateway', () => {
  it('gateway invoke -> description carrega o alvo real', () => {
    const detail = deriveToolDetail(GATEWAY_INVOKE_TOOL_NAME, {
      server: 'gmail',
      tool: 'send_email',
      args: { to: 'a@b.c' },
    });
    expect(detail).toEqual({ description: 'mcp__gmail__send_email' });
  });

  it('tool normal segue o fluxo atual (fallback generico intacto)', () => {
    expect(deriveToolDetail('Bash', { command: 'ls -la' })).toEqual({ command: 'ls -la' });
    expect(
      deriveToolDetail('mcp__google-gmail__send_email', { query: 'oi' }),
    ).toEqual({ description: 'oi' });
  });
});

describe('recordActivity — label de exibicao do invoke via gateway (AC-9)', () => {
  function emit(ev: LiveActivityEvent): StreamChunk[] {
    const sent: StreamChunk[] = [];
    recordActivity('sess-1', 3, ev, (chunk) => sent.push(chunk));
    return sent;
  }

  it('evento do gateway com description = alvo real -> label vira o alvo real (stream + persistencia)', () => {
    const sent = emit({
      id: 'tool-1',
      kind: 'tool',
      phase: 'update',
      label: GATEWAY_INVOKE_TOOL_NAME,
      toolName: GATEWAY_INVOKE_TOOL_NAME,
      description: 'mcp__gmail__send_email',
    } as LiveActivityEvent);

    expect(sent).toHaveLength(1);
    const activity = (sent[0] as { activity: LiveActivityEvent }).activity;
    expect(activity.label).toBe('mcp__gmail__send_email');
    expect(activity.toolName).toBe(GATEWAY_INVOKE_TOOL_NAME);

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const persisted = mockUpsert.mock.calls[0][2] as LiveActivityEvent;
    expect(persisted.label).toBe('mcp__gmail__send_email');
  });

  it('evento do gateway SEM alvo no description -> label original (sem mentira)', () => {
    const sent = emit({
      id: 'tool-2',
      kind: 'tool',
      phase: 'start',
      label: GATEWAY_INVOKE_TOOL_NAME,
      toolName: GATEWAY_INVOKE_TOOL_NAME,
    } as LiveActivityEvent);
    const activity = (sent[0] as { activity: LiveActivityEvent }).activity;
    expect(activity.label).toBe(GATEWAY_INVOKE_TOOL_NAME);
  });

  it('tool MCP normal -> label atual (nao ha remapeamento)', () => {
    const sent = emit({
      id: 'tool-3',
      kind: 'tool',
      phase: 'update',
      label: 'mcp__google-gmail__send_email',
      toolName: 'mcp__google-gmail__send_email',
      description: 'mcp__isso__nao-conta',
    } as LiveActivityEvent);
    const activity = (sent[0] as { activity: LiveActivityEvent }).activity;
    expect(activity.label).toBe('mcp__google-gmail__send_email');
  });
});

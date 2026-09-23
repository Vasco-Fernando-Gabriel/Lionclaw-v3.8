import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { StreamChunk } from '../../../../src/types';

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../db', () => ({
  insertAuditEntry: vi.fn(),
  upsertActivityLog: vi.fn(),
}));

vi.mock('../../artifact-detector', () => ({
  captureToolUse: vi.fn(() => null),
  captureToolResult: vi.fn(() => null),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('lion stream-translator activity parity', () => {
  it('emitToolCall emits activity phase:start with command derived (Bash)', async () => {
    const { createLionStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const t = createLionStreamTranslator({
      sessionId: 'sess-1',
      emit: (chunk) => emitted.push(chunk),
    });

    t.emitToolCall('tu-1', 'Bash', { command: 'node -v' });

    expect(emitted[0]).toEqual({ type: 'tool_call', tool: 'Bash', input: { command: 'node -v' } });
    const start = emitted[1];
    expect(start.type).toBe('activity');
    expect(start.activity?.kind).toBe('tool');
    expect(start.activity?.phase).toBe('start');
    expect(start.activity?.label).toBe('Bash');
    expect(start.activity?.status).toBe('running');
    expect(start.activity?.command).toBe('node -v');
    expect(start.activity?.id).toBe('tu-1');
  });

  it('emitToolCall derives file for read/write tools', async () => {
    const { createLionStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const t = createLionStreamTranslator({
      sessionId: 'sess-2',
      emit: (chunk) => emitted.push(chunk),
    });

    t.emitToolCall('tu-read', 'Read', { file_path: '/tmp/a.ts' });

    const start = emitted[1];
    expect(start.type).toBe('activity');
    expect(start.activity?.phase).toBe('start');
    expect(start.activity?.file).toBe('/tmp/a.ts');
  });

  it('emitToolResult emits activity phase:end with changed:true for write (no error)', async () => {
    const { createLionStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const t = createLionStreamTranslator({
      sessionId: 'sess-3',
      emit: (chunk) => emitted.push(chunk),
    });

    t.emitToolResult('tu-3', 'Write', 'ok', false);

    expect(emitted[0]).toEqual({ type: 'tool_result', tool: 'Write', result: 'ok' });
    const end = emitted[1];
    expect(end.type).toBe('activity');
    expect(end.activity?.phase).toBe('end');
    expect(end.activity?.label).toBe('Write');
    expect(end.activity?.status).toBe('done');
    expect(end.activity?.changed).toBe(true);
    expect(end.activity?.id).toBe('tu-3');
  });

  it('emitToolResult emits changed:false for read tool (no error) — CHANGED-PARITY', async () => {
    const { createLionStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const t = createLionStreamTranslator({
      sessionId: 'sess-4',
      emit: (chunk) => emitted.push(chunk),
    });

    t.emitToolResult('tu-4', 'Read', 'file contents', false);

    const end = emitted[1];
    expect(end.type).toBe('activity');
    expect(end.activity?.phase).toBe('end');
    expect(end.activity?.status).toBe('done');
    expect(end.activity?.changed).toBe(false);
  });

  it('emitToolResult emits status:error and changed:undefined when isError', async () => {
    const { createLionStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const t = createLionStreamTranslator({
      sessionId: 'sess-5',
      emit: (chunk) => emitted.push(chunk),
    });

    t.emitToolResult('tu-5', 'Write', 'boom', true);

    const end = emitted[1];
    expect(end.type).toBe('activity');
    expect(end.activity?.phase).toBe('end');
    expect(end.activity?.status).toBe('error');
    expect(end.activity?.changed).toBeUndefined();
  });

  it('does not emit activity for mcp:* tools (call_agent covered elsewhere)', async () => {
    const { createLionStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const t = createLionStreamTranslator({
      sessionId: 'sess-6',
      emit: (chunk) => emitted.push(chunk),
    });

    t.emitToolCall('tu-6', 'mcp:server.tool', { query: 'x' });
    t.emitToolResult('tu-6', 'mcp:server.tool', 'ok', false);

    expect(emitted.some((c) => c.type === 'activity')).toBe(false);
    expect(emitted[0]).toEqual({ type: 'tool_call', tool: 'mcp:server.tool', input: { query: 'x' } });
    expect(emitted[1]).toEqual({ type: 'tool_result', tool: 'mcp:server.tool', result: 'ok' });
  });
});

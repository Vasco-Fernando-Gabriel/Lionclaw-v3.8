import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveActivityEvent, StreamChunk } from '../../../src/types';

const mocks = vi.hoisted(() => ({
  upsertActivityLog: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../db', () => ({
  upsertActivityLog: mocks.upsertActivityLog,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.loggerError,
    debug: vi.fn(),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('activity-log', () => {
  it('normalizes orphan tool updates before streaming and persisting', async () => {
    const { recordActivity } = await import('../activity-log');
    const emitted: StreamChunk[] = [];

    recordActivity(
      'sess-1',
      2,
      {
        id: 'toolu_1',
        kind: 'tool',
        phase: 'update',
        label: 'ToolSearch',
        toolName: 'ToolSearch',
      },
      (chunk) => emitted.push(chunk),
    );

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      type: 'activity',
      activity: expect.objectContaining({
        id: 'toolu_1',
        kind: 'tool',
        phase: 'update',
        label: 'ToolSearch',
        toolName: 'ToolSearch',
        status: 'running',
        turnIndex: 2,
      }),
    });
    expect(mocks.upsertActivityLog).toHaveBeenCalledWith(
      'sess-1',
      2,
      expect.objectContaining({
        id: 'toolu_1',
        status: 'running',
      }),
    );
  });

  it('preserves intentional blank labels on end events', async () => {
    const { recordActivity } = await import('../activity-log');
    const emitted: StreamChunk[] = [];

    recordActivity(
      'sess-1',
      3,
      {
        id: 'toolu_2',
        kind: 'tool',
        phase: 'end',
        label: '',
      },
      (chunk) => emitted.push(chunk),
    );

    expect(emitted[0].activity).toEqual(
      expect.objectContaining({
        id: 'toolu_2',
        label: '',
        status: 'done',
      }),
    );
    expect(mocks.upsertActivityLog).toHaveBeenCalledWith(
      'sess-1',
      3,
      expect.objectContaining({
        id: 'toolu_2',
        label: '',
        status: 'done',
      }),
    );
  });

  it('fills missing runtime fields when a malformed activity reaches the sink', async () => {
    const { recordActivity } = await import('../activity-log');
    const emitted: StreamChunk[] = [];

    recordActivity(
      'sess-1',
      4,
      {
        id: 'toolu_3',
        phase: 'update',
        toolName: 'mcp__nano-banana__generate_image',
      } as unknown as LiveActivityEvent,
      (chunk) => emitted.push(chunk),
    );

    expect(emitted[0].activity).toEqual(
      expect.objectContaining({
        id: 'toolu_3',
        kind: 'tool',
        label: 'mcp__nano-banana__generate_image',
        status: 'running',
      }),
    );
    expect(mocks.upsertActivityLog).toHaveBeenCalledWith(
      'sess-1',
      4,
      expect.objectContaining({
        kind: 'tool',
        label: 'mcp__nano-banana__generate_image',
        status: 'running',
      }),
    );
  });
});


import { BrowserWindow } from 'electron';
import { pipelineEventBus } from '../pipeline-event-bus';
import { brandLionDesignPayload } from '../liondesign-branding';

const STREAM_COALESCE_MS = 80;
const STREAM_COALESCE_MAX_CHARS = 16_384;
const STREAM_COALESCE_CHANNELS = new Set(['pipeline:stream', 'harness:agent-stream']);

interface PendingStreamText {
  channel: string;
  payload: Record<string, unknown>;
  timer: NodeJS.Timeout;
}

const pendingStreamText = new Map<string, PendingStreamText>();

function coalesceKey(channel: string, payload: unknown): string | null {
  if (!STREAM_COALESCE_CHANNELS.has(channel)) return null;
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== 'text' || typeof p.content !== 'string') return null;
  return `${channel}|${JSON.stringify({ ...p, content: '' })}`;
}

function deliver(channel: string, payload: unknown): void {
  try {
    const wins = BrowserWindow.getAllWindows();
    for (const win of wins) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  } catch {
  }

  if (channel.startsWith('pipeline:')) {
    pipelineEventBus.emit(channel, payload);
  }
}

function flushStreamKey(key: string): void {
  const entry = pendingStreamText.get(key);
  if (!entry) return;
  pendingStreamText.delete(key);
  clearTimeout(entry.timer);
  deliver(entry.channel, entry.payload);
}

export function flushCoalescedStreams(): void {
  for (const key of [...pendingStreamText.keys()]) {
    flushStreamKey(key);
  }
}

export function emitIPC(channel: string, payload: unknown): void {
  const presentedPayload = brandLionDesignPayload(payload);
  const key = coalesceKey(channel, presentedPayload);
  if (key) {
    const content = (presentedPayload as Record<string, unknown>).content as string;
    const existing = pendingStreamText.get(key);
    if (existing) {
      existing.payload = {
        ...existing.payload,
        content: `${existing.payload.content as string}${content}`,
      };
      if ((existing.payload.content as string).length >= STREAM_COALESCE_MAX_CHARS) {
        flushStreamKey(key);
      }
      return;
    }
    pendingStreamText.set(key, {
      channel,
      payload: { ...(presentedPayload as Record<string, unknown>) },
      timer: setTimeout(() => flushStreamKey(key), STREAM_COALESCE_MS),
    });
    return;
  }

  flushCoalescedStreams();
  deliver(channel, presentedPayload);
}

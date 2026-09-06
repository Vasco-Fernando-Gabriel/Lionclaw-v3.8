import { BrowserWindow } from 'electron';
import type { ChatMessage, MessageMetadata, StreamChunk } from '../../src/types';
import { insertMessage } from './db';
import { createLogger } from './logger';

const logger = createLogger('chat-push');

export interface PushAssistantMessageOptions {
  getWindow?: () => BrowserWindow | null;
  metadata?: MessageMetadata;
}

function resolveWindow(getWindow?: () => BrowserWindow | null): BrowserWindow | null {
  if (getWindow) {
    try {
      return getWindow();
    } catch {
    }
  }
  const wins = BrowserWindow.getAllWindows();
  return wins.length > 0 ? wins[0] : null;
}

export function pushAssistantMessage(
  sessionId: string,
  content: string,
  opts?: PushAssistantMessageOptions,
): number | null {
  try {
    const metadata: MessageMetadata = { source: 'pipeline-drive', ...opts?.metadata };

    const messageId = insertMessage(
      sessionId,
      'assistant',
      content,
      undefined,
      JSON.stringify(metadata),
    );

    const message: ChatMessage = {
      id: messageId,
      sessionId,
      role: 'assistant',
      content,
      metadata,
      createdAt: new Date().toISOString(),
    };

    const chunk: StreamChunk = {
      type: 'assistant_pushed',
      sessionId,
      message,
    };

    const win = resolveWindow(opts?.getWindow);
    if (win && !win.isDestroyed()) {
      win.webContents.send('chat:stream', chunk);
    }

    return messageId;
  } catch (err) {
    logger.error({ err, sessionId }, 'pushAssistantMessage failed');
    return null;
  }
}

export function pushDrivePaused(
  sessionId: string,
  opts?: { getWindow?: () => BrowserWindow | null },
): void {
  try {
    const chunk: StreamChunk = { type: 'drive_paused', sessionId };
    const win = resolveWindow(opts?.getWindow);
    if (win && !win.isDestroyed()) {
      win.webContents.send('chat:stream', chunk);
    }
  } catch (err) {
    logger.error({ err, sessionId }, 'pushDrivePaused failed');
  }
}

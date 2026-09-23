import type { BrowserWindow } from 'electron';
import {
  countSessionMessages,
  getSession,
  getSessionsWithDreamingStarted,
  getSetting,
  isOpenDesktopConversation,
  replaceLaneSession,
  setDreamingStartedAt,
} from './db';
import { acquireDreamingMutex } from './dreaming-mutex';
import { resolveCompactionSelection, runCompaction, type CompactionSelection } from './memory-pipeline';
import { humanizeModelLabel } from './memory-pipeline/oneshot-subscription';
import { readDefaultOrchestratorColumns } from './orchestrator-selection';
import { getDesktopSessionExecutionState, stopDesktopSessionQuery } from './orchestrator';
import { isChatSessionCompacting } from './chat-compaction-inplace';
import { listActiveDriveProjectIdsForSession } from './session-drive';
import { getPipelineDriveCoordinator } from './pipeline-drive-coordinator';
import { closeCachedChatCodexSession } from './codex-sdk';
import { pruneIdleDesktopLane } from './desktop-lanes';
import { awaitTurnSettled } from './turn-settle';
import { createLaneClearer, readClearForceSettleMs } from './chat-clear-core';
import type { ChatClearCancelResult, ChatClearResult } from '../../src/types';

export {
  CHAT_CLEAR_ERROR_MESSAGES,
  CLEAR_FORCE_SETTLE_MS_SETTING_KEY,
  buildTranscriptName,
  createLaneClearer,
  readClearForceSettleMs,
  type ClearLaneDeps,
  type LaneClearer,
} from './chat-clear-core';

export interface ClearLaneOptions {
  force?: boolean;
  getMainWindow?: () => BrowserWindow | null;
}

function labelFor(sel: CompactionSelection): string {
  switch (sel.kind) {
    case 'subscription':
      return humanizeModelLabel(sel.selection);
    case 'lion-sdk':
      return sel.model;
    case 'claude':
      return sel.model;
  }
}

let mainWindowGetter: () => BrowserWindow | null = () => null;

function send(channel: string, payload?: unknown): void {
  const win = mainWindowGetter();
  if (!win || win.isDestroyed()) return;
  if (payload === undefined) win.webContents.send(channel);
  else win.webContents.send(channel, payload);
}

const defaultClearer = createLaneClearer({
  getSession,
  countSessionMessages,
  isOpenDesktopConversation,
  setDreamingStartedAt,
  replaceLaneSession: (input) => {
    const replaced = replaceLaneSession(input);
    pruneIdleDesktopLane(input.sessionId);
    return replaced;
  },
  getSessionsWithDreamingStarted,
  getExecutionState: getDesktopSessionExecutionState,
  isCompacting: isChatSessionCompacting,
  listActiveDriveProjectIds: listActiveDriveProjectIdsForSession,
  stopDrive: (projectId, reason) => getPipelineDriveCoordinator()?.stopDrive(projectId, reason),
  onLaneClearFinished: (sessionId) => getPipelineDriveCoordinator()?.onLaneClearFinished(sessionId),
  stopSessionQuery: stopDesktopSessionQuery,
  awaitTurnSettled: (sessionId, timeoutMs) => awaitTurnSettled(sessionId, timeoutMs),
  readSettleTimeoutMs: () => readClearForceSettleMs(getSetting),
  acquireDreamingMutex,
  runCompaction,
  resolveModelLabel: async () => labelFor(await resolveCompactionSelection()),
  readDefaultOrchestrator: readDefaultOrchestratorColumns,
  closeCodexSession: (sessionId) => closeCachedChatCodexSession(sessionId, 'lane-clear'),
  emitCompactionActive: (payload) => send('compaction:active', payload),
  emitSessionsUpdated: () => send('chat:sessions-updated'),
  now: () => new Date(),
});

export function clearLaneSession(sessionId: string, opts: ClearLaneOptions = {}): Promise<ChatClearResult> {
  if (opts.getMainWindow) mainWindowGetter = opts.getMainWindow;
  return defaultClearer.clearLaneSession(sessionId, { force: opts.force });
}

export function cancelQueuedClear(sessionId: string): ChatClearCancelResult {
  return defaultClearer.cancelQueuedClear(sessionId);
}

export function rebuildClearingSessionsOnBoot(): string[] {
  return defaultClearer.rebuildClearingSessionsOnBoot();
}

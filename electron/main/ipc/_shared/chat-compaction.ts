import type { BrowserWindow } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../../logger';
import { getLionClawHome } from '../../paths';
import {
  getActiveChatSession,
  getSessionMessages,
  updateSessionStatus,
  createSession,
  getSession,
  purgeActivityLog,
  listActiveTelegramSessions,
} from '../../db';
import {
  runCompaction,
  resolveCompactionSelection,
  type CompactionSelection,
} from '../../memory-pipeline';
import { humanizeModelLabel } from '../../memory-pipeline/oneshot-subscription';
import { resetSdkSessionState } from '../../orchestrator';
import { onTelegramSessionCompacted } from '../../telegram-bridge';

const logger = createLogger('ipc');

export function getTelegramActiveThreadIds(): string[] {
  try {
    return listActiveTelegramSessions().map((s) => s.sdkSessionId ?? s.id);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'getTelegramActiveThreadIds falhou; varredura segue sem filtro de exclusao',
    );
    return [];
  }
}

export function clearSDKSessionFiles(preserveThreadIds: string[] = []): void {
  const homedir = os.homedir();
  const preserve = new Set(preserveThreadIds.map((id) => `${id}.jsonl`));
  const possibleCwds = [getLionClawHome(), homedir];
  for (const cwd of possibleCwds) {
    const sanitized = cwd.replace(/\//g, '-').replace(/^-/, '-');
    const projectDir = path.join(homedir, '.claude', 'projects', sanitized);
    if (fs.existsSync(projectDir)) {
      for (const file of fs.readdirSync(projectDir)) {
        if (file.endsWith('.jsonl')) {
          if (preserve.has(file)) {
            logger.info({ file }, 'Preserved Telegram SDK session file (SPEC 14-obs)');
            continue;
          }
          fs.unlinkSync(path.join(projectDir, file));
          logger.info({ file }, 'Cleared SDK session file');
        }
      }
    }
  }
}

export type CompactActiveChatSessionResult = {
  success: boolean;
  reason?: string;
  error?: string;
  newSessionId?: string;
};

let activeChatCompaction: Promise<CompactActiveChatSessionResult> | null = null;

export async function compactActiveChatSession(
  getMainWindow: () => BrowserWindow | null,
  trigger: 'manual' | 'orchestrator-switch',
): Promise<CompactActiveChatSessionResult> {
  if (activeChatCompaction) return activeChatCompaction;

  activeChatCompaction = (async () => {
    const activeSession = getActiveChatSession();
    if (!activeSession) {
      logger.warn({ trigger }, 'No active session to compact');
      return { success: false, reason: 'no_active_session' };
    }

    const messages = getSessionMessages(activeSession.id);
    if (messages.length === 0) {
      logger.info(
        { trigger, sessionId: activeSession.id },
        'Active session has no messages to compact',
      );
      return { success: false, reason: 'empty_session' };
    }

    const totalTokens = activeSession.inputTokens + activeSession.outputTokens;
    logger.info(
      { trigger, sessionId: activeSession.id, totalTokens },
      trigger === 'manual'
        ? 'Manual compaction triggered'
        : 'Orchestrator switch compaction triggered',
    );

    const emitCompaction = (payload: { isActive: boolean; modelLabel?: string; source?: 'lionclaw' }) => {
      const w = getMainWindow();
      if (w && !w.isDestroyed()) w.webContents.send('compaction:active', payload);
    };

    const labelFor = (sel: CompactionSelection): string => {
      switch (sel.kind) {
        case 'subscription':
          return humanizeModelLabel(sel.selection);
        case 'lion-sdk':
          return sel.model; // raw slug — lion models are not in the catalogs
        case 'claude':
          return sel.model;
      }
    };
    let initialLabel = '';
    try {
      initialLabel = labelFor(await resolveCompactionSelection());
    } catch (err) {
      logger.warn(
        { trigger, sessionId: activeSession.id, err: err instanceof Error ? err.message : String(err) },
        'Compaction initial-label resolution failed; badge starts label-less',
      );
    }
    emitCompaction({ isActive: true, modelLabel: initialLabel, source: 'lionclaw' });

    const onModelLabel = (label: string) =>
      emitCompaction({ isActive: true, modelLabel: label, source: 'lionclaw' });

    try {
      await runCompaction(
        new Date(activeSession.createdAt),
        new Date(),
        activeSession.id,
        { onModelLabel },
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(
        { trigger, sessionId: activeSession.id, err: error },
        'Active session compaction failed',
      );
      if (trigger === 'orchestrator-switch') {
        logger.warn(
          { trigger, sessionId: activeSession.id, code: 'COMPACT-SKIPPED' },
          'Orchestrator switch proceeding WITHOUT compaction; forcing SDK session reset (SB-4 P5)',
        );
        clearSDKSessionFiles(getTelegramActiveThreadIds());
        resetSdkSessionState();

        const newSessionId = crypto.randomUUID();
        const fullActiveSession = getSession(activeSession.id);
        updateSessionStatus(activeSession.id, 'archived');
        createSession(newSessionId, '', fullActiveSession?.subagent, {
          type: fullActiveSession?.type,
          taskId: fullActiveSession?.taskId,
        });

        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('chat:sessions-updated');
        }

        return { success: false, reason: 'compaction_failed', error, newSessionId };
      }
      return { success: false, reason: 'compaction_failed', error };
    } finally {
      emitCompaction({ isActive: false });
    }

    updateSessionStatus(activeSession.id, 'compacted');

    try {
      purgeActivityLog(activeSession.id);
    } catch (err) {
      logger.warn(
        { trigger, sessionId: activeSession.id, err: err instanceof Error ? err.message : String(err) },
        'purgeActivityLog falhou na compaction (fluxo nao afetado)',
      );
    }

    clearSDKSessionFiles(getTelegramActiveThreadIds());
    resetSdkSessionState();

    const newSessionId = crypto.randomUUID();
    const fullActiveSession = getSession(activeSession.id);
    createSession(newSessionId, '', fullActiveSession?.subagent, {
      type: fullActiveSession?.type,
      taskId: fullActiveSession?.taskId,
    });

    if (fullActiveSession?.type === 'telegram') {
      onTelegramSessionCompacted(activeSession.id, newSessionId);
    }

    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('chat:sessions-updated');
    }

    return { success: true, newSessionId };
  })().finally(() => {
    activeChatCompaction = null;
  });

  return activeChatCompaction;
}

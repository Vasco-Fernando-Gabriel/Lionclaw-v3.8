
import { createLogger } from '../logger';
import { getSetting, isDriveEngaged } from '../db';
import {
  getSessionConfig,
  setSessionConfig,
  LAST_SESSION_CONFIG_SETTINGS_KEY,
} from './session-config';
import { getOpenDesignConfig } from './config';
import type { OpenDesignSessionConfig } from '../../../src/types/open-design';

const logger = createLogger('od-drive-autostart');


function readLastSessionConfig(): OpenDesignSessionConfig | null {
  try {
    const raw = getSetting(LAST_SESSION_CONFIG_SETTINGS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { agentId?: unknown }).agentId !== 'string' ||
      typeof (parsed as { model?: unknown }).model !== 'string'
    ) {
      return null;
    }
    return parsed as OpenDesignSessionConfig;
  } catch (err) {
    logger.warn(
      { error: (err as Error).message },
      'openDesign.lastSessionConfig ilegivel; sem config utilizavel',
    );
    return null;
  }
}

export function resolveAutostartBaseSessionConfig(): OpenDesignSessionConfig | null {
  return readLastSessionConfig();
}

export function isDriveStartPending(projectId: string): boolean {
  if (!isDriveEngaged(projectId)) return false;
  const od = getOpenDesignConfig(projectId);
  const started =
    !!od &&
    (typeof od.conversationId === 'string' && od.conversationId.length > 0
      ? true
      : typeof od.initialPromptSentAt === 'string' &&
        od.initialPromptSentAt.length > 0);
  return !started;
}

export async function maybeAutostartDesignSession(
  projectId: string,
  startGeneration = true,
): Promise<void> {
  try {
    const existing = getSessionConfig(projectId);
    if (existing) {
      logger.info({ projectId }, 'sessionConfig ja existe; autostart e no-op');
      return;
    }

    const last = readLastSessionConfig();
    let configured = false;
    if (last) {
      try {
        setSessionConfig(projectId, { ...last, configuredAt: new Date().toISOString() });
        configured = true;
        logger.info(
          { projectId, agentId: last.agentId, model: last.model },
          'autostart: aplicado o ultimo sessionConfig salvo',
        );
      } catch (err) {
        logger.warn(
          { projectId, error: (err as Error).message },
          'ultimo sessionConfig salvo foi rejeitado; sem config utilizavel',
        );
      }
    }
    if (!configured) {
      logger.warn(
        { projectId },
        'autostart abortado: nenhum sessionConfig salvo do LionDesign. Configure o Studio ' +
          '(agente/modelo) na UI antes de dirigir esta fase; nenhum default e assumido.',
      );
      const { recordSystemActivity } = await import('../activity-log');
      recordSystemActivity({
        id: `od-autostart-abort-${projectId}-${Date.now()}`,
        label: 'LionDesign autostart abortado',
        description:
          'sem sessionConfig salvo; configure agente/modelo no Studio (nenhum default assumido)',
        status: 'error',
      });
      return;
    }

    if (!startGeneration) {
      logger.info(
        { projectId },
        'autostart config-only sob drive: sessionConfig semeado, geracao aguarda o GO do motorista',
      );
      return;
    }

    const { ensureSession } = await import('./bootstrap');
    const result = await ensureSession(projectId);
    if ('error' in result) {
      logger.error(
        { projectId, error: result.error },
        'autostart: ensureSession falhou (fase fica para o humano)',
      );
      return;
    }
    logger.info(
      { projectId, conversationId: result.conversationId },
      'autostart: sessao OD garantida (ensureSession ok)',
    );
  } catch (err) {
    logger.error(
      { projectId, error: err instanceof Error ? err.message : String(err) },
      'maybeAutostartDesignSession falhou (fase fica para o humano)',
    );
  }
}

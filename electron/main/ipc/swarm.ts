import { ipcMain, shell } from 'electron';
import type { IpcContext } from './context';
import {
  getSession,
  getDesktopActiveSessionById,
  getChatFeatureToggles,
  getSessionActiveRepository,
  getLocalRepository,
} from '../db';
import { getAgentCwd } from '../paths';
import { getSwarmService } from '../swarm';
import { createLogger } from '../logger';
import type { SwarmStartInput, SwarmSettings } from '../../../src/types/swarm';
const logger = createLogger('ipc-swarm');
export function registerSwarmHandlers(ctx: IpcContext): void {
  function register(channel: string, action: (...args: unknown[]) => unknown) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (event.sender !== ctx.getMainWindow()?.webContents) {
        return { error: 'Sessão autenticada do desktop necessária.', code: 'auth-required' };
      }
      try {
        return await action(...args);
      } catch (error) {
        logger.warn({ error }, 'Falha no Swarm');
        return {
          error: error instanceof Error ? error.message : String(error),
          code: (error as { code?: string })?.code ?? 'swarm-error',
        };
      }
    });
  }
  function session(value: unknown): string {
    if (typeof value !== 'string' || !getSession(value)) throw new Error('Sessão não encontrada.');
    return value;
  }
  register('swarm:start', (id, input) => {
    const sessionId = session(id);
    if (!getDesktopActiveSessionById(sessionId)) throw new Error('Swarm exige sessão desktop ativa.');
    const repo = getSessionActiveRepository(sessionId);
    return getSwarmService().start(
      {
        sessionId,
        swarmEnabled: getChatFeatureToggles(sessionId)?.swarm === true,
        readRoots: [(repo ? getLocalRepository(repo.repositoryId)?.rootPath : undefined) ?? getAgentCwd(false)],
      },
      input as SwarmStartInput,
    );
  });
  register('swarm:open-findings', async (id, runId, slug) => {
    const findingsPath = await getSwarmService().getFindingsPath(session(id), String(runId), String(slug));
    const error = await shell.openPath(findingsPath);
    if (error) throw new Error(error);
    return { opened: true };
  });
  register('swarm:abort', (id, runId) => getSwarmService().abort(session(id), String(runId)));
  register('swarm:get-run-state', (id, runId) => getSwarmService().getRunState(session(id), String(runId)));
  register('swarm:list-runs', (id, cursor, limit) =>
    getSwarmService().listRuns(session(id), cursor as string | undefined, limit as number | undefined),
  );
  register('swarm:get-catalog', (id) => {
    const sessionId = session(id);
    return getSwarmService().getCatalog(sessionId, getChatFeatureToggles(sessionId)?.swarm === true);
  });
  register('swarm:get-settings', () => getSwarmService().getSettings());
  register('swarm:set-settings', (settings) => getSwarmService().setSettings(settings as SwarmSettings));
  getSwarmService().subscribe((event) => {
    const window = ctx.getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send('swarm:stream', event);
  });
}

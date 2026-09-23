import path from 'node:path';
import { DEFAULT_SWARM_SETTINGS, type SwarmSettings } from '../../../src/types/swarm';
import {
  getSetting,
  setSetting,
  insertAuditEntry,
  upsertSwarmRunIndex,
  enqueueSwarmDelivery,
  getSwarmDelivery,
} from '../db';
import { getLionClawHome } from '../paths';
import { createLogger } from '../logger';
import { SwarmArtifacts } from './artifacts';
import { SwarmRunner } from './runner';
import { validateSwarmSettings } from './validation';

const logger = createLogger('swarm');
const keys: Record<keyof SwarmSettings, string> = {
  concurrencyCap: 'swarm_concurrency_cap',
  maxAttempts: 'swarm_max_attempts',
  idleTimeoutMs: 'swarm_idle_timeout_ms',
  hardTimeoutMs: 'swarm_hard_timeout_ms',
};
let singleton: SwarmRunner | undefined;
export function getSwarmService(): SwarmRunner {
  if (singleton) return singleton;
  singleton = new SwarmRunner({
    artifacts: new SwarmArtifacts(path.join(getLionClawHome(), 'artifacts', 'swarm')),
    resolve: async (member, cwd) => (await import('../agent-runtime/swarm-adapter')).resolveSwarmMember(member, cwd),
    execute: async (request) => (await import('../agent-runtime/swarm-adapter')).executeSwarmAttempt(request),
    catalog: async () => (await import('../agent-runtime/swarm-adapter')).getSwarmCatalog(),
    recoverAttempt: async (run, item, attempt) =>
      (await import('../agent-runtime/swarm-adapter')).recoverSwarmAttempt({
        runId: run.runId,
        slug: item.slug,
        attemptId: attempt.id,
        runtime: item.runtime,
      }),
    readSettings: () => {
      const settings = { ...DEFAULT_SWARM_SETTINGS };
      for (const key of Object.keys(keys) as Array<keyof SwarmSettings>) {
        const stored = getSetting(keys[key]);
        if (stored != null) settings[key] = Number(stored);
      }
      return validateSwarmSettings(settings);
    },
    writeSettings: (settings) => {
      const valid = validateSwarmSettings(settings);
      for (const key of Object.keys(keys) as Array<keyof SwarmSettings>) setSetting(keys[key], String(valid[key]));
    },
    audit: (event) => {
      insertAuditEntry({
        sessionId: event.sessionId,
        eventType: 'tool_call',
        toolName: `swarm_${event.action}`,
        input: JSON.stringify({ runId: event.runId, itemCount: event.itemCount }),
        output: 'accepted',
      });
    },
    project: (summary) => upsertSwarmRunIndex(summary),
    deliveryState: (run) =>
      run.terminalRevision === null ? undefined : getSwarmDelivery(run.runId, run.terminalRevision),
    deliver: (run, envelope) => {
      if (run.terminalRevision === null) throw new Error('Run terminal sem revisão de entrega.');
      enqueueSwarmDelivery(run.runId, run.terminalRevision, run.chatSessionId, envelope, run.status);
    },
    reportError: (error, context) =>
      logger.error({ error: error instanceof Error ? error.message : String(error) }, context),
  });
  return singleton;
}
export { SwarmDomainError } from './validation';

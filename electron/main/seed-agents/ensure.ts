import path from 'path';
import fs from 'fs';
import type { AgentConfig } from '../../../src/types';
import { reconcileSeedAgent } from '../db';
import { getLionClawHome } from '../paths';
import { resolveAgentQueryConfig } from '../agent-config-resolver';
import { createLogger } from '../logger';
import { ALL_SEED_AGENTS } from './index';

const logger = createLogger('seed-agents-ensure');

type SeedAgent = Omit<AgentConfig, 'sortOrder'>;

export async function ensureSeedAgent(seed: SeedAgent): Promise<void> {
  const squad = seed.squad ?? 'unknown';
  reconcileSeedAgent(seed, squad);

  const dir = path.join(getLionClawHome(), 'agents', seed.id);
  fs.mkdirSync(dir, { recursive: true });

  try {
    const resolved = await resolveAgentQueryConfig(seed.id);
    const snapshot = {
      _comment: 'AUTO-GENERATED snapshot from DB. Edit via UI; this file is overwritten on every boot.',
      ...resolved,
    };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (err) {
    logger.warn({ agentId: seed.id, err }, 'Failed to materialize agent config snapshot');
  }
}

export async function ensureAllSeedAgents(): Promise<void> {
  for (const seed of ALL_SEED_AGENTS) {
    await ensureSeedAgent(seed);
  }
  logger.info({ count: ALL_SEED_AGENTS.length }, 'Ensured all seed agents');
}

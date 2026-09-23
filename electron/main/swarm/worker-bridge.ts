import { randomBytes } from 'crypto';
import { mintHelperToken, revokeHelperToken, LIONCLAW_HELPER_TOKEN_ENV } from '../helper-identity';
import { resolveMcpServerRuntime } from '../mcp-path-resolver';
import type { SwarmFindingsOperation, SwarmFindingsAck } from '../../../src/types/swarm';
const uploads = new Map<string, (operation: SwarmFindingsOperation) => Promise<SwarmFindingsAck> | SwarmFindingsAck>();
export const SWARM_WORKER_OWNER_PREFIX = 'swarm-findings-worker-';
export function createSwarmWorkerBridge(
  upload: (operation: SwarmFindingsOperation) => Promise<SwarmFindingsAck> | SwarmFindingsAck,
): { extraArgs: string[]; spawnEnv: Record<string, string>; dispose: () => void } {
  const runtime = resolveMcpServerRuntime('lionclaw-swarm', 'dist/lionclaw-swarm/src/index.js');
  if (!runtime.command || !runtime.entryPath) throw new Error('MCP Swarm não instalado. Execute build:mcps.');
  const owner = `${SWARM_WORKER_OWNER_PREFIX}${randomBytes(32).toString('hex')}`;
  const helperToken = mintHelperToken(owner);
  uploads.set(owner, upload);
  const config = {
    command: runtime.command,
    args: [runtime.entryPath],
    env: { LIONCLAW_SWARM_WORKER: '1' },
    env_vars: [LIONCLAW_HELPER_TOKEN_ENV],
    enabled: true,
  };
  return {
    extraArgs: ['-c', `mcp_servers.swarm-worker=${toToml(config)}`],
    spawnEnv: { [LIONCLAW_HELPER_TOKEN_ENV]: helperToken },
    dispose: () => {
      uploads.delete(owner);
      revokeHelperToken(helperToken);
    },
  };
}
function toToml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toToml).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)}=${toToml(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export async function dispatchSwarmFindings(owner: string, operation: unknown): Promise<SwarmFindingsAck> {
  const upload = uploads.get(owner);
  if (!upload) throw new Error('Capability da tentativa ausente ou revogada.');
  return upload(operation as SwarmFindingsOperation);
}

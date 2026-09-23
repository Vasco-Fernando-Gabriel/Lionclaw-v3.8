import type { KimiMcpBridge } from './mcp-http-bridge';
import { createLogger } from '../logger';

const logger = createLogger('kimi-acp:mcp-bridge-registry');

export const MAX_LIVE_BRIDGES = 8;

export class KimiBridgeRegistry {
  private readonly bridges = new Map<string, KimiMcpBridge>();

  register(bridge: KimiMcpBridge): void {
    if (this.bridges.size >= MAX_LIVE_BRIDGES) {
      logger.warn(
        { live: this.bridges.size, cap: MAX_LIVE_BRIDGES, bridgeId: bridge.bridgeId },
        'KI-2 bridge cap: live bridge count at/over the diagnostic ceiling (no auto-reap; investigate a possible leak)',
      );
    }
    this.bridges.set(bridge.bridgeId, bridge);
    logger.debug({ bridgeId: bridge.bridgeId, live: this.bridges.size }, 'kimi mcp bridge registered');
  }

  remove(bridgeId: string): void {
    this.bridges.delete(bridgeId);
  }

  size(): number {
    return this.bridges.size;
  }

  async stopAll(): Promise<void> {
    const snapshot = [...this.bridges.values()];
    for (const bridge of snapshot) {
      try {
        await bridge.stop();
      } catch (err) {
        logger.warn({ err, bridgeId: bridge.bridgeId }, 'kimi mcp bridge stopAll(): a stop() rejected (ignored)');
      }
    }
    this.bridges.clear();
  }
}

let cachedRegistry: KimiBridgeRegistry | null = null;

export function getKimiBridgeRegistry(): KimiBridgeRegistry {
  if (!cachedRegistry) {
    cachedRegistry = new KimiBridgeRegistry();
  }
  return cachedRegistry;
}

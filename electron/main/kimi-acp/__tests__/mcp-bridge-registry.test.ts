import { afterEach, describe, expect, it, vi } from 'vitest';
import { KimiBridgeRegistry, MAX_LIVE_BRIDGES, getKimiBridgeRegistry } from '../mcp-bridge-registry';
import type { KimiMcpBridge } from '../mcp-http-bridge';
import type { KimiAcpMcpServerEntry } from '../types';

function fakeBridge(bridgeId: string, stop: () => Promise<void> = async () => undefined): KimiMcpBridge {
  const url = 'http://127.0.0.1:54000/mcp';
  const token = 'tok-' + bridgeId;
  const mcpServerEntry: KimiAcpMcpServerEntry = {
    id: 'lionbridge',
    name: 'LionClaw Bridge',
    type: 'http',
    url,
    headers: [{ name: 'Authorization', value: 'Bearer ' + token }],
    env: [],
  };
  return { url, token, mcpServerEntry, bridgeId, stop };
}

describe('KimiBridgeRegistry (B3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('register/remove/size: a registered bridge increments size, remove decrements it', () => {
    const reg = new KimiBridgeRegistry();
    expect(reg.size()).toBe(0);

    const a = fakeBridge('a');
    const b = fakeBridge('b');
    reg.register(a);
    expect(reg.size()).toBe(1);
    reg.register(b);
    expect(reg.size()).toBe(2);

    reg.remove('a');
    expect(reg.size()).toBe(1);
    reg.remove('does-not-exist');
    expect(reg.size()).toBe(1);
    reg.remove('b');
    expect(reg.size()).toBe(0);
  });

  it('registering the same bridgeId twice keeps a single entry', () => {
    const reg = new KimiBridgeRegistry();
    reg.register(fakeBridge('dup'));
    reg.register(fakeBridge('dup'));
    expect(reg.size()).toBe(1);
  });

  it('stopAll() stops every live bridge and leaves size() === 0', async () => {
    const reg = new KimiBridgeRegistry();
    const stops = [vi.fn(async () => undefined), vi.fn(async () => undefined), vi.fn(async () => undefined)];
    reg.register(fakeBridge('a', stops[0]));
    reg.register(fakeBridge('b', stops[1]));
    reg.register(fakeBridge('c', stops[2]));
    expect(reg.size()).toBe(3);

    await reg.stopAll();

    for (const stop of stops) {
      expect(stop).toHaveBeenCalledTimes(1);
    }
    expect(reg.size()).toBe(0);
  });

  it('stopAll() is best-effort: one rejecting stop() does not block the others and never throws', async () => {
    const reg = new KimiBridgeRegistry();
    const okOne = vi.fn(async () => undefined);
    const rejecting = vi.fn(async () => {
      throw new Error('stop blew up');
    });
    const okTwo = vi.fn(async () => undefined);
    reg.register(fakeBridge('ok-one', okOne));
    reg.register(fakeBridge('rejecting', rejecting));
    reg.register(fakeBridge('ok-two', okTwo));

    await expect(reg.stopAll()).resolves.toBeUndefined();

    expect(okOne).toHaveBeenCalledTimes(1);
    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(okTwo).toHaveBeenCalledTimes(1);
    expect(reg.size()).toBe(0);
  });

  it('stopAll() is idempotent against a bridge whose stop() deregisters itself', async () => {
    const reg = new KimiBridgeRegistry();
    const selfRemoving = fakeBridge('self', async () => {
      reg.remove('self');
    });
    reg.register(selfRemoving);
    reg.register(fakeBridge('other'));
    expect(reg.size()).toBe(2);

    await reg.stopAll();
    expect(reg.size()).toBe(0);
    await expect(reg.stopAll()).resolves.toBeUndefined();
    expect(reg.size()).toBe(0);
  });

  it('registering past MAX_LIVE_BRIDGES logs a warn and does NOT reap any live bridge', async () => {
    const reg = new KimiBridgeRegistry();
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    for (let i = 0; i < MAX_LIVE_BRIDGES; i += 1) {
      const stop = vi.fn(async () => undefined);
      stops.push(stop);
      reg.register(fakeBridge('b' + i, stop));
    }
    expect(reg.size()).toBe(MAX_LIVE_BRIDGES);

    const overStop = vi.fn(async () => undefined);
    reg.register(fakeBridge('over', overStop));

    expect(reg.size()).toBe(MAX_LIVE_BRIDGES + 1);
    for (const stop of stops) {
      expect(stop).not.toHaveBeenCalled();
    }
    expect(overStop).not.toHaveBeenCalled();
  });

  it('getKimiBridgeRegistry() returns a stable process singleton', () => {
    const first = getKimiBridgeRegistry();
    const second = getKimiBridgeRegistry();
    expect(first).toBe(second);
  });
});

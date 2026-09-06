
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const INDEX_SRC = path.join(__dirname, '..', 'index.ts');

const EXPECTED_BOOT_ORDER: ReadonlyArray<string | RegExp> = [
  'initDatabase()',
  'ensureAllSeedAgents()',
  'startKnowledgeBridge()',
  /new HarnessEngine\s*\(/,
  /new PipelineEngine\s*\(/,
  'registerIPCHandlers(',
  'ensureBuiltinMCPServers()',
  'startLocalIpcServer()',
  'startActiveMCPServers()',
  'syncCodexMcpConfig()',
  'discoverSDKMcpServers()',
  'startScheduler(',
  'startTelegramBot(',
  'createWindow()',
];

describe('SPEC-001 §15/§16 #47: index.ts boot order snapshot', () => {
  const src = fs.readFileSync(INDEX_SRC, 'utf8');

  it('declares all of the expected boot calls', () => {
    for (const needle of EXPECTED_BOOT_ORDER) {
      if (typeof needle === 'string') {
        expect(src).toContain(needle);
      } else {
        expect(src).toMatch(needle);
      }
    }
  });

  it('the boot calls appear in the documented order', () => {
    const bootStartAnchor = 'initDatabase();';
    const bootStart = src.indexOf(bootStartAnchor);
    expect(bootStart, 'boot section anchor initDatabase() not found').toBeGreaterThan(-1);
    const bootBody = src.slice(bootStart);

    const offsets: { needle: string; offset: number }[] = [];
    for (const needle of EXPECTED_BOOT_ORDER) {
      let offset: number;
      if (typeof needle === 'string') {
        offset = bootBody.indexOf(needle);
      } else {
        const match = needle.exec(bootBody);
        offset = match ? match.index : -1;
      }
      expect(offset, `boot anchor not found in boot body: ${String(needle)}`).toBeGreaterThan(-1);
      offsets.push({ needle: String(needle), offset });
    }

    for (let i = 1; i < offsets.length; i++) {
      const prev = offsets[i - 1]!;
      const cur = offsets[i]!;
      expect(
        cur.offset > prev.offset,
        `${cur.needle} appears BEFORE ${prev.needle} (expected after)`,
      ).toBe(true);
    }
  });

  it('contains exactly ONE invocation of the SPEC-001 inserted calls', () => {
    const localIpcCalls = src.match(/\bstartLocalIpcServer\s*\(\s*\)/g) ?? [];
    expect(localIpcCalls.length).toBe(1);

    const syncCalls = src.match(/\bsyncCodexMcpConfig\s*\(\s*\)/g) ?? [];
    expect(syncCalls.length).toBe(1);
  });

  it('places startLocalIpcServer between ensureBuiltinMCPServers and startActiveMCPServers (SPEC #47b)', () => {
    const bootBody = src.slice(src.indexOf('initDatabase();'));
    const ensure = bootBody.indexOf('ensureBuiltinMCPServers()');
    const local = bootBody.indexOf('startLocalIpcServer()');
    const active = bootBody.indexOf('startActiveMCPServers()');
    expect(ensure).toBeGreaterThan(-1);
    expect(local).toBeGreaterThan(ensure);
    expect(active).toBeGreaterThan(local);
  });

  it('places syncCodexMcpConfig between startActiveMCPServers and discoverSDKMcpServers (SPEC #47c)', () => {
    const bootBody = src.slice(src.indexOf('initDatabase();'));
    const active = bootBody.indexOf('startActiveMCPServers()');
    const sync = bootBody.indexOf('syncCodexMcpConfig()');
    const discover = bootBody.indexOf('discoverSDKMcpServers()');
    expect(active).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(active);
    expect(discover).toBeGreaterThan(sync);
  });

  it('stopLocalIpcServer is called AFTER stopAllMCPServers on shutdown (SPEC §15 shutdown clause)', () => {
    const stopAll = src.indexOf('stopAllMCPServers');
    const stopLocal = src.indexOf('stopLocalIpcServer');
    expect(stopAll).toBeGreaterThan(-1);
    expect(stopLocal).toBeGreaterThan(stopAll);
  });
});

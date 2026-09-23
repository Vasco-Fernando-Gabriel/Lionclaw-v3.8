import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('../paths', () => ({ getLionClawHome: () => state.root }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: {} }));

import { getDb, getSetting, initDatabase, setOrchestratorCompactionSelection } from '../db';

const previous = {
  runtime: 'claude-sdk',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
};

beforeAll(() => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-compaction-db-'));
  initDatabase();
});

afterAll(() => {
  try {
    getDb().close();
  } catch {}
  fs.rmSync(state.root, { recursive: true, force: true });
});

describe('setOrchestratorCompactionSelection', () => {
  it('rolls back the whole triple when the second write fails', () => {
    setOrchestratorCompactionSelection(previous);
    getDb().exec(`
      CREATE TEMP TRIGGER fail_compaction_provider
      BEFORE UPDATE OF value ON settings
      WHEN NEW.key = 'orchestrator_compaction_provider'
      BEGIN
        SELECT RAISE(ABORT, 'injected compaction write failure');
      END;
    `);

    expect(() =>
      setOrchestratorCompactionSelection({
        runtime: 'codex-sdk',
        provider: 'codex',
        model: 'gpt-5.5',
      }),
    ).toThrow(/injected compaction write failure/i);

    expect(getSetting('orchestrator_compaction_runtime')).toBe(previous.runtime);
    expect(getSetting('orchestrator_compaction_provider')).toBe(previous.provider);
    expect(getSetting('orchestrator_compaction_model')).toBe(previous.model);
    getDb().exec('DROP TRIGGER fail_compaction_provider');
  });

  it('removes all three keys atomically for Auto', () => {
    setOrchestratorCompactionSelection(previous);
    setOrchestratorCompactionSelection(null);

    expect(getSetting('orchestrator_compaction_runtime')).toBeUndefined();
    expect(getSetting('orchestrator_compaction_provider')).toBeUndefined();
    expect(getSetting('orchestrator_compaction_model')).toBeUndefined();
  });
});

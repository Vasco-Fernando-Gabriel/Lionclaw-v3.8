import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyMigrationV107, __V107_INTERNAL } from '../db-migrations/v107-kimi-model-id-fix';

const SHORT = __V107_INTERNAL.SHORT_ID;
const NS = __V107_INTERNAL.NAMESPACED_ID;

interface AgentRow {
  id: string;
  model: string;
}
interface SettingRow {
  key: string;
  value: string;
}

interface FakeDb {
  agents: AgentRow[];
  settings: SettingRow[];
  preparedSql: string[];
  transactionCalls: number;
}

function makeFake(state: FakeDb): import('better-sqlite3').Database {
  function prepare(sql: string) {
    state.preparedSql.push(sql);
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('UPDATE agents SET model = ?')) {
      return {
        run: (newModel: string, whereModel: string) => {
          for (const row of state.agents) {
            if (row.model === whereModel) row.model = newModel;
          }
        },
      };
    }

    if (normalized.startsWith('UPDATE settings SET value = ?')) {
      return {
        run: (newValue: string, key: string, whereValue: string) => {
          for (const row of state.settings) {
            if (row.key === key && row.value === whereValue) row.value = newValue;
          }
        },
      };
    }

    throw new Error(`unexpected prepare(): ${normalized}`);
  }

  const fake = {
    prepare: vi.fn(prepare),
    transaction: vi.fn((fn: () => void) => {
      state.transactionCalls += 1;
      return () => fn();
    }),
  };

  return fake as unknown as import('better-sqlite3').Database;
}

function freshState(): FakeDb {
  return {
    agents: [
      { id: 'a-short', model: SHORT },
      { id: 'a-already-ns', model: NS },
      { id: 'a-claude', model: 'claude-opus-4-7' },
      { id: 'a-pricing-basis', model: 'kimi-k2.7-code' },
    ],
    settings: [
      { key: 'orchestrator_model', value: SHORT },
      { key: 'default_model', value: SHORT },
      { key: 'orchestrator_runtime', value: 'kimi-sdk' },
      { key: 'orchestrator_effort', value: 'high' },
    ],
    preparedSql: [],
    transactionCalls: 0,
  };
}

describe('applyMigrationV107 - structural', () => {
  it('exports applyMigrationV107 as a function', () => {
    expect(typeof applyMigrationV107).toBe('function');
  });

  it('targets the right id pair and the two settings keys (AC-S8.2b)', () => {
    expect(__V107_INTERNAL.SHORT_ID).toBe('kimi-for-coding');
    expect(__V107_INTERNAL.NAMESPACED_ID).toBe('kimi-code/kimi-for-coding');
    expect(__V107_INTERNAL.SETTINGS_MODEL_KEYS).toEqual(['orchestrator_model', 'default_model']);
  });

  it('runs everything inside exactly one db.transaction', () => {
    const state = freshState();
    applyMigrationV107(makeFake(state));
    expect(state.transactionCalls).toBe(1);
  });
});

describe('applyMigrationV107 - rewrites the short id, preserves others (AC-S8.2)', () => {
  it('agent row holding the short id becomes the namespaced id', () => {
    const state = freshState();
    applyMigrationV107(makeFake(state));
    expect(state.agents.find((r) => r.id === 'a-short')?.model).toBe(NS);
  });

  it('agent rows with any other model are untouched (claude, pricing-basis, already-ns)', () => {
    const state = freshState();
    applyMigrationV107(makeFake(state));
    expect(state.agents.find((r) => r.id === 'a-claude')?.model).toBe('claude-opus-4-7');
    expect(state.agents.find((r) => r.id === 'a-pricing-basis')?.model).toBe('kimi-k2.7-code');
    expect(state.agents.find((r) => r.id === 'a-already-ns')?.model).toBe(NS);
  });

  it('settings orchestrator_model + default_model holding the short id become namespaced (AC-S8.2b)', () => {
    const state = freshState();
    applyMigrationV107(makeFake(state));
    expect(state.settings.find((r) => r.key === 'orchestrator_model')?.value).toBe(NS);
    expect(state.settings.find((r) => r.key === 'default_model')?.value).toBe(NS);
  });

  it('unrelated settings rows are untouched', () => {
    const state = freshState();
    applyMigrationV107(makeFake(state));
    expect(state.settings.find((r) => r.key === 'orchestrator_runtime')?.value).toBe('kimi-sdk');
    expect(state.settings.find((r) => r.key === 'orchestrator_effort')?.value).toBe('high');
  });

  it('a settings key NOT in the model-key set is never rewritten even if it holds the short id', () => {
    const state = freshState();
    state.settings.push({ key: 'some_other_key', value: SHORT });
    applyMigrationV107(makeFake(state));
    expect(state.settings.find((r) => r.key === 'some_other_key')?.value).toBe(SHORT);
  });
});

describe('applyMigrationV107 - idempotent (AC-S8.2)', () => {
  it('re-running on already-migrated rows is a no-op', () => {
    const state = freshState();
    applyMigrationV107(makeFake(state));
    const afterFirst = JSON.parse(JSON.stringify({ agents: state.agents, settings: state.settings }));

    applyMigrationV107(makeFake(state));
    expect(state.agents).toEqual(afterFirst.agents);
    expect(state.settings).toEqual(afterFirst.settings);
  });
});

describe('applyMigrationV107 - SQL shape', () => {
  it('agent UPDATE is filtered by model and stamps updated_at; no table rebuild', () => {
    const state = freshState();
    applyMigrationV107(makeFake(state));
    const agentSql = state.preparedSql.find((s) => /UPDATE agents/.test(s)) ?? '';
    expect(agentSql).toMatch(/UPDATE agents SET model = \?/);
    expect(agentSql).toMatch(/updated_at = datetime\('now'\)/);
    expect(agentSql).toMatch(/WHERE model = \?/);
    for (const sql of state.preparedSql) {
      expect(sql).not.toMatch(/CREATE TABLE/i);
      expect(sql).not.toMatch(/DROP TABLE/i);
    }
  });

  it('settings UPDATE is filtered by BOTH key and value', () => {
    const state = freshState();
    applyMigrationV107(makeFake(state));
    const settingSql = state.preparedSql.find((s) => /UPDATE settings/.test(s)) ?? '';
    expect(settingSql).toMatch(/UPDATE settings SET value = \?/);
    expect(settingSql).toMatch(/WHERE key = \? AND value = \?/);
  });
});

const MAIN_DIR = join(__dirname, '..');
function readMainSource(relPath: string): string {
  return readFileSync(join(MAIN_DIR, relPath), 'utf8');
}

describe('applyMigrationV107 - registration in db.ts runner', () => {
  const dbSrc = readMainSource('db.ts');

  it('db.ts imports applyMigrationV107', () => {
    expect(dbSrc).toContain("import { applyMigrationV107 } from './db-migrations/v107-kimi-model-id-fix'");
  });

  it('runMigrations has the if (currentVersion < 107) block after v106', () => {
    const i106 = dbSrc.indexOf('if (currentVersion < 106) {');
    const i107 = dbSrc.indexOf('if (currentVersion < 107) {');
    expect(i106).toBeGreaterThan(-1);
    expect(i107).toBeGreaterThan(i106);
  });

  it('the v107 block calls the migration, bumps schema_version and logs', () => {
    const start = dbSrc.indexOf('if (currentVersion < 107) {');
    const block = dbSrc.slice(start, start + 400);
    expect(block).toContain('applyMigrationV107(db)');
    expect(block).toContain("db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(107)");
    expect(block).toMatch(/Applied migration v107/);
  });
});

describe('V107 R10 - source edits carry the namespaced id (fresh installs)', () => {
  it('kimi-models.ts catalog uses the namespaced subscription slug', () => {
    const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'constants', 'kimi-models.ts'), 'utf8');
    expect(src).toContain("slug: 'kimi-code/kimi-for-coding'");
    expect(src).toContain("export const KIMI_DEFAULT_MODEL = 'kimi-code/kimi-for-coding'");
    expect(src).not.toContain("slug: 'kimi-k2.7-code'");
  });

  it('kimi-executor.ts KIMI_SUBSCRIPTION_MODEL is namespaced; pricing model unchanged', () => {
    const src = readMainSource(join('agent-runtime', 'kimi-executor.ts'));
    expect(src).toContain("const KIMI_SUBSCRIPTION_MODEL = 'kimi-code/kimi-for-coding'");
    expect(src).toContain("const KIMI_PRICING_MODEL = 'kimi-k2.7-code'");
  });

  it('kimi-sdk/session.ts KIMI_SUBSCRIPTION_MODEL is namespaced', () => {
    const src = readMainSource(join('kimi-sdk', 'session.ts'));
    expect(src).toContain("const KIMI_SUBSCRIPTION_MODEL = 'kimi-code/kimi-for-coding'");
  });
});

describe('V107 - no em-dash', () => {
  it('migration source has no U+2014', () => {
    const src = readFileSync(join(__dirname, '..', 'db-migrations', 'v107-kimi-model-id-fix.ts'), 'utf8');
    expect(src).not.toContain(String.fromCharCode(0x2014));
  });
});

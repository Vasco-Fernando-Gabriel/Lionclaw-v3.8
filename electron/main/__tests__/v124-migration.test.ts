
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyMigrationV124,
  __V124_INTERNAL,
} from '../db-migrations/v124-orchestrator-single-source';
import { PRODUCT_DEFAULT_ORCHESTRATOR } from '../orchestrator-defaults';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';
import { CODEX_DEFAULT_MODEL } from '../../../src/constants/codex-models';
import { CLAUDE_COMPAT_PRESETS } from '../../../src/constants/claude-compat-presets';

const SCHEMA = `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(key, value);
}

function getSettingValue(db: Database.Database, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

describe('v124: contrato interno (alias + inferencia + defaults curados)', () => {
  it('resolveModelAlias mapeia aliases curtos e preserva slugs canonicos', () => {
    const { resolveModelAlias } = __V124_INTERNAL;
    expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-4-6');
    expect(resolveModelAlias('opus')).toBe('claude-opus-4-7');
    expect(resolveModelAlias('haiku')).toBe('claude-haiku-4-5-20251001');
    expect(resolveModelAlias('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(resolveModelAlias('gpt-5.5')).toBe('gpt-5.5');
  });

  it('inferRuntimeFromModel espelha a heuristica do resolver', () => {
    const { inferRuntimeFromModel } = __V124_INTERNAL;
    expect(inferRuntimeFromModel('claude-opus-4-8')).toBe('claude-sdk');
    expect(inferRuntimeFromModel('gpt-5.5')).toBe('codex-sdk');
    expect(inferRuntimeFromModel('glm-4.7')).toBe('claude-compat-sdk');
    expect(inferRuntimeFromModel('MiniMax-M2.7')).toBe('claude-compat-sdk');
    expect(inferRuntimeFromModel('llama3.1:8b')).toBe('lion-sdk');
  });
});

describe('v124: applyMigrationV124 (4 ramos + alias + idempotencia)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
  });

  it('passo 1: triple completo permanece intocado (sem re-bump)', () => {
    setSetting(db, 'orchestrator_runtime', 'claude-sdk');
    setSetting(db, 'orchestrator_provider', 'anthropic');
    setSetting(db, 'orchestrator_model', 'claude-opus-4-7');

    applyMigrationV124(db);

    expect(getSettingValue(db, 'orchestrator_runtime')).toBe('claude-sdk');
    expect(getSettingValue(db, 'orchestrator_provider')).toBe('anthropic');
    expect(getSettingValue(db, 'orchestrator_model')).toBe('claude-opus-4-7');
  });

  it('passo 1: default_model presente com triple completo e IGNORADO e apagado', () => {
    setSetting(db, 'orchestrator_runtime', 'codex-sdk');
    setSetting(db, 'orchestrator_provider', 'codex');
    setSetting(db, 'orchestrator_model', 'gpt-5.4');
    setSetting(db, 'default_model', 'claude-sonnet-4-6');

    applyMigrationV124(db);

    expect(getSettingValue(db, 'orchestrator_runtime')).toBe('codex-sdk');
    expect(getSettingValue(db, 'orchestrator_model')).toBe('gpt-5.4');
    expect(getSettingValue(db, 'default_model')).toBeUndefined();
  });

  it('passo 2: runtime presente com provider/model faltando completa pelo catalogo curado', () => {
    setSetting(db, 'orchestrator_runtime', 'codex-sdk');

    applyMigrationV124(db);

    expect(getSettingValue(db, 'orchestrator_runtime')).toBe('codex-sdk');
    expect(getSettingValue(db, 'orchestrator_provider')).toBe('codex');
    expect(getSettingValue(db, 'orchestrator_model')).toBe(CODEX_DEFAULT_MODEL);
  });

  it('passo 2: default_model NAO contradiz o runtime escolhido pelo usuario', () => {
    setSetting(db, 'orchestrator_runtime', 'claude-compat-sdk');
    setSetting(db, 'default_model', 'claude-opus-4-8');

    applyMigrationV124(db);

    expect(getSettingValue(db, 'orchestrator_runtime')).toBe('claude-compat-sdk');
    expect(getSettingValue(db, 'orchestrator_provider')).toBe('zai');
    expect(getSettingValue(db, 'orchestrator_model')).toBe(
      CLAUDE_COMPAT_PRESETS[0]?.models[0]?.id,
    );
    expect(getSettingValue(db, 'default_model')).toBeUndefined();
  });

  it('passo 2: preserva provider explicito e completa so o model', () => {
    setSetting(db, 'orchestrator_runtime', 'claude-sdk');
    setSetting(db, 'orchestrator_provider', 'anthropic');

    applyMigrationV124(db);

    expect(getSettingValue(db, 'orchestrator_provider')).toBe('anthropic');
    expect(getSettingValue(db, 'orchestrator_model')).toBe(CLAUDE_DEFAULT_MODEL);
  });

  it('passo 3a: runtime vazio com default_model slug canonico infere o triple', () => {
    setSetting(db, 'default_model', 'gpt-5.5');

    applyMigrationV124(db);

    expect(getSettingValue(db, 'orchestrator_runtime')).toBe('codex-sdk');
    expect(getSettingValue(db, 'orchestrator_provider')).toBe('codex');
    expect(getSettingValue(db, 'orchestrator_model')).toBe('gpt-5.5');
    expect(getSettingValue(db, 'default_model')).toBeUndefined();
  });

  it('passo 3a (alias): default_model = "sonnet" resolve para o slug e infere claude-sdk', () => {
    setSetting(db, 'default_model', 'sonnet');

    applyMigrationV124(db);

    expect(getSettingValue(db, 'orchestrator_runtime')).toBe('claude-sdk');
    expect(getSettingValue(db, 'orchestrator_provider')).toBe('anthropic');
    expect(getSettingValue(db, 'orchestrator_model')).toBe('claude-sonnet-4-6');
    expect(getSettingValue(db, 'default_model')).toBeUndefined();
  });

  it('passo 3a (alias): default_model = "opus"/"haiku" resolvem para os slugs', () => {
    const cases: Array<[string, string]> = [
      ['opus', 'claude-opus-4-7'],
      ['haiku', 'claude-haiku-4-5-20251001'],
    ];
    for (const [alias, slug] of cases) {
      const fresh = new Database(':memory:');
      fresh.exec(SCHEMA);
      setSetting(fresh, 'default_model', alias);
      applyMigrationV124(fresh);
      expect(getSettingValue(fresh, 'orchestrator_runtime')).toBe('claude-sdk');
      expect(getSettingValue(fresh, 'orchestrator_model')).toBe(slug);
      expect(getSettingValue(fresh, 'default_model')).toBeUndefined();
      fresh.close();
    }
  });

  it('passo 3b: settings vazios gravam PRODUCT_DEFAULT_ORCHESTRATOR completo', () => {
    applyMigrationV124(db);

    expect(getSettingValue(db, 'orchestrator_runtime')).toBe(
      PRODUCT_DEFAULT_ORCHESTRATOR.runtime,
    );
    expect(getSettingValue(db, 'orchestrator_provider')).toBe(
      PRODUCT_DEFAULT_ORCHESTRATOR.provider,
    );
    expect(getSettingValue(db, 'orchestrator_model')).toBe(
      PRODUCT_DEFAULT_ORCHESTRATOR.model,
    );
    expect(getSettingValue(db, 'default_model')).toBeUndefined();
  });

  it('passo 4: default_model e apagado mesmo quando o triple ja estava completo', () => {
    setSetting(db, 'orchestrator_runtime', 'claude-sdk');
    setSetting(db, 'orchestrator_provider', 'anthropic');
    setSetting(db, 'orchestrator_model', 'claude-opus-4-8');
    setSetting(db, 'default_model', 'sonnet');

    applyMigrationV124(db);

    expect(getSettingValue(db, 'default_model')).toBeUndefined();
  });

  it('idempotente: rodar 2x mantem o resultado e nao re-bumpa opus-4-7', () => {
    setSetting(db, 'orchestrator_runtime', 'claude-sdk');
    setSetting(db, 'orchestrator_provider', 'anthropic');
    setSetting(db, 'orchestrator_model', 'claude-opus-4-7');
    setSetting(db, 'default_model', 'sonnet');

    applyMigrationV124(db);
    applyMigrationV124(db);

    expect(getSettingValue(db, 'orchestrator_runtime')).toBe('claude-sdk');
    expect(getSettingValue(db, 'orchestrator_provider')).toBe('anthropic');
    expect(getSettingValue(db, 'orchestrator_model')).toBe('claude-opus-4-7');
    expect(getSettingValue(db, 'default_model')).toBeUndefined();
  });

  it('idempotente: passo 3b duas vezes mantem o default de produto', () => {
    applyMigrationV124(db);
    const firstModel = getSettingValue(db, 'orchestrator_model');
    applyMigrationV124(db);
    expect(getSettingValue(db, 'orchestrator_model')).toBe(firstModel);
    expect(getSettingValue(db, 'orchestrator_model')).toBe(
      PRODUCT_DEFAULT_ORCHESTRATOR.model,
    );
  });
});

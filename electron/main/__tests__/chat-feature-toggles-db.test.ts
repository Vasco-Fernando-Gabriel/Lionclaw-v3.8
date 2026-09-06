
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';

import {
  getChatFeatureToggles,
  setChatFeatureToggles,
  ensureChatFeatureToggles,
} from '../db';
import { applyMigrationV127 } from '../db-migrations/v127-chat-feature-toggles';


interface Harness {
  sqlite: DatabaseSync;
  db: Database.Database;
}

function makeDb(): Harness {
  const sqlite = new DatabaseSync(':memory:', {
    enableForeignKeyConstraints: true,
  });
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      type TEXT DEFAULT 'chat',
      status TEXT DEFAULT 'active',
      title TEXT
    );
  `);
  const db = sqlite as unknown as Database.Database;
  applyMigrationV127(db);
  return { sqlite, db };
}

function addSession(
  sqlite: DatabaseSync,
  id: string,
  type: string | null,
  status: string,
): void {
  sqlite
    .prepare('INSERT INTO sessions (id, type, status) VALUES (?, ?, ?)')
    .run(id, type, status);
}

interface FeatureRow {
  pipeline_control_enabled: number;
  dynamic_workflows_enabled: number;
}

function featureRow(sqlite: DatabaseSync, sessionId: string): FeatureRow | undefined {
  return sqlite
    .prepare(
      `SELECT pipeline_control_enabled, dynamic_workflows_enabled
         FROM chat_session_features WHERE session_id = ?`,
    )
    .get(sessionId) as FeatureRow | undefined;
}


describe('getChatFeatureToggles', () => {
  it('linha presente -> mapeia 0/1 para booleans', () => {
    const { sqlite, db } = makeDb();
    addSession(sqlite, 's1', 'chat', 'active');
    sqlite
      .prepare(
        `INSERT INTO chat_session_features
           (session_id, pipeline_control_enabled, dynamic_workflows_enabled)
         VALUES ('s1', 1, 0)`,
      )
      .run();

    expect(getChatFeatureToggles('s1', db)).toEqual({
      pipelineControl: true,
      dynamicWorkflows: false,
    });
  });

  it('sem linha -> null (caller decide o fallback, A.4)', () => {
    const { db } = makeDb();
    expect(getChatFeatureToggles('nao-existe', db)).toBeNull();
  });
});


describe('ensureChatFeatureToggles', () => {
  it('chat -> linha 0/0 (sessao desktop nova nasce OFF, decisao A.1-2)', () => {
    const { sqlite, db } = makeDb();
    addSession(sqlite, 's-chat', 'chat', 'active');
    ensureChatFeatureToggles('s-chat', 'chat', db);

    const row = featureRow(sqlite, 's-chat');
    expect(row).toEqual({
      pipeline_control_enabled: 0,
      dynamic_workflows_enabled: 0,
    });
    expect(getChatFeatureToggles('s-chat', db)).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
    });
  });

  it('manual -> linha 0/0 (tambem e desktop)', () => {
    const { sqlite, db } = makeDb();
    addSession(sqlite, 's-manual', 'manual', 'active');
    ensureChatFeatureToggles('s-manual', 'manual', db);
    expect(featureRow(sqlite, 's-manual')).toBeDefined();
  });

  it('telegram e scheduled -> SEM linha (lanes nao-desktop, A.9)', () => {
    const { sqlite, db } = makeDb();
    addSession(sqlite, 's-tg', 'telegram', 'active');
    addSession(sqlite, 's-cron', 'scheduled', 'active');
    ensureChatFeatureToggles('s-tg', 'telegram', db);
    ensureChatFeatureToggles('s-cron', 'scheduled', db);

    expect(featureRow(sqlite, 's-tg')).toBeUndefined();
    expect(featureRow(sqlite, 's-cron')).toBeUndefined();
  });

  it('idempotente: NUNCA sobrescreve linha existente (backfill 1/1 sobrevive)', () => {
    const { sqlite, db } = makeDb();
    addSession(sqlite, 's-legacy', 'chat', 'active');
    sqlite
      .prepare(
        `INSERT INTO chat_session_features
           (session_id, pipeline_control_enabled, dynamic_workflows_enabled)
         VALUES ('s-legacy', 1, 1)`,
      )
      .run();

    ensureChatFeatureToggles('s-legacy', 'chat', db);
    expect(featureRow(sqlite, 's-legacy')).toEqual({
      pipeline_control_enabled: 1,
      dynamic_workflows_enabled: 1,
    });
  });

  it('NUNCA lanca: dbh quebrado -> loga e segue (nao pode quebrar createSession)', () => {
    const broken = {
      prepare: () => {
        throw new Error('boom');
      },
    } as unknown as Database.Database;
    expect(() => ensureChatFeatureToggles('s-x', 'chat', broken)).not.toThrow();
  });
});


describe('setChatFeatureToggles - caminho feliz', () => {
  it('patch parcial faz MERGE sobre o persistido e retorna { ok:true, toggles }', () => {
    const { sqlite, db } = makeDb();
    addSession(sqlite, 's1', 'chat', 'active');
    ensureChatFeatureToggles('s1', 'chat', db);

    const first = setChatFeatureToggles('s1', { pipelineControl: true }, db);
    expect(first).toEqual({
      ok: true,
      toggles: { pipelineControl: true, dynamicWorkflows: false },
    });

    const second = setChatFeatureToggles('s1', { dynamicWorkflows: true }, db);
    expect(second).toEqual({
      ok: true,
      toggles: { pipelineControl: true, dynamicWorkflows: true },
    });

    expect(featureRow(sqlite, 's1')).toEqual({
      pipeline_control_enabled: 1,
      dynamic_workflows_enabled: 1,
    });
  });

  it('patch vazio e no-op valido (retorna o estado corrente)', () => {
    const { sqlite, db } = makeDb();
    addSession(sqlite, 's1', 'chat', 'active');
    sqlite
      .prepare(
        `INSERT INTO chat_session_features
           (session_id, pipeline_control_enabled, dynamic_workflows_enabled)
         VALUES ('s1', 1, 0)`,
      )
      .run();

    expect(setChatFeatureToggles('s1', {}, db)).toEqual({
      ok: true,
      toggles: { pipelineControl: true, dynamicWorkflows: false },
    });
  });

  it('sessao desktop legada SEM linha: upsert cria a linha (merge sobre default OFF)', () => {
    const { sqlite, db } = makeDb();
    addSession(sqlite, 's-orfa', 'manual', 'active');

    const result = setChatFeatureToggles('s-orfa', { dynamicWorkflows: true }, db);
    expect(result).toEqual({
      ok: true,
      toggles: { pipelineControl: false, dynamicWorkflows: true },
    });
    expect(featureRow(sqlite, 's-orfa')).toEqual({
      pipeline_control_enabled: 0,
      dynamic_workflows_enabled: 1,
    });
  });
});

describe('setChatFeatureToggles - validacoes (erro estruturado, sem throw)', () => {
  it('sessao inexistente -> { ok:false, code: session_not_found }', () => {
    const { db } = makeDb();
    expect(setChatFeatureToggles('fantasma', { pipelineControl: true }, db)).toEqual({
      ok: false,
      code: 'session_not_found',
    });
  });

  it('telegram/scheduled -> { ok:false, code: session_not_desktop }', () => {
    const { sqlite, db } = makeDb();
    addSession(sqlite, 's-tg', 'telegram', 'active');
    addSession(sqlite, 's-cron', 'scheduled', 'active');

    for (const id of ['s-tg', 's-cron']) {
      expect(setChatFeatureToggles(id, { pipelineControl: true }, db)).toEqual({
        ok: false,
        code: 'session_not_desktop',
      });
    }
  });

  it('status archived/compacted/trashed -> { ok:false, code: session_not_active }', () => {
    const { sqlite, db } = makeDb();
    addSession(sqlite, 's-arch', 'chat', 'archived');
    addSession(sqlite, 's-comp', 'chat', 'compacted');
    addSession(sqlite, 's-trash', 'manual', 'trashed');

    for (const id of ['s-arch', 's-comp', 's-trash']) {
      expect(setChatFeatureToggles(id, { pipelineControl: true }, db)).toEqual({
        ok: false,
        code: 'session_not_active',
      });
    }
  });

  it('rejeicao NAO escreve linha nenhuma', () => {
    const { sqlite, db } = makeDb();
    addSession(sqlite, 's-tg', 'telegram', 'active');
    setChatFeatureToggles('s-tg', { pipelineControl: true }, db);
    expect(featureRow(sqlite, 's-tg')).toBeUndefined();
  });
});


describe('guardrail estatico - createSession chama ensureChatFeatureToggles', () => {
  const dbSource = readFileSync(join(__dirname, '..', 'db.ts'), 'utf-8');

  it('o corpo de createSession invoca ensureChatFeatureToggles com o type da sessao', () => {
    const start = dbSource.indexOf('export function createSession(');
    expect(start).toBeGreaterThan(-1);
    const end = dbSource.indexOf('export function', start + 1);
    const body = dbSource.slice(start, end);
    expect(body).toContain("ensureChatFeatureToggles(id, options?.type ?? 'chat')");
  });
});

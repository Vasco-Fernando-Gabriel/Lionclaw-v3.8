
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const state = vi.hoisted(() => ({ home: '' }));

vi.mock('../paths', () => ({ getLionClawHome: () => state.home }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  initDatabase,
  getDb,
  upsertLocalRepository,
  removeLocalRepository,
  insertKanbanCardWithEvent,
  getKanbanCardByLocalId,
  listKanbanCardEvents,
} from '../db';
import * as dbApi from '../db';
import { KanbanEngine, normalizeGitRemoteUrl, type KanbanEngineDb } from '../kanban-engine';
import { RepoGraphEngine, type RepoGraphEngineDb, type RepoGraphProvider } from '../repo-graph/engine';
import type { KanbanCard, KanbanChangedEvent } from '../../../src/types/kanban';
import { applyMigrationV147 } from '../db-migrations/v147-kanban';


let attachmentsRoot = '';
let repoDir = '';
let repoId = '';
const changedEvents: KanbanChangedEvent[] = [];
let remoteUrl: string | null = null;

function realDbSurface(): KanbanEngineDb {
  return {
    insertKanbanBoard: dbApi.insertKanbanBoard,
    getKanbanBoard: dbApi.getKanbanBoard,
    getKanbanBoardByPrefix: dbApi.getKanbanBoardByPrefix,
    getKanbanBoardByRepositoryId: dbApi.getKanbanBoardByRepositoryId,
    listKanbanBoards: dbApi.listKanbanBoards,
    getKanbanBoardColumnCounts: dbApi.getKanbanBoardColumnCounts,
    deleteKanbanBoard: dbApi.deleteKanbanBoard,
    insertKanbanCardWithEvent: dbApi.insertKanbanCardWithEvent,
    updateKanbanCardWithEvents: dbApi.updateKanbanCardWithEvents,
    getKanbanCardByLocalId: dbApi.getKanbanCardByLocalId,
    deleteKanbanCard: dbApi.deleteKanbanCard,
    queryKanbanCards: dbApi.queryKanbanCards,
    listKanbanCardEvents: dbApi.listKanbanCardEvents,
    insertKanbanCardAttachmentWithEvent: dbApi.insertKanbanCardAttachmentWithEvent,
    deleteKanbanCardAttachmentWithEvent: dbApi.deleteKanbanCardAttachmentWithEvent,
    getKanbanCardAttachment: dbApi.getKanbanCardAttachment,
    listKanbanCardAttachments: dbApi.listKanbanCardAttachments,
    getLocalRepository: dbApi.getLocalRepository,
    listLocalRepositories: dbApi.listLocalRepositories,
  };
}

function makeEngine(overrides: Partial<KanbanEngineDb> = {}): KanbanEngine {
  const engine = new KanbanEngine(
    { ...realDbSurface(), ...overrides },
    {
      attachmentsRoot,
      resolveGitRemote: () => remoteUrl,
    },
  );
  engine.setChangeEmitter((event) => changedEvents.push(event));
  return engine;
}

let engine: KanbanEngine;

function okCard(result: ReturnType<KanbanEngine['createCard']>): KanbanCard {
  if (!('ok' in result)) throw new Error(`esperava ok, veio erro: ${result.error}`);
  return result.card;
}

function registerRepo(id: string, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  upsertLocalRepository({
    id,
    name: `repo-${id}`,
    rootPath: dir,
    canonicalRootPath: dir,
    gitRoot: null,
  });
}

beforeAll(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-kanban-home-'));
  attachmentsRoot = path.join(state.home, 'kanban');
  initDatabase();
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-kanban-repo-'));
  repoId = 'repo-kanban-main';
  registerRepo(repoId, repoDir);
  engine = makeEngine();
});

afterAll(() => {
  try {
    getDb().close();
  } catch {
  }
  try {
    fs.rmSync(state.home, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  } catch {
  }
});


describe('migration V147', () => {
  it('cria as 4 tabelas kanban_* e os 2 indices', () => {
    const names = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE '%kanban%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const set = new Set(names.map((row) => row.name));
    expect(set).toContain('kanban_boards');
    expect(set).toContain('kanban_cards');
    expect(set).toContain('kanban_card_events');
    expect(set).toContain('kanban_card_attachments');
    expect(set).toContain('idx_kanban_cards_board');
    expect(set).toContain('idx_kanban_events_card');
  });

  it('e idempotente (re-rodar em DB que ja tem as tabelas e no-op)', () => {
    const raw = new Database(':memory:');
    raw.exec('CREATE TABLE local_repositories (id TEXT PRIMARY KEY)');
    applyMigrationV147(raw);
    expect(() => applyMigrationV147(raw)).not.toThrow();
    raw.close();
  });
});


describe('boards', () => {
  it('cria quadro, normaliza prefixo para maiusculas e lista com contagens', () => {
    const result = engine.createBoard({ name: 'LionClaw', prefix: 'lc', repositoryId: repoId });
    expect(result).toMatchObject({ ok: true });
    if (!('ok' in result)) return;
    expect(result.board.prefix).toBe('LC');
    expect(result.board.nextLocalId).toBe(1);
    const boards = engine.listBoards().boards;
    expect(boards.some((board) => board.prefix === 'LC')).toBe(true);
    expect(boards.find((board) => board.prefix === 'LC')?.columnCounts).toEqual({
      Backlog: 0,
      Desenvolvimento: 0,
      Testes: 0,
      Done: 0,
    });
  });

  it('recusa (a) prefixo ja usado, mesmo com caixa diferente', () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-kanban-repo2-'));
    registerRepo('repo-kanban-2', otherDir);
    const result = engine.createBoard({ name: 'X', prefix: 'Lc', repositoryId: 'repo-kanban-2' });
    expect(result).toEqual({ error: expect.stringContaining('prefixo ja usado') });
  });

  it('recusa (b) repositorio que JA possui quadro', () => {
    const result = engine.createBoard({ name: 'Outro', prefix: 'XX', repositoryId: repoId });
    expect(result).toEqual({ error: expect.stringContaining('ja possui quadro Kanban (LC)') });
  });

  it('recusa (d) repositorio inexistente', () => {
    const result = engine.createBoard({ name: 'X', prefix: 'ZZ', repositoryId: 'nao-existe' });
    expect(result).toEqual({ error: expect.stringContaining('repositorio nao encontrado') });
  });

  it('delta 3.1: remover repositorio com quadro devolve { error } amigavel', () => {
    const repoGraph = new RepoGraphEngine(
      {
        getLocalRepository: dbApi.getLocalRepository,
        removeLocalRepository,
        getKanbanBoardForRepository: dbApi.getKanbanBoardByRepositoryId,
      } as unknown as RepoGraphEngineDb,
      {} as RepoGraphProvider,
    );
    const result = repoGraph.removeRepository(repoId);
    expect(result).toEqual({
      error: 'repositorio possui quadro Kanban (LC); delete o quadro antes',
    });
  });

  it('RESTRICT no banco e a ultima linha de defesa do delete de repo', () => {
    expect(() => removeLocalRepository(repoId)).toThrow(/FOREIGN KEY/i);
  });
});


describe('cards', () => {
  it('recusa (c) card sem titulo; título vazio idem', () => {
    expect(engine.createCard({ board: 'LC' }, 'user')).toEqual({
      error: expect.stringContaining('sem titulo'),
    });
    expect(engine.createCard({ board: 'LC', title: '   ' }, 'user')).toEqual({
      error: expect.stringContaining('sem titulo'),
    });
  });

  it('recusa (d) quadro inexistente', () => {
    expect(engine.createCard({ board: 'NOPE', title: 'x' }, 'user')).toEqual({
      error: expect.stringContaining('quadro nao encontrado'),
    });
  });

  it('next_local_id SO cresce, inclusive apos hard delete do maior numero', () => {
    const c1 = okCard(engine.createCard({ board: 'LC', title: 'Card 1' }, 'user'));
    const c2 = okCard(engine.createCard({ board: 'LC', title: 'Card 2' }, 'user'));
    const c3 = okCard(engine.createCard({ board: 'LC', title: 'Card 3' }, 'user'));
    expect([c1.localId, c2.localId, c3.localId]).toEqual([1, 2, 3]);
    const deleted = engine.deleteCard('LC', 3, true, 'user');
    expect(deleted).toMatchObject({ ok: true });
    const c4 = okCard(engine.createCard({ board: 'LC', title: 'Card 4' }, 'user'));
    expect(c4.localId).toBe(4); // "LC-3" nunca aponta para outro card
  });

  it('coage acento/caixa para o valor canonico nos 4 enums opcionais', () => {
    const card = okCard(
      engine.createCard(
        {
          board: 'LC',
          title: 'Coacao',
          type: 'debito tecnico',
          priority: 'critica',
          complexity: 'MEDIA',
          severity: 's2',
        },
        'user',
      ),
    );
    expect(card.type).toBe('Débito técnico');
    expect(card.priority).toBe('Crítica');
    expect(card.complexity).toBe('Média');
    expect(card.severity).toBe('S2');
  });

  it('enum opcional irreconhecivel grava NULL + warning (nunca erro SQL)', () => {
    const result = engine.createCard(
      { board: 'LC', title: 'Prio invalida', priority: 'Urgente' },
      'user',
    );
    const card = okCard(result);
    expect(card.priority).toBeNull();
    if ('ok' in result) {
      expect(result.warnings.some((w) => w.includes('Urgente'))).toBe(true);
    }
  });

  it('create com column irreconhecivel nasce em Backlog + warning', () => {
    const result = engine.createCard(
      { board: 'LC', title: 'Coluna doida', column: 'Andamento' },
      'user',
    );
    const card = okCard(result);
    expect(card.boardColumn).toBe('Backlog');
    if ('ok' in result) {
      expect(result.warnings.some((w) => w.includes('Backlog'))).toBe(true);
    }
    const events = listKanbanCardEvents(card.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'created', toColumn: 'Backlog', actor: 'user' });
  });

  it('create com column valida (caixa/acento diferentes) nasce nela, com evento created', () => {
    const card = okCard(
      engine.createCard({ board: 'LC', title: 'Direto em testes', column: 'TESTES' }, 'orchestrator'),
    );
    expect(card.boardColumn).toBe('Testes');
    const events = listKanbanCardEvents(card.id);
    expect(events[0]).toMatchObject({
      event: 'created',
      toColumn: 'Testes',
      actor: 'orchestrator',
    });
  });

  it('card+evento na MESMA transacao: falha no evento nao deixa card nem consome local_id', () => {
    const board = dbApi.getKanbanBoardByPrefix('LC');
    expect(board).not.toBeNull();
    if (!board) return;
    const nextBefore = board.nextLocalId;
    const countBefore = (
      getDb().prepare('SELECT COUNT(*) AS n FROM kanban_cards WHERE board_id = ?').get(board.id) as {
        n: number;
      }
    ).n;
    expect(() =>
      insertKanbanCardWithEvent(
        {
          boardId: board.id,
          title: 'fantasma',
          boardColumn: 'Backlog',
          type: null,
          priority: null,
          complexity: null,
          severity: null,
          problem: null,
          acceptanceCriteria: null,
          reproduction: null,
          acceptanceTests: null,
          commitUrl: null,
          docRef: null,
          startDate: null,
          dueDate: null,
          body: null,
        },
        { event: 'created', toColumn: 'Backlog', actor: 'martian' as never },
      ),
    ).toThrow();
    const countAfter = (
      getDb().prepare('SELECT COUNT(*) AS n FROM kanban_cards WHERE board_id = ?').get(board.id) as {
        n: number;
      }
    ).n;
    expect(countAfter).toBe(countBefore);
    expect(dbApi.getKanbanBoardByPrefix('LC')?.nextLocalId).toBe(nextBefore);
  });

  it('warnings de completude: card generico, Bug e Feature', () => {
    const generic = engine.createCard({ board: 'LC', title: 'Generico' }, 'user');
    if ('ok' in generic) {
      expect(generic.warnings).toContain('card sem criterio de aceite');
    }
    const bug = engine.createCard({ board: 'LC', title: 'Um bug', type: 'bug' }, 'user');
    if ('ok' in bug) {
      expect(bug.warnings).toContain('Bug sem reproducao');
      expect(bug.warnings).toContain('Bug sem severidade');
    }
    const feature = engine.createCard({ board: 'LC', title: 'Uma feature', type: 'FEATURE' }, 'user');
    if ('ok' in feature) {
      expect(feature.warnings).toContain('Feature sem testes de aceite');
    }
    const complete = engine.createCard(
      {
        board: 'LC',
        title: 'Bug completo',
        type: 'Bug',
        severity: 'S1',
        reproduction: '1. abrir',
        acceptanceCriteria: 'nao trava',
      },
      'user',
    );
    if ('ok' in complete) {
      expect(complete.warnings).toEqual([]);
    }
  });
});


describe('move', () => {
  it('recusa (g) coluna inexistente apos normalizacao', () => {
    const card = okCard(engine.createCard({ board: 'LC', title: 'Movivel' }, 'user'));
    const result = engine.moveCard('LC', card.localId, 'Limbo', null, 'user');
    expect(result).toEqual({ error: expect.stringContaining('coluna inexistente') });
    expect(getKanbanCardByLocalId(card.boardId, card.localId)?.boardColumn).toBe('Backlog');
  });

  it('-> Desenvolvimento seta start_date se vazio e grava moved com from/to', () => {
    const card = okCard(engine.createCard({ board: 'LC', title: 'Comeca dev' }, 'user'));
    const moved = engine.moveCard('LC', card.localId, 'desenvolvimento', null, 'orchestrator');
    if (!('ok' in moved)) throw new Error(moved.error);
    expect(moved.card.boardColumn).toBe('Desenvolvimento');
    expect(moved.card.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const events = listKanbanCardEvents(card.id);
    expect(events.at(-1)).toMatchObject({
      event: 'moved',
      fromColumn: 'Backlog',
      toColumn: 'Desenvolvimento',
      actor: 'orchestrator',
    });
  });

  it('-> Done sem commit_url executa com warning (nunca trava)', () => {
    const card = okCard(engine.createCard({ board: 'LC', title: 'Direto pra done' }, 'user'));
    const moved = engine.moveCard('LC', card.localId, 'done', null, 'user');
    if (!('ok' in moved)) throw new Error(moved.error);
    expect(moved.card.boardColumn).toBe('Done');
    expect(moved.warnings.some((w) => w.includes('sem commit_url'))).toBe(true);
  });

  it('para tras saindo de Done grava reopened; entre outras colunas grava moved; sem reason avisa', () => {
    const card = okCard(engine.createCard({ board: 'LC', title: 'Vai e volta' }, 'user'));
    engine.moveCard('LC', card.localId, 'Done', null, 'user');
    const reopened = engine.moveCard('LC', card.localId, 'Testes', 'regressao em prod', 'user');
    if (!('ok' in reopened)) throw new Error(reopened.error);
    let events = listKanbanCardEvents(card.id);
    expect(events.at(-1)).toMatchObject({
      event: 'reopened',
      fromColumn: 'Done',
      toColumn: 'Testes',
      reason: 'regressao em prod',
    });
    const backNoReason = engine.moveCard('LC', card.localId, 'Backlog', null, 'user');
    if (!('ok' in backNoReason)) throw new Error(backNoReason.error);
    expect(backNoReason.warnings.some((w) => w.includes('sem motivo'))).toBe(true);
    events = listKanbanCardEvents(card.id);
    expect(events.at(-1)).toMatchObject({
      event: 'moved',
      fromColumn: 'Testes',
      toColumn: 'Backlog',
      reason: null,
    });
  });
});


describe('deliver', () => {
  it('recusa (f) sem argumento commit', () => {
    const card = okCard(engine.createCard({ board: 'LC', title: 'Entrega' }, 'user'));
    expect(engine.deliverCard('LC', card.localId, undefined, undefined, 'orchestrator')).toEqual({
      error: expect.stringContaining('commit'),
    });
    expect(engine.deliverCard('LC', card.localId, '  ', undefined, 'orchestrator')).toEqual({
      error: expect.stringContaining('commit'),
    });
  });

  it('hash com remote SSH resolvivel vira URL https; commit vai no reason do delivered', () => {
    remoteUrl = 'git@github.com:breno/lionclaw.git';
    const card = okCard(engine.createCard({ board: 'LC', title: 'Entrega com hash' }, 'user'));
    const hash = 'abc1234def5678abc1234def5678abc1234def56';
    const delivered = engine.deliverCard('LC', card.localId, hash, undefined, 'orchestrator');
    if (!('ok' in delivered)) throw new Error(delivered.error);
    const expectedUrl = `https://github.com/breno/lionclaw/commit/${hash}`;
    expect(delivered.card.commitUrl).toBe(expectedUrl);
    expect(delivered.card.boardColumn).toBe('Testes'); // default
    expect(delivered.warnings).toEqual([]);
    const events = listKanbanCardEvents(card.id);
    expect(events.at(-1)).toMatchObject({
      event: 'delivered',
      fromColumn: 'Backlog',
      toColumn: 'Testes',
      reason: expectedUrl,
      actor: 'orchestrator',
    });
    remoteUrl = null;
  });

  it('hash sem remote resolvivel grava o hash cru + warning', () => {
    remoteUrl = null;
    const card = okCard(engine.createCard({ board: 'LC', title: 'Entrega sem remote' }, 'user'));
    const delivered = engine.deliverCard('LC', card.localId, 'deadbeef1', 'Done', 'user');
    if (!('ok' in delivered)) throw new Error(delivered.error);
    expect(delivered.card.commitUrl).toBe('deadbeef1');
    expect(delivered.card.boardColumn).toBe('Done');
    expect(delivered.warnings.some((w) => w.includes('remote'))).toBe(true);
  });

  it('URL e gravada como esta; normalizeGitRemoteUrl cobre gitlab e .git', () => {
    const card = okCard(engine.createCard({ board: 'LC', title: 'Entrega com URL' }, 'user'));
    const url = 'https://github.com/breno/lionclaw/commit/aaa';
    const delivered = engine.deliverCard('LC', card.localId, url, undefined, 'user');
    if (!('ok' in delivered)) throw new Error(delivered.error);
    expect(delivered.card.commitUrl).toBe(url);
    expect(normalizeGitRemoteUrl('git@gitlab.com:g/p.git')).toBe('https://gitlab.com/g/p');
    expect(normalizeGitRemoteUrl('https://github.com/g/p.git')).toBe('https://github.com/g/p');
    expect(normalizeGitRemoteUrl('')).toBeNull();
  });
});


describe('stalled_days', () => {
  it('card que nunca moveu conta a partir do created; card entregue a partir do delivered', () => {
    const parado = okCard(engine.createCard({ board: 'LC', title: 'Parado 3 dias' }, 'user'));
    getDb()
      .prepare(
        `UPDATE kanban_card_events SET created_at = datetime('now', '-3 days')
         WHERE card_id = ? AND event = 'created'`,
      )
      .run(parado.id);
    const stale = getKanbanCardByLocalId(parado.boardId, parado.localId);
    expect(stale?.stalledDays).toBe(3);

    const entregue = okCard(engine.createCard({ board: 'LC', title: 'Entregue ha 1 dia' }, 'user'));
    engine.deliverCard('LC', entregue.localId, 'https://x/commit/1', undefined, 'user');
    getDb()
      .prepare(
        `UPDATE kanban_card_events SET created_at = datetime('now', '-9 days')
         WHERE card_id = ? AND event = 'created'`,
      )
      .run(entregue.id);
    getDb()
      .prepare(
        `UPDATE kanban_card_events SET created_at = datetime('now', '-1 days')
         WHERE card_id = ? AND event = 'delivered'`,
      )
      .run(entregue.id);
    const fresh = getKanbanCardByLocalId(entregue.boardId, entregue.localId);
    expect(fresh?.stalledDays).toBe(1);

    const query = engine.queryCards({ board: 'LC', stalledDays: 2 });
    if (!('ok' in query)) throw new Error(query.error);
    const ids = query.cards.map((card) => card.localId);
    expect(ids).toContain(parado.localId);
    expect(ids).not.toContain(entregue.localId);
  });

  it('card recem-criado tem stalledDays 0', () => {
    const card = okCard(engine.createCard({ board: 'LC', title: 'Fresquinho' }, 'user'));
    expect(getKanbanCardByLocalId(card.boardId, card.localId)?.stalledDays).toBe(0);
  });
});


describe('query', () => {
  it('busca por "LC-1" acha o card pelo prefixo+local_id', () => {
    const result = engine.queryCards({ text: 'LC-1' });
    if (!('ok' in result)) throw new Error(result.error);
    expect(result.cards.some((card) => card.localId === 1 && card.boardPrefix === 'LC')).toBe(true);
  });

  it('filtros de enum sao coagidos (priority "critica")', () => {
    const result = engine.queryCards({ board: 'LC', priority: 'critica' });
    if (!('ok' in result)) throw new Error(result.error);
    expect(result.cards.every((card) => card.priority === 'Crítica')).toBe(true);
    expect(result.cards.length).toBeGreaterThan(0);
  });

  it('quadro inexistente na query e recusa (d)', () => {
    expect(engine.queryCards({ board: 'NOPE' })).toEqual({
      error: expect.stringContaining('quadro nao encontrado'),
    });
  });
});


describe('archive/unarchive/delete', () => {
  it('archive tira da query default, unarchive traz de volta; eventos gravados', () => {
    const card = okCard(engine.createCard({ board: 'LC', title: 'Arquivavel' }, 'user'));
    const archived = engine.archiveCard('LC', card.localId, 'user');
    if (!('ok' in archived)) throw new Error(archived.error);
    expect(archived.card.archived).toBe(true);

    const active = engine.queryCards({ board: 'LC' });
    if (!('ok' in active)) throw new Error(active.error);
    expect(active.cards.some((c) => c.localId === card.localId)).toBe(false);

    const onlyArchived = engine.queryCards({ board: 'LC', archived: true });
    if (!('ok' in onlyArchived)) throw new Error(onlyArchived.error);
    expect(onlyArchived.cards.some((c) => c.localId === card.localId)).toBe(true);

    const unarchived = engine.unarchiveCard('LC', card.localId, 'user');
    if (!('ok' in unarchived)) throw new Error(unarchived.error);
    expect(unarchived.card.archived).toBe(false);

    const eventTypes = listKanbanCardEvents(card.id).map((event) => event.event);
    expect(eventTypes).toContain('archived');
    expect(eventTypes).toContain('unarchived');
  });

  it('delete default ARQUIVA (reversivel); update com archived=false desarquiva', () => {
    const card = okCard(engine.createCard({ board: 'LC', title: 'Soft delete' }, 'user'));
    const soft = engine.deleteCard('LC', card.localId, false, 'user');
    if (!('ok' in soft)) throw new Error(soft.error);
    expect(soft.card?.archived).toBe(true);
    const updated = engine.updateCard('LC', card.localId, { archived: false }, 'user');
    if (!('ok' in updated)) throw new Error(updated.error);
    expect(updated.card.archived).toBe(false);
  });

  it('hard delete remove card, eventos (CASCADE) e a pasta de anexos', () => {
    const card = okCard(engine.createCard({ board: 'LC', title: 'Hard delete' }, 'user'));
    const file = path.join(os.tmpdir(), `lc-kanban-evidencia-${Date.now()}.txt`);
    fs.writeFileSync(file, 'evidencia', 'utf8');
    const attached = engine.attachFile('LC', card.localId, file, 'user');
    if (!('ok' in attached)) throw new Error(attached.error);
    const cardDir = path.join(attachmentsRoot, card.boardId, String(card.localId));
    expect(fs.existsSync(cardDir)).toBe(true);

    const deleted = engine.deleteCard('LC', card.localId, true, 'user');
    expect(deleted).toMatchObject({ ok: true });
    expect(getKanbanCardByLocalId(card.boardId, card.localId)).toBeNull();
    expect(listKanbanCardEvents(card.id)).toEqual([]);
    const orphanEvents = (
      getDb().prepare('SELECT COUNT(*) AS n FROM kanban_card_events WHERE card_id = ?').get(card.id) as {
        n: number;
      }
    ).n;
    expect(orphanEvents).toBe(0);
    expect(fs.existsSync(cardDir)).toBe(false);
    fs.rmSync(file, { force: true });
  });
});


describe('anexos', () => {
  it('recusa (e) arquivo inexistente', () => {
    const card = okCard(engine.createCard({ board: 'LC', title: 'Sem arquivo' }, 'user'));
    expect(engine.attachFile('LC', card.localId, path.join(os.tmpdir(), 'nao-existe-987.txt'), 'user')).toEqual({
      error: expect.stringContaining('arquivo nao encontrado'),
    });
  });

  it('attach copia para <board_id>/<local_id>/, grava stored_path relativo e evento', () => {
    const card = okCard(engine.createCard({ board: 'LC', title: 'Com anexo' }, 'user'));
    const file = path.join(os.tmpdir(), `lc-kanban-anexo-${Date.now()}.md`);
    fs.writeFileSync(file, '# doc', 'utf8');
    const attached = engine.attachFile('LC', card.localId, file, 'orchestrator');
    if (!('ok' in attached)) throw new Error(attached.error);
    expect(attached.attachment.storedPath).toBe(
      `${card.boardId}/${card.localId}/${path.basename(file)}`,
    );
    expect(attached.attachment.mime).toBe('text/markdown');
    expect(
      fs.existsSync(path.join(attachmentsRoot, card.boardId, String(card.localId), path.basename(file))),
    ).toBe(true);
    expect(listKanbanCardEvents(card.id).at(-1)).toMatchObject({
      event: 'attachment-added',
      actor: 'orchestrator',
    });

    const again = engine.attachFile('LC', card.localId, file, 'user');
    if (!('ok' in again)) throw new Error(again.error);
    expect(again.attachment.filename).not.toBe(attached.attachment.filename);

    const removed = engine.removeAttachment(attached.attachment.id, 'user');
    expect(removed).toMatchObject({ ok: true });
    expect(dbApi.getKanbanCardAttachment(attached.attachment.id)).toBeNull();
    expect(
      fs.existsSync(path.join(attachmentsRoot, ...attached.attachment.storedPath.split('/'))),
    ).toBe(false);
    expect(listKanbanCardEvents(card.id).at(-1)).toMatchObject({ event: 'attachment-removed' });
    fs.rmSync(file, { force: true });
  });

  it('atomicidade: insert falho REMOVE a copia (nunca linha sem arquivo nem lixo orfao)', () => {
    const failing = makeEngine({
      insertKanbanCardAttachmentWithEvent: () => {
        throw new Error('disco caiu no meio');
      },
    });
    const card = okCard(engine.createCard({ board: 'LC', title: 'Anexo atomico' }, 'user'));
    const file = path.join(os.tmpdir(), `lc-kanban-atomico-${Date.now()}.txt`);
    fs.writeFileSync(file, 'x', 'utf8');
    const result = failing.attachFile('LC', card.localId, file, 'user');
    expect(result).toEqual({ error: expect.stringContaining('falha ao registrar anexo') });
    const cardDir = path.join(attachmentsRoot, card.boardId, String(card.localId));
    const leftovers = fs.existsSync(cardDir) ? fs.readdirSync(cardDir) : [];
    expect(leftovers).toEqual([]);
    expect(dbApi.listKanbanCardAttachments(card.id)).toEqual([]);
    fs.rmSync(file, { force: true });
  });
});


describe('update e broadcast', () => {
  it('update coage enums, grava edited e recomputa warnings de completude', () => {
    const card = okCard(engine.createCard({ board: 'LC', title: 'Editavel' }, 'user'));
    const updated = engine.updateCard(
      'LC',
      card.localId,
      { type: 'bug', severity: 'S3', reproduction: '1. clicar' },
      'user',
    );
    if (!('ok' in updated)) throw new Error(updated.error);
    expect(updated.card.type).toBe('Bug');
    expect(updated.card.severity).toBe('S3');
    expect(updated.warnings).toContain('card sem criterio de aceite');
    expect(updated.warnings).not.toContain('Bug sem reproducao');
    expect(listKanbanCardEvents(card.id).at(-1)).toMatchObject({ event: 'edited' });
  });

  it('toda escrita emite kanban:changed com o boardId', () => {
    const before = changedEvents.length;
    const card = okCard(engine.createCard({ board: 'LC', title: 'Broadcast' }, 'user'));
    engine.moveCard('LC', card.localId, 'Testes', null, 'user');
    expect(changedEvents.length).toBe(before + 2);
    expect(changedEvents.at(-1)).toEqual({ boardId: card.boardId });
  });
});

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import type {
  KanbanBoard,
  KanbanBoardWithCounts,
  KanbanCard,
  KanbanCardEvent,
  KanbanCardDetail,
  KanbanAttachment,
  KanbanColumnId,
  KanbanActor,
  KanbanActorInput,
  KanbanCardCreateInput,
  KanbanCardPatch,
  KanbanQueryFilters,
  KanbanWriteResult,
  KanbanAck,
  KanbanChangedEvent,
} from '../../src/types/kanban';
import { KANBAN_COLUMNS } from '../../src/types/kanban';
import * as dbApi from './db';
import type { KanbanCardRowInput, KanbanCardRowPatch, KanbanCardQuery, KanbanEventInput } from './db';
import type { LocalRepositoryRecord } from './repo-graph/types';

const logger = createLogger('kanban-engine');

function eventActor(actor: KanbanActorInput): { actor: KanbanActor; actorDetail: string | null } {
  return typeof actor === 'string' ? { actor, actorDetail: null } : { actor: actor.actor, actorDetail: actor.detail };
}

export interface KanbanEngineDb {
  insertKanbanBoard: (input: { id: string; repositoryId: string; name: string; prefix: string }) => KanbanBoard;
  getKanbanBoard: (id: string) => KanbanBoard | null;
  getKanbanBoardByPrefix: (prefix: string) => KanbanBoard | null;
  getKanbanBoardByRepositoryId: (repositoryId: string) => KanbanBoard | null;
  listKanbanBoards: () => KanbanBoard[];
  getKanbanBoardColumnCounts: (boardId: string) => Record<KanbanColumnId, number>;
  deleteKanbanBoard: (id: string) => void;
  insertKanbanCardWithEvent: (input: KanbanCardRowInput, event: KanbanEventInput) => KanbanCard;
  updateKanbanCardWithEvents: (cardId: number, patch: KanbanCardRowPatch, events: KanbanEventInput[]) => KanbanCard;
  getKanbanCardByLocalId: (boardId: string, localId: number) => KanbanCard | null;
  deleteKanbanCard: (id: number) => void;
  queryKanbanCards: (query: KanbanCardQuery) => KanbanCard[];
  listKanbanCardEvents: (cardId: number) => KanbanCardEvent[];
  insertKanbanCardAttachmentWithEvent: (
    input: {
      id: string;
      cardId: number;
      filename: string;
      storedPath: string;
      mime: string | null;
      sizeBytes: number | null;
    },
    event: KanbanEventInput,
  ) => KanbanAttachment;
  deleteKanbanCardAttachmentWithEvent: (attachmentId: string, event: KanbanEventInput) => void;
  getKanbanCardAttachment: (id: string) => KanbanAttachment | null;
  listKanbanCardAttachments: (cardId: number) => KanbanAttachment[];
  getLocalRepository: (id: string) => LocalRepositoryRecord | null;
  listLocalRepositories: () => LocalRepositoryRecord[];
}

export interface KanbanEngineOptions {
  attachmentsRoot?: string;
  resolveGitRemote?: (repoRoot: string) => string | null;
}

function foldEnumKey(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

function buildEnumMap(canonical: readonly string[]): Map<string, string> {
  return new Map(canonical.map((value) => [foldEnumKey(value), value]));
}

const TYPE_MAP = buildEnumMap(['Bug', 'Feature', 'Débito técnico', 'Chore']);
const PRIORITY_MAP = buildEnumMap(['Crítica', 'Alta', 'Média', 'Baixa']);
const COMPLEXITY_MAP = buildEnumMap(['Baixa', 'Média', 'Alta']);
const SEVERITY_MAP = buildEnumMap(['S1', 'S2', 'S3', 'S4']);
const COLUMN_MAP = buildEnumMap(KANBAN_COLUMNS);

const COLUMN_ORDER: Record<KanbanColumnId, number> = {
  Backlog: 0,
  Desenvolvimento: 1,
  Testes: 2,
  Done: 3,
};

function coerceOptionalEnum(
  value: string | null | undefined,
  map: Map<string, string>,
  field: string,
  warnings: string[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;
  const canonical = map.get(foldEnumKey(value));
  if (canonical) return canonical;
  warnings.push(`${field} "${value}" nao reconhecido; gravado vazio`);
  return null;
}

function coerceColumn(value: string): KanbanColumnId | null {
  return (COLUMN_MAP.get(foldEnumKey(value)) as KanbanColumnId | undefined) ?? null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
};

const ATTACHMENT_SIZE_WARNING_BYTES = 25 * 1024 * 1024;

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

export function normalizeGitRemoteUrl(remote: string): string | null {
  let url = remote.trim();
  if (url === '') return null;
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) url = `https://${sshMatch[1]}/${sshMatch[2]}`;
  if (url.startsWith('ssh://git@')) url = `https://${url.slice('ssh://git@'.length)}`;
  if (!/^https?:\/\//.test(url)) return null;
  return url.replace(/\.git$/, '').replace(/\/+$/, '');
}

function buildCommitUrl(baseUrl: string, hash: string): string {
  const isGitlab = baseUrl.includes('gitlab');
  return `${baseUrl}${isGitlab ? '/-/commit/' : '/commit/'}${hash}`;
}

function defaultResolveGitRemote(repoRoot: string): string | null {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    const remote = out.trim();
    return remote === '' ? null : remote;
  } catch {
    return null;
  }
}

function completenessWarnings(card: KanbanCard): string[] {
  const warnings: string[] = [];
  if (!card.acceptanceCriteria || card.acceptanceCriteria.trim() === '') {
    warnings.push('card sem criterio de aceite');
  }
  if (card.type === 'Bug') {
    if (!card.reproduction || card.reproduction.trim() === '') {
      warnings.push('Bug sem reproducao');
    }
    if (!card.severity) warnings.push('Bug sem severidade');
  }
  if (card.type === 'Feature' && (!card.acceptanceTests || card.acceptanceTests.trim() === '')) {
    warnings.push('Feature sem testes de aceite');
  }
  return warnings;
}

export class KanbanEngine {
  private readonly db: KanbanEngineDb;
  private readonly attachmentsRoot: string;
  private readonly resolveGitRemote: (repoRoot: string) => string | null;
  private changeEmitter: ((event: KanbanChangedEvent) => void) | null = null;

  constructor(db: KanbanEngineDb, options: KanbanEngineOptions = {}) {
    this.db = db;
    this.attachmentsRoot = options.attachmentsRoot ?? path.join(getLionClawHome(), 'kanban');
    this.resolveGitRemote = options.resolveGitRemote ?? defaultResolveGitRemote;
  }

  setChangeEmitter(emitter: ((event: KanbanChangedEvent) => void) | null): void {
    this.changeEmitter = emitter;
  }

  private emitChanged(boardId: string): void {
    try {
      this.changeEmitter?.({ boardId });
    } catch (err) {
      logger.warn({ err, boardId }, 'emitter de kanban:changed falhou');
    }
  }

  createBoard(input: {
    name?: string;
    prefix?: string;
    repositoryId?: string;
    repoPath?: string;
  }): KanbanWriteResult<{ board: KanbanBoard }> {
    const warnings: string[] = [];
    const repo = this.resolveRepository(input.repositoryId, input.repoPath);
    if (!repo) {
      const ref = input.repositoryId ?? input.repoPath ?? '(nenhuma referencia)';
      return { error: `repositorio nao encontrado: ${ref}` };
    }
    const prefix = (input.prefix ?? '').trim().toUpperCase();
    if (prefix === '') {
      return { error: 'prefixo obrigatorio para criar quadro (ancora dos ids, ex: "LC")' };
    }
    if (!/^[A-Z]{2,4}$/.test(prefix)) {
      warnings.push(`prefixo "${prefix}" fora do padrao 2-4 letras maiusculas`);
    }
    if (this.db.getKanbanBoardByPrefix(prefix)) {
      return { error: `prefixo ja usado por outro quadro: ${prefix}` };
    }
    const existing = this.db.getKanbanBoardByRepositoryId(repo.id);
    if (existing) {
      return {
        error: `repositorio ja possui quadro Kanban (${existing.prefix}); 1 quadro por repositorio`,
      };
    }
    let name = (input.name ?? '').trim();
    if (name === '') {
      name = repo.name;
      warnings.push(`nome vazio; usando o nome do repositorio ("${name}")`);
    }
    const board = this.db.insertKanbanBoard({
      id: crypto.randomUUID(),
      repositoryId: repo.id,
      name,
      prefix,
    });
    this.emitChanged(board.id);
    return { ok: true, board, warnings };
  }

  listBoards(): { ok: true; boards: KanbanBoardWithCounts[] } {
    const boards = this.db.listKanbanBoards().map((board) => {
      const repo = this.db.getLocalRepository(board.repositoryId);
      return {
        ...board,
        repoPath: repo?.rootPath ?? null,
        repoName: repo?.name ?? null,
        columnCounts: this.db.getKanbanBoardColumnCounts(board.id),
      };
    });
    return { ok: true, boards };
  }

  deleteBoard(boardId: string): KanbanAck {
    const board = this.db.getKanbanBoard(boardId);
    if (!board) return { error: `quadro nao encontrado: ${boardId}` };
    this.db.deleteKanbanBoard(board.id);
    this.removeAttachmentDir(path.join(this.attachmentsRoot, board.id));
    logger.info({ boardId: board.id, prefix: board.prefix, name: board.name }, 'quadro kanban deletado (hard, via UI)');
    this.emitChanged(board.id);
    return { ok: true, warnings: [] };
  }

  createCard(input: KanbanCardCreateInput, actor: KanbanActorInput): KanbanWriteResult<{ card: KanbanCard }> {
    const warnings: string[] = [];
    const board = this.findBoard(input.board);
    if (!board) return { error: `quadro nao encontrado: ${input.board}` };
    const title = (input.title ?? '').trim();
    if (title === '') return { error: 'card sem titulo (unico campo obrigatorio)' };

    let column: KanbanColumnId = 'Backlog';
    if (input.column !== undefined && input.column !== null && input.column.trim() !== '') {
      const coerced = coerceColumn(input.column);
      if (coerced) {
        column = coerced;
      } else {
        warnings.push(`coluna "${input.column}" nao reconhecida; card criado em Backlog`);
      }
    }

    const card = this.db.insertKanbanCardWithEvent(
      {
        boardId: board.id,
        title,
        boardColumn: column,
        type: coerceOptionalEnum(input.type, TYPE_MAP, 'tipo', warnings) ?? null,
        priority: coerceOptionalEnum(input.priority, PRIORITY_MAP, 'prioridade', warnings) ?? null,
        complexity: coerceOptionalEnum(input.complexity, COMPLEXITY_MAP, 'complexidade', warnings) ?? null,
        severity: coerceOptionalEnum(input.severity, SEVERITY_MAP, 'severidade', warnings) ?? null,
        problem: input.problem ?? null,
        acceptanceCriteria: input.acceptanceCriteria ?? null,
        reproduction: input.reproduction ?? null,
        acceptanceTests: input.acceptanceTests ?? null,
        commitUrl: input.commitUrl ?? null,
        docRef: input.docRef ?? null,
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        body: input.body ?? null,
      },
      { event: 'created', toColumn: column, ...eventActor(actor) },
    );
    warnings.push(...completenessWarnings(card));
    this.emitChanged(board.id);
    return { ok: true, card, warnings };
  }

  getCard(boardRef: string, localId: number): KanbanWriteResult<KanbanCardDetail> {
    const found = this.findCard(boardRef, localId);
    if ('error' in found) return found;
    return {
      ok: true,
      warnings: [],
      card: found.card,
      events: this.db.listKanbanCardEvents(found.card.id),
      attachments: this.db.listKanbanCardAttachments(found.card.id),
    };
  }

  queryCards(filters: KanbanQueryFilters): KanbanWriteResult<{ cards: KanbanCard[] }> {
    const warnings: string[] = [];
    const query: KanbanCardQuery = { archived: filters.archived === true };
    if (filters.board !== undefined && filters.board.trim() !== '') {
      const board = this.findBoard(filters.board);
      if (!board) return { error: `quadro nao encontrado: ${filters.board}` };
      query.boardId = board.id;
    }
    if (filters.column !== undefined && filters.column.trim() !== '') {
      const column = coerceColumn(filters.column);
      if (column) query.column = column;
      else warnings.push(`coluna "${filters.column}" nao reconhecida; filtro ignorado`);
    }
    query.type = coerceOptionalEnum(filters.type, TYPE_MAP, 'tipo', warnings) ?? undefined;
    query.priority = coerceOptionalEnum(filters.priority, PRIORITY_MAP, 'prioridade', warnings) ?? undefined;
    query.severity = coerceOptionalEnum(filters.severity, SEVERITY_MAP, 'severidade', warnings) ?? undefined;
    if (filters.text !== undefined && filters.text.trim() !== '') {
      const text = filters.text.trim();
      query.text = text;
      const refMatch = text.match(/^([A-Za-z]{2,4})-(\d+)$/);
      if (refMatch) {
        query.textRef = { prefix: refMatch[1].toUpperCase(), localId: Number(refMatch[2]) };
      }
    }
    if (filters.dueBefore !== undefined && filters.dueBefore.trim() !== '') {
      query.dueBefore = filters.dueBefore.trim();
    }
    if (filters.stalledDays !== undefined) query.stalledDays = filters.stalledDays;
    return { ok: true, warnings, cards: this.db.queryKanbanCards(query) };
  }

  updateCard(
    boardRef: string,
    localId: number,
    patch: KanbanCardPatch,
    actor: KanbanActorInput,
  ): KanbanWriteResult<{ card: KanbanCard }> {
    const found = this.findCard(boardRef, localId);
    if ('error' in found) return found;
    const before = found.card;
    const warnings: string[] = [];

    const rowPatch: KanbanCardRowPatch = {};
    if (patch.title !== undefined) {
      rowPatch.title = patch.title.trim();
      if (rowPatch.title === '') warnings.push('titulo ficou vazio');
    }
    if (patch.type !== undefined) {
      rowPatch.type = coerceOptionalEnum(patch.type, TYPE_MAP, 'tipo', warnings) ?? null;
    }
    if (patch.priority !== undefined) {
      rowPatch.priority = coerceOptionalEnum(patch.priority, PRIORITY_MAP, 'prioridade', warnings) ?? null;
    }
    if (patch.complexity !== undefined) {
      rowPatch.complexity = coerceOptionalEnum(patch.complexity, COMPLEXITY_MAP, 'complexidade', warnings) ?? null;
    }
    if (patch.severity !== undefined) {
      rowPatch.severity = coerceOptionalEnum(patch.severity, SEVERITY_MAP, 'severidade', warnings) ?? null;
    }
    for (const key of [
      'problem',
      'acceptanceCriteria',
      'reproduction',
      'acceptanceTests',
      'commitUrl',
      'docRef',
      'startDate',
      'dueDate',
      'body',
    ] as const) {
      if (patch[key] !== undefined) rowPatch[key] = patch[key];
    }

    const events: KanbanEventInput[] = [];
    const editedFields = Object.keys(rowPatch);
    if (editedFields.length > 0) {
      events.push({
        event: 'edited',
        reason: `campos: ${editedFields.join(', ')}`,
        ...eventActor(actor),
      });
    }
    if (patch.archived !== undefined && patch.archived !== before.archived) {
      rowPatch.archived = patch.archived;
      events.push({ event: patch.archived ? 'archived' : 'unarchived', ...eventActor(actor) });
    }
    if (editedFields.length === 0 && rowPatch.archived === undefined) {
      warnings.push('nenhum campo para atualizar');
      return { ok: true, card: before, warnings };
    }

    const card = this.db.updateKanbanCardWithEvents(before.id, rowPatch, events);
    warnings.push(...completenessWarnings(card));
    this.emitChanged(card.boardId);
    return { ok: true, card, warnings };
  }

  moveCard(
    boardRef: string,
    localId: number,
    toColumnRaw: string,
    reason: string | null | undefined,
    actor: KanbanActorInput,
  ): KanbanWriteResult<{ card: KanbanCard }> {
    const found = this.findCard(boardRef, localId);
    if ('error' in found) return found;
    const before = found.card;
    const toColumn = coerceColumn(toColumnRaw);
    if (!toColumn) {
      return {
        error: `coluna inexistente: "${toColumnRaw}" (validas: ${KANBAN_COLUMNS.join(', ')})`,
      };
    }
    const warnings: string[] = [];
    if (toColumn === before.boardColumn) {
      warnings.push(`card ja esta em ${toColumn}`);
      return { ok: true, card: before, warnings };
    }

    const backward = COLUMN_ORDER[toColumn] < COLUMN_ORDER[before.boardColumn];
    if (toColumn === 'Done' && !before.commitUrl) {
      warnings.push('movido para Done sem commit_url (a entrega formal e card_deliver)');
    }
    if (backward && (!reason || reason.trim() === '')) {
      warnings.push('movimento para tras sem motivo registrado');
    }

    const rowPatch: KanbanCardRowPatch = { boardColumn: toColumn };
    if (toColumn === 'Desenvolvimento' && !before.startDate) {
      rowPatch.startDate = todayIso();
    }
    const event: KanbanEventInput = {
      event: backward && before.boardColumn === 'Done' ? 'reopened' : 'moved',
      fromColumn: before.boardColumn,
      toColumn,
      reason: reason?.trim() || null,
      ...eventActor(actor),
    };
    const card = this.db.updateKanbanCardWithEvents(before.id, rowPatch, [event]);
    this.emitChanged(card.boardId);
    return { ok: true, card, warnings };
  }

  deliverCard(
    boardRef: string,
    localId: number,
    commit: string | null | undefined,
    toColumnRaw: string | null | undefined,
    actor: KanbanActorInput,
  ): KanbanWriteResult<{ card: KanbanCard }> {
    const found = this.findCard(boardRef, localId);
    if ('error' in found) return found;
    const before = found.card;
    if (!commit || commit.trim() === '') {
      return { error: 'card_deliver exige o argumento commit (URL ou hash); sem commit use card_move' };
    }
    const warnings: string[] = [];

    let toColumn: KanbanColumnId = 'Testes';
    if (toColumnRaw !== undefined && toColumnRaw !== null && toColumnRaw.trim() !== '') {
      const coerced = coerceColumn(toColumnRaw);
      if (coerced) {
        toColumn = coerced;
      } else {
        warnings.push(`coluna "${toColumnRaw}" nao reconhecida; entrega registrada em Testes`);
      }
    }

    const commitUrl = this.resolveCommitRef(commit.trim(), before.boardId, warnings);
    const rowPatch: KanbanCardRowPatch = { boardColumn: toColumn, commitUrl };
    const event: KanbanEventInput = {
      event: 'delivered',
      fromColumn: before.boardColumn,
      toColumn,
      reason: commitUrl,
      ...eventActor(actor),
    };
    const card = this.db.updateKanbanCardWithEvents(before.id, rowPatch, [event]);
    this.emitChanged(card.boardId);
    return { ok: true, card, warnings };
  }

  archiveCard(boardRef: string, localId: number, actor: KanbanActorInput): KanbanWriteResult<{ card: KanbanCard }> {
    return this.setArchived(boardRef, localId, true, actor);
  }

  unarchiveCard(boardRef: string, localId: number, actor: KanbanActorInput): KanbanWriteResult<{ card: KanbanCard }> {
    return this.setArchived(boardRef, localId, false, actor);
  }

  deleteCard(
    boardRef: string,
    localId: number,
    hard: boolean,
    actor: KanbanActorInput,
  ): KanbanWriteResult<{ card: KanbanCard | null }> {
    if (!hard) {
      const archived = this.setArchived(boardRef, localId, true, actor);
      if ('error' in archived) return archived;
      return { ok: true, card: archived.card, warnings: archived.warnings };
    }
    const found = this.findCard(boardRef, localId);
    if ('error' in found) return found;
    const card = found.card;
    this.db.deleteKanbanCard(card.id);
    this.removeAttachmentDir(path.join(this.attachmentsRoot, card.boardId, String(card.localId)));
    logger.info(
      { boardId: card.boardId, prefix: card.boardPrefix, localId: card.localId, title: card.title },
      'card kanban deletado (hard)',
    );
    this.emitChanged(card.boardId);
    return { ok: true, card: null, warnings: [] };
  }

  attachFile(
    boardRef: string,
    localId: number,
    filePath: string,
    actor: KanbanActorInput,
  ): KanbanWriteResult<{ attachment: KanbanAttachment }> {
    const found = this.findCard(boardRef, localId);
    if ('error' in found) return found;
    const card = found.card;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return { error: `arquivo nao encontrado: ${filePath}` };
    }
    const warnings: string[] = [];
    const cardDir = path.join(this.attachmentsRoot, card.boardId, String(card.localId));
    let destPath: string;
    let sizeBytes: number;
    try {
      fs.mkdirSync(cardDir, { recursive: true });
      destPath = this.uniqueDestination(cardDir, path.basename(filePath));
      fs.copyFileSync(filePath, destPath);
      sizeBytes = fs.statSync(destPath).size;
    } catch (err) {
      logger.error({ err, filePath, cardDir }, 'falha de IO ao copiar anexo');
      return { error: `falha de IO ao copiar anexo: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (sizeBytes > ATTACHMENT_SIZE_WARNING_BYTES) {
      warnings.push(`anexo com ${(sizeBytes / (1024 * 1024)).toFixed(1)}MB (acima de 25MB)`);
    }
    const filename = path.basename(destPath);
    const storedPath = path.relative(this.attachmentsRoot, destPath).split(path.sep).join('/');
    try {
      const attachment = this.db.insertKanbanCardAttachmentWithEvent(
        {
          id: crypto.randomUUID(),
          cardId: card.id,
          filename,
          storedPath,
          mime: MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? null,
          sizeBytes,
        },
        { event: 'attachment-added', reason: filename, ...eventActor(actor) },
      );
      this.emitChanged(card.boardId);
      return { ok: true, attachment, warnings };
    } catch (err) {
      try {
        fs.unlinkSync(destPath);
      } catch (unlinkErr) {
        logger.warn({ unlinkErr, destPath }, 'rollback da copia do anexo falhou (arquivo orfao)');
      }
      logger.error({ err, filePath }, 'insert do anexo falhou; copia removida');
      return { error: `falha ao registrar anexo: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  resolveAttachment(
    attachmentId: string,
  ): { ok: true; attachment: KanbanAttachment; absolutePath: string } | { error: string } {
    const attachment = this.db.getKanbanCardAttachment(attachmentId);
    if (!attachment) return { error: `anexo nao encontrado: ${attachmentId}` };
    const root = path.resolve(this.attachmentsRoot);
    const absolutePath = path.resolve(root, ...attachment.storedPath.split('/'));
    if (!absolutePath.startsWith(root + path.sep)) {
      return { error: `anexo fora do root permitido: ${attachment.storedPath}` };
    }
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return { error: `arquivo do anexo nao encontrado: ${attachment.filename}` };
    }
    return { ok: true, attachment, absolutePath };
  }

  removeAttachment(attachmentId: string, actor: KanbanActorInput): KanbanAck {
    const attachment = this.db.getKanbanCardAttachment(attachmentId);
    if (!attachment) return { error: `anexo nao encontrado: ${attachmentId}` };
    const card = this.cardOfAttachment(attachment);
    this.db.deleteKanbanCardAttachmentWithEvent(attachmentId, {
      event: 'attachment-removed',
      reason: attachment.filename,
      ...eventActor(actor),
    });
    const absolutePath = path.join(this.attachmentsRoot, ...attachment.storedPath.split('/'));
    try {
      fs.unlinkSync(absolutePath);
    } catch (err) {
      logger.warn({ err, absolutePath }, 'unlink do anexo falhou (arquivo orfao tolerado)');
    }
    if (card) this.emitChanged(card.boardId);
    return { ok: true, warnings: [] };
  }

  private findBoard(ref: string): KanbanBoard | null {
    const trimmed = ref.trim();
    return this.db.getKanbanBoardByPrefix(trimmed.toUpperCase()) ?? this.db.getKanbanBoard(trimmed);
  }

  private findCard(boardRef: string, localId: number): { card: KanbanCard } | { error: string } {
    const board = this.findBoard(boardRef);
    if (!board) return { error: `quadro nao encontrado: ${boardRef}` };
    const card = this.db.getKanbanCardByLocalId(board.id, localId);
    if (!card) return { error: `card nao encontrado: ${board.prefix}-${localId}` };
    return { card };
  }

  private setArchived(
    boardRef: string,
    localId: number,
    archived: boolean,
    actor: KanbanActorInput,
  ): KanbanWriteResult<{ card: KanbanCard }> {
    const found = this.findCard(boardRef, localId);
    if ('error' in found) return found;
    const before = found.card;
    if (before.archived === archived) {
      return {
        ok: true,
        card: before,
        warnings: [`card ja esta ${archived ? 'arquivado' : 'ativo'}`],
      };
    }
    const card = this.db.updateKanbanCardWithEvents(before.id, { archived }, [
      { event: archived ? 'archived' : 'unarchived', ...eventActor(actor) },
    ]);
    this.emitChanged(card.boardId);
    return { ok: true, card, warnings: [] };
  }

  private resolveRepository(
    repositoryId: string | undefined,
    repoPath: string | undefined,
  ): LocalRepositoryRecord | null {
    if (repositoryId) return this.db.getLocalRepository(repositoryId);
    if (repoPath) {
      const resolved = path.resolve(repoPath);
      return (
        this.db
          .listLocalRepositories()
          .find(
            (repo) => path.resolve(repo.canonicalRootPath) === resolved || path.resolve(repo.rootPath) === resolved,
          ) ?? null
      );
    }
    return null;
  }

  private resolveCommitRef(commit: string, boardId: string, warnings: string[]): string {
    if (/^https?:\/\//.test(commit)) return commit;
    if (!COMMIT_HASH_RE.test(commit)) return commit;
    const board = this.db.getKanbanBoard(boardId);
    const repo = board ? this.db.getLocalRepository(board.repositoryId) : null;
    const remote = repo ? this.resolveGitRemote(repo.rootPath) : null;
    const baseUrl = remote ? normalizeGitRemoteUrl(remote) : null;
    if (!baseUrl) {
      warnings.push('hash sem remote resolvivel; gravado o hash cru');
      return commit;
    }
    return buildCommitUrl(baseUrl, commit);
  }

  private cardOfAttachment(attachment: KanbanAttachment): KanbanCard | null {
    const [boardId, localIdRaw] = attachment.storedPath.split('/');
    const localId = Number(localIdRaw);
    if (!boardId || !Number.isInteger(localId)) return null;
    return this.db.getKanbanCardByLocalId(boardId, localId);
  }

  private uniqueDestination(dir: string, filename: string): string {
    const ext = path.extname(filename);
    const stem = path.basename(filename, ext);
    let candidate = path.join(dir, filename);
    let suffix = 1;
    while (fs.existsSync(candidate)) {
      candidate = path.join(dir, `${stem}-${suffix}${ext}`);
      suffix += 1;
    }
    return candidate;
  }

  private removeAttachmentDir(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err, dir }, 'remocao da pasta de anexos falhou (best-effort)');
    }
  }
}

let engineSingleton: KanbanEngine | null = null;

export function getKanbanEngine(): KanbanEngine {
  if (!engineSingleton) {
    engineSingleton = new KanbanEngine({
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
    });
  }
  return engineSingleton;
}

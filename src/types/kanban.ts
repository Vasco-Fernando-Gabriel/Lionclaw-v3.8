

export type KanbanColumnId = 'Backlog' | 'Desenvolvimento' | 'Testes' | 'Done';

export type KanbanCardType = 'Bug' | 'Feature' | 'Débito técnico' | 'Chore';

export type KanbanPriority = 'Crítica' | 'Alta' | 'Média' | 'Baixa';

export type KanbanComplexity = 'Baixa' | 'Média' | 'Alta';

export type KanbanSeverity = 'S1' | 'S2' | 'S3' | 'S4';

export type KanbanEventType =
  | 'created'
  | 'moved'
  | 'delivered'
  | 'edited'
  | 'reopened'
  | 'archived'
  | 'unarchived'
  | 'attachment-added'
  | 'attachment-removed';

export type KanbanActor = 'user' | 'orchestrator' | 'scheduler';

export const KANBAN_COLUMNS: readonly KanbanColumnId[] = [
  'Backlog',
  'Desenvolvimento',
  'Testes',
  'Done',
];


export interface KanbanBoard {
  id: string;
  repositoryId: string;
  name: string;
  prefix: string;
  nextLocalId: number;
  createdAt: string;
}

export interface KanbanBoardWithCounts extends KanbanBoard {
  columnCounts: Record<KanbanColumnId, number>;
}

export interface KanbanCard {
  id: number;
  boardId: string;
  boardPrefix: string;
  localId: number;
  title: string;
  boardColumn: KanbanColumnId;
  type: KanbanCardType | null;
  priority: KanbanPriority | null;
  complexity: KanbanComplexity | null;
  severity: KanbanSeverity | null;
  problem: string | null;
  acceptanceCriteria: string | null;
  reproduction: string | null;
  acceptanceTests: string | null;
  commitUrl: string | null;
  docRef: string | null;
  startDate: string | null;
  dueDate: string | null;
  body: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  stalledDays: number;
  attachmentCount: number;
}

export interface KanbanCardEvent {
  id: number;
  cardId: number;
  event: KanbanEventType;
  fromColumn: KanbanColumnId | null;
  toColumn: KanbanColumnId | null;
  reason: string | null;
  actor: KanbanActor;
  createdAt: string;
}

export interface KanbanAttachment {
  id: string;
  cardId: number;
  filename: string;
  storedPath: string;
  mime: string | null;
  sizeBytes: number | null;
  createdAt: string;
}


export interface KanbanQueryFilters {
  board?: string;
  column?: string;
  type?: string;
  priority?: string;
  severity?: string;
  text?: string;
  dueBefore?: string;
  stalledDays?: number;
  archived?: boolean;
}

export interface KanbanCardPatch {
  title?: string;
  type?: string | null;
  priority?: string | null;
  complexity?: string | null;
  severity?: string | null;
  problem?: string | null;
  acceptanceCriteria?: string | null;
  reproduction?: string | null;
  acceptanceTests?: string | null;
  commitUrl?: string | null;
  docRef?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  body?: string | null;
  archived?: boolean;
}

export interface KanbanCardCreateInput {
  board: string;
  title?: string;
  column?: string;
  type?: string | null;
  priority?: string | null;
  complexity?: string | null;
  severity?: string | null;
  problem?: string | null;
  acceptanceCriteria?: string | null;
  reproduction?: string | null;
  acceptanceTests?: string | null;
  commitUrl?: string | null;
  docRef?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  body?: string | null;
}

export type KanbanWriteResult<T> =
  | ({ ok: true; warnings: string[] } & T)
  | { error: string };

export type KanbanAck = { ok: true; warnings: string[] } | { error: string };

export interface KanbanCardDetail {
  card: KanbanCard;
  events: KanbanCardEvent[];
  attachments: KanbanAttachment[];
}

export interface KanbanChangedEvent {
  boardId: string;
}


export interface KanbanBoardCreateInput {
  name?: string;
  prefix?: string;
  repositoryId?: string;
  repoPath?: string;
}

export type KanbanReadAttachmentResult =
  | { ok: true; attachment: KanbanAttachment; content: string }
  | { ok: false; tooLarge: true; sizeBytes: number }
  | { error: string };

export interface KanbanAPI {
  listBoards: () => Promise<{ ok: true; boards: KanbanBoardWithCounts[] } | { error: string }>;
  createBoard: (input: KanbanBoardCreateInput) => Promise<KanbanWriteResult<{ board: KanbanBoard }>>;
  deleteBoard: (boardId: string) => Promise<KanbanAck>;
  queryCards: (filters: KanbanQueryFilters) => Promise<KanbanWriteResult<{ cards: KanbanCard[] }>>;
  createCard: (input: KanbanCardCreateInput) => Promise<KanbanWriteResult<{ card: KanbanCard }>>;
  getCard: (board: string, localId: number) => Promise<KanbanWriteResult<KanbanCardDetail>>;
  updateCard: (
    board: string,
    localId: number,
    patch: KanbanCardPatch,
  ) => Promise<KanbanWriteResult<{ card: KanbanCard }>>;
  moveCard: (
    board: string,
    localId: number,
    toColumn: string,
    reason?: string | null,
  ) => Promise<KanbanWriteResult<{ card: KanbanCard }>>;
  deliverCard: (
    board: string,
    localId: number,
    commit: string,
    toColumn?: string | null,
  ) => Promise<KanbanWriteResult<{ card: KanbanCard }>>;
  archiveCard: (board: string, localId: number) => Promise<KanbanWriteResult<{ card: KanbanCard }>>;
  unarchiveCard: (
    board: string,
    localId: number,
  ) => Promise<KanbanWriteResult<{ card: KanbanCard }>>;
  deleteCard: (
    board: string,
    localId: number,
    hard?: boolean,
  ) => Promise<KanbanWriteResult<{ card: KanbanCard | null }>>;
  attachFile: (
    board: string,
    localId: number,
    filePath: string,
  ) => Promise<KanbanWriteResult<{ attachment: KanbanAttachment }>>;
  removeAttachment: (attachmentId: string) => Promise<KanbanAck>;
  openAttachment: (attachmentId: string) => Promise<{ ok: true } | { error: string }>;
  readAttachment: (attachmentId: string) => Promise<KanbanReadAttachmentResult>;
  onChanged: (cb: (event: KanbanChangedEvent) => void) => () => void;
}

declare module './index' {
  interface LionClawAPI {
    kanban: KanbanAPI;
  }
}

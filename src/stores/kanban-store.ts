import { create } from 'zustand';
import type {
  KanbanBoardWithCounts,
  KanbanCard,
  KanbanCardCreateInput,
  KanbanCardDetail,
  KanbanCardPatch,
} from '@/types/kanban';

export type KanbanToastKind = 'ok' | 'warn' | 'error';

export interface KanbanToast {
  id: string;
  kind: KanbanToastKind;
  message: string;
}

const TOAST_DISMISS_MS = 4600;
let nextToastId = 0;

interface KanbanState {
  boards: KanbanBoardWithCounts[];
  currentBoardId: string | null;
  cards: KanbanCard[];
  archivedCards: KanbanCard[];
  loading: boolean;

  search: string;
  filterType: string;
  filterPriority: string;
  filterSeverity: string;
  showArchived: boolean;

  openCardDetail: KanbanCardDetail | null;

  toasts: KanbanToast[];

  init: () => Promise<void>;
  loadBoards: () => Promise<void>;
  selectBoard: (boardId: string) => void;
  loadCards: () => Promise<void>;
  handleChanged: (boardId: string) => void;

  setSearch: (v: string) => void;
  setFilterType: (v: string) => void;
  setFilterPriority: (v: string) => void;
  setFilterSeverity: (v: string) => void;
  setShowArchived: (v: boolean) => void;
  clearFilters: () => void;

  openCard: (board: string, localId: number) => Promise<void>;
  closeCard: () => void;
  refreshOpenCard: () => Promise<void>;

  createCard: (input: KanbanCardCreateInput) => Promise<boolean>;
  updateCard: (board: string, localId: number, patch: KanbanCardPatch) => Promise<boolean>;
  moveCard: (board: string, localId: number, toColumn: string, reason?: string | null) => Promise<boolean>;
  deliverCard: (board: string, localId: number, commit: string) => Promise<boolean>;
  archiveCard: (board: string, localId: number) => Promise<boolean>;
  unarchiveCard: (board: string, localId: number) => Promise<boolean>;
  deleteCardHard: (board: string, localId: number) => Promise<boolean>;
  attachFile: (board: string, localId: number, filePath: string) => Promise<boolean>;
  removeAttachment: (attachmentId: string) => Promise<boolean>;

  createBoard: (input: {
    name: string;
    prefix: string;
    repositoryId: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  deleteBoard: (boardId: string) => Promise<boolean>;

  pushToast: (kind: KanbanToastKind, message: string) => void;
  dismissToast: (id: string) => void;
}

function surfaceWrite(
  get: () => KanbanState,
  result: { ok: true; warnings: string[] } | { error: string },
  okMessage?: string,
): boolean {
  if ('error' in result) {
    get().pushToast('error', result.error);
    return false;
  }
  for (const w of result.warnings) get().pushToast('warn', w);
  if (result.warnings.length === 0 && okMessage) get().pushToast('ok', okMessage);
  return true;
}

export const useKanbanStore = create<KanbanState>((set, get) => ({
  boards: [],
  currentBoardId: null,
  cards: [],
  archivedCards: [],
  loading: false,

  search: '',
  filterType: '',
  filterPriority: '',
  filterSeverity: '',
  showArchived: false,

  openCardDetail: null,
  toasts: [],

  init: async () => {
    await get().loadBoards();
    const { boards, currentBoardId } = get();
    if (!currentBoardId && boards.length > 0) {
      get().selectBoard(boards[0].id);
    } else if (currentBoardId) {
      await get().loadCards();
    }
  },

  loadBoards: async () => {
    const result = await window.lionclaw.kanban.listBoards();
    if ('error' in result) {
      get().pushToast('error', result.error);
      return;
    }
    set({ boards: result.boards });
    const { currentBoardId } = get();
    if (currentBoardId && !result.boards.some((b) => b.id === currentBoardId)) {
      set({ currentBoardId: result.boards[0]?.id ?? null, cards: [], archivedCards: [] });
      if (result.boards.length > 0) void get().loadCards();
    }
  },

  selectBoard: (boardId) => {
    set({ currentBoardId: boardId, cards: [], archivedCards: [], openCardDetail: null });
    void get().loadCards();
  },

  loadCards: async () => {
    const { boards, currentBoardId, showArchived } = get();
    const board = boards.find((b) => b.id === currentBoardId);
    if (!board) return;
    set({ loading: true });
    try {
      const active = await window.lionclaw.kanban.queryCards({ board: board.prefix });
      if ('error' in active) {
        get().pushToast('error', active.error);
        return;
      }
      let archived: KanbanCard[] = [];
      if (showArchived) {
        const res = await window.lionclaw.kanban.queryCards({
          board: board.prefix,
          archived: true,
        });
        if ('error' in res) {
          get().pushToast('error', res.error);
        } else {
          archived = res.cards;
        }
      }
      if (get().currentBoardId !== board.id) return;
      set({ cards: active.cards, archivedCards: archived });
    } finally {
      set({ loading: false });
    }
  },

  handleChanged: (boardId) => {
    void get().loadBoards();
    if (boardId === get().currentBoardId) {
      void get().loadCards();
      if (get().openCardDetail) void get().refreshOpenCard();
    }
  },

  setSearch: (v) => set({ search: v }),
  setFilterType: (v) => set({ filterType: v }),
  setFilterPriority: (v) => set({ filterPriority: v }),
  setFilterSeverity: (v) => set({ filterSeverity: v }),
  setShowArchived: (v) => {
    set({ showArchived: v });
    void get().loadCards();
  },
  clearFilters: () => set({ search: '', filterType: '', filterPriority: '', filterSeverity: '' }),

  openCard: async (board, localId) => {
    const result = await window.lionclaw.kanban.getCard(board, localId);
    if ('error' in result) {
      get().pushToast('error', result.error);
      return;
    }
    set({ openCardDetail: { card: result.card, events: result.events, attachments: result.attachments } });
  },

  closeCard: () => set({ openCardDetail: null }),

  refreshOpenCard: async () => {
    const detail = get().openCardDetail;
    if (!detail) return;
    const result = await window.lionclaw.kanban.getCard(detail.card.boardPrefix, detail.card.localId);
    if ('error' in result) {
      set({ openCardDetail: null });
      return;
    }
    set({ openCardDetail: { card: result.card, events: result.events, attachments: result.attachments } });
  },

  createCard: async (input) => {
    const result = await window.lionclaw.kanban.createCard(input);
    const ok = surfaceWrite(get, result);
    if (ok && 'card' in result) {
      get().pushToast('ok', `${result.card.boardPrefix}-${result.card.localId} criado no Backlog`);
    }
    return ok;
  },

  updateCard: async (board, localId, patch) => {
    const result = await window.lionclaw.kanban.updateCard(board, localId, patch);
    return surfaceWrite(get, result, 'Card atualizado');
  },

  moveCard: async (board, localId, toColumn, reason) => {
    const result = await window.lionclaw.kanban.moveCard(board, localId, toColumn, reason ?? null);
    return surfaceWrite(get, result, `${board}-${localId} movido para ${toColumn}`);
  },

  deliverCard: async (board, localId, commit) => {
    const result = await window.lionclaw.kanban.deliverCard(board, localId, commit, null);
    return surfaceWrite(get, result, 'Entrega registrada: commit preenchido, card em Testes aguardando validacao');
  },

  archiveCard: async (board, localId) => {
    const result = await window.lionclaw.kanban.archiveCard(board, localId);
    return surfaceWrite(get, result, `${board}-${localId} arquivado (historico preservado)`);
  },

  unarchiveCard: async (board, localId) => {
    const result = await window.lionclaw.kanban.unarchiveCard(board, localId);
    return surfaceWrite(get, result, `${board}-${localId} desarquivado`);
  },

  deleteCardHard: async (board, localId) => {
    const result = await window.lionclaw.kanban.deleteCard(board, localId, true);
    const ok = surfaceWrite(get, result, `${board}-${localId} deletado`);
    if (ok) set({ openCardDetail: null });
    return ok;
  },

  attachFile: async (board, localId, filePath) => {
    const result = await window.lionclaw.kanban.attachFile(board, localId, filePath);
    return surfaceWrite(get, result, 'Anexo adicionado');
  },

  removeAttachment: async (attachmentId) => {
    const result = await window.lionclaw.kanban.removeAttachment(attachmentId);
    return surfaceWrite(get, result, 'Anexo removido');
  },

  createBoard: async (input) => {
    const result = await window.lionclaw.kanban.createBoard(input);
    if ('error' in result) return { ok: false, error: result.error };
    for (const w of result.warnings) get().pushToast('warn', w);
    await get().loadBoards();
    get().selectBoard(result.board.id);
    get().pushToast('ok', `Quadro ${result.board.prefix} criado`);
    return { ok: true };
  },

  deleteBoard: async (boardId) => {
    const result = await window.lionclaw.kanban.deleteBoard(boardId);
    if ('error' in result) {
      get().pushToast('error', result.error);
      return false;
    }
    get().pushToast('ok', 'Quadro deletado');
    await get().loadBoards();
    const { boards } = get();
    set({ currentBoardId: boards[0]?.id ?? null, cards: [], archivedCards: [], openCardDetail: null });
    if (boards.length > 0) void get().loadCards();
    return true;
  },

  pushToast: (kind, message) => {
    nextToastId += 1;
    const id = `kanban-toast-${nextToastId}`;
    set((state) => ({ toasts: [...state.toasts, { id, kind, message }].slice(-5) }));
    setTimeout(() => get().dismissToast(id), TOAST_DISMISS_MS);
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

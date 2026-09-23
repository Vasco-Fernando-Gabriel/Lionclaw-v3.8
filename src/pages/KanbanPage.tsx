import { useEffect, useMemo, useState } from 'react';
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { Kanban, Search, Plus, Trash2, Loader2 } from 'lucide-react';
import { useKanbanStore } from '@/stores/kanban-store';
import type { KanbanCard, KanbanColumnId } from '@/types/kanban';
import { KANBAN_COLUMNS } from '@/types/kanban';
import { BoardColumn } from '@/components/kanban/BoardColumn';
import { CardModal } from '@/components/kanban/CardModal';
import { NewCardModal } from '@/components/kanban/NewCardModal';
import { NewBoardModal } from '@/components/kanban/NewBoardModal';
import { DeleteBoardModal } from '@/components/kanban/DeleteBoardModal';
import { KanbanToastHost } from '@/components/kanban/KanbanToastHost';
import { matchesFilters, filtersActive, sortColumnCards } from '@/components/kanban/kanban-ui';
import type { LocalRepositoryRecord } from '@/types/repo-graph';

const COLUMN_ORDER: Record<KanbanColumnId, number> = {
  Backlog: 0,
  Desenvolvimento: 1,
  Testes: 2,
  Done: 3,
};

const BACKWARD_DRAG_REASON = 'movido pelo dono no board';

export function KanbanPage() {
  const store = useKanbanStore();
  const {
    boards,
    currentBoardId,
    cards,
    archivedCards,
    loading,
    search,
    filterType,
    filterPriority,
    filterSeverity,
    showArchived,
    openCardDetail,
  } = store;

  const [showNewCard, setShowNewCard] = useState(false);
  const [showNewBoard, setShowNewBoard] = useState(false);
  const [showDeleteBoard, setShowDeleteBoard] = useState(false);
  const [repoPaths, setRepoPaths] = useState<Record<string, string>>({});

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const board = boards.find((b) => b.id === currentBoardId) ?? null;

  useEffect(() => {
    void store.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const cleanup = window.lionclaw.kanban.onChanged((event) => {
      useKanbanStore.getState().handleChanged(event.boardId);
    });
    return cleanup;
  }, []);

  useEffect(() => {
    let mounted = true;
    void window.lionclaw.repoGraph.list().then((result) => {
      if (!mounted || !Array.isArray(result)) return;
      const map: Record<string, string> = {};
      for (const repo of result as LocalRepositoryRecord[]) map[repo.id] = repo.rootPath;
      setRepoPaths(map);
    });
    return () => {
      mounted = false;
    };
  }, [boards]);

  const uiFilters = { search, filterType, filterPriority, filterSeverity };
  const allCards = useMemo(
    () => (showArchived ? [...cards, ...archivedCards] : cards),
    [cards, archivedCards, showArchived],
  );
  const visibleCards = useMemo(
    () => allCards.filter((c) => matchesFilters(c, uiFilters)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allCards, search, filterType, filterPriority, filterSeverity],
  );
  const byColumn = useMemo(() => {
    const map = new Map<KanbanColumnId, KanbanCard[]>();
    for (const col of KANBAN_COLUMNS) {
      map.set(col, sortColumnCards(visibleCards.filter((c) => c.boardColumn === col)));
    }
    return map;
  }, [visibleCards]);

  const anyFilter = filtersActive(uiFilters);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || !board) return;
    const toColumn = over.id as KanbanColumnId;
    const data = active.data.current as { localId: number; fromColumn: KanbanColumnId } | undefined;
    if (!data || data.fromColumn === toColumn) return;
    const backward = COLUMN_ORDER[toColumn] < COLUMN_ORDER[data.fromColumn];
    void store.moveCard(board.prefix, data.localId, toColumn, backward ? BACKWARD_DRAG_REASON : null);
  };

  const openCard = (card: KanbanCard) => {
    void store.openCard(card.boardPrefix, card.localId);
  };

  const selectClass =
    'bg-zinc-900 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-amber-500';

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800 flex-wrap shrink-0">
        {board ? (
          <span className="px-2.5 py-1 rounded-lg bg-amber-500/15 text-amber-300 text-[13px] font-bold tracking-wide">
            {board.prefix}
          </span>
        ) : (
          <Kanban size={20} className="text-amber-500" />
        )}
        {boards.length > 0 && (
          <select
            value={currentBoardId ?? ''}
            onChange={(e) => store.selectBoard(e.target.value)}
            className={selectClass}
            aria-label="Selecionar quadro"
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.prefix} · {b.name}
              </option>
            ))}
          </select>
        )}
        {board && repoPaths[board.repositoryId] && (
          <span className="text-[11px] text-zinc-600 font-mono truncate max-w-xs">{repoPaths[board.repositoryId]}</span>
        )}
        {board && (
          <button
            onClick={() => setShowDeleteBoard(true)}
            className="p-1.5 rounded-md text-zinc-600 hover:text-red-400 hover:bg-zinc-800 transition-colors"
            title="Deletar quadro (exige digitar o prefixo)"
          >
            <Trash2 size={14} />
          </button>
        )}
        <span className="flex-1" />
        <button
          onClick={() => setShowNewBoard(true)}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-zinc-700 text-zinc-200 hover:bg-zinc-800 transition-colors inline-flex items-center gap-1.5"
        >
          <Plus size={13} /> Novo quadro
        </button>
        {board && (
          <button
            onClick={() => setShowNewCard(true)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white transition-colors inline-flex items-center gap-1.5"
          >
            <Plus size={13} /> Novo card
          </button>
        )}
      </div>

      {boards.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
          <Kanban size={32} className="text-zinc-700" />
          <p className="text-sm text-zinc-400">Nenhum quadro ainda.</p>
          <p className="text-xs text-zinc-600 max-w-sm leading-relaxed">
            Um quadro por repositório registrado, com 4 colunas fixas e as mesmas tools que o orquestrador usa. Crie o
            primeiro.
          </p>
          <button
            onClick={() => setShowNewBoard(true)}
            className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white transition-colors"
          >
            + Novo quadro
          </button>
        </div>
      ) : (
        <>
          {/* Toolbar */}
          <div className="flex items-center gap-2 px-5 pt-2.5 flex-wrap shrink-0">
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
              <input
                type="text"
                value={search}
                onChange={(e) => store.setSearch(e.target.value)}
                placeholder="Buscar por id, título, problema ou corpo..."
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-200 outline-none focus:border-amber-500"
              />
            </div>
            <select
              value={filterType}
              onChange={(e) => store.setFilterType(e.target.value)}
              className={selectClass}
              aria-label="Filtrar por tipo"
            >
              <option value="">Tipo: todos</option>
              <option>Bug</option>
              <option>Feature</option>
              <option>Débito técnico</option>
              <option>Chore</option>
            </select>
            <select
              value={filterPriority}
              onChange={(e) => store.setFilterPriority(e.target.value)}
              className={selectClass}
              aria-label="Filtrar por prioridade"
            >
              <option value="">Prioridade: todas</option>
              <option>Crítica</option>
              <option>Alta</option>
              <option>Média</option>
              <option>Baixa</option>
            </select>
            <select
              value={filterSeverity}
              onChange={(e) => store.setFilterSeverity(e.target.value)}
              className={selectClass}
              aria-label="Filtrar por severidade"
            >
              <option value="">Severidade: todas</option>
              <option>S1</option>
              <option>S2</option>
              <option>S3</option>
              <option>S4</option>
            </select>
            {anyFilter && (
              <button
                onClick={store.clearFilters}
                className="px-2 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
              >
                Limpar
              </button>
            )}
            <span className="text-xs text-zinc-500 tabular-nums">
              {anyFilter ? `${visibleCards.length} de ${allCards.length} cards` : `${allCards.length} cards`}
            </span>
            <label className="inline-flex items-center gap-1.5 text-xs text-zinc-500 cursor-pointer select-none ml-1">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => store.setShowArchived(e.target.checked)}
                className="accent-amber-500"
              />
              mostrar arquivados
            </label>
            {loading && <Loader2 size={13} className="animate-spin text-zinc-600" />}
          </div>

          {/* Board */}
          <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
            <div className="flex-1 min-h-0 grid grid-cols-4 gap-3.5 px-5 py-4">
              {KANBAN_COLUMNS.map((col) => (
                <BoardColumn key={col} column={col} cards={byColumn.get(col) ?? []} onOpenCard={openCard} />
              ))}
            </div>
          </DndContext>
        </>
      )}

      {/* Modals */}
      {openCardDetail && <CardModal detail={openCardDetail} onClose={store.closeCard} />}
      {showNewCard && board && <NewCardModal boardPrefix={board.prefix} onClose={() => setShowNewCard(false)} />}
      {showNewBoard && <NewBoardModal onClose={() => setShowNewBoard(false)} />}
      {showDeleteBoard && board && <DeleteBoardModal board={board} onClose={() => setShowDeleteBoard(false)} />}

      <KanbanToastHost />
    </div>
  );
}

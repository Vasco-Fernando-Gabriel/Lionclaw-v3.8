import { useDroppable } from '@dnd-kit/core';
import type { KanbanCard, KanbanColumnId } from '@/types/kanban';
import { CardItem } from './CardItem';
import { COLUMN_DOTS } from './kanban-ui';

interface BoardColumnProps {
  column: KanbanColumnId;
  cards: KanbanCard[];
  onOpenCard: (card: KanbanCard) => void;
}

export function BoardColumn({ column, cards, onOpenCard }: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column });

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col min-h-0 rounded-xl border bg-zinc-900/50 transition-colors ${
        isOver ? 'border-amber-500' : 'border-zinc-800'
      }`}
    >
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-zinc-800 shrink-0">
        <span
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: COLUMN_DOTS[column] }}
        />
        <span className={`text-[13px] font-semibold ${isOver ? 'text-amber-500' : 'text-zinc-200'}`}>
          {column}
        </span>
        <span className="ml-auto text-xs text-zinc-500 tabular-nums">{cards.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-2">
        {cards.length === 0 ? (
          <p className="text-xs text-zinc-700 text-center py-7">Nenhum card</p>
        ) : (
          cards.map((card) => <CardItem key={card.id} card={card} onOpen={onOpenCard} />)
        )}
      </div>
    </div>
  );
}

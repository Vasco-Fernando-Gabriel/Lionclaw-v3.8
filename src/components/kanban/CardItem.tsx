import { useDraggable } from '@dnd-kit/core';
import { Paperclip, Check, Clock, Archive } from 'lucide-react';
import type { KanbanCard } from '@/types/kanban';
import { TYPE_BADGE_CLASS, PRIORITY_BADGE_CLASS, SEVERITY_BADGE_CLASS, isOverdue, formatShortDate } from './kanban-ui';

interface CardItemProps {
  card: KanbanCard;
  onOpen: (card: KanbanCard) => void;
}

export function CardItem({ card, onOpen }: CardItemProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `card:${card.localId}`,
    data: { localId: card.localId, fromColumn: card.boardColumn },
    disabled: card.archived,
  });

  const overdue = isOverdue(card);

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onOpen(card)}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 40 } : undefined}
      className={`rounded-[10px] border bg-zinc-900 px-3 py-2.5 transition-colors relative
        ${isDragging ? 'opacity-40 cursor-grabbing border-amber-500/50' : 'cursor-grab border-zinc-800 hover:border-zinc-700'}
        ${card.archived ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-bold text-amber-500 tracking-wide">
          {card.boardPrefix}-{card.localId}
        </span>
        {card.archived && (
          <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500">
            <Archive size={10} /> arquivado
          </span>
        )}
      </div>
      <p className="text-[13px] text-zinc-100 mt-0.5 mb-2 leading-snug">{card.title}</p>
      {(card.type || card.priority || card.severity) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {card.type && (
            <span
              className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full ${TYPE_BADGE_CLASS[card.type] ?? 'bg-zinc-500/20 text-zinc-400'}`}
            >
              {card.type}
            </span>
          )}
          {card.priority && (
            <span
              className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full ${PRIORITY_BADGE_CLASS[card.priority] ?? 'bg-zinc-500/20 text-zinc-400'}`}
            >
              {card.priority}
            </span>
          )}
          {card.severity && (
            <span className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full ${SEVERITY_BADGE_CLASS}`}>
              {card.severity}
            </span>
          )}
        </div>
      )}
      {(card.dueDate || card.attachmentCount > 0 || card.commitUrl) && (
        <div className="flex items-center gap-2.5 mt-1.5 text-[11px] text-zinc-500">
          {card.dueDate && (
            <span className={`inline-flex items-center gap-1 ${overdue ? 'text-red-400 font-semibold' : ''}`}>
              <Clock size={11} />
              {formatShortDate(card.dueDate)}
              {overdue ? ' · vencido' : ''}
            </span>
          )}
          {card.attachmentCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <Paperclip size={11} /> {card.attachmentCount}
            </span>
          )}
          {card.commitUrl && (
            <span className="inline-flex items-center gap-1">
              <Check size={11} /> commit
            </span>
          )}
        </div>
      )}
    </div>
  );
}

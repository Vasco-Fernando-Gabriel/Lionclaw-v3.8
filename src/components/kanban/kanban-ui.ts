import type { KanbanCard, KanbanColumnId } from '@/types/kanban';
import { formatLocalDateTime, parseSqliteUtc } from '@/lib/sqlite-time';

export const COLUMN_DOTS: Record<KanbanColumnId, string> = {
  Backlog: '#60a5fa',
  Desenvolvimento: '#fbbf24',
  Testes: '#a78bfa',
  Done: '#4ade80',
};

export const TYPE_BADGE_CLASS: Record<string, string> = {
  Bug: 'bg-red-500/15 text-red-300',
  Feature: 'bg-blue-500/15 text-blue-300',
  'Débito técnico': 'bg-purple-500/15 text-purple-300',
  Chore: 'bg-zinc-500/20 text-zinc-400',
};

export const PRIORITY_BADGE_CLASS: Record<string, string> = {
  'Crítica': 'bg-red-500/15 text-red-300',
  Alta: 'bg-amber-500/15 text-amber-300',
  'Média': 'bg-blue-500/15 text-blue-300',
  Baixa: 'bg-zinc-500/20 text-zinc-400',
};

export const SEVERITY_BADGE_CLASS = 'bg-red-500/10 text-red-400 border border-red-500/30';

const PRIORITY_RANK: Record<string, number> = {
  'Crítica': 0,
  Alta: 1,
  'Média': 2,
  Baixa: 3,
};

export function sortColumnCards(cards: KanbanCard[]): KanbanCard[] {
  return [...cards].sort((a, b) => {
    const pa = a.priority ? PRIORITY_RANK[a.priority] : 4;
    const pb = b.priority ? PRIORITY_RANK[b.priority] : 4;
    if (pa !== pb) return pa - pb;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export interface KanbanUiFilters {
  search: string;
  filterType: string;
  filterPriority: string;
  filterSeverity: string;
}

export function matchesFilters(card: KanbanCard, f: KanbanUiFilters): boolean {
  const q = f.search.trim().toLowerCase();
  if (q) {
    const haystack = `${card.boardPrefix}-${card.localId} ${card.title} ${card.problem ?? ''} ${card.body ?? ''}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  if (f.filterType && card.type !== f.filterType) return false;
  if (f.filterPriority && card.priority !== f.filterPriority) return false;
  if (f.filterSeverity && card.severity !== f.filterSeverity) return false;
  return true;
}

export function filtersActive(f: KanbanUiFilters): boolean {
  return !!(f.search.trim() || f.filterType || f.filterPriority || f.filterSeverity);
}

export function isOverdue(card: KanbanCard): boolean {
  if (!card.dueDate || card.boardColumn === 'Done') return false;
  const today = new Date().toISOString().slice(0, 10);
  return card.dueDate.slice(0, 10) < today;
}

export function formatShortDate(iso: string): string {
  const d = iso.slice(0, 10).split('-');
  if (d.length !== 3) return iso;
  return `${d[2]}/${d[1]}`;
}

export function formatDateTime(iso: string): string {
  const date = parseSqliteUtc(iso);
  if (!date) return iso;
  return formatLocalDateTime(date);
}

export type AttachmentFamily = 'image' | 'pdf' | 'markdown' | 'text' | 'other';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const MARKDOWN_EXTS = new Set(['md', 'markdown']);
const TEXT_EXTS = new Set([
  'txt', 'log', 'json', 'csv', 'yaml', 'yml', 'toml', 'ini', 'xml', 'sql', 'sh',
  'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'css', 'html',
]);

export function attachmentFamily(filename: string): AttachmentFamily {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'other';
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

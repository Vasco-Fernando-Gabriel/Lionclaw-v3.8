import { useState, useEffect, useCallback, useRef } from 'react';
import { FixedSizeList, type ListChildComponentProps } from 'react-window';
import { Search, Trash2, X, AlertTriangle } from 'lucide-react';
import type { NoteListItem, BacklinkResult } from '@/types';
import ReactMarkdown from 'react-markdown';


interface NoteListViewProps {
  type: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
}

interface DeleteDialogState {
  open: boolean;
  note: NoteListItem | null;
  backlinks: BacklinkResult[];
  loading: boolean;
}


function SkeletonCard() {
  return (
    <div className="mx-3 my-1 p-3 bg-zinc-900 border border-zinc-800 rounded-lg animate-pulse">
      <div className="h-3.5 bg-zinc-700 rounded w-2/3 mb-2" />
      <div className="flex gap-1 mb-2">
        <div className="h-4 bg-zinc-800 rounded-full w-12" />
        <div className="h-4 bg-zinc-800 rounded-full w-16" />
      </div>
      <div className="h-3 bg-zinc-800 rounded w-full mb-1" />
      <div className="h-3 bg-zinc-800 rounded w-4/5" />
    </div>
  );
}


interface NoteCardProps {
  note: NoteListItem;
  onDelete: (note: NoteListItem) => void;
  onClick: (note: NoteListItem) => void;
}

function NoteCard({ note, onDelete, onClick }: NoteCardProps) {
  const [hovered, setHovered] = useState(false);

  const formattedDate = note.updatedAt
    ? new Date(note.updatedAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
    : '';

  return (
    <div
      className="mx-3 my-1 p-3 bg-zinc-900 border border-zinc-800 rounded-lg cursor-pointer hover:border-zinc-700 transition-colors relative group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onClick(note)}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold text-zinc-200 leading-snug">{note.title}</span>
        {hovered && (
          <button
            className="shrink-0 p-1 text-zinc-500 hover:text-red-400 transition-colors rounded"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(note);
            }}
            title="Deletar nota"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {note.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {note.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded-full">
              {tag}
            </span>
          ))}
        </div>
      )}

      {note.snippet && (
        <p className="text-xs text-zinc-500 mt-1.5 line-clamp-2 leading-relaxed">{note.snippet}</p>
      )}

      {formattedDate && (
        <p className="text-[10px] text-zinc-600 mt-1.5">{formattedDate}</p>
      )}
    </div>
  );
}


interface DeleteDialogProps {
  state: DeleteDialogState;
  onConfirm: (force: boolean) => void;
  onCancel: () => void;
}

function DeleteDialog({ state, onConfirm, onCancel }: DeleteDialogProps) {
  if (!state.open || !state.note) return null;

  const hasBacklinks = state.backlinks.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-md mx-4 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-zinc-200">Deletar nota</h3>
            <p className="text-xs text-zinc-400 mt-1">
              {hasBacklinks
                ? `A nota "${state.note.title}" é referenciada por ${state.backlinks.length} nota(s):`
                : `Tem certeza que deseja deletar "${state.note.title}"?`}
            </p>
          </div>
        </div>

        {hasBacklinks && (
          <div className="mb-4 max-h-40 overflow-y-auto space-y-2">
            {state.backlinks.map((bl) => (
              <div key={bl.path} className="bg-zinc-800 rounded-lg p-2.5 text-xs">
                <p className="text-zinc-300 font-medium">{bl.title}</p>
                <p className="text-zinc-500 mt-0.5 italic">{bl.linkContext}</p>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={() => onConfirm(hasBacklinks)}
            className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
          >
            {hasBacklinks ? 'Deletar mesmo assim' : 'Deletar'}
          </button>
        </div>
      </div>
    </div>
  );
}


interface PreviewPanelProps {
  note: NoteListItem | null;
  content: string;
  loading: boolean;
  onClose: () => void;
}

function PreviewPanel({ note, content, loading, onClose }: PreviewPanelProps) {
  if (!note) return null;

  return (
    <div className="w-80 shrink-0 border-l border-zinc-800 flex flex-col bg-zinc-950">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-800">
        <span className="flex-1 text-xs font-semibold text-zinc-200 truncate">{note.title}</span>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="prose prose-sm prose-invert max-w-none text-zinc-300 text-xs leading-relaxed">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}


export function NoteListView({ type, icon: Icon, label }: NoteListViewProps) {
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState>({
    open: false, note: null, backlinks: [], loading: false,
  });
  const [previewNote, setPreviewNote] = useState<NoteListItem | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(400);


  const loadNotes = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.lionclaw.mgraph.listNotes(type);
      setNotes(Array.isArray(result) ? result : []);
    } catch {
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }, [type]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);


  useEffect(() => {
    if (!listContainerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setListHeight(entry.contentRect.height);
    });
    observer.observe(listContainerRef.current);
    return () => observer.disconnect();
  }, []);


  const filtered = searchQuery.trim()
    ? notes.filter((n) => {
        const q = searchQuery.toLowerCase();
        return n.title.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q));
      })
    : notes;


  const handleDeleteClick = useCallback(async (note: NoteListItem) => {
    setDeleteDialog({ open: true, note, backlinks: [], loading: true });
    try {
      const backlinks = await window.lionclaw.mgraph.noteBacklinks(note.path);
      setDeleteDialog((d) => ({ ...d, backlinks: Array.isArray(backlinks) ? backlinks : [], loading: false }));
    } catch {
      setDeleteDialog((d) => ({ ...d, backlinks: [], loading: false }));
    }
  }, []);

  const handleDeleteConfirm = useCallback(async (force: boolean) => {
    if (!deleteDialog.note) return;
    const notePath = deleteDialog.note.path;
    setDeleteDialog((d) => ({ ...d, open: false }));

    try {
      await window.lionclaw.mgraph.deleteNote(notePath, { force });
      if (previewNote?.path === notePath) {
        setPreviewNote(null);
        setPreviewContent('');
      }
      loadNotes();
    } catch {
    }
  }, [deleteDialog.note, previewNote, loadNotes]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteDialog({ open: false, note: null, backlinks: [], loading: false });
  }, []);


  const handleNoteClick = useCallback(async (note: NoteListItem) => {
    if (previewNote?.path === note.path) {
      setPreviewNote(null);
      setPreviewContent('');
      return;
    }
    setPreviewNote(note);
    setPreviewContent('');
    setPreviewLoading(true);
    try {
      const content = await window.lionclaw.mgraph.read(note.path);
      setPreviewContent(typeof content === 'string' ? content : '');
    } catch {
      setPreviewContent('Erro ao carregar conteúdo.');
    } finally {
      setPreviewLoading(false);
    }
  }, [previewNote]);


  const Row = useCallback(({ index, style }: ListChildComponentProps) => {
    const note = filtered[index];
    if (!note) return null;
    return (
      <div style={style}>
        <NoteCard
          note={note}
          onDelete={handleDeleteClick}
          onClick={handleNoteClick}
        />
      </div>
    );
  }, [filtered, handleDeleteClick, handleNoteClick]);


  return (
    <div className="flex flex-1 min-h-0">
      {/* Main list */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0">
        {/* Header + search */}
        <div className="px-3 pt-3 pb-2 border-b border-zinc-800">
          <div className="flex items-center gap-2 mb-2">
            <Icon size={14} className="text-amber-500" />
            <span className="text-sm font-semibold text-zinc-200">{label}</span>
            {!loading && (
              <span className="text-xs text-zinc-500">({notes.length})</span>
            )}
          </div>
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filtrar por título ou tag..."
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-7 pr-3 py-1.5 text-xs text-zinc-200 outline-none focus:border-amber-500/50 placeholder:text-zinc-600"
            />
          </div>
        </div>

        {/* Content */}
        <div ref={listContainerRef} className="flex-1 min-h-0">
          {loading ? (
            <div className="pt-2">
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : notes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full px-6 text-center">
              <p className="text-sm text-zinc-500">Nenhuma {label.toLowerCase()} registrada ainda.</p>
              <p className="text-xs text-zinc-600 mt-1.5 leading-relaxed">
                Notas são criadas via compaction de conversas ou ingestão de documentos.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-zinc-600">Nenhum resultado para "{searchQuery}"</p>
            </div>
          ) : (
            <FixedSizeList
              height={listHeight}
              itemCount={filtered.length}
              itemSize={110}
              width="100%"
            >
              {Row}
            </FixedSizeList>
          )}
        </div>
      </div>

      {/* Preview panel */}
      <PreviewPanel
        note={previewNote}
        content={previewContent}
        loading={previewLoading}
        onClose={() => { setPreviewNote(null); setPreviewContent(''); }}
      />

      {/* Delete dialog */}
      <DeleteDialog
        state={deleteDialog}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </div>
  );
}

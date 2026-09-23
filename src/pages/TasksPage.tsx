import { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  X,
  Trash2,
  Calendar,
  ChevronDown,
  Circle,
  CheckCircle2,
  Clock,
  ArrowUp,
  ArrowRight,
  ArrowDown,
  RotateCcw,
  Loader2,
} from 'lucide-react';
import type { PersonalTask, PersonalTaskFilters } from '@/types';

const PRIORITY_LABELS: Record<string, string> = {
  low: 'Baixa',
  normal: 'Normal',
  high: 'Alta',
};

function PriorityIcon({ priority }: { priority: string }) {
  switch (priority) {
    case 'high':
      return <ArrowUp size={14} className="text-red-400" />;
    case 'low':
      return <ArrowDown size={14} className="text-blue-400" />;
    default:
      return <ArrowRight size={14} className="text-zinc-500" />;
  }
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'done':
      return <CheckCircle2 size={16} className="text-green-400" />;
    case 'in_progress':
      return <Clock size={16} className="text-amber-400" />;
    default:
      return <Circle size={16} className="text-zinc-500" />;
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00'));
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isOverdue(task: PersonalTask): boolean {
  if (!task.dueDate || task.status === 'done') return false;
  const today = new Date().toISOString().split('T')[0];
  return task.dueDate < today;
}

function FilterChip({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
          value && value !== 'all'
            ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
            : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-400 hover:text-zinc-200'
        }`}
      >
        {label}: {selected?.label || 'Todas'}
        <ChevronDown size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-20 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl py-1 min-w-[140px]">
            {options.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                  value === opt.value ? 'text-amber-400 bg-amber-500/10' : 'text-zinc-300 hover:bg-zinc-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TaskFormModal({
  task,
  categories,
  onSave,
  onClose,
}: {
  task?: PersonalTask;
  categories: string[];
  onSave: (data: {
    title: string;
    description?: string;
    category?: string;
    priority?: string;
    dueDate?: string;
  }) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [category, setCategory] = useState(task?.category || '');
  const [newCategory, setNewCategory] = useState('');
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [priority, setPriority] = useState(task?.priority || 'normal');
  const [dueDate, setDueDate] = useState(task?.dueDate || '');

  const handleSave = () => {
    if (!title.trim()) return;
    const finalCategory = showNewCategory ? newCategory.trim() : category;
    onSave({
      title: title.trim(),
      description: description.trim() || undefined,
      category: finalCategory || undefined,
      priority,
      dueDate: dueDate || undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-lg mx-4 p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-zinc-100">{task ? 'Editar Task' : 'Nova Task'}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-500">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Titulo *</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="O que precisa ser feito?"
              className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-500/50"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Descricao</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Detalhes, contexto, links..."
              rows={3}
              className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-500/50 resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Categoria</label>
              {showNewCategory ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    placeholder="Nova categoria"
                    className="flex-1 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 outline-none focus:border-amber-500/50"
                  />
                  <button
                    onClick={() => setShowNewCategory(false)}
                    className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                  >
                    Voltar
                  </button>
                </div>
              ) : (
                <select
                  value={category}
                  onChange={(e) => {
                    if (e.target.value === '__new__') {
                      setShowNewCategory(true);
                      setCategory('');
                    } else {
                      setCategory(e.target.value);
                    }
                  }}
                  className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 outline-none focus:border-amber-500/50"
                >
                  <option value="">Sem categoria</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  <option value="__new__">+ Nova categoria</option>
                </select>
              )}
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Prioridade</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as 'low' | 'normal' | 'high')}
                className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 outline-none focus:border-amber-500/50"
              >
                <option value="low">Baixa</option>
                <option value="normal">Normal</option>
                <option value="high">Alta</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Data limite</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 outline-none focus:border-amber-500/50"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={!title.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

function TaskDetailPopup({
  task,
  categories,
  onUpdate,
  onDelete,
  onClose,
}: {
  task: PersonalTask;
  categories: string[];
  onUpdate: (id: string, updates: Partial<PersonalTask>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || '');
  const [category, setCategory] = useState(task.category || '');
  const [priority, setPriority] = useState(task.priority);
  const [status, setStatus] = useState(task.status);
  const [dueDate, setDueDate] = useState(task.dueDate || '');
  const [doneComment, setDoneComment] = useState(task.doneComment || '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dirty, setDirty] = useState(false);

  const save = useCallback(() => {
    const updates: Partial<PersonalTask> = {};
    if (title !== task.title) updates.title = title;
    if (description !== (task.description || '')) updates.description = description || null;
    if (category !== (task.category || '')) updates.category = category || null;
    if (priority !== task.priority) updates.priority = priority;
    if (status !== task.status) updates.status = status;
    if (dueDate !== (task.dueDate || '')) updates.dueDate = dueDate || null;
    if (doneComment !== (task.doneComment || '')) updates.doneComment = doneComment || null;
    if (Object.keys(updates).length > 0) {
      onUpdate(task.id, updates);
    }
    onClose();
  }, [title, description, category, priority, status, dueDate, doneComment, task, onUpdate, onClose]);

  const markDirty = useCallback(() => setDirty(true), []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-zinc-100">Detalhes da Task</h2>
          <button onClick={save} className="p-1 rounded hover:bg-zinc-800 text-zinc-500">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Titulo</label>
            <input
              type="text"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                markDirty();
              }}
              className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 outline-none focus:border-amber-500/50"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Descricao</label>
            <textarea
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                markDirty();
              }}
              rows={14}
              className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 outline-none focus:border-amber-500/50 resize-y"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Categoria</label>
              <select
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  markDirty();
                }}
                className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 outline-none focus:border-amber-500/50"
              >
                <option value="">Sem categoria</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Prioridade</label>
              <select
                value={priority}
                onChange={(e) => {
                  setPriority(e.target.value as PersonalTask['priority']);
                  markDirty();
                }}
                className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 outline-none focus:border-amber-500/50"
              >
                <option value="low">Baixa</option>
                <option value="normal">Normal</option>
                <option value="high">Alta</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Status</label>
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as PersonalTask['status']);
                  markDirty();
                }}
                className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 outline-none focus:border-amber-500/50"
              >
                <option value="pending">Pendente</option>
                <option value="in_progress">Em andamento</option>
                <option value="done">Concluida</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Data limite</label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => {
                  setDueDate(e.target.value);
                  markDirty();
                }}
                className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 outline-none focus:border-amber-500/50"
              />
            </div>
          </div>

          {status === 'done' && (
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Comentario de conclusao</label>
              <textarea
                value={doneComment}
                onChange={(e) => {
                  setDoneComment(e.target.value);
                  markDirty();
                }}
                placeholder="Como foi feito? O que lembrar para a proxima vez?"
                rows={3}
                className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-500/50 resize-none"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 pt-2">
            <div>
              <span className="text-[10px] text-zinc-600 uppercase">Criada em</span>
              <p className="text-xs text-zinc-400">{formatDateTime(task.createdAt)}</p>
            </div>
            <div>
              <span className="text-[10px] text-zinc-600 uppercase">Atualizada em</span>
              <p className="text-xs text-zinc-400">{formatDateTime(task.updatedAt)}</p>
            </div>
          </div>

          {task.doneAt && (
            <div>
              <span className="text-[10px] text-zinc-600 uppercase">Concluida em</span>
              <p className="text-xs text-zinc-400">{formatDateTime(task.doneAt)}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between mt-6 pt-4 border-t border-zinc-800">
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-400">Confirmar exclusao?</span>
              <button
                onClick={() => {
                  onDelete(task.id);
                  onClose();
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30"
              >
                Deletar
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200"
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-zinc-500 hover:text-red-400 transition-colors"
            >
              <Trash2 size={13} />
              Deletar
            </button>
          )}

          {task.status === 'done' && (
            <button
              onClick={() => {
                onUpdate(task.id, { status: 'pending' });
                onClose();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-amber-400 transition-colors"
            >
              <RotateCcw size={13} />
              Reabrir
            </button>
          )}

          <button
            onClick={save}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors"
          >
            {dirty ? 'Salvar' : 'Fechar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TasksPage() {
  const [tasks, setTasks] = useState<PersonalTask[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedTask, setSelectedTask] = useState<PersonalTask | null>(null);

  const [filters, setFilters] = useState<PersonalTaskFilters>({
    status: 'all',
    category: 'all',
    priority: 'all',
    period: 'last30',
  });

  const loadTasks = useCallback(async () => {
    setIsLoading(true);
    const [taskList, cats] = await Promise.all([
      window.lionclaw.tasks.list(filters),
      window.lionclaw.tasks.getCategories(),
    ]);
    const mapped = (taskList as unknown as Record<string, unknown>[]).map((t) => ({
      id: t.id as string,
      title: t.title as string,
      description: (t.description as string) || null,
      category: (t.category as string) || null,
      status: t.status as PersonalTask['status'],
      priority: (t.priority as PersonalTask['priority']) || 'normal',
      dueDate: (t.due_date as string) || (t.dueDate as string) || null,
      createdAt: (t.created_at as string) || (t.createdAt as string) || '',
      updatedAt: (t.updated_at as string) || (t.updatedAt as string) || '',
      doneAt: (t.done_at as string) || (t.doneAt as string) || null,
      doneComment: (t.done_comment as string) || (t.doneComment as string) || null,
    }));
    setTasks(mapped);
    setCategories(cats);
    setIsLoading(false);
  }, [filters]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const handleCreate = async (data: {
    title: string;
    description?: string;
    category?: string;
    priority?: string;
    dueDate?: string;
  }) => {
    await window.lionclaw.tasks.create(data);
    setShowCreateModal(false);
    loadTasks();
  };

  const handleUpdate = async (id: string, updates: Partial<PersonalTask>) => {
    await window.lionclaw.tasks.update(id, updates as Record<string, unknown>);
    loadTasks();
  };

  const handleDelete = async (id: string) => {
    await window.lionclaw.tasks.delete(id);
    loadTasks();
  };

  const handleToggleDone = async (task: PersonalTask) => {
    const newStatus = task.status === 'done' ? 'pending' : 'done';
    await window.lionclaw.tasks.update(task.id, { status: newStatus } as Record<string, unknown>);
    loadTasks();
  };

  const categoryOptions = [{ value: 'all', label: 'Todas' }, ...categories.map((c) => ({ value: c, label: c }))];

  const statusOptions = [
    { value: 'all', label: 'Todas' },
    { value: 'pending', label: 'Pendente' },
    { value: 'in_progress', label: 'Em andamento' },
    { value: 'done', label: 'Concluida' },
  ];

  const priorityOptions = [
    { value: 'all', label: 'Todas' },
    { value: 'high', label: 'Alta' },
    { value: 'normal', label: 'Normal' },
    { value: 'low', label: 'Baixa' },
  ];

  const periodOptions = [
    { value: 'last30', label: '30 dias' },
    { value: 'last90', label: '90 dias' },
    { value: 'all', label: 'Tudo' },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-zinc-100">Tasks</h1>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors"
          >
            <Plus size={16} />
            Nova Task
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 mb-5">
          <FilterChip
            label="Status"
            options={statusOptions}
            value={filters.status || 'all'}
            onChange={(v) => setFilters((f) => ({ ...f, status: v }))}
          />
          <FilterChip
            label="Categoria"
            options={categoryOptions}
            value={filters.category || 'all'}
            onChange={(v) => setFilters((f) => ({ ...f, category: v }))}
          />
          <FilterChip
            label="Prioridade"
            options={priorityOptions}
            value={filters.priority || 'all'}
            onChange={(v) => setFilters((f) => ({ ...f, priority: v }))}
          />
          <FilterChip
            label="Periodo"
            options={periodOptions}
            value={filters.period || 'last30'}
            onChange={(v) => setFilters((f) => ({ ...f, period: v as PersonalTaskFilters['period'] }))}
          />
        </div>

        {/* Loading */}
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={24} className="animate-spin text-zinc-500" />
          </div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-zinc-500 text-sm">Nenhuma task encontrada</p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="mt-3 text-sm text-amber-500 hover:text-amber-400 transition-colors"
            >
              Criar primeira task
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-5">
            {/* Column: A Fazer */}
            <div className="min-h-[200px]">
              <div className="flex items-center gap-2 mb-3 pb-2 border-b border-zinc-800">
                <Circle size={14} className="text-amber-400" />
                <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">A Fazer</h2>
                <span className="text-[10px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded-full">
                  {tasks.filter((t) => t.status !== 'done').length}
                </span>
              </div>
              <div className="space-y-2">
                {tasks
                  .filter((t) => t.status !== 'done')
                  .map((task) => (
                    <div
                      key={task.id}
                      onClick={() => setSelectedTask(task)}
                      className="group p-3 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-700 cursor-pointer transition-colors"
                    >
                      <div className="flex items-start gap-2.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleDone(task);
                          }}
                          className="shrink-0 mt-0.5 transition-colors"
                          title="Marcar como concluida"
                        >
                          <StatusIcon status={task.status} />
                        </button>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-zinc-200 block">{task.title}</span>
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            {task.category && (
                              <span className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                                {task.category}
                              </span>
                            )}
                            {task.dueDate && (
                              <span
                                className={`flex items-center gap-1 text-[11px] ${isOverdue(task) ? 'text-red-400' : 'text-zinc-500'}`}
                              >
                                <Calendar size={11} />
                                {formatDate(task.dueDate)}
                              </span>
                            )}
                            <span className="shrink-0" title={PRIORITY_LABELS[task.priority]}>
                              <PriorityIcon priority={task.priority} />
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                {tasks.filter((t) => t.status !== 'done').length === 0 && (
                  <p className="text-xs text-zinc-600 text-center py-8">Nenhuma task pendente</p>
                )}
              </div>
            </div>

            {/* Column: Concluido */}
            <div className="min-h-[200px]">
              <div className="flex items-center gap-2 mb-3 pb-2 border-b border-zinc-800">
                <CheckCircle2 size={14} className="text-green-400" />
                <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">Concluido</h2>
                <span className="text-[10px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded-full">
                  {tasks.filter((t) => t.status === 'done').length}
                </span>
              </div>
              <div className="space-y-2">
                {tasks
                  .filter((t) => t.status === 'done')
                  .map((task) => (
                    <div
                      key={task.id}
                      onClick={() => setSelectedTask(task)}
                      className="group p-3 rounded-lg bg-zinc-900/50 border border-zinc-800/50 hover:border-zinc-700 cursor-pointer transition-colors"
                    >
                      <div className="flex items-start gap-2.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleDone(task);
                          }}
                          className="shrink-0 mt-0.5 transition-colors"
                          title="Reabrir"
                        >
                          <StatusIcon status={task.status} />
                        </button>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-zinc-500 line-through block">{task.title}</span>
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            {task.category && (
                              <span className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-zinc-800/50 text-zinc-500 border border-zinc-700/30">
                                {task.category}
                              </span>
                            )}
                            {task.doneAt && (
                              <span className="text-[11px] text-zinc-600">{formatDate(task.doneAt)}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                {tasks.filter((t) => t.status === 'done').length === 0 && (
                  <p className="text-xs text-zinc-600 text-center py-8">Nenhuma task concluida</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <TaskFormModal categories={categories} onSave={handleCreate} onClose={() => setShowCreateModal(false)} />
      )}

      {/* Detail Popup */}
      {selectedTask && (
        <TaskDetailPopup
          task={selectedTask}
          categories={categories}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          onClose={() => setSelectedTask(null)}
        />
      )}
    </div>
  );
}

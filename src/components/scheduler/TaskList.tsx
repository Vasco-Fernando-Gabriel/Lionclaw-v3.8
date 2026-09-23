import { useState } from 'react';
import {
  Clock,
  Plus,
  Pause,
  Play,
  Trash2,
  History,
  Pencil,
  Eye,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import type { ScheduledTask, TaskRun, TaskInput } from '@/types';
import { TaskFormModal } from './TaskFormModal';
import { RejectNoteModal } from './RejectNoteModal';
import { useErrorToastStore } from '@/stores/error-toast-store';

interface Props {
  tasks: ScheduledTask[];
  isLoading: boolean;
  pendingCount: number;
  onReload: () => void;
  onViewSession: (sessionId: string, runId: number, reviewStatus?: string | null) => void;
}

export function TaskList({ tasks, isLoading, pendingCount, onReload, onViewSession }: Props) {
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | undefined>(undefined);
  const [rejectingRunId, setRejectingRunId] = useState<number | null>(null);

  const toggleExpand = async (taskId: string) => {
    if (expandedTask === taskId) {
      setExpandedTask(null);
      return;
    }
    setExpandedTask(taskId);
    const taskRuns = await window.lionclaw.scheduler.getRuns(taskId);
    setRuns(taskRuns);
  };

  const handlePause = async (id: string) => {
    await window.lionclaw.scheduler.pause(id);
    onReload();
  };

  const handleResume = async (id: string) => {
    await window.lionclaw.scheduler.resume(id);
    onReload();
  };

  const handleDelete = async (id: string) => {
    await window.lionclaw.scheduler.delete(id);
    onReload();
  };

  const handleCreate = async (input: TaskInput) => {
    const result = await window.lionclaw.scheduler.create(input);
    if (result && 'error' in result) {
      useErrorToastStore.getState().pushError(result.error, { title: 'Agendamento invalido', source: 'scheduler' });
      return;
    }
    setShowModal(false);
    onReload();
  };

  const handleUpdate = async (input: TaskInput) => {
    if (!editingTask) return;
    const result = await window.lionclaw.scheduler.update(editingTask.id, input);
    if (result && 'error' in result) {
      useErrorToastStore.getState().pushError(result.error, { title: 'Agendamento invalido', source: 'scheduler' });
      return;
    }
    setShowModal(false);
    setEditingTask(undefined);
    onReload();
  };

  const handleReviewRun = async (runId: number, status: 'validated' | 'rejected', note?: string) => {
    await window.lionclaw.scheduler.reviewRun(runId, status, note);
    if (expandedTask) {
      const taskRuns = await window.lionclaw.scheduler.getRuns(expandedTask);
      setRuns(taskRuns);
    }
    onReload();
  };

  const formatDate = (d?: string) => {
    if (!d) return '-';
    return new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-zinc-100">Tarefas</h2>
              {pendingCount > 0 && (
                <span className="px-2 py-0.5 text-[11px] font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-full">
                  {pendingCount} pendente{pendingCount > 1 ? 's' : ''}
                </span>
              )}
            </div>
            <p className="text-sm text-zinc-500 mt-1">Tarefas agendadas por cron, intervalo ou execucao unica</p>
          </div>
          <button
            onClick={() => {
              setEditingTask(undefined);
              setShowModal(true);
            }}
            className="flex items-center gap-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          >
            <Plus size={16} />
            Nova Tarefa
          </button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-12 text-zinc-600">
            <Clock size={32} className="mx-auto mb-3 opacity-50" />
            <p className="text-sm">Nenhuma tarefa agendada</p>
          </div>
        ) : (
          <div className="space-y-3">
            {tasks.map((task) => (
              <div key={task.id} className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                <div className="p-4 flex items-center gap-3">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      task.status === 'active'
                        ? 'bg-green-400'
                        : task.status === 'paused'
                          ? 'bg-amber-400'
                          : 'bg-zinc-600'
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-zinc-200">{task.name}</h3>
                      {task.tags && task.tags.length > 0 && (
                        <div className="flex gap-1">
                          {task.tags.map((tag) => (
                            <span key={tag} className="px-1.5 py-0.5 text-[9px] bg-zinc-800 text-zinc-500 rounded">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-3 text-[11px] text-zinc-500 mt-0.5">
                      <span className="font-mono">
                        {task.scheduleType}: {task.scheduleValue}
                      </span>
                      <span>Runs: {task.runCount}</span>
                      <span>Proximo: {formatDate(task.nextRun)}</span>
                    </div>
                    {task.scheduleError && (
                      <span
                        title={task.scheduleError}
                        className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-red-500/20 text-red-400 border border-red-500/30 rounded font-medium"
                      >
                        <AlertTriangle size={10} />
                        {task.scheduleError}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => toggleExpand(task.id)}
                      className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
                      title="Historico"
                    >
                      <History size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setEditingTask(task);
                        setShowModal(true);
                      }}
                      className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
                      title="Editar"
                    >
                      <Pencil size={14} />
                    </button>
                    {task.status === 'active' ? (
                      <button
                        onClick={() => handlePause(task.id)}
                        className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-amber-400"
                        title="Pausar"
                      >
                        <Pause size={14} />
                      </button>
                    ) : (
                      <button
                        onClick={() => handleResume(task.id)}
                        className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-green-400"
                        title="Retomar"
                      >
                        <Play size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(task.id)}
                      className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-red-400"
                      title="Remover"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {expandedTask === task.id && (
                  <div className="border-t border-zinc-800 px-4 py-3 bg-zinc-950">
                    <p className="text-xs text-zinc-500 mb-2">Ultimas execucoes:</p>
                    {runs.length === 0 ? (
                      <p className="text-xs text-zinc-600">Nenhuma execucao registrada</p>
                    ) : (
                      <div className="space-y-1.5">
                        {runs.slice(0, 10).map((run) => (
                          <div key={run.id} className="flex items-center gap-3 text-[11px]">
                            <span className="text-zinc-500 shrink-0">{formatDate(run.startedAt)}</span>
                            <span
                              className={
                                run.status === 'success'
                                  ? 'text-green-400'
                                  : run.status === 'error'
                                    ? 'text-red-400'
                                    : 'text-amber-400'
                              }
                            >
                              {run.status}
                            </span>
                            {run.reviewStatus === 'pending_review' && (
                              <span className="px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded text-[10px] font-medium">
                                pendente
                              </span>
                            )}
                            {run.reviewStatus === 'validated' && (
                              <span className="text-green-400 text-[10px]">validado</span>
                            )}
                            {run.reviewStatus === 'rejected' && (
                              <span className="text-red-400 text-[10px]">rejeitado</span>
                            )}
                            {run.error && (
                              <span title={run.error} className="text-red-400 truncate">
                                {run.error}
                              </span>
                            )}
                            <div className="flex-1" />
                            <div className="flex items-center gap-1 shrink-0">
                              {run.sessionId && (
                                <button
                                  onClick={() => onViewSession(run.sessionId!, run.id, run.reviewStatus)}
                                  className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
                                  title="Ver Sessao"
                                >
                                  <Eye size={12} />
                                </button>
                              )}
                              {run.reviewStatus === 'pending_review' && (
                                <>
                                  <button
                                    onClick={() => handleReviewRun(run.id, 'validated')}
                                    className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-green-400"
                                    title="Validar"
                                  >
                                    <CheckCircle2 size={12} />
                                  </button>
                                  <button
                                    onClick={() => setRejectingRunId(run.id)}
                                    className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-red-400"
                                    title="Rejeitar"
                                  >
                                    <XCircle size={12} />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showModal && (
        <TaskFormModal
          mode={editingTask ? 'edit' : 'create'}
          task={editingTask}
          onSave={editingTask ? handleUpdate : handleCreate}
          onClose={() => {
            setShowModal(false);
            setEditingTask(undefined);
          }}
        />
      )}

      {rejectingRunId !== null && (
        <RejectNoteModal
          onConfirm={(note) => {
            handleReviewRun(rejectingRunId, 'rejected', note);
            setRejectingRunId(null);
          }}
          onCancel={() => setRejectingRunId(null)}
        />
      )}
    </div>
  );
}

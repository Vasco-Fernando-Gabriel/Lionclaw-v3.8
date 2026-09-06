import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useHarnessStore } from '@/stores/harness-store';
import type { HarnessProject } from '@/types';

const STATUS_COLORS: Record<HarnessProject['status'], string> = {
  idle: 'bg-zinc-500/20 text-zinc-400',
  planning: 'bg-purple-500/20 text-purple-400',
  reviewing: 'bg-orange-500/20 text-orange-400',
  ready: 'bg-cyan-500/20 text-cyan-400',
  running: 'bg-blue-500/20 text-blue-400',
  paused: 'bg-yellow-500/20 text-yellow-400',
  done: 'bg-green-500/20 text-green-400',
  failed: 'bg-red-500/20 text-red-400',
  aborted: 'bg-orange-600/20 text-orange-500',
  interrupted: 'bg-amber-600/20 text-amber-500',
};

const STATUS_LABELS: Record<HarnessProject['status'], string> = {
  idle: 'Inativo',
  planning: 'Planejando',
  reviewing: 'Em revisao',
  ready: 'Pronto',
  running: 'Executando',
  paused: 'Pausado',
  done: 'Concluido',
  failed: 'Falhou',
  aborted: 'Abortado',
  interrupted: 'Interrompido',
};

export function ProjectCard({ project }: { project: HarnessProject }) {
  const { selectProject, deleteProject } = useHarnessStore();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const completedSprints =
    project.currentSprintIndex >= 0
      ? Math.min(project.currentSprintIndex + 1, project.totalSprints)
      : 0;
  const progress =
    project.totalSprints > 0
      ? Math.round((completedSprints / project.totalSprints) * 100)
      : 0;

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await deleteProject(project.id);
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const cancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  };

  return (
    <button
      onClick={() => selectProject(project.id)}
      className="w-full text-left p-4 bg-zinc-900 border border-zinc-800 rounded-lg hover:border-zinc-700 transition-colors"
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-zinc-100">{project.name}</h3>
          {project.description && (
            <p className="text-xs text-zinc-500 mt-0.5">{project.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 ml-2 shrink-0">
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${STATUS_COLORS[project.status]}`}
          >
            {STATUS_LABELS[project.status]}
          </span>
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
              >
                {deleting ? '...' : 'Confirmar'}
              </button>
              <button
                onClick={cancelDelete}
                className="px-2 py-0.5 rounded text-[10px] font-semibold bg-zinc-700/50 text-zinc-400 hover:bg-zinc-700 transition-colors"
              >
                Nao
              </button>
            </div>
          ) : (
            <button
              onClick={handleDelete}
              className="p-1 rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="Deletar projeto"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-zinc-500 mb-2">
        <span>
          Sprints: {completedSprints}/{project.totalSprints}
        </span>
        <span>Features: {project.totalFeatures}</span>
      </div>

      {project.totalSprints > 0 && (
        <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              project.status === 'done'
                ? 'bg-green-500'
                : project.status === 'failed'
                  ? 'bg-red-500'
                  : 'bg-amber-500'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </button>
  );
}

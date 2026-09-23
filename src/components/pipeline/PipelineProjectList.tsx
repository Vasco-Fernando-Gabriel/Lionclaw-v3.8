import { Plus, Loader2 } from 'lucide-react';
import type { PipelineProject } from '@/types/pipeline';
import { PipelineProjectCard } from './PipelineProjectCard';

function sortProjects(projects: PipelineProject[]): PipelineProject[] {
  const order: Record<string, number> = {
    running: 0,
    paused: 1,
    done: 2,
    failed: 3,
    idle: 4,
  };
  return [...projects].sort((a, b) => {
    const oa = order[a.status] ?? 5;
    const ob = order[b.status] ?? 5;
    if (oa !== ob) return oa - ob;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

interface PipelineProjectListProps {
  projects: PipelineProject[];
  isLoading: boolean;
  onSelect: (projectId: string) => void;
  onNewPipeline: () => void;
}

export function PipelineProjectList({ projects, isLoading, onSelect, onNewPipeline }: PipelineProjectListProps) {
  const sorted = sortProjects(projects);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header with + Novo button always visible */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Pipeline</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Automacao completa: Discovery ate Acceptance Review</p>
        </div>
        <button
          onClick={onNewPipeline}
          className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus size={16} />
          Novo Pipeline
        </button>
      </div>

      {/* Loading state: simple central spinner */}
      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-zinc-500" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-zinc-500">
          <p className="text-sm text-zinc-400 text-center">
            Nenhum pipeline ainda. Crie um novo pipeline para comecar.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 max-w-3xl">
          {sorted.map((project) => (
            <PipelineProjectCard key={project.id} project={project} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

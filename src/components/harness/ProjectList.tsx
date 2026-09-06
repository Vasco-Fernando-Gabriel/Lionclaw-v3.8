import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useHarnessStore } from '@/stores/harness-store';
import { ProjectCard } from './ProjectCard';
import { NewProjectModal } from './NewProjectModal';

export function ProjectList() {
  const { projects } = useHarnessStore();
  const [showModal, setShowModal] = useState(false);

  const hasContent = projects.length > 0;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-zinc-100">Agent Harness</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus size={16} />
            Novo Projeto
          </button>
        </div>
      </div>

      {!hasContent ? (
        <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
          <p className="text-sm">Nenhum projeto ainda.</p>
          <p className="text-xs mt-1">Crie um novo projeto para comecar.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}

      {showModal && <NewProjectModal onClose={() => setShowModal(false)} />}
    </div>
  );
}

import { useCallback } from 'react';
import { ArrowLeft, PenTool } from 'lucide-react';
import { useOpenDesignStore } from '@/stores/open-design-store';
import { usePipelineStore } from '@/stores/pipeline-store';
import { Phase4Container } from '@/components/open-design/Phase4Container';

interface OpenDesignStudioPageProps {
  projectId: string;
}

export default function OpenDesignStudioPage({ projectId }: OpenDesignStudioPageProps) {
  const closeStudio = useOpenDesignStore((s) => s.closeStudio);
  const projects = usePipelineStore((s) => s.projects);
  const project = projects.find((p) => p.id === projectId);

  const handleBack = useCallback(() => {
    closeStudio();
  }, [closeStudio]);

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <div className="h-10 shrink-0 flex items-center gap-3 px-4 border-b border-zinc-800 bg-zinc-950/90">
        <button
          onClick={handleBack}
          className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Voltar ao Pipeline"
        >
          <ArrowLeft size={14} />
          Voltar ao Pipeline
        </button>

        <div className="w-px h-4 bg-zinc-700 mx-1" />

        <div className="flex items-center gap-2 min-w-0">
          <PenTool size={14} className="text-amber-400 shrink-0" />
          <span className="text-xs font-medium text-zinc-200 truncate">
            {project?.name ?? projectId}
          </span>
          <span className="text-[10px] text-zinc-600">/ Fase 5: LionDesign Studio</span>
        </div>
      </div>

      <Phase4Container projectId={projectId} />
    </div>
  );
}

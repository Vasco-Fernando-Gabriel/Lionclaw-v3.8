import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useHarnessStore } from '@/stores/harness-store';
import type { HarnessProject } from '@/types';
import { SprintList } from './SprintList';
import { ExecutionView } from './ExecutionView';
import { MetricsView } from './MetricsView';

const STATUS_COLORS: Record<string, string> = {
  planning: 'text-purple-400',
  reviewing: 'text-orange-400',
  ready: 'text-cyan-400',
  running: 'text-blue-400',
  paused: 'text-yellow-400',
  done: 'text-green-400',
  failed: 'text-red-400',
};

const STATUS_LABELS: Record<string, string> = {
  planning: 'Planejando',
  reviewing: 'Em revisao',
  ready: 'Pronto',
  running: 'Executando',
  paused: 'Pausado',
  done: 'Concluido',
  failed: 'Falhou',
};

const TABS = [
  { id: 'sprints' as const, label: 'Sprints' },
  { id: 'execution' as const, label: 'Execucao' },
  { id: 'metrics' as const, label: 'Metricas' },
] as const;

export function ProjectDetail({ projectId }: { projectId: string }) {
  const { selectProject, activeTab, setTab } = useHarnessStore();
  const [project, setProject] = useState<HarnessProject | null>(null);

  useEffect(() => {
    window.lionclaw.harness.getProject(projectId).then(setProject);

    const unsub = window.lionclaw.harness.onProjectUpdate((data) => {
      if ((data as Record<string, unknown>).projectId === projectId) {
        window.lionclaw.harness.getProject(projectId).then(setProject);
      }
    });

    return unsub;
  }, [projectId]);

  if (!project) return null;

  const statusColor = STATUS_COLORS[project.status] ?? 'text-zinc-400';
  const statusLabel = STATUS_LABELS[project.status] ?? project.status;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-zinc-800">
        <button
          onClick={() => selectProject(null)}
          className="p-1 rounded hover:bg-zinc-800 text-zinc-400"
          title="Voltar"
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-lg font-bold text-zinc-100">{project.name}</h1>
        <span className={`text-xs font-semibold uppercase ${statusColor}`}>{statusLabel}</span>
      </div>

      <div className="flex gap-1 px-6 py-2 border-b border-zinc-800">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setTab(tab.id)}
            className={`px-4 py-1.5 text-sm rounded-lg transition-colors ${
              activeTab === tab.id ? 'bg-zinc-800 text-amber-500 font-medium' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'execution' ? (
        <div className="flex-1 overflow-hidden p-4">
          <ExecutionView projectId={projectId} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'sprints' && (
            <SprintList
              projectId={projectId}
              projectStatus={project.status}
              providerAuthCheckpoint={project.config.providerAuthCheckpoint}
            />
          )}
          {activeTab === 'metrics' && <MetricsView projectId={projectId} />}
        </div>
      )}
    </div>
  );
}

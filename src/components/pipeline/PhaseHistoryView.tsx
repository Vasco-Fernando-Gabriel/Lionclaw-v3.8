import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { usePipelineStore } from '@/stores/pipeline-store';
import type { HarnessSprint } from '@/types';
import { SprintsFormattedView } from './SprintsFormattedView';
import { ArchitectureReviewArtifactView } from './ArchitectureReviewArtifactView';


interface PhaseHistoryViewProps {
  phase: number;
  projectId: string;
}


export function PhaseHistoryView({ phase, projectId }: PhaseHistoryViewProps) {
  const { artifactCache, loadPhaseArtifact } = usePipelineStore();

  const cacheKey = artifactCache[projectId];
  const artifact = cacheKey?.[phase];
  const isLoading = artifact === undefined;

  useEffect(() => {
    void loadPhaseArtifact(projectId, phase);
  }, [projectId, phase, loadPhaseArtifact]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center flex-1 min-h-0 text-zinc-600 text-sm gap-2 py-12">
        <Loader2 size={14} className="animate-spin" />
        <span>Carregando artefato...</span>
      </div>
    );
  }

  if (artifact.type === 'sprints') {
    const sprints = (artifact.sprints ?? []) as HarnessSprint[];
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <SprintsFormattedView sprints={sprints} />
      </div>
    );
  }

  if (artifact.type === 'architecture') {
    if (!artifact.markdown && !artifact.json) {
      return (
        <div className="flex items-center justify-center flex-1 min-h-0 py-12">
          <p className="text-sm text-zinc-500">Ainda nao ha artefato para esta fase.</p>
        </div>
      );
    }
    return (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <ArchitectureReviewArtifactView
          phase={artifact.phase ?? phase}
          markdownContent={artifact.markdown ?? null}
          jsonContent={artifact.json ?? null}
        />
      </div>
    );
  }

  const content = artifact.content ?? '';

  if (!content.trim()) {
    return (
      <div className="flex items-center justify-center flex-1 min-h-0 py-12">
        <p className="text-sm text-zinc-500">Ainda nao ha artefato para esta fase.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
      <div className="phase-artifact-markdown text-sm text-zinc-300 leading-relaxed max-w-4xl mx-auto">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>

      <style>{`
        .phase-artifact-markdown h1 {
          font-size: 1.25rem;
          font-weight: 700;
          color: #f4f4f5;
          margin-bottom: 0.75rem;
          padding-bottom: 0.5rem;
          border-bottom: 1px solid #3f3f46;
        }
        .phase-artifact-markdown h2 {
          font-size: 1.05rem;
          font-weight: 600;
          color: #e4e4e7;
          margin-top: 1.5rem;
          margin-bottom: 0.5rem;
        }
        .phase-artifact-markdown h3 {
          font-size: 0.925rem;
          font-weight: 600;
          color: #d4d4d8;
          margin-top: 1rem;
          margin-bottom: 0.375rem;
        }
        .phase-artifact-markdown p {
          margin-bottom: 0.625rem;
          color: #a1a1aa;
        }
        .phase-artifact-markdown ul,
        .phase-artifact-markdown ol {
          margin-bottom: 0.625rem;
          padding-left: 1.25rem;
          color: #a1a1aa;
        }
        .phase-artifact-markdown li {
          margin-bottom: 0.25rem;
        }
        .phase-artifact-markdown code {
          background: #27272a;
          border: 1px solid #3f3f46;
          border-radius: 0.25rem;
          padding: 0.1rem 0.35rem;
          font-size: 0.8rem;
          color: #fbbf24;
          font-family: ui-monospace, monospace;
        }
        .phase-artifact-markdown pre {
          background: #18181b;
          border: 1px solid #3f3f46;
          border-radius: 0.5rem;
          padding: 0.875rem 1rem;
          overflow-x: auto;
          margin-bottom: 0.75rem;
        }
        .phase-artifact-markdown pre code {
          background: transparent;
          border: none;
          padding: 0;
          color: #d4d4d8;
        }
        .phase-artifact-markdown blockquote {
          border-left: 3px solid #78350f;
          padding-left: 0.875rem;
          color: #a1a1aa;
          margin-bottom: 0.625rem;
        }
        .phase-artifact-markdown table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 0.875rem;
          font-size: 0.8rem;
        }
        .phase-artifact-markdown th {
          background: #27272a;
          color: #e4e4e7;
          padding: 0.375rem 0.625rem;
          text-align: left;
          font-weight: 600;
          border: 1px solid #3f3f46;
        }
        .phase-artifact-markdown td {
          padding: 0.375rem 0.625rem;
          border: 1px solid #3f3f46;
          color: #a1a1aa;
        }
        .phase-artifact-markdown tr:nth-child(even) td {
          background: #18181b;
        }
        .phase-artifact-markdown a {
          color: #fbbf24;
          text-decoration: underline;
        }
        .phase-artifact-markdown hr {
          border: none;
          border-top: 1px solid #3f3f46;
          margin: 1rem 0;
        }
        .phase-artifact-markdown strong {
          color: #e4e4e7;
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}

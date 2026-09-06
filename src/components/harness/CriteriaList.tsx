import { useEffect, useState } from 'react';
import type { EvaluationResult } from '@/types';

interface CriteriaListProps {
  projectId: string;
  sprintId: string;
}

export function CriteriaList({ projectId, sprintId }: CriteriaListProps) {
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    window.lionclaw.harness
      .getEvaluation(projectId, sprintId)
      .then(setEvaluation)
      .finally(() => setLoading(false));
  }, [projectId, sprintId]);

  if (loading) {
    return (
      <div className="px-4 pb-3 pt-1">
        <p className="text-xs text-zinc-500">Carregando criterios...</p>
      </div>
    );
  }

  if (!evaluation || evaluation.criteria.length === 0) {
    return (
      <div className="px-4 pb-3 pt-1">
        <p className="text-xs text-zinc-500">Aguardando avaliacao</p>
      </div>
    );
  }

  return (
    <div className="px-4 pb-3 pt-1 space-y-2">
      {evaluation.summary && (
        <p className="text-xs text-zinc-400 italic border-l-2 border-zinc-700 pl-2">
          {evaluation.summary}
        </p>
      )}
      {evaluation.criteria.map((criterion) => (
        <div
          key={criterion.id}
          className="flex items-start gap-2 bg-zinc-900 rounded p-2 border border-zinc-800"
        >
          <span
            className={`mt-0.5 shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
              criterion.result === 'pass'
                ? 'bg-green-500/20 text-green-400'
                : 'bg-red-500/20 text-red-400'
            }`}
          >
            {criterion.result === 'pass' ? 'PASS' : 'FAIL'}
          </span>
          <div className="min-w-0">
            <p className="text-xs text-zinc-200 leading-snug">{criterion.description}</p>
            {criterion.justification && (
              <p className="text-xs text-zinc-500 mt-0.5 leading-snug">{criterion.justification}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

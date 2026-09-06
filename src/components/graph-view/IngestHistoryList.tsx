import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw,
  CheckCircle,
  XCircle,
  X,
  Clock,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import type { IngestJob } from '@/types';


function IngestProgressBar({ job }: { job: IngestJob }) {
  const pct =
    job.totalChunks > 0 ? Math.round((job.processedChunks / job.totalChunks) * 100) : 0;
  return (
    <div className="mt-1.5">
      <div className="flex justify-between text-[10px] text-zinc-500 mb-1">
        <span>
          Processando com IA... (chunk {job.processedChunks}/{job.totalChunks})
        </span>
        <span>{pct}%</span>
      </div>
      <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-amber-500 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}


interface IngestConfirmDialogProps {
  job: IngestJob | null;
  onConfirm: (jobId: string) => void;
  onCancel: (jobId: string) => void;
}

function IngestConfirmDialog({ job, onConfirm, onCancel }: IngestConfirmDialogProps) {
  if (!job) return null;

  const estimatedTokens =
    (job.estimatedCostUsd ?? 0) > 0
      ? Math.round((job.estimatedCostUsd! / 0.000003))
      : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-md mx-4 p-5 shadow-2xl">
        <h3 className="text-sm font-semibold text-zinc-200 mb-1">
          Confirmar processamento
        </h3>
        <p className="text-xs text-zinc-400 mb-4">
          O documento{' '}
          <span className="text-zinc-200 font-medium">"{job.fileName}"</span> requer
          confirmação antes de processar com IA.
        </p>

        {job.truncated && job.originalChunkCount != null && (
          <div className="flex items-start gap-2 mb-3 p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg">
            <AlertTriangle size={13} className="text-amber-400 shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-300">
              Documento muito grande. Processando primeiros {job.totalChunks} chunks de{' '}
              {job.originalChunkCount} total.
            </p>
          </div>
        )}

        <div className="space-y-2 mb-4 bg-zinc-800/50 rounded-lg p-3">
          <div className="flex justify-between text-xs">
            <span className="text-zinc-500">Chunks</span>
            <span className="text-zinc-200">{job.totalChunks}</span>
          </div>
          {estimatedTokens && (
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Tokens estimados</span>
              <span className="text-zinc-200">~{estimatedTokens.toLocaleString('pt-BR')}</span>
            </div>
          )}
          <div className="flex justify-between text-xs">
            <span className="text-zinc-500">Custo estimado</span>
            <span className="text-amber-400 font-medium">
              ${(job.estimatedCostUsd ?? 0).toFixed(4)} USD
            </span>
          </div>
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={() => onCancel(job.id)}
            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={() => onConfirm(job.id)}
            className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors"
          >
            Processar
          </button>
        </div>
      </div>
    </div>
  );
}


const STATUS_CONFIG: Record<
  IngestJob['status'],
  { label: string; className: string }
> = {
  extracting:     { label: 'Extraindo',   className: 'bg-blue-500/20 text-blue-400' },
  estimating:     { label: 'Estimando',   className: 'bg-purple-500/20 text-purple-400' },
  waiting_confirm:{ label: 'Aguardando',  className: 'bg-amber-500/20 text-amber-400' },
  processing:     { label: 'Processando', className: 'bg-amber-500/20 text-amber-400' },
  completed:      { label: 'Concluído',   className: 'bg-green-500/20 text-green-400' },
  failed:         { label: 'Falhou',      className: 'bg-red-500/20 text-red-400' },
  partial:        { label: 'Parcial',     className: 'bg-orange-500/20 text-orange-400' },
};

function StatusBadge({ status }: { status: IngestJob['status'] }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, className: 'bg-zinc-800 text-zinc-400' };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}


interface JobCardProps {
  job: IngestJob;
  onResume: (id: string) => void;
  onAccept: (id: string) => void;
  onDiscard: (id: string) => void;
  onDelete: (id: string) => void;
}

function JobCard({ job, onResume, onAccept, onDiscard, onDelete }: JobCardProps) {
  const isDone = job.status === 'completed' || job.status === 'failed';
  const isActive =
    job.status === 'extracting' || job.status === 'estimating' || job.status === 'processing';

  return (
    <div className="px-3 py-3 bg-zinc-900 border border-zinc-800 rounded-lg">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {/* File name + badges */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-medium text-zinc-200 truncate max-w-[180px]">
              {job.fileName}
            </span>
            <span className="text-[10px] bg-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded-full shrink-0">
              {job.sourceType}
            </span>
            <StatusBadge status={job.status} />
          </div>

          {/* Status description */}
          <div className="mt-1">
            {job.status === 'extracting' && (
              <span className="text-[11px] text-zinc-500">Extraindo texto...</span>
            )}
            {job.status === 'estimating' && (
              <span className="text-[11px] text-zinc-500">Calculando estimativa...</span>
            )}
            {job.status === 'waiting_confirm' && (
              <span className="text-[11px] text-zinc-500">
                {job.totalChunks} chunks · ${(job.estimatedCostUsd ?? 0).toFixed(4)} USD estimado
              </span>
            )}
            {job.status === 'processing' && <IngestProgressBar job={job} />}
            {job.status === 'completed' && (
              <span className="text-[11px] text-zinc-500">
                Concluído: {job.notesCreated} nota(s) criada(s), {job.notesUpdated} atualizada(s)
              </span>
            )}
            {job.status === 'failed' && (
              <span className="text-[11px] text-red-400">
                {job.error || 'Falha no processamento'}
              </span>
            )}
            {job.status === 'partial' && (
              <span className="text-[11px] text-zinc-500">
                {job.processedChunks}/{job.totalChunks} chunks · {job.notesCreated} nota(s) criada(s)
              </span>
            )}
          </div>

          {/* Active spinner */}
          {isActive && (
            <div className="flex items-center gap-1.5 mt-1.5">
              <Loader2 size={10} className="animate-spin text-amber-500" />
              <span className="text-[10px] text-zinc-600">em andamento...</span>
            </div>
          )}

          {/* Partial actions */}
          {job.status === 'partial' && (
            <div className="flex gap-1.5 mt-2">
              <button
                onClick={() => onResume(job.id)}
                className="flex items-center gap-1 px-2 py-1 text-[10px] bg-amber-600/20 text-amber-400 hover:bg-amber-600/30 border border-amber-600/30 rounded transition-colors"
              >
                <RefreshCw size={10} /> Retomar
              </button>
              <button
                onClick={() => onAccept(job.id)}
                className="flex items-center gap-1 px-2 py-1 text-[10px] bg-green-600/20 text-green-400 hover:bg-green-600/30 border border-green-600/30 rounded transition-colors"
              >
                <CheckCircle size={10} /> Aceitar
              </button>
              <button
                onClick={() => onDiscard(job.id)}
                className="flex items-center gap-1 px-2 py-1 text-[10px] bg-red-600/20 text-red-400 hover:bg-red-600/30 border border-red-600/30 rounded transition-colors"
              >
                <XCircle size={10} /> Descartar
              </button>
            </div>
          )}
        </div>

        {/* Delete button for terminal states */}
        {isDone && (
          <button
            onClick={() => onDelete(job.id)}
            className="shrink-0 p-1 text-zinc-600 hover:text-red-400 transition-colors rounded"
            title="Remover entrada"
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}


function DiscardConfirmDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-sm mx-4 p-5 shadow-2xl">
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-zinc-200">Descartar ingestão parcial?</h3>
            <p className="text-xs text-zinc-400 mt-1">
              Isso removerá as notas já criadas por este job e não poderá ser desfeito.
            </p>
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
          >
            Descartar
          </button>
        </div>
      </div>
    </div>
  );
}


interface IngestHistoryListProps {
  newJobs?: IngestJob[];
}

export function IngestHistoryList({ newJobs = [] }: IngestHistoryListProps) {
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmJob, setConfirmJob] = useState<IngestJob | null>(null);
  const [discardId, setDiscardId] = useState<string | null>(null);


  const loadHistory = useCallback(async () => {
    try {
      const history = await window.lionclaw.mgraph.ingestHistory();
      setJobs(Array.isArray(history) ? history : []);
    } catch {
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);


  useEffect(() => {
    if (newJobs.length === 0) return;
    setJobs((prev) => {
      const existingIds = new Set(prev.map((j) => j.id));
      const additions = newJobs.filter((j) => !existingIds.has(j.id));
      return additions.length > 0 ? [...additions, ...prev] : prev;
    });
  }, [newJobs]);


  useEffect(() => {
    const unsub = window.lionclaw.mgraph.onIngestProgress((data) => {
      const job = data as IngestJob;
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === job.id);
        if (idx === -1) return [job, ...prev];
        const next = [...prev];
        next[idx] = job;
        return next;
      });

      if (job.status === 'waiting_confirm') {
        setConfirmJob((cur) => (cur?.id === job.id ? cur : job));
      } else {
        setConfirmJob((cur) => (cur?.id === job.id ? null : cur));
      }
    });
    return unsub;
  }, []);


  useEffect(() => {
    if (loading) return;
    const pending = jobs.find((j) => j.status === 'waiting_confirm');
    if (pending && !confirmJob) {
      setConfirmJob(pending);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);


  const handleConfirm = async (jobId: string) => {
    setConfirmJob(null);
    try {
      await window.lionclaw.mgraph.ingestAccept(jobId);
    } catch { /* progress event will update state */ }
  };

  const handleConfirmCancel = async (jobId: string) => {
    setConfirmJob(null);
    try {
      await window.lionclaw.mgraph.ingestCancel(jobId);
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
    } catch { /* ignore */ }
  };

  const handleResume = async (jobId: string) => {
    try {
      const updated = await window.lionclaw.mgraph.ingestResume(jobId);
      if ('error' in updated) {
        setJobs((prev) => prev.map((job) => (
          job.id === jobId ? { ...job, status: 'failed', error: updated.error } : job
        )));
        return;
      }
      setJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j)));
    } catch { /* ignore */ }
  };

  const handleAccept = async (jobId: string) => {
    try {
      await window.lionclaw.mgraph.ingestAccept(jobId);
    } catch { /* ignore */ }
  };

  const handleDiscardRequest = (jobId: string) => {
    setDiscardId(jobId);
  };

  const handleDiscardConfirm = async () => {
    if (!discardId) return;
    const id = discardId;
    setDiscardId(null);
    try {
      await window.lionclaw.mgraph.ingestDiscard(id);
      setJobs((prev) => prev.filter((j) => j.id !== id));
    } catch { /* ignore */ }
  };

  const handleDelete = (jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
  };

  const handleClearHistory = () => {
    const ACTIVE_STATUSES = new Set<IngestJob['status']>([
      'processing', 'extracting', 'estimating', 'waiting_confirm', 'partial',
    ]);
    setJobs((prev) => prev.filter((j) => ACTIVE_STATUSES.has(j.status)));
  };

  const completedCount = jobs.filter(
    (j) => j.status === 'completed' || j.status === 'failed',
  ).length;


  return (
    <>
      {/* Section header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
          Histórico de ingestões
        </span>
        {completedCount > 0 && (
          <button
            onClick={handleClearHistory}
            className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            Limpar histórico
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={18} className="animate-spin text-zinc-500" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Clock size={20} className="text-zinc-700 mb-2" />
          <p className="text-xs text-zinc-600">Nenhuma ingestão realizada ainda</p>
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onResume={handleResume}
              onAccept={handleAccept}
              onDiscard={handleDiscardRequest}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* Confirm dialog for waiting_confirm status */}
      <IngestConfirmDialog
        job={confirmJob}
        onConfirm={handleConfirm}
        onCancel={handleConfirmCancel}
      />

      {/* Discard confirmation dialog */}
      <DiscardConfirmDialog
        open={discardId !== null}
        onConfirm={handleDiscardConfirm}
        onCancel={() => setDiscardId(null)}
      />
    </>
  );
}

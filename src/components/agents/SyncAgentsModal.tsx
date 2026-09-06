import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { isAgentSyncIpcError } from '@/types';
import type {
  AgentSyncBlockedResponse,
  AgentSyncResult,
  AgentSyncSuccessResponse,
  HarnessProjectStatus,
  OrchestratorSelectionSnapshot,
} from '@/types';

interface SyncAgentsModalProps {
  open: boolean;
  onClose: () => void;
  filteredAgentIds: string[];
  totalAgents: number;
  onComplete: () => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: AgentSyncSuccessResponse }
  | { kind: 'blocked'; data: AgentSyncBlockedResponse }
  | { kind: 'error'; message: string };

type ConfirmState =
  | { kind: 'idle' }
  | { kind: 'in-flight' }
  | { kind: 'blocked'; data: AgentSyncBlockedResponse }
  | { kind: 'error'; message: string };

type SnackbarState =
  | { kind: 'hidden' }
  | { kind: 'success'; updated: number; skipped: number; failed: number };

type Scope = 'all' | 'filtered';


function translateBlockedReason(
  reason: AgentSyncBlockedResponse['reason'],
): string {
  switch (reason) {
    case 'pipeline-running':
      return 'Ha projetos com pipelines em execucao, pausados ou aguardando revisao.';
    case 'enrich-active':
      return 'Ha uma sessao de Enrich ativa.';
    case 'project-locked':
      return 'Ha projetos com lock ativo.';
    default:
      return 'Sincronizacao bloqueada.';
  }
}

const HARNESS_STATUS_LABEL_PT: Record<HarnessProjectStatus, string> = {
  idle: 'ocioso',
  planning: 'planejando',
  reviewing: 'em revisao',
  ready: 'pronto',
  running: 'em execucao',
  paused: 'pausado',
  done: 'concluido',
  failed: 'falhou',
  aborted: 'abortado',
  interrupted: 'interrompido',
};

function translateHarnessStatus(status: HarnessProjectStatus): string {
  return HARNESS_STATUS_LABEL_PT[status] ?? status;
}

function formatOrchestrator(snap: OrchestratorSelectionSnapshot): string {
  return `${snap.runtime} / ${snap.provider} / ${snap.model}`;
}

function formatRuntimeLabel(runtime: string | undefined): string {
  return runtime ?? '-';
}

function formatModelLabel(model: string | undefined): string {
  if (!model) return '-';
  return model;
}

const SAMPLE_LIMIT = 5;
const WARNING_SAMPLE_LIMIT = 3;

export function SyncAgentsModal({
  open,
  onClose,
  filteredAgentIds,
  totalAgents,
  onComplete,
}: SyncAgentsModalProps) {
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [confirmState, setConfirmState] = useState<ConfirmState>({
    kind: 'idle',
  });
  const [snackbar, setSnackbar] = useState<SnackbarState>({ kind: 'hidden' });
  const [scope, setScope] = useState<Scope>('all');

  useEffect(() => {
    if (!open) return;
    setLoadState({ kind: 'loading' });
    setConfirmState({ kind: 'idle' });
    setSnackbar({ kind: 'hidden' });
    setScope('all');
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const agentIdsForPreview =
      scope === 'filtered' ? filteredAgentIds : undefined;
    if (scope === 'filtered' && (!agentIdsForPreview || agentIdsForPreview.length === 0)) {
      return;
    }

    let cancelled = false;
    setLoadState({ kind: 'loading' });

    (async () => {
      try {
        const response = await window.lionclaw.agents.syncToOrchestrator({
          dryRun: true,
          agentIds: agentIdsForPreview,
        });

        if (cancelled) return;

        if (isAgentSyncIpcError(response)) {
          setLoadState({ kind: 'error', message: response.error });
          return;
        }

        if (response.blocked) {
          setLoadState({ kind: 'blocked', data: response });
          return;
        }

        setLoadState({ kind: 'ready', data: response });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setLoadState({ kind: 'error', message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, scope, filteredAgentIds]);

  const handleConfirm = useCallback(async () => {
    if (loadState.kind !== 'ready') return;

    const agentIdsToSync = scope === 'filtered' ? filteredAgentIds : undefined;
    setConfirmState({ kind: 'in-flight' });

    try {
      const response = await window.lionclaw.agents.syncToOrchestrator({
        agentIds: agentIdsToSync,
        dryRun: false,
        mode: 'manual-button',
      });

      if (isAgentSyncIpcError(response)) {
        setConfirmState({ kind: 'error', message: response.error });
        return;
      }

      if (response.blocked) {
        setConfirmState({ kind: 'blocked', data: response });
        return;
      }

      setSnackbar({
        kind: 'success',
        updated: response.summary.updated,
        skipped: response.summary.skipped,
        failed: response.summary.failed,
      });
      setConfirmState({ kind: 'idle' });
      onComplete();
      setTimeout(() => {
        onClose();
      }, 1200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setConfirmState({ kind: 'error', message });
    }
  }, [loadState, scope, filteredAgentIds, onComplete, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-zinc-950/80 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="w-full max-w-3xl mx-4 max-h-[90vh] rounded-lg border border-zinc-800 bg-zinc-900 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <RefreshCw size={18} className="text-amber-500" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-amber-500">
                {renderHeaderTitle(loadState, confirmState)}
              </h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                {renderHeaderSubtitle(loadState, confirmState)}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
            title="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Loading */}
          {loadState.kind === 'loading' && (
            <div className="flex items-center justify-center py-12 gap-2 text-sm text-zinc-400">
              <Loader2 size={18} className="animate-spin text-amber-500" />
              Carregando preview...
            </div>
          )}

          {/* Error (IPC error) */}
          {loadState.kind === 'error' && (
            <ErrorPanel message={loadState.message} />
          )}

          {/* Blocked from dryRun */}
          {loadState.kind === 'blocked' && (
            <BlockedPanel response={loadState.data} />
          )}

          {/* Race condition: blocked at confirm time */}
          {loadState.kind === 'ready' && confirmState.kind === 'blocked' && (
            <BlockedPanel response={confirmState.data} />
          )}

          {/* Confirm error */}
          {loadState.kind === 'ready' && confirmState.kind === 'error' && (
            <ErrorPanel message={confirmState.message} />
          )}

          {/* Ready: preview + controls */}
          {loadState.kind === 'ready' &&
            (confirmState.kind === 'idle' ||
              confirmState.kind === 'in-flight') && (
              <ReadyPanel
                data={loadState.data}
                scope={scope}
                onScopeChange={setScope}
                filteredCount={filteredAgentIds.length}
                totalAgents={totalAgents}
                inFlight={confirmState.kind === 'in-flight'}
              />
            )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-zinc-800">
          <div className="text-xs text-zinc-500">
            {snackbar.kind === 'success' && (
              <span className="inline-flex items-center gap-1.5 text-emerald-400">
                <CheckCircle2 size={14} />
                {snackbar.updated} agentes atualizados, {snackbar.skipped} ignorados,{' '}
                {snackbar.failed} erros
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm transition-colors"
            >
              {shouldShowOnlyCloseButton(loadState, confirmState)
                ? 'Fechar'
                : 'Cancelar'}
            </button>
            {!shouldShowOnlyCloseButton(loadState, confirmState) && (
              <button
                onClick={handleConfirm}
                disabled={confirmState.kind === 'in-flight'}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {confirmState.kind === 'in-flight' ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Sincronizando...
                  </>
                ) : (
                  <>
                    <RefreshCw size={14} />
                    Confirmar e Sincronizar
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


function renderHeaderTitle(
  loadState: LoadState,
  confirmState: ConfirmState,
): string {
  if (loadState.kind === 'error') return 'Erro na sincronizacao';
  if (loadState.kind === 'blocked') return 'Sincronizacao bloqueada';
  if (confirmState.kind === 'blocked') return 'Sincronizacao bloqueada';
  if (confirmState.kind === 'error') return 'Erro na sincronizacao';
  return 'Sincronizar agentes com o orquestrador';
}

function renderHeaderSubtitle(
  loadState: LoadState,
  confirmState: ConfirmState,
): string {
  if (loadState.kind === 'loading') return 'Calculando preview de mudancas...';
  if (loadState.kind === 'error' || confirmState.kind === 'error') {
    return 'A operacao nao pode prosseguir.';
  }
  if (loadState.kind === 'blocked' || confirmState.kind === 'blocked') {
    return 'Resolva os bloqueios antes de tentar novamente.';
  }
  return 'Revise as mudancas propostas antes de confirmar.';
}

function shouldShowOnlyCloseButton(
  loadState: LoadState,
  confirmState: ConfirmState,
): boolean {
  return (
    loadState.kind === 'error' ||
    loadState.kind === 'blocked' ||
    confirmState.kind === 'blocked' ||
    confirmState.kind === 'error'
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="text-red-400 mt-0.5" />
        <div>
          <h3 className="text-sm font-semibold text-red-300 mb-1">
            Nao foi possivel sincronizar
          </h3>
          <p className="text-xs text-zinc-300 break-words">{message}</p>
        </div>
      </div>
    </div>
  );
}

function BlockedPanel({ response }: { response: AgentSyncBlockedResponse }) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-amber-300 mb-1">
              Sincronizacao bloqueada
            </h3>
            <p className="text-xs text-zinc-300">
              {translateBlockedReason(response.reason)}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
        <h4 className="text-xs font-semibold text-zinc-300 mb-2">
          Sessao de Enrich ativa
        </h4>
        <p className="text-xs text-zinc-400">
          {response.active.enrich ? 'Sim' : 'Nao'}
        </p>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
        <h4 className="text-xs font-semibold text-zinc-300 mb-2">
          Projetos bloqueando a sincronizacao
        </h4>
        {response.active.projects.length === 0 ? (
          <p className="text-xs text-zinc-500">
            Nenhum projeto listado. O bloqueio pode ser por lock interno.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {response.active.projects.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between text-xs text-zinc-300"
              >
                <span className="truncate pr-2">{p.name}</span>
                <span className="text-zinc-500 shrink-0">
                  {translateHarnessStatus(p.status)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs text-zinc-500">
        Termine ou pause as execucoes ativas e abra este modal novamente.
      </p>
    </div>
  );
}

interface ReadyPanelProps {
  data: AgentSyncSuccessResponse;
  scope: Scope;
  onScopeChange: (s: Scope) => void;
  filteredCount: number;
  totalAgents: number;
  inFlight: boolean;
}

function ReadyPanel({
  data,
  scope,
  onScopeChange,
  filteredCount,
  totalAgents,
  inFlight,
}: ReadyPanelProps) {
  const changedResults = data.results.filter((r) => r.changed);
  const unchangedCount = data.results.filter((r) => !r.changed).length;
  const sampleResults = changedResults.slice(0, SAMPLE_LIMIT);
  const remainingChanged = Math.max(0, changedResults.length - SAMPLE_LIMIT);

  const warnings = data.results.filter((r): r is AgentSyncResult & { warning: string } =>
    Boolean(r.warning),
  );
  const warningSamples = warnings.slice(0, WARNING_SAMPLE_LIMIT);
  const remainingWarnings = Math.max(0, warnings.length - WARNING_SAMPLE_LIMIT);

  const restored = data.results.filter(
    (r) => (r.restoredFromSeed?.length ?? 0) > 0,
  );

  return (
    <div className="space-y-4">
      {/* Orchestrator summary */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-1">
          Orquestrador atual
        </h3>
        <p className="text-sm text-zinc-100 font-mono break-all">
          {formatOrchestrator(data.orchestrator)}
        </p>
        {data.orchestrator.baseUrl && (
          <p className="text-xs text-zinc-500 mt-1 font-mono break-all">
            {data.orchestrator.baseUrl}
          </p>
        )}
      </div>

      {/* Scope toggle (Decisao-2.B) */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
          Escopo da sincronizacao
        </h3>
        <div className="space-y-2">
          <label
            className={`flex items-center gap-3 p-2 rounded-md cursor-pointer transition-colors ${
              scope === 'all'
                ? 'bg-amber-500/10 border border-amber-500/30'
                : 'bg-zinc-900 border border-zinc-800 hover:border-zinc-700'
            }`}
          >
            <input
              type="radio"
              name="sync-scope"
              value="all"
              checked={scope === 'all'}
              onChange={() => onScopeChange('all')}
              disabled={inFlight}
              className="accent-amber-500"
            />
            <span className="text-sm text-zinc-200">
              Aplicar a todos ({totalAgents})
            </span>
          </label>
          <label
            className={`flex items-center gap-3 p-2 rounded-md cursor-pointer transition-colors ${
              scope === 'filtered'
                ? 'bg-amber-500/10 border border-amber-500/30'
                : 'bg-zinc-900 border border-zinc-800 hover:border-zinc-700'
            } ${filteredCount === 0 ? 'opacity-50' : ''}`}
          >
            <input
              type="radio"
              name="sync-scope"
              value="filtered"
              checked={scope === 'filtered'}
              onChange={() => onScopeChange('filtered')}
              disabled={inFlight || filteredCount === 0}
              className="accent-amber-500"
            />
            <span className="text-sm text-zinc-200">
              Aplicar apenas aos {filteredCount} agentes filtrados
            </span>
          </label>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
          <p className="text-xs text-zinc-400">Serao atualizados</p>
          <p className="text-lg font-semibold text-amber-300">
            {changedResults.length}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <p className="text-xs text-zinc-400">Permanecem inalterados</p>
          <p className="text-lg font-semibold text-zinc-300">{unchangedCount}</p>
        </div>
      </div>

      {/* Restored from seed (Decisao em 2.4) */}
      {restored.length > 0 && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 size={16} className="text-emerald-400 mt-0.5" />
            <div>
              <h4 className="text-xs font-semibold text-emerald-300 mb-1">
                Restauracao do seed registry
              </h4>
              <p className="text-xs text-zinc-300">
                {restored.length} agente(s) terao tools restauradas do seed
                registry porque estavam vazias e o agente vinha de um runtime
                que zera tools.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Warnings panel (Decisao-2.C) */}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-amber-400 mt-0.5" />
            <div className="min-w-0">
              <h4 className="text-xs font-semibold text-amber-300 mb-2">
                Avisos ({warnings.length})
              </h4>
              <ul className="space-y-1">
                {warningSamples.map((w) => (
                  <li key={w.agentId} className="text-xs text-zinc-300">
                    <span className="font-mono text-zinc-400">{w.agentId}</span>
                    : {w.warning}
                  </li>
                ))}
              </ul>
              {remainingWarnings > 0 && (
                <p className="text-xs text-zinc-500 mt-1">
                  +{remainingWarnings} outros avisos
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Before -> After table */}
      {sampleResults.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 overflow-hidden">
          <div className="px-4 py-2 border-b border-zinc-800 bg-zinc-900/50">
            <h4 className="text-xs font-semibold text-zinc-300">
              Antes &rarr; Depois (amostra)
            </h4>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-zinc-900/40 text-zinc-500">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Agente</th>
                  <th className="text-left px-4 py-2 font-medium">Runtime</th>
                  <th className="text-left px-4 py-2 font-medium">Modelo</th>
                </tr>
              </thead>
              <tbody>
                {sampleResults.map((r) => (
                  <tr
                    key={r.agentId}
                    className="border-t border-zinc-800/60 align-top"
                  >
                    <td className="px-4 py-2 text-zinc-300 font-mono break-all">
                      {r.agentId}
                    </td>
                    <td className="px-4 py-2 text-zinc-300">
                      <span className="text-zinc-500">
                        {formatRuntimeLabel(r.before.runtime)}
                      </span>
                      <span className="text-zinc-600 mx-1">&rarr;</span>
                      <span className="text-amber-300">
                        {formatRuntimeLabel(r.after.runtime)}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-zinc-300">
                      <span className="text-zinc-500 break-all">
                        {formatModelLabel(r.before.model)}
                      </span>
                      <span className="text-zinc-600 mx-1">&rarr;</span>
                      <span className="text-amber-300 break-all">
                        {formatModelLabel(r.after.model)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {remainingChanged > 0 && (
            <div className="px-4 py-2 border-t border-zinc-800 text-xs text-zinc-500">
              +{remainingChanged} outros agentes serao atualizados
            </div>
          )}
        </div>
      )}

      {changedResults.length === 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 text-center">
          <p className="text-sm text-zinc-400">
            Nenhuma alteracao necessaria. Todos os agentes ja estao alinhados
            com o orquestrador atual.
          </p>
        </div>
      )}
    </div>
  );
}

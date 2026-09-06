import { LayoutPanelLeft, LifeBuoy, Loader2, Lock } from 'lucide-react';
import { CloserChatView } from './CloserChatView';
import { WorkflowDeliveryMetrics } from './WorkflowDeliveryMetrics';
import { HandoffButton } from '@/components/common/HandoffButton';
import type { CloserThreadMessage } from '@/stores/dynamic-workflow-store';
import type { DynamicWorkflowNode, DynamicWorkflowNodeRun } from '@/types';

export interface WorkflowHandoffViewProps {
  runId: string;
  projectName: string;
  status: string;
  projectPath: string | null;
  branch: string | null;
  closerThread: CloserThreadMessage[];
  closerBusy?: boolean;
  nodeRuns: DynamicWorkflowNodeRun[];
  nodes: DynamicWorkflowNode[];
  totalCostUsd?: number | null;
  onViewDetails?: () => void;
  onFinalize: () => Promise<{ ok: true } | { error: string }>;
}

export function summarizeCloserWalkthrough(
  thread: CloserThreadMessage[],
  maxChars = 1200,
): string {
  let last = '';
  for (const m of thread) {
    if (m.role === 'closer' && m.content.trim().length > 0) last = m.content.trim();
  }
  if (last.length <= maxChars) return last;
  return `${last.slice(0, maxChars).trimEnd()}...`;
}

export function WorkflowHandoffView({
  runId,
  projectName,
  status,
  projectPath,
  branch,
  closerThread,
  closerBusy = false,
  nodeRuns,
  nodes,
  totalCostUsd,
  onViewDetails,
  onFinalize,
}: WorkflowHandoffViewProps) {
  const isCompleted = status === 'completed';

  const workflowSummary = summarizeCloserWalkthrough(closerThread);

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="workflow-handoff-view">
      {/* Header da fase de fechamento: titulo + Encerrar e abrir no orquestrador. */}
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/60 px-4 py-2 shrink-0">
        <LifeBuoy size={14} className="text-amber-400 shrink-0" />
        <span className="text-[12px] font-semibold text-zinc-200">
          {isCompleted ? 'Workflow encerrado' : 'Entrega pronta'}
        </span>
        {closerBusy && <Loader2 size={12} className="animate-spin text-amber-400" />}
        <div className="ml-auto flex items-center gap-2">
          {onViewDetails && (
            <button
              type="button"
              onClick={onViewDetails}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              data-testid="handoff-view-details"
              title="Ver a tela anterior: nodes, stream, custo e timeline do run"
            >
              <LayoutPanelLeft size={12} />
              Ver detalhes do run
            </button>
          )}
          {isCompleted ? (
            <span
              className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1 text-[11px] font-medium text-zinc-400"
              data-testid="handoff-locked"
            >
              <Lock size={12} />
              Encerrado (preservado)
            </span>
          ) : (
            <HandoffButton
              request={{
                source: 'workflow',
                projectId: runId,
                projectName,
                projectPath,
                branch,
                workflowSummary,
              }}
              beforeHandoff={onFinalize}
              data-testid="handoff-to-orchestrator"
            />
          )}
        </div>
      </div>

      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        {/* Painel de METRICAS da entrega: tempo/tokens/custo no total e por sprint.
            Sempre presente (deriva de node_runs), entao a tela final nunca fica
            vazia mesmo quando o closer falha. Scroll proprio quando ha muitas
            sprints; cede o resto pro walkthrough abaixo. */}
        <div className="max-h-[55%] shrink-0 overflow-y-auto border-b border-zinc-800">
          <WorkflowDeliveryMetrics nodeRuns={nodeRuns} nodes={nodes} totalCostUsd={totalCostUsd} />
        </div>

        {/* Resumo "como rodar" / walkthrough da entrega: o CloserChatView read-only
            renderiza a thread do closer (a apresentacao da entrega). status
            'completed' deixa-o somente leitura (sem input). O dono quer VER esse
            resumo aqui no fechamento (req B.1); o handoff e o passo seguinte. */}
        <div className="flex flex-1 min-h-0 overflow-hidden" data-testid="handoff-summary">
          <CloserChatView
            runId={runId}
            thread={closerThread}
            status="completed"
            isBusy={closerBusy}
            onSend={async () => ({ ok: true as const })}
            onFinalize={onFinalize}
          />
        </div>
      </div>
    </div>
  );
}

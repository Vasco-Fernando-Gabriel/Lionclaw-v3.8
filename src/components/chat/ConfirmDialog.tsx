import { ShieldAlert, Check, X } from 'lucide-react';
import type { ConfirmAction } from '@/types';

interface ConfirmDialogProps {
  action: ConfirmAction;
  onApprove: () => void;
  onDeny: () => void;
}

export function ConfirmDialog({ action, onApprove, onDeny }: ConfirmDialogProps) {
  const riskColors: Record<string, string> = {
    medium: 'border-amber-500/50 bg-amber-500/5',
    high: 'border-orange-500/50 bg-orange-500/5',
    critical: 'border-red-500/50 bg-red-500/5',
  };

  const riskBadge: Record<string, string> = {
    medium: 'bg-amber-500/20 text-amber-400',
    high: 'bg-orange-500/20 text-orange-400',
    critical: 'bg-red-500/20 text-red-400',
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className={`w-full max-w-md mx-4 rounded-xl border ${riskColors[action.risk]} p-5`}>
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-zinc-800 flex items-center justify-center">
            <ShieldAlert size={20} className="text-amber-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Confirmacao necessaria</h3>
            <span className={`text-[10px] font-medium uppercase px-2 py-0.5 rounded-full ${riskBadge[action.risk]}`}>
              {action.risk}
            </span>
          </div>
        </div>

        {/* Description */}
        <div className="bg-zinc-900/50 rounded-lg px-3 py-2.5 mb-4">
          <p className="text-sm text-zinc-300">{action.description}</p>
          <p className="text-xs text-zinc-500 mt-1 font-mono">Tool: {action.tool}</p>
        </div>

        {/* Input preview */}
        {action.input != null && (
          <details className="mb-4">
            <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-400">
              Ver detalhes do input
            </summary>
            <pre className="mt-2 bg-zinc-900 rounded-lg p-2 text-[11px] text-zinc-400 overflow-x-auto max-h-32 selectable">
              {JSON.stringify(action.input, null, 2).substring(0, 500)}
            </pre>
          </details>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={onDeny}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-sm transition-colors"
          >
            <X size={16} />
            Negar
          </button>
          <button
            onClick={onApprove}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium transition-colors"
          >
            <Check size={16} />
            Aprovar
          </button>
        </div>
      </div>
    </div>
  );
}

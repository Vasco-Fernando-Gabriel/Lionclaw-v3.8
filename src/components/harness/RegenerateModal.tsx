import { useState } from 'react';
import { X } from 'lucide-react';

interface RegenerateModalProps {
  projectId: string;
  onClose: () => void;
}

export function RegenerateModal({ projectId, onClose }: RegenerateModalProps) {
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!feedback.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await window.lionclaw.harness.regenerateSprints(projectId, feedback.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao regenerar sprints');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-md mx-4 shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-100">Regenerar Sprints</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400"
            disabled={submitting}
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-xs text-zinc-400">
            Descreva o que deve ser ajustado no planejamento dos sprints. O agente planejador ira
            considerar seu feedback ao regenerar.
          </p>

          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Ex: Separar a autenticacao em um sprint proprio, incluir testes de integracao..."
            rows={5}
            disabled={submitting}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 resize-none focus:outline-none focus:border-amber-500 disabled:opacity-50"
          />

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-zinc-800">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-1.5 text-sm rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !feedback.trim()}
            className="px-4 py-1.5 text-sm rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Regenerando...' : 'Regenerar'}
          </button>
        </div>
      </div>
    </div>
  );
}

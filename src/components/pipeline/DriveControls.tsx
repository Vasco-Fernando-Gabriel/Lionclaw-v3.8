import { useEffect } from 'react';
import { Hand, PlayCircle, Square } from 'lucide-react';
import { useDriveStore } from '@/stores/drive-store';

export function DriveControls({ projectId }: { projectId: string }) {
  const drive = useDriveStore((s) => s.drives.get(projectId) ?? null);
  const isPending = useDriveStore((s) => s.pending.has(projectId));
  const loadDrive = useDriveStore((s) => s.loadDrive);
  const assumir = useDriveStore((s) => s.assumir);
  const stop = useDriveStore((s) => s.stop);
  const resume = useDriveStore((s) => s.resume);

  useEffect(() => {
    void loadDrive(projectId);
  }, [projectId, loadDrive]);

  if (!drive || drive.driver !== 'orchestrator') return null;

  const canResume =
    drive.status === 'awaiting-human' || drive.status === 'stopped';

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {/* Badge de status removido a pedido do dono (poluia o header; o estado do
          drive ja e inferivel pelos botoes visiveis: Parar = dirigindo,
          Retomar = parado/aguardando). */}

      {/* Autonomia (semi/full): controlada APENAS no card de pipeline ativo da
          barra de Atividade do chat (pedido do dono - header limpo). */}

      {/* Retomar — quando awaiting-human OU stopped (FX3/UI-4: o drive parado
          tambem pode ser retomado; resumeDrive re-arma o lock). */}
      {canResume && (
        <button
          onClick={() => void resume(projectId)}
          disabled={isPending}
          className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-green-400 border border-green-500/30 rounded-lg hover:bg-green-500/10 transition-colors disabled:opacity-40"
          title="Retoma a conducao do orquestrador"
        >
          <PlayCircle size={12} />
          Retomar
        </button>
      )}

      {/* Parar — so quando dirigindo */}
      {drive.status === 'driving' && (
        <button
          onClick={() => void stop(projectId)}
          disabled={isPending}
          className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-zinc-300 border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-40"
          title="Para o drive (o orquestrador deixa de conduzir, mas voce nao assume o volante)"
        >
          <Square size={12} />
          Parar
        </button>
      )}

      {/* Assumir — handoff permanente pro humano */}
      <button
        onClick={() => void assumir(projectId)}
        disabled={isPending}
        className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-amber-400 border border-amber-500/30 rounded-lg hover:bg-amber-500/10 transition-colors disabled:opacity-40"
        title="Desliga o orquestrador deste pipeline em definitivo. Voce ja pode aprovar/responder direto a qualquer momento; Assumir e so para ele parar de conduzir."
      >
        <Hand size={12} />
        Assumir
      </button>
    </div>
  );
}

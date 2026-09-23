import { SlidersHorizontal } from 'lucide-react';
import type { AppSettings } from '@/types';

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}

function formatTokens(value: number | undefined): string {
  if (!value || value <= 0) return 'auto';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return value.toLocaleString();
}

export function CompactionTriggerSettings({ settings, onUpdate }: Props) {
  const contextWindow = settings.orchestratorContextWindowTokens ?? 0;
  const thresholdPercent = settings.orchestratorCompactionThresholdPercent ?? 80;
  const targetTokens = settings.chatCompactionTargetTokens ?? 50_000;
  const autoEnabled = settings.chatAutoCompactionEnabled !== false;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
        <SlidersHorizontal size={16} className="text-amber-500" />
        Gatilho de compactacao
      </h2>

      <div className="bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3 space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs text-zinc-400">Compactacao automatica</label>
            <button
              type="button"
              role="switch"
              aria-checked={autoEnabled}
              onClick={() => onUpdate({ chatAutoCompactionEnabled: !autoEnabled })}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                autoEnabled ? 'bg-amber-500' : 'bg-zinc-700'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-zinc-100 transition-transform ${
                  autoEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                }`}
              />
            </button>
          </div>
          <p className="text-[10px] text-zinc-600">
            {autoEnabled
              ? 'O LionClaw compacta a conversa sozinho ao atingir o gatilho abaixo.'
              : 'DESLIGADA: o LionClaw nunca compacta sozinho. Em runtimes Claude/Z.ai/MiniMax o provider ainda compacta por conta propria no limite dele; em modelos locais (Ollama/LM Studio) e external NADA compacta e a conversa cresce ate estourar a janela, falhando o turno com erro do provider. A compactacao manual (botao da sidebar) continua disponivel.'}
          </p>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs text-zinc-400">Janela de contexto (override)</label>
            <span className="text-[10px] text-zinc-500 font-mono">{formatTokens(contextWindow)} tokens</span>
          </div>
          <input
            type="number"
            min={0}
            step={1024}
            value={contextWindow || ''}
            onChange={(e) => {
              const value = Number(e.target.value);
              onUpdate({
                orchestratorContextWindowTokens: Number.isFinite(value) && value > 0 ? Math.floor(value) : 0,
              });
            }}
            placeholder="Auto"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-amber-500/50"
          />
          <p className="text-[10px] text-zinc-600">
            Detectada automaticamente pelo modelo ativo. Preencha apenas para modelos locais ou desconhecidos que nao
            reportam a janela.
          </p>
        </div>

        <div className={`space-y-2 ${autoEnabled ? '' : 'opacity-40'}`}>
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs text-zinc-400">Compactar em</label>
            <span className="text-[10px] text-amber-300 font-mono">{thresholdPercent}%</span>
          </div>
          <input
            type="range"
            min={50}
            max={95}
            step={5}
            value={thresholdPercent}
            disabled={!autoEnabled}
            onChange={(e) =>
              onUpdate({
                orchestratorCompactionThresholdPercent: Number(e.target.value),
              })
            }
            className="w-full accent-amber-500"
          />
          <div className="flex justify-between text-[10px] text-zinc-600">
            <span>50%</span>
            <span>70%</span>
            <span>95%</span>
          </div>
        </div>

        <div className={`space-y-1.5 ${autoEnabled ? '' : 'opacity-40'}`}>
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs text-zinc-400">Alvo pos-compactacao (auto-compact)</label>
            <span className="text-[10px] text-zinc-500 font-mono">{formatTokens(targetTokens)} tokens</span>
          </div>
          <input
            type="number"
            min={1000}
            step={1000}
            disabled={!autoEnabled}
            value={targetTokens || ''}
            onChange={(e) => {
              const value = Number(e.target.value);
              onUpdate({
                chatCompactionTargetTokens: Number.isFinite(value) && value > 0 ? Math.floor(value) : 50_000,
              });
            }}
            placeholder="50000"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-amber-500/50"
          />
          <p className="text-[10px] text-zinc-600">
            Tamanho do contexto (resumo + turnos recentes) apos a compactacao automatica do chat.
          </p>
        </div>
      </div>
    </section>
  );
}

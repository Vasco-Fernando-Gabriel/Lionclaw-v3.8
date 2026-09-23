import { History } from 'lucide-react';
import type { AppSettings } from '@/types';

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}

export function TimelineReinjectSettings({ settings, onUpdate }: Props) {
  const enabled = settings.chatTimelineReinjectEnabled === true;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
        <History size={16} className="text-amber-500" />
        Tools na timeline
      </h2>

      <div className="bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3 space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs text-zinc-400">
              Reinjetar tools no historico (lion-sdk, Grok, Kimi; Codex e Cursor ao reidratar)
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => onUpdate({ chatTimelineReinjectEnabled: !enabled })}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                enabled ? 'bg-amber-500' : 'bg-zinc-700'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-zinc-100 transition-transform ${
                  enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                }`}
              />
            </button>
          </div>
          <p className="text-[10px] text-zinc-600">
            DESLIGADO por padrao: o historico reenviado ao modelo leva so o texto dos turnos. Ligado, as chamadas de
            tool gravadas na timeline voltam junto do historico nos runtimes lion-sdk, Grok e Kimi, e no Codex e no
            Cursor apenas quando a sessao e reidratada. Claude, Z.ai e MiniMax nao sao afetados: esses runtimes mantem o
            proprio historico do lado do provider.
          </p>
        </div>
      </div>
    </section>
  );
}

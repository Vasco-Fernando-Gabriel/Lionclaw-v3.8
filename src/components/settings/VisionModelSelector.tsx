import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import type { AppSettings } from '@/types';
import {
  VISION_DEFAULT,
  visionModelsForProvider,
  defaultVisionModelForProvider,
  type VisionProvider,
} from '@/constants/vision-models';

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}

const VAULT_KEY_BY_PROVIDER: Record<VisionProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

const PROVIDER_LABEL: Record<VisionProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

export function VisionModelSelector({ settings, onUpdate }: Props) {
  const provider = (settings.visionProvider || VISION_DEFAULT.provider) as VisionProvider;
  const modelsForProvider = useMemo(() => visionModelsForProvider(provider), [provider]);
  const selectedModel = settings.visionModel || defaultVisionModelForProvider(provider);

  const [keyPresent, setKeyPresent] = useState<boolean | null>(null);

  const refreshKeyPresence = useCallback(async () => {
    try {
      const present = await window.lionclaw.vault.check(VAULT_KEY_BY_PROVIDER[provider]);
      setKeyPresent(present === true);
    } catch {
      setKeyPresent(null);
    }
  }, [provider]);

  useEffect(() => {
    void refreshKeyPresence();
  }, [refreshKeyPresence]);

  const handleProvider = (next: VisionProvider) => {
    onUpdate({ visionProvider: next, visionModel: defaultVisionModelForProvider(next) });
  };

  const handleModel = (id: string) => {
    onUpdate({ visionModel: id });
  };

  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
          <ImageIcon size={16} className="text-amber-500" />
          Vision (imagens)
        </h2>
        <p className="text-xs text-zinc-500 mt-1">
          Transcreve toda imagem recebida (chat e Telegram) antes de mandar ao orquestrador.
          Independente do SDK escolhido. Usa a chave do provider no Vault.
        </p>
      </div>

      <div className="bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3 space-y-4">
        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            Provider
          </label>
          <div className="flex gap-2">
            {(Object.keys(PROVIDER_LABEL) as VisionProvider[]).map((p) => {
              const isSelected = provider === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => handleProvider(p)}
                  className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                    isSelected
                      ? 'bg-amber-600/15 text-amber-200 border-amber-600/40'
                      : 'bg-zinc-800/40 text-zinc-300 border-zinc-700 hover:border-zinc-600'
                  }`}
                >
                  {PROVIDER_LABEL[p]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            Modelo
          </label>
          <div className="space-y-2">
            {modelsForProvider.map((model) => {
              const isSelected = selectedModel === model.id;
              return (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => handleModel(model.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
                    isSelected
                      ? 'bg-amber-600/15 text-amber-200 border-amber-600/40'
                      : 'bg-zinc-800/40 text-zinc-300 border-zinc-700 hover:border-zinc-600'
                  }`}
                >
                  <span className="block text-sm font-medium">{model.displayName}</span>
                  <span className="block text-[11px] text-zinc-500 mt-0.5">{model.id}</span>
                </button>
              );
            })}
          </div>
        </div>

        {keyPresent === false && (
          <p className="text-xs text-amber-400 leading-relaxed">
            Chave {VAULT_KEY_BY_PROVIDER[provider]} ausente no Vault. Sem ela o vision fica
            indisponivel e o turno segue so com o texto. Adicione a chave em Provedores externos.
          </p>
        )}
        {keyPresent === true && (
          <p className="text-[11px] text-emerald-400 leading-relaxed">
            Chave {VAULT_KEY_BY_PROVIDER[provider]} presente no Vault.
          </p>
        )}
      </div>
    </section>
  );
}

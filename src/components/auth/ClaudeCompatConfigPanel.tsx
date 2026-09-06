import { useState } from 'react';
import { Eye, EyeOff, ArrowRight, Loader2 } from 'lucide-react';
import { CLAUDE_COMPAT_PRESETS } from '@/constants/claude-compat-presets';
import type { SdkCompleteHandler } from '@/types';

interface ClaudeCompatConfigPanelProps {
  onComplete: SdkCompleteHandler;
}

type CompatProvider = 'zai' | 'minimax';

export function ClaudeCompatConfigPanel({ onComplete }: ClaudeCompatConfigPanelProps) {
  const [chosenProvider, setChosenProvider] = useState<CompatProvider>('zai');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [localError, setLocalError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const activePreset = CLAUDE_COMPAT_PRESETS.find((p) => p.id === chosenProvider);
  const defaultModelId = activePreset?.models[0]?.id ?? '';

  const [selectedModelId, setSelectedModelId] = useState<string>(defaultModelId);

  const handleProviderChange = (provider: CompatProvider) => {
    setChosenProvider(provider);
    const preset = CLAUDE_COMPAT_PRESETS.find((p) => p.id === provider);
    setSelectedModelId(preset?.models[0]?.id ?? '');
    setLocalError('');
  };

  const trimmedKey = apiKey.trim();
  const canContinue =
    trimmedKey.length > 0 && selectedModelId.length > 0 && !isSubmitting;

  const handleContinue = async () => {
    if (!canContinue) return;
    setLocalError('');
    setIsSubmitting(true);
    try {
      const result = await onComplete(
        {
          orchestratorRuntime: 'claude-compat-sdk',
          orchestratorProvider: chosenProvider,
          orchestratorModel: selectedModelId,
        },
        () =>
          window.lionclaw.provider.connect({
            provider: chosenProvider,
            apiKey: trimmedKey,
          }),
      );
      if ('error' in result) {
        setLocalError(result.error);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const providerOptions: Array<{ id: CompatProvider; label: string; subtitle: string }> = [
    {
      id: 'zai',
      label: 'Z.ai (GLM)',
      subtitle: 'GLM-4.7 e variantes via API Anthropic-compat.',
    },
    {
      id: 'minimax',
      label: 'MiniMax Token Plan',
      subtitle: 'MiniMax M2.7 e variantes via API Anthropic-compat.',
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Sub-radio: provider choice */}
      <div className="flex flex-col gap-2">
        <label className="text-xs text-zinc-500">Provedor</label>
        <div className="flex flex-col gap-2">
          {providerOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => handleProviderChange(opt.id)}
              className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                chosenProvider === opt.id
                  ? 'border-amber-500/60 bg-amber-500/10'
                  : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
              }`}
            >
              <span
                className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 transition-colors ${
                  chosenProvider === opt.id
                    ? 'border-amber-500 bg-amber-500'
                    : 'border-zinc-600 bg-transparent'
                }`}
              />
              <span className="flex flex-col">
                <span className="text-sm font-medium text-zinc-100">{opt.label}</span>
                <span className="text-xs text-zinc-500 leading-snug">{opt.subtitle}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* API key input */}
      <div>
        <label className="block text-xs text-zinc-500 mb-1.5">API Key</label>
        <div className="relative">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 pr-10 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
            placeholder="Sua chave de API"
            autoComplete="off"
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <p className="text-xs text-zinc-600 mt-1.5">
          Armazenada no keychain do SO, nunca em plaintext.
        </p>
      </div>

      {/* Model dropdown */}
      <div>
        <label className="block text-xs text-zinc-500 mb-1.5">Modelo padrao</label>
        <select
          value={selectedModelId}
          onChange={(e) => setSelectedModelId(e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50 appearance-none cursor-pointer"
        >
          {(activePreset?.models ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
              {m.notes ? ` -- ${m.notes}` : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Local error */}
      {localError && (
        <p className="text-sm text-red-400">{localError}</p>
      )}

      {/* Continue button */}
      <button
        type="button"
        onClick={handleContinue}
        disabled={!canContinue}
        className="w-full flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isSubmitting ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <>
            Continuar
            <ArrowRight size={16} />
          </>
        )}
      </button>
    </div>
  );
}

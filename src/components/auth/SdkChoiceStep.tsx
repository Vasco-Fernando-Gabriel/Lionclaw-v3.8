import type { SdkChoice } from '@/types';

interface SdkChoiceStepProps {
  value: SdkChoice | null;
  onChange: (sdk: SdkChoice) => void;
}

interface SdkOption {
  id: SdkChoice;
  label: string;
  subtitle: string;
  recommended?: boolean;
}

const SDK_OPTIONS: SdkOption[] = [
  {
    id: 'claude-anthropic',
    label: 'Claude Agent SDK',
    subtitle: 'Conta Anthropic direto (sk-ant-...). Recomendado.',
    recommended: true,
  },
  {
    id: 'codex',
    label: 'Codex SDK (OpenAI)',
    subtitle: 'OAuth via CLI do OpenAI. Sem API key.',
  },
  {
    id: 'claude-compat',
    label: 'Claude-compat SDK',
    subtitle: 'Z.ai (GLM) ou MiniMax Token Plan. Plano + API key.',
  },
  {
    id: 'lion-sdk',
    label: 'Lion-SDK',
    subtitle: 'Ollama local, LM Studio, OpenAI-compat (Kimi/Qwen/DeepSeek) ou Vertex AI.',
  },
];

export function SdkChoiceStep({ value, onChange }: SdkChoiceStepProps) {
  return (
    <div className="space-y-3">
      {SDK_OPTIONS.map((option) => {
        const isSelected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            className={[
              'w-full text-left px-4 py-3 rounded-xl border transition-colors',
              isSelected
                ? 'bg-amber-600/10 border-amber-500/60'
                : 'bg-zinc-900 border-zinc-800 hover:border-zinc-700',
            ].join(' ')}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span
                  className={[
                    'w-4 h-4 rounded-full border-2 flex-shrink-0 mt-0.5',
                    isSelected
                      ? 'border-amber-500 bg-amber-500'
                      : 'border-zinc-600',
                  ].join(' ')}
                />
                <div>
                  <p className={[
                    'text-sm font-medium',
                    isSelected ? 'text-amber-400' : 'text-zinc-200',
                  ].join(' ')}>
                    {option.label}
                  </p>
                  <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
                    {option.subtitle}
                  </p>
                </div>
              </div>
              {option.recommended && (
                <span className="text-xs bg-amber-600/20 text-amber-400 border border-amber-600/30 rounded px-2 py-0.5 ml-2 flex-shrink-0">
                  Recomendado
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

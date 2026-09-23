import { useState } from 'react';
import { OllamaSubPanel } from './lion-sdk/OllamaSubPanel';
import { LmStudioSubPanel } from './lion-sdk/LmStudioSubPanel';
import { OpenAiCompatSubPanel } from './lion-sdk/OpenAiCompatSubPanel';
import { VertexSubPanel } from './lion-sdk/VertexSubPanel';
import type { SdkCompleteHandler } from '@/types';

interface LionSdkConfigPanelProps {
  onComplete: SdkCompleteHandler;
}

type LionProvider = 'ollama' | 'lmstudio' | 'openai-compatible' | 'vertex-ai';

const PROVIDER_OPTIONS: Array<{ id: LionProvider; label: string; subtitle: string }> = [
  {
    id: 'ollama',
    label: 'Ollama',
    subtitle: 'Modelos locais via servidor Ollama.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    subtitle: 'Modelos locais via servidor LM Studio.',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    subtitle: 'Kimi, Qwen, DeepSeek, MiniMax PAYG e provedores customizados.',
  },
  {
    id: 'vertex-ai',
    label: 'Vertex AI (Gemini)',
    subtitle: 'Modelos Gemini via Google Vertex AI.',
  },
];

export function LionSdkConfigPanel({ onComplete }: LionSdkConfigPanelProps) {
  const [chosenProvider, setChosenProvider] = useState<LionProvider>('ollama');

  return (
    <div className="flex flex-col gap-5">
      {/* Sub-radio: escolha do provedor Lion-SDK */}
      <div className="flex flex-col gap-2">
        <label className="text-xs text-zinc-500">Provedor</label>
        <div className="flex flex-col gap-2">
          {PROVIDER_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setChosenProvider(opt.id)}
              className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                chosenProvider === opt.id
                  ? 'border-amber-500/60 bg-amber-500/10'
                  : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
              }`}
            >
              <span
                className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 transition-colors ${
                  chosenProvider === opt.id ? 'border-amber-500 bg-amber-500' : 'border-zinc-600 bg-transparent'
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

      {/* Separador visual */}
      <div className="h-px bg-zinc-800" />

      {/* Sub-painel conforme provedor escolhido */}
      {chosenProvider === 'ollama' && <OllamaSubPanel onComplete={onComplete} />}
      {chosenProvider === 'lmstudio' && <LmStudioSubPanel onComplete={onComplete} />}
      {chosenProvider === 'openai-compatible' && <OpenAiCompatSubPanel onComplete={onComplete} />}
      {chosenProvider === 'vertex-ai' && <VertexSubPanel onComplete={onComplete} />}
    </div>
  );
}

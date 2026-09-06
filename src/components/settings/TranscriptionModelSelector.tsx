import { AudioLines } from 'lucide-react';
import type { AppSettings, VoiceTranscriptionModel } from '@/types';
import {
  DEFAULT_VOICE_TRANSCRIPTION_MODEL,
  VOICE_TRANSCRIPTION_MODELS,
} from '@/constants/transcription-models';

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}

export function TranscriptionModelSelector({ settings, onUpdate }: Props) {
  const selected = settings.voiceTranscriptionModel || DEFAULT_VOICE_TRANSCRIPTION_MODEL;

  const handleSelect = (model: VoiceTranscriptionModel) => {
    onUpdate({ voiceTranscriptionModel: model });
  };

  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
          <AudioLines size={16} className="text-amber-500" />
          Modelo de transcricao
        </h2>
        <p className="text-xs text-zinc-500 mt-1">
          Usado por audio no chat, conversa por voz e Telegram. A transcricao e feita pela API da OpenAI.
        </p>
      </div>

      <div className="bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3 space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">OpenAI API</p>
        {VOICE_TRANSCRIPTION_MODELS.map((model) => {
          const isSelected = selected === model.id;
          return (
            <button
              key={model.id}
              type="button"
              onClick={() => handleSelect(model.id)}
              className={`block w-full text-left px-3 py-2 rounded-lg border transition-colors ${
                isSelected
                  ? 'bg-amber-600/15 text-amber-200 border-amber-600/40'
                  : 'bg-zinc-800/40 text-zinc-300 border-zinc-700 hover:border-zinc-600'
              }`}
            >
              <span className="block text-sm font-medium">{model.label}</span>
              <span className="block text-xs text-zinc-500 mt-0.5">{model.description}</span>
            </button>
          );
        })}
        <p className="text-[11px] leading-relaxed text-zinc-600">
          Requer OPENAI_API_KEY configurada no Vault. O audio nao e processado localmente.
        </p>
      </div>
    </section>
  );
}

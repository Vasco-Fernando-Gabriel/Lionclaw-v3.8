import type { VoiceTranscriptionModel } from '../types';

export const DEFAULT_VOICE_TRANSCRIPTION_MODEL: VoiceTranscriptionModel = 'whisper-1';

export const VOICE_TRANSCRIPTION_MODELS: Array<{
  id: VoiceTranscriptionModel;
  label: string;
  description: string;
  provider: 'openai';
}> = [
  {
    id: 'whisper-1',
    label: 'Whisper-1',
    description: 'Padrao atual, estavel e compativel com o fluxo existente.',
    provider: 'openai',
  },
  {
    id: 'gpt-4o-mini-transcribe',
    label: 'GPT-4o mini Transcribe',
    description: 'Mais novo, rapido e com melhor acuracia que Whisper original.',
    provider: 'openai',
  },
  {
    id: 'gpt-4o-transcribe',
    label: 'GPT-4o Transcribe',
    description: 'Mais forte para transcricoes com sotaque, ruido e termos tecnicos.',
    provider: 'openai',
  },
];

const MODEL_IDS = new Set<string>(VOICE_TRANSCRIPTION_MODELS.map((model) => model.id));

export function isVoiceTranscriptionModel(value: string): value is VoiceTranscriptionModel {
  return MODEL_IDS.has(value);
}

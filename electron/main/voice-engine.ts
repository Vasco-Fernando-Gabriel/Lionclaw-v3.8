import fsPromises from 'fs/promises';
import path from 'path';
import { createLogger } from './logger';
import { getSecret } from './secrets-vault';
import { getSetting } from './db';
import { DEFAULT_VOICE_TRANSCRIPTION_MODEL, isVoiceTranscriptionModel } from '../../src/constants/transcription-models';
import type { VoiceTranscriptionModel } from '../../src/types';

const logger = createLogger('voice-engine');
export const DEFAULT_ELEVENLABS_VOICE_ID = 'RGymW84CSmfVugnA5tvA';

type AudioFormat = 'webm' | 'ogg' | 'mp3' | 'wav' | 'm4a' | 'flac' | 'mp4' | 'mpeg' | 'mpga';

const MIME_TYPES: Record<AudioFormat, string> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'audio/mp4',
  mpeg: 'audio/mpeg',
  mpga: 'audio/mpeg',
};

function getVoiceTranscriptionModel(): VoiceTranscriptionModel {
  const configured = getSetting('voice_transcription_model') || '';
  return isVoiceTranscriptionModel(configured) ? configured : DEFAULT_VOICE_TRANSCRIPTION_MODEL;
}

export async function transcribeAudio(audioBase64: string, format: AudioFormat = 'webm'): Promise<string> {
  const audioBuffer = Buffer.from(audioBase64, 'base64');
  return transcribeAudioBuffer(audioBuffer, {
    format,
    filename: `recording.${format}`,
  });
}

export async function transcribeAudioFile(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const format = (ext in MIME_TYPES ? ext : 'mp3') as AudioFormat;
  const audioBuffer = await fsPromises.readFile(filePath);
  return transcribeAudioBuffer(audioBuffer, {
    format,
    filename: path.basename(filePath),
  });
}

async function transcribeAudioBuffer(
  audioBuffer: Buffer,
  opts: { format: AudioFormat; filename: string },
): Promise<string> {
  const model = getVoiceTranscriptionModel();
  const apiKey = await getSecret('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY nao configurada. Configure no Vault para usar transcricao de audio.');

  const blob = new Blob([new Uint8Array(audioBuffer)], { type: MIME_TYPES[opts.format] });

  const formData = new FormData();
  formData.append('file', blob, opts.filename);
  formData.append('model', model);
  formData.append('language', 'pt');
  formData.append('response_format', 'json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error({ status: response.status, errorText, model }, 'OpenAI STT failed');
    throw new Error(`OpenAI STT failed: ${response.status} ${response.statusText}`);
  }

  const result = (await response.json()) as { text?: string };
  logger.info({ model, textLength: result.text?.length }, 'OpenAI transcription complete');
  return result.text || '';
}

export const __voiceEngineInternal = {
  getVoiceTranscriptionModel,
};

export async function generateSpeech(
  text: string,
  voiceId?: string,
  outputFormat?: 'mp3' | 'opus',
): Promise<{ base64: string; format: 'mp3' | 'opus' }> {
  const apiKey = await getSecret('ELEVENLABS_API_KEY');
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY nao configurada. Configure no Vault.');

  const explicitVoice = typeof voiceId === 'string' ? voiceId.trim() : '';
  const configuredVoice = (getSetting('voice_id') || '').trim();
  const selectedVoice = explicitVoice || configuredVoice || DEFAULT_ELEVENLABS_VOICE_ID;
  const format = outputFormat || 'mp3';

  const formatParam = format === 'opus' ? 'opus_48000_64' : 'mp3_44100_128';

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoice}?output_format=${formatParam}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    logger.error({ status: response.status, errorText }, 'ElevenLabs TTS failed');
    throw new Error(`ElevenLabs TTS failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return { base64: buffer.toString('base64'), format };
}

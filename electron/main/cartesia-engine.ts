import { getSetting } from './db';
import { createLogger } from './logger';
import { getSecret } from './secrets-vault';
import { generateSpeech } from './voice-engine';

const logger = createLogger('cartesia');

export const DEFAULT_CARTESIA_MODEL = 'sonic-3';
export const DEFAULT_CARTESIA_VOICE_ID = '694f9389-aac1-45b6-b726-9d9369183238';
export const DEFAULT_CARTESIA_SPEED = 1.15;
export const DEFAULT_CARTESIA_LANGUAGE = 'pt';
export const CARTESIA_VERSION = '2026-03-01';

export type VoiceLiveProvider = 'elevenlabs' | 'cartesia';

export interface CartesiaVoice {
  id: string;
  name: string;
  description: string;
  gender?: string;
  language?: string;
  country?: string;
  isOwner: boolean;
  isPublic: boolean;
  previewUrl?: string;
}

function getVoiceLiveProvider(): VoiceLiveProvider {
  return getSetting('voice_live_provider') === 'cartesia' ? 'cartesia' : 'elevenlabs';
}

function getCartesiaVoiceId(explicitVoiceId?: string): string {
  const explicit = typeof explicitVoiceId === 'string' ? explicitVoiceId.trim() : '';
  const configured = (getSetting('cartesia_voice_id') || '').trim();
  return explicit || configured || DEFAULT_CARTESIA_VOICE_ID;
}

function getCartesiaModel(): string {
  const configured = (getSetting('cartesia_model') || '').trim();
  return configured && configured !== 'sonic-3.5' ? configured : DEFAULT_CARTESIA_MODEL;
}

function getCartesiaSpeed(): number {
  const speed = Number.parseFloat(getSetting('cartesia_speed') || String(DEFAULT_CARTESIA_SPEED));
  if (!Number.isFinite(speed)) return DEFAULT_CARTESIA_SPEED;
  return Math.min(1.5, Math.max(0.6, speed));
}

function getCartesiaLanguage(explicitLanguage?: string): string {
  const explicit = typeof explicitLanguage === 'string' ? explicitLanguage.trim() : '';
  const configured = (getSetting('cartesia_voice_language') || '').trim();
  return explicit || configured || DEFAULT_CARTESIA_LANGUAGE;
}

async function getCartesiaApiKey(): Promise<string> {
  const apiKey = await getSecret('CARTESIA_API_KEY');
  if (!apiKey) {
    throw new Error('CARTESIA_API_KEY nao configurada. Configure no Vault para usar Cartesia no chat ao vivo.');
  }
  return apiKey;
}

async function readError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 1200);
  } catch {
    return '';
  }
}

export async function listCartesiaVoices(options?: {
  q?: string;
  language?: string;
  limit?: number;
}): Promise<CartesiaVoice[]> {
  const apiKey = await getCartesiaApiKey();
  const params = new URLSearchParams();
  params.set('limit', String(Math.min(Math.max(options?.limit ?? 80, 1), 100)));
  params.append('expand[]', 'preview_file_url');
  if (options?.q?.trim()) params.set('q', options.q.trim());
  if (options?.language?.trim()) params.set('language', options.language.trim());

  const response = await fetch(`https://api.cartesia.ai/voices?${params.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Cartesia-Version': CARTESIA_VERSION,
    },
  });

  if (!response.ok) {
    const errorText = await readError(response);
    logger.error({ status: response.status, errorText }, 'Cartesia voices list failed');
    throw new Error(`Cartesia voices failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    data?: Array<{
      id: string;
      is_owner?: boolean;
      is_public?: boolean;
      name: string;
      description?: string;
      gender?: string;
      language?: string;
      country?: string;
      preview_file_url?: string;
    }>;
  };

  return (data.data || []).map((voice) => ({
    id: voice.id,
    name: voice.name,
    description: voice.description || '',
    gender: voice.gender,
    language: voice.language,
    country: voice.country,
    isOwner: voice.is_owner === true,
    isPublic: voice.is_public !== false,
    previewUrl: voice.preview_file_url,
  }));
}

export async function generateCartesiaSpeech(
  text: string,
  voiceId?: string,
  language?: string,
): Promise<{ base64: string; format: 'mp3' }> {
  const apiKey = await getCartesiaApiKey();
  const selectedVoice = getCartesiaVoiceId(voiceId);

  const response = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Cartesia-Version': CARTESIA_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: getCartesiaModel(),
      transcript: text,
      language: getCartesiaLanguage(language),
      voice: {
        mode: 'id',
        id: selectedVoice,
      },
      output_format: {
        container: 'mp3',
        sample_rate: 44100,
        bit_rate: 128000,
      },
      generation_config: {
        speed: getCartesiaSpeed(),
      },
    }),
  });

  if (!response.ok) {
    const errorText = await readError(response);
    logger.error({ status: response.status, errorText }, 'Cartesia TTS failed');
    throw new Error(`Cartesia TTS failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return { base64: buffer.toString('base64'), format: 'mp3' };
}

export async function generateLiveSpeech(
  text: string,
): Promise<{ base64: string; format: 'mp3' | 'opus'; provider: VoiceLiveProvider }> {
  const provider = getVoiceLiveProvider();
  if (provider === 'cartesia') {
    const result = await generateCartesiaSpeech(text);
    return { ...result, provider };
  }

  const result = await generateSpeech(text);
  return { ...result, provider };
}

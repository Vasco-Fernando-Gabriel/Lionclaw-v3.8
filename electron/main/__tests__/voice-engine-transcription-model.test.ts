import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string | undefined>,
  requestedModels: [] as string[],
  requestedSpeechVoiceIds: [] as string[],
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async (key: string) => {
    if (key === 'OPENAI_API_KEY') return 'openai-key';
    if (key === 'ELEVENLABS_API_KEY') return 'elevenlabs-key';
    return null;
  }),
}));

vi.mock('../db', () => ({
  getSetting: vi.fn((key: string) => state.settings[key]),
}));

import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  generateSpeech,
  transcribeAudio,
} from '../voice-engine';

function installFetchMock() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const urlText = String(url);
    if (urlText.includes('/text-to-speech/')) {
      state.requestedSpeechVoiceIds.push(
        decodeURIComponent(urlText.match(/\/text-to-speech\/([^?]+)/)?.[1] ?? ''),
      );
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as Response;
    }

    const body = init?.body as FormData;
    state.requestedModels.push(String(body.get('model') ?? ''));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ text: 'transcricao ok' }),
    } as Response;
  });
}

describe('voice-engine transcription model selection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    state.settings = {};
    state.requestedModels = [];
    state.requestedSpeechVoiceIds = [];
    installFetchMock();
  });

  it('defaults to whisper-1', async () => {
    await transcribeAudio(Buffer.from('audio').toString('base64'));

    expect(state.requestedModels).toEqual(['whisper-1']);
  });

  it('uses the configured OpenAI transcription model', async () => {
    state.settings.voice_transcription_model = 'gpt-4o-transcribe';

    await transcribeAudio(Buffer.from('audio').toString('base64'));

    expect(state.requestedModels).toEqual(['gpt-4o-transcribe']);
  });

  it('uses explicit, configured, then fallback ElevenLabs voice IDs for TTS', async () => {
    state.settings.voice_id = 'stored-voice';

    await generateSpeech('ola', ' explicit-voice ');
    await generateSpeech('ola', ' ');

    state.settings.voice_id = '';
    await generateSpeech('ola');

    expect(state.requestedSpeechVoiceIds).toEqual([
      'explicit-voice',
      'stored-voice',
      DEFAULT_ELEVENLABS_VOICE_ID,
    ]);
  });

  it('falls back to whisper-1 for invalid stored values', async () => {
    state.settings.voice_transcription_model = 'not-a-transcriber';

    await transcribeAudio(Buffer.from('audio').toString('base64'));

    expect(state.requestedModels).toEqual(['whisper-1']);
  });

  it('falls back to OpenAI whisper-1 for a retired local model stored by an old install', async () => {
    state.settings.voice_transcription_model = 'local-whisper-large-v3-turbo';

    await transcribeAudio(Buffer.from('audio').toString('base64'));

    expect(state.requestedModels).toEqual(['whisper-1']);
  });
});

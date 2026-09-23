import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const settings = new Map<string, string>();
vi.mock('../db', () => ({
  getSetting: (key: string) => settings.get(key),
}));

const getSecretMock = vi.fn();
vi.mock('../secrets-vault', () => ({
  getSecret: (key: string) => getSecretMock(key),
}));

const anthropicCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate };
    constructor(_opts: unknown) {
      void _opts;
    }
  },
}));

import {
  describeImage,
  buildTranscriptionBlock,
  visionUnavailableNotice,
  VISION_TRANSCRIPTION_MARKER,
  VisionUnconfiguredError,
  VisionCallError,
} from '../vision-engine';

const IMAGE = { data: 'AAAA', mimeType: 'image/jpeg' };

beforeEach(() => {
  vi.clearAllMocks();
  settings.clear();
  vi.unstubAllGlobals();
});

describe('describeImage - openai', () => {
  beforeEach(() => {
    settings.set('vision_provider', 'openai');
    settings.set('vision_model', 'gpt-5.5');
    getSecretMock.mockImplementation(async (k: string) => (k === 'OPENAI_API_KEY' ? 'sk-test' : null));
  });

  it('chama chat/completions com content image_url data URL e retorna o texto', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'transcricao ocr openai' } }] }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await describeImage({ ...IMAGE, hint: 'foca no texto' });
    expect(out).toBe('transcricao ocr openai');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as unknown as Mock).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('gpt-5.5');
    const content = body.messages[0].content;
    expect(content.some((c: { type: string }) => c.type === 'image_url')).toBe(true);
    const img = content.find((c: { type: string }) => c.type === 'image_url');
    expect(img.image_url.url).toBe('data:image/jpeg;base64,AAAA');
    const txt = content.find((c: { type: string }) => c.type === 'text');
    expect(txt.text).toContain('foca no texto');
  });

  it('chave ausente -> VisionUnconfiguredError e NAO chama fetch', async () => {
    getSecretMock.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(describeImage(IMAGE)).rejects.toBeInstanceOf(VisionUnconfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it('HTTP nao-ok -> VisionCallError; nunca tenta o outro provider', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(describeImage(IMAGE)).rejects.toBeInstanceOf(VisionCallError);
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it('abort/timeout -> VisionCallError', async () => {
    settings.set('vision_timeout_ms', '5');
    const fetchMock = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(describeImage(IMAGE)).rejects.toBeInstanceOf(VisionCallError);
  });
});

describe('describeImage - anthropic', () => {
  beforeEach(() => {
    settings.set('vision_provider', 'anthropic');
    settings.set('vision_model', 'claude-opus-4-8');
    getSecretMock.mockImplementation(async (k: string) => (k === 'ANTHROPIC_API_KEY' ? 'sk-ant' : null));
  });

  it('chama messages.create com bloco image base64 e retorna o texto', async () => {
    anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'transcricao ocr anthropic' }] });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await describeImage(IMAGE);
    expect(out).toBe('transcricao ocr anthropic');
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const arg = anthropicCreate.mock.calls[0][0];
    expect(arg.model).toBe('claude-opus-4-8');
    const content = arg.messages[0].content;
    const imgBlock = content.find((c: { type: string }) => c.type === 'image');
    expect(imgBlock.source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: 'AAAA' });
  });

  it('chave ausente -> VisionUnconfiguredError e NAO chama o SDK', async () => {
    getSecretMock.mockResolvedValue(null);
    await expect(describeImage(IMAGE)).rejects.toBeInstanceOf(VisionUnconfiguredError);
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it('erro do SDK -> VisionCallError', async () => {
    anthropicCreate.mockRejectedValue(new Error('rate limit'));
    await expect(describeImage(IMAGE)).rejects.toBeInstanceOf(VisionCallError);
  });

  it('mimeType fora do dominio da API -> normaliza para image/png no bloco', async () => {
    anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    await describeImage({ data: 'BBBB', mimeType: 'image/tiff' });
    const arg = anthropicCreate.mock.calls[0][0];
    const imgBlock = arg.messages[0].content.find((c: { type: string }) => c.type === 'image');
    expect(imgBlock.source.media_type).toBe('image/png');
  });
});

describe('coerencia provider->modelo e defaults', () => {
  it('provider anthropic com modelo openai salvo -> realinha ao primeiro do provider', async () => {
    settings.set('vision_provider', 'anthropic');
    settings.set('vision_model', 'gpt-5.5');
    getSecretMock.mockResolvedValue('sk-ant');
    anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    await describeImage(IMAGE);
    const arg = anthropicCreate.mock.calls[0][0];
    expect(arg.model).toBe('claude-opus-4-8');
  });

  it('provider vazio -> default do catalogo (openai) usa fetch', async () => {
    getSecretMock.mockImplementation(async (k: string) => (k === 'OPENAI_API_KEY' ? 'sk' : null));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'default openai' } }] }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await describeImage(IMAGE);
    expect(out).toBe('default openai');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('helpers de bloco e aviso', () => {
  it('buildTranscriptionBlock injeta o marcador entre texto e transcricao', () => {
    const out = buildTranscriptionBlock('minha caption', 'texto extraido');
    expect(out).toBe(`minha caption\n\n${VISION_TRANSCRIPTION_MARKER}\ntexto extraido`);
  });

  it('buildTranscriptionBlock sem texto base -> so o bloco', () => {
    const out = buildTranscriptionBlock('', 'texto extraido');
    expect(out).toBe(`${VISION_TRANSCRIPTION_MARKER}\ntexto extraido`);
  });

  it('buildTranscriptionBlock transcricao vazia -> texto original intacto', () => {
    expect(buildTranscriptionBlock('so caption', '   ')).toBe('so caption');
  });

  it('visionUnavailableNotice tipa o motivo do erro', () => {
    expect(visionUnavailableNotice(new VisionUnconfiguredError('x'))).toContain('nao configurado');
    expect(visionUnavailableNotice(new VisionCallError('estourou'))).toContain('estourou');
    expect(visionUnavailableNotice(new VisionCallError('x'))).toContain('Seguindo so com o texto');
  });
});

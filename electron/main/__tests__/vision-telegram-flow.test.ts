
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getSettingMock: vi.fn((_key: string): string | undefined => undefined),
  describeImageMock: vi.fn(async (): Promise<string> => ''),
  sendMessageMock: vi.fn(async (_chatId: number, _text: string) => undefined),
}));

vi.mock('node-telegram-bot-api', () => ({ default: class {} }));
vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../db', () => ({
  getDb: vi.fn(() => ({ prepare: () => ({ get: () => undefined, all: () => [], run: () => undefined }) })),
  createSession: vi.fn(),
  getSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  getSetting: h.getSettingMock,
  listActiveTelegramSessions: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  setSessionCompactionState: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
}));
vi.mock('../orchestrator', () => ({
  executeTelegramLaneQuery: vi.fn(async () => undefined),
  enqueueTelegramLaneTask: vi.fn((fn: () => Promise<unknown>) => fn()),
  resetTelegramSessionState: vi.fn(),
}));
vi.mock('../memory-pipeline', () => ({ runCompaction: vi.fn() }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../channels-db', () => ({ updateChannelStatus: vi.fn() }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
}));
vi.mock('../scheduler', () => ({
  getAllScheduledTasks: vi.fn(() => []),
  getPendingReviewCount: vi.fn(() => 0),
}));
vi.mock('../voice-engine', () => ({ transcribeAudio: vi.fn() }));
vi.mock('../smoke-audit', () => ({ smokeAudit: vi.fn() }));

vi.mock('../vision-engine', async () => {
  const actual = await vi.importActual<typeof import('../vision-engine')>('../vision-engine');
  return {
    ...actual,
    describeImage: h.describeImageMock,
  };
});

import { __telegramInternal, buildTelegramCompactionSeed } from '../telegram-bridge';
import {
  VISION_TRANSCRIPTION_MARKER,
  VisionCallError,
  buildTranscriptionBlock,
} from '../vision-engine';

const ATTACHMENT = {
  id: 'tg-1-2',
  type: 'image',
  filename: 'telegram-2.jpg',
  mimeType: 'image/jpeg',
  data: 'AAAA',
  size: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getSettingMock.mockImplementation(() => undefined);
  __telegramInternal.setBotForTests({ sendMessage: h.sendMessageMock });
});

describe('transcribeAndResolveImageTurn (Telegram)', () => {
  it('runtime com visao nativa (claude-sdk): texto ganha o bloco E o anexo nativo segue', async () => {
    h.getSettingMock.mockImplementation((k: string) => (k === 'orchestrator_runtime' ? 'claude-sdk' : undefined));
    h.describeImageMock.mockResolvedValue('texto extraido da imagem');

    const out = await __telegramInternal.transcribeAndResolveImageTurn(1, 'minha caption', ATTACHMENT);

    expect(out.text).toContain('minha caption');
    expect(out.text).toContain(VISION_TRANSCRIPTION_MARKER);
    expect(out.text).toContain('texto extraido da imagem');
    expect(out.attachment).toEqual(ATTACHMENT);
    expect(h.sendMessageMock).not.toHaveBeenCalled();
  });

  it('runtime SEM visao nativa (codex): texto ganha o bloco, anexo nativo NAO segue', async () => {
    h.getSettingMock.mockImplementation((k: string) => (k === 'orchestrator_runtime' ? 'codex-sdk' : undefined));
    h.describeImageMock.mockResolvedValue('texto ocr');

    const out = await __telegramInternal.transcribeAndResolveImageTurn(1, 'cap', ATTACHMENT);

    expect(out.text).toContain(VISION_TRANSCRIPTION_MARKER);
    expect(out.text).toContain('texto ocr');
    expect(out.attachment).toBeUndefined();
  });

  it('falha do vision (P5): aviso no canal + texto original intacto, sem bloco', async () => {
    h.getSettingMock.mockImplementation((k: string) => (k === 'orchestrator_runtime' ? 'codex-sdk' : undefined));
    h.describeImageMock.mockRejectedValue(new VisionCallError('provider caiu'));

    const out = await __telegramInternal.transcribeAndResolveImageTurn(1, 'so a caption', ATTACHMENT);

    expect(out.text).toBe('so a caption');
    expect(out.text).not.toContain(VISION_TRANSCRIPTION_MARKER);
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
    const [, notice] = h.sendMessageMock.mock.calls[0];
    expect(notice).toContain('Vision indisponivel');
    expect(out.attachment).toBeUndefined();
  });

  it('transcricao vazia: nao injeta bloco vazio, segue caption original', async () => {
    h.getSettingMock.mockImplementation((k: string) => (k === 'orchestrator_runtime' ? 'claude-sdk' : undefined));
    h.describeImageMock.mockResolvedValue('   ');

    const out = await __telegramInternal.transcribeAndResolveImageTurn(1, 'cap sozinha', ATTACHMENT);
    expect(out.text).toBe('cap sozinha');
    expect(out.text).not.toContain(VISION_TRANSCRIPTION_MARKER);
    expect(out.attachment).toEqual(ATTACHMENT);
  });
});

describe('AC-V7: transcricao persistida sobrevive a compactacao (preamble)', () => {
  it('a mensagem de usuario com o bloco aparece no seed do buildTelegramCompactionSeed', () => {
    const persisted = buildTranscriptionBlock('minha caption', 'texto extraido por OCR');
    const seed = buildTelegramCompactionSeed(
      'resumo anterior',
      [{ id: 1, session_id: 's', role: 'user', content: persisted, created_at: '' } as never],
      100_000,
    );
    expect(seed).toContain(VISION_TRANSCRIPTION_MARKER);
    expect(seed).toContain('texto extraido por OCR');
  });
});

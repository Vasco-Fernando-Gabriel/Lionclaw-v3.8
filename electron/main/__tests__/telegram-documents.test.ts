
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as XLSX from 'xlsx';

const h = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSessionMessagesMock: vi.fn((): unknown[] => []),
  getSettingMock: vi.fn((_key: string): string | undefined => undefined),
  setSessionCompactionStateMock: vi.fn(),
  setSessionActiveContextTokensMock: vi.fn(),
  updateSessionStatusMock: vi.fn(),
  createSessionMock: vi.fn(),
  listActiveTelegramSessionsMock: vi.fn((): Array<{ id: string }> => []),
  prepareImpl: vi.fn((_sql: string): Record<string, unknown> => ({
    get: () => undefined,
    all: () => [],
    run: () => undefined,
  })),
  runCompactionMock: vi.fn(),
  executeTelegramLaneQueryMock: vi.fn(
    async (_message: string, ..._args: unknown[]) => undefined,
  ),
  enqueueTelegramLaneTaskMock: vi.fn((fn: () => Promise<unknown>) => fn()),
  resetTelegramSessionStateMock: vi.fn(),
  parseFileMock: vi.fn(async (_filePath: string, _fileType: string): Promise<{ text: string }> => ({ text: '' })),
}));

vi.mock('node-telegram-bot-api', () => ({ default: class {} }));
vi.mock('electron', () => ({ BrowserWindow: class {} }));

vi.mock('../db', () => ({
  getDb: vi.fn(() => ({ prepare: (sql: string) => h.prepareImpl(sql) })),
  createSession: h.createSessionMock,
  getSession: h.getSessionMock,
  updateSessionStatus: h.updateSessionStatusMock,
  getSetting: h.getSettingMock,
  listActiveTelegramSessions: h.listActiveTelegramSessionsMock,
  getSessionMessages: h.getSessionMessagesMock,
  setSessionCompactionState: h.setSessionCompactionStateMock,
  setSessionActiveContextTokens: h.setSessionActiveContextTokensMock,
}));

vi.mock('../orchestrator', () => ({
  executeTelegramLaneQuery: h.executeTelegramLaneQueryMock,
  enqueueTelegramLaneTask: h.enqueueTelegramLaneTaskMock,
  resetTelegramSessionState: h.resetTelegramSessionStateMock,
}));

vi.mock('../memory-pipeline', () => ({ runCompaction: h.runCompactionMock }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../channels-db', () => ({ updateChannelStatus: vi.fn() }));
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));
vi.mock('../scheduler', () => ({
  getAllScheduledTasks: vi.fn(() => []),
  getPendingReviewCount: vi.fn(() => 0),
}));
vi.mock('../voice-engine', () => ({ transcribeAudio: vi.fn() }));
vi.mock('../knowledge-engine', () => ({ parseFile: h.parseFileMock }));

import {
  detectTelegramDocumentType,
  extractTelegramDocumentText,
  buildTelegramDocumentPrompt,
  formatBytes,
  sendTelegramDocument,
  sendTelegramPhoto,
  TELEGRAM_MAX_DOWNLOAD_BYTES,
  TELEGRAM_MAX_UPLOAD_BYTES,
  TELEGRAM_MAX_PHOTO_BYTES,
  TELEGRAM_DOC_TEXT_MAX_CHARS,
  __telegramInternal,
} from '../telegram-bridge';


interface FakeBot {
  sendMessage: ReturnType<typeof vi.fn>;
  sendChatAction: ReturnType<typeof vi.fn>;
  sendDocument: ReturnType<typeof vi.fn>;
  sendPhoto: ReturnType<typeof vi.fn>;
  sendVoice: ReturnType<typeof vi.fn>;
  getFileLink: ReturnType<typeof vi.fn>;
}

function makeFakeBot(): FakeBot {
  return {
    sendMessage: vi.fn(async () => undefined),
    sendChatAction: vi.fn(async () => undefined),
    sendDocument: vi.fn(async () => undefined),
    sendPhoto: vi.fn(async () => undefined),
    sendVoice: vi.fn(async () => undefined),
    getFileLink: vi.fn(async () => 'https://fake.telegram/file'),
  };
}

function makeDocMessage(overrides: {
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  caption?: string;
} = {}): Record<string, unknown> {
  return {
    message_id: 7,
    chat: { id: 42 },
    caption: overrides.caption,
    document: {
      file_id: 'file-1',
      file_name: overrides.fileName ?? 'notas.txt',
      mime_type: overrides.mimeType ?? 'text/plain',
      file_size: overrides.fileSize,
    },
  };
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-tgdoc-test-'));
  tempDirs.push(dir);
  return dir;
}

let fakeBot: FakeBot;

beforeEach(() => {
  vi.clearAllMocks();
  h.getSettingMock.mockReturnValue(undefined);
  h.getSessionMessagesMock.mockReturnValue([]);
  h.listActiveTelegramSessionsMock.mockReturnValue([]);
  h.parseFileMock.mockResolvedValue({ text: '' });
  h.prepareImpl.mockImplementation((_sql: string) => ({
    get: () => undefined,
    all: () => [],
    run: () => undefined,
  }));
  fakeBot = makeFakeBot();
  __telegramInternal.setBotForTests(fakeBot);
  __telegramInternal.setActiveSessionIdForTests('tg-session');
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  __telegramInternal.setBotForTests(null);
  __telegramInternal.setActiveSessionIdForTests(null);
});


describe('limites e formatBytes (SPEC 8.4)', () => {
  it('constantes centrais: 20MB download, 50MB upload, 10MB foto', () => {
    expect(TELEGRAM_MAX_DOWNLOAD_BYTES).toBe(20 * 1024 * 1024);
    expect(TELEGRAM_MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect(TELEGRAM_MAX_PHOTO_BYTES).toBe(10 * 1024 * 1024);
  });

  it('formatBytes em PT-BR legivel', () => {
    expect(formatBytes(500)).toBe('500 bytes');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(formatBytes(25.5 * 1024 * 1024)).toBe('25,5 MB');
  });
});


describe('detectTelegramDocumentType (SPEC 8.1)', () => {
  it('detecta cada tipo suportado por extensao', () => {
    expect(detectTelegramDocumentType('a.pdf')).toBe('pdf');
    expect(detectTelegramDocumentType('a.docx')).toBe('docx');
    expect(detectTelegramDocumentType('a.xlsx')).toBe('xlsx');
    expect(detectTelegramDocumentType('a.xls')).toBe('xlsx');
    expect(detectTelegramDocumentType('a.csv')).toBe('csv');
    expect(detectTelegramDocumentType('a.txt')).toBe('txt');
    expect(detectTelegramDocumentType('a.md')).toBe('md');
  });

  it('detecta por mime quando a extensao nao ajuda', () => {
    expect(detectTelegramDocumentType('sem-ext', 'application/pdf')).toBe('pdf');
    expect(detectTelegramDocumentType('sem-ext', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx');
    expect(detectTelegramDocumentType('sem-ext', 'text/csv')).toBe('csv');
    expect(detectTelegramDocumentType('sem-ext', 'text/plain')).toBe('txt');
  });

  it('XLSX NUNCA vira csv, mesmo com mime text/csv enganoso', () => {
    expect(detectTelegramDocumentType('dados.xlsx', 'text/csv')).toBe('xlsx');
  });

  it('tipo nao suportado retorna null', () => {
    expect(detectTelegramDocumentType('video.mp4', 'video/mp4')).toBeNull();
    expect(detectTelegramDocumentType('pacote.zip', 'application/zip')).toBeNull();
    expect(detectTelegramDocumentType('musica.mp3', 'audio/mpeg')).toBeNull();
  });
});


describe('extractTelegramDocumentText', () => {
  it('XLSX: cada aba vira texto tabular com cabecalho proprio; parser de CSV nao e chamado', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['produto', 'total'], ['abacate', 10]]), 'Vendas');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['item', 'gasto'], ['luz', 200]]), 'Custos');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const text = await extractTelegramDocumentText(buffer, 'xlsx', 'planilha.xlsx');

    expect(text).toContain('=== Aba: Vendas ===');
    expect(text).toContain('=== Aba: Custos ===');
    expect(text).toContain('produto,total');
    expect(text).toContain('abacate,10');
    expect(text).toContain('luz,200');
    expect(h.parseFileMock).not.toHaveBeenCalled();
  });

  it('tipos parseFile: temp efemero de nome unico, apagado no SUCESSO', async () => {
    let seenTempPath = '';
    h.parseFileMock.mockImplementation(async (filePath: string, fileType: string) => {
      seenTempPath = filePath;
      expect(fileType).toBe('txt');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('conteudo do arquivo');
      return { text: 'conteudo do arquivo' };
    });

    const text = await extractTelegramDocumentText(Buffer.from('conteudo do arquivo'), 'txt', 'notas.txt');

    expect(text).toBe('conteudo do arquivo');
    expect(seenTempPath).toContain('lionclaw-tgdoc-');
    expect(seenTempPath.endsWith('.txt')).toBe(true);
    expect(fs.existsSync(seenTempPath)).toBe(false);
  });

  it('temp apagado tambem no ERRO de parse (finally em todos os caminhos)', async () => {
    let seenTempPath = '';
    h.parseFileMock.mockImplementation(async (filePath: string) => {
      seenTempPath = filePath;
      throw new Error('pdf corrompido');
    });

    await expect(
      extractTelegramDocumentText(Buffer.from('lixo'), 'pdf', 'quebrado.pdf'),
    ).rejects.toThrow('pdf corrompido');
    expect(seenTempPath).not.toBe('');
    expect(fs.existsSync(seenTempPath)).toBe(false);
  });

  it('nomes de temp sao unicos entre chamadas', async () => {
    const seen: string[] = [];
    h.parseFileMock.mockImplementation(async (filePath: string) => {
      seen.push(filePath);
      return { text: 'x' };
    });
    await extractTelegramDocumentText(Buffer.from('a'), 'md', 'a.md');
    await extractTelegramDocumentText(Buffer.from('b'), 'md', 'a.md');
    expect(seen[0]).not.toBe(seen[1]);
  });
});


describe('buildTelegramDocumentPrompt', () => {
  it('monta [Documento recebido] + caption como instrucao + conteudo', () => {
    const prompt = buildTelegramDocumentPrompt('relatorio.pdf', 'pdf', 1024 * 1024, 'resuma isto', 'corpo do doc');
    expect(prompt).toContain('[Documento recebido: relatorio.pdf (PDF, 1 MB)]');
    expect(prompt).toContain('resuma isto');
    expect(prompt).toContain('=== CONTEUDO ===\ncorpo do doc');
  });

  it('sem caption usa a instrucao default', () => {
    const prompt = buildTelegramDocumentPrompt('a.txt', 'txt', 10, undefined, 'oi');
    expect(prompt).toContain('O usuario enviou este documento; analise e responda.');
  });

  it('truncagem de seguranca ~200KB com nota explicita', () => {
    const giant = 'x'.repeat(TELEGRAM_DOC_TEXT_MAX_CHARS + 5000);
    const prompt = buildTelegramDocumentPrompt('grande.txt', 'txt', 300_000, undefined, giant);
    expect(prompt).toContain('[documento truncado para caber no contexto]');
    expect(prompt.length).toBeLessThan(TELEGRAM_DOC_TEXT_MAX_CHARS + 500);
  });

  it('texto que cabe entra integral, sem nota de truncagem', () => {
    const prompt = buildTelegramDocumentPrompt('ok.txt', 'txt', 10, undefined, 'inteiro');
    expect(prompt).not.toContain('[documento truncado');
    expect(prompt).toContain('inteiro');
  });
});


describe('handleIncomingDocument — limites (AC-28)', () => {
  it('file_size acima de 20MB: NAO baixa e avisa com limite e tamanho reais', async () => {
    const msg = makeDocMessage({ fileName: 'grande.pdf', mimeType: 'application/pdf', fileSize: 25 * 1024 * 1024 });

    await __telegramInternal.handleIncomingDocument(msg as never, 42, 'Breno');

    expect(fakeBot.getFileLink).not.toHaveBeenCalled();
    expect(fakeBot.sendMessage).toHaveBeenCalledWith(
      42,
      'Arquivo grande demais para eu baixar pelo Telegram. O maximo e 20 MB; este tem 25 MB.',
    );
    expect(h.executeTelegramLaneQueryMock).not.toHaveBeenCalled();
  });

  it('file_size undefined + falha no download: mesma mensagem de limite', async () => {
    fakeBot.getFileLink.mockRejectedValue(new Error('file is too big'));
    const msg = makeDocMessage({ fileName: 'misterio.pdf', mimeType: 'application/pdf', fileSize: undefined });

    await __telegramInternal.handleIncomingDocument(msg as never, 42, 'Breno');

    expect(fakeBot.sendMessage).toHaveBeenCalledWith(
      42,
      'Arquivo grande demais para eu baixar pelo Telegram. O maximo e 20 MB; este tem tamanho desconhecido.',
    );
    expect(h.executeTelegramLaneQueryMock).not.toHaveBeenCalled();
  });

  it('file_size undefined + download passou mas acima do limite: avisa com tamanho real', async () => {
    const big = new ArrayBuffer(TELEGRAM_MAX_DOWNLOAD_BYTES + 1024);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => big })));
    const msg = makeDocMessage({ fileName: 'surpresa.txt', mimeType: 'text/plain', fileSize: undefined });

    await __telegramInternal.handleIncomingDocument(msg as never, 42, 'Breno');

    const sent = fakeBot.sendMessage.mock.calls[0][1] as string;
    expect(sent).toContain('Arquivo grande demais para eu baixar pelo Telegram. O maximo e 20 MB; este tem');
    expect(h.executeTelegramLaneQueryMock).not.toHaveBeenCalled();
  });

  it('file_size definido + falha no download: erro claro (nao mensagem de limite)', async () => {
    fakeBot.getFileLink.mockRejectedValue(new Error('rede caiu'));
    const msg = makeDocMessage({ fileSize: 1024 });

    await __telegramInternal.handleIncomingDocument(msg as never, 42, 'Breno');

    expect(fakeBot.sendMessage).toHaveBeenCalledWith(42, 'Erro ao baixar o documento. Tente novamente.');
  });

  it('tipo nao suportado: resposta clara SEM download', async () => {
    const msg = makeDocMessage({ fileName: 'pacote.zip', mimeType: 'application/zip', fileSize: 1024 });

    await __telegramInternal.handleIncomingDocument(msg as never, 42, 'Breno');

    expect(fakeBot.getFileLink).not.toHaveBeenCalled();
    const sent = fakeBot.sendMessage.mock.calls[0][1] as string;
    expect(sent).toContain('pacote.zip');
    expect(sent).toContain('ainda nao processo esse tipo');
    expect(sent).toContain('Posso trabalhar com PDF, DOCX, planilha (XLSX), CSV, TXT, MD, imagens e audio de voz.');
  });

  it('caminho feliz TXT: baixa, parseia e o prompt do turno leva o conteudo (AC-26)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('linha um do doc').buffer,
    })));
    h.parseFileMock.mockResolvedValue({ text: 'linha um do doc' });
    h.prepareImpl.mockImplementation((sql: string) => ({
      get: () => (sql.includes('content, metadata')
        ? { id: 9, content: 'analise pronta', metadata: undefined }
        : undefined),
      all: () => [],
      run: () => undefined,
    }));
    const msg = makeDocMessage({ fileName: 'notas.txt', mimeType: 'text/plain', fileSize: 1024, caption: 'resuma isto' });

    await __telegramInternal.handleIncomingDocument(msg as never, 42, 'Breno');

    expect(h.executeTelegramLaneQueryMock).toHaveBeenCalledTimes(1);
    const contextual = h.executeTelegramLaneQueryMock.mock.calls[0][0] as string;
    expect(contextual).toContain('[Documento recebido: notas.txt (TXT, 15 bytes)]');
    expect(contextual).toContain('resuma isto');
    expect(contextual).toContain('=== CONTEUDO ===\nlinha um do doc');
    expect(fakeBot.sendMessage).toHaveBeenCalledWith(42, 'analise pronta', expect.anything());
  });

  it('falha de parse: temp nao vaza e o usuario recebe erro claro', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('lixo binario').buffer,
    })));
    let seenTempPath = '';
    h.parseFileMock.mockImplementation(async (filePath: string) => {
      seenTempPath = filePath;
      throw new Error('docx corrompido');
    });
    const msg = makeDocMessage({ fileName: 'quebrado.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileSize: 512 });

    await __telegramInternal.handleIncomingDocument(msg as never, 42, 'Breno');

    expect(fs.existsSync(seenTempPath)).toBe(false);
    const sent = fakeBot.sendMessage.mock.calls[0][1] as string;
    expect(sent).toContain('Nao consegui ler o conteudo de quebrado.docx');
    expect(h.executeTelegramLaneQueryMock).not.toHaveBeenCalled();
  });
});


describe('saida de arquivo (SPEC 8.3 / 8.4)', () => {
  it('sendTelegramDocument envia buffer com filename/contentType e caption <= 1024', async () => {
    const caption = 'c'.repeat(2000);
    await sendTelegramDocument(42, Buffer.from('dados'), 'saida.pdf', 'application/pdf', caption);

    expect(fakeBot.sendDocument).toHaveBeenCalledTimes(1);
    const [chatId, buf, options, fileOptions] = fakeBot.sendDocument.mock.calls[0];
    expect(chatId).toBe(42);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect((options as { caption: string }).caption).toHaveLength(1024);
    expect(fileOptions).toEqual({ filename: 'saida.pdf', contentType: 'application/pdf' });
  });

  it('arquivo gerado acima de 50MB NAO e enviado; aviso com nome e tamanho (AC-28)', async () => {
    const dir = makeTempDir();
    const bigPath = path.join(dir, 'relatorio.zip');
    fs.writeFileSync(bigPath, 'x');
    fs.truncateSync(bigPath, TELEGRAM_MAX_UPLOAD_BYTES + 1024 * 1024); // sparse

    await __telegramInternal.sendDocumentPathViaTelegram(42, bigPath);

    expect(fakeBot.sendDocument).not.toHaveBeenCalled();
    expect(fakeBot.sendMessage).toHaveBeenCalledWith(
      42,
      'Gerei o arquivo relatorio.zip (51 MB), mas passou do limite de 50 MB do Telegram.',
    );
  });

  it('arquivo dentro do limite vai via sendDocument', async () => {
    const dir = makeTempDir();
    const okPath = path.join(dir, 'dados.csv');
    fs.writeFileSync(okPath, 'a,b\n1,2\n');

    await __telegramInternal.sendDocumentPathViaTelegram(42, okPath);

    expect(fakeBot.sendDocument).toHaveBeenCalledTimes(1);
    const [, , , fileOptions] = fakeBot.sendDocument.mock.calls[0];
    expect((fileOptions as { filename: string }).filename).toBe('dados.csv');
  });

  it('foto de saida acima de 10MB: avisa em vez de enviar (AC-28)', async () => {
    const big = Buffer.alloc(TELEGRAM_MAX_PHOTO_BYTES + 1024).toString('base64');
    await sendTelegramPhoto(42, big, 'image/png', 'grande');

    expect(fakeBot.sendPhoto).not.toHaveBeenCalled();
    const sent = fakeBot.sendMessage.mock.calls[0][1] as string;
    expect(sent).toContain('passou do limite de 10 MB para fotos no Telegram');
  });

  it('executeTelegramQuery: ENVIAR_ARQUIVO no texto envia o doc e o usuario NUNCA ve o caminho (AC-29)', async () => {
    const dir = makeTempDir();
    const docPath = path.join(dir, 'resultado.pdf');
    fs.writeFileSync(docPath, 'pdf fake');
    h.prepareImpl.mockImplementation((sql: string) => ({
      get: () => (sql.includes('content, metadata')
        ? { id: 9, content: `Segue o relatorio!\nENVIAR_ARQUIVO: ${docPath}\nQualquer duvida avisa.`, metadata: undefined }
        : undefined),
      all: () => [],
      run: () => undefined,
    }));

    const response = await __telegramInternal.executeTelegramQueryForTests('gera o pdf', 'tg-session', 42, 'Breno');

    expect(fakeBot.sendDocument).toHaveBeenCalledTimes(1);
    expect(response).toContain('Segue o relatorio!');
    expect(response).toContain('Qualquer duvida avisa.');
    expect(response).not.toContain('ENVIAR_ARQUIVO');
    expect(response).not.toContain(docPath);
  });

  it('artifact document + MESMO caminho no fallback textual: envia UMA vez so', async () => {
    const dir = makeTempDir();
    const docPath = path.join(dir, 'unico.csv');
    fs.writeFileSync(docPath, 'a;b');
    const metadata = JSON.stringify({
      artifacts: [{
        type: 'document',
        data: { filePath: docPath, fileName: 'unico.csv', size: 3, mimeType: 'text/csv' },
      }],
    });
    h.prepareImpl.mockImplementation((sql: string) => ({
      get: () => (sql.includes('content, metadata')
        ? { id: 9, content: `Pronto.\nENVIAR_ARQUIVO: ${docPath}`, metadata }
        : undefined),
      all: () => [],
      run: () => undefined,
    }));

    await __telegramInternal.executeTelegramQueryForTests('gera', 'tg-session', 42, 'Breno');

    expect(fakeBot.sendDocument).toHaveBeenCalledTimes(1);
  });

  it('resposta que era SO o marcador vira "Arquivo enviado." (nada de path)', async () => {
    const dir = makeTempDir();
    const docPath = path.join(dir, 'so-arquivo.txt');
    fs.writeFileSync(docPath, 'x');
    h.prepareImpl.mockImplementation((sql: string) => ({
      get: () => (sql.includes('content, metadata')
        ? { id: 9, content: `ENVIAR_ARQUIVO: ${docPath}`, metadata: undefined }
        : undefined),
      all: () => [],
      run: () => undefined,
    }));

    const response = await __telegramInternal.executeTelegramQueryForTests('gera', 'tg-session', 42, 'Breno');

    expect(fakeBot.sendDocument).toHaveBeenCalledTimes(1);
    expect(response).toBe('Arquivo enviado.');
  });
});


describe('anexos nao processaveis (AC-27)', () => {
  it('cada tipo recebe resposta clara e especifica', async () => {
    const cases: Array<[string, string]> = [
      ['video', 'Recebi um video, mas ainda nao processo video.'],
      ['sticker', 'Recebi um sticker, mas ainda nao processo sticker.'],
      ['video_note', 'Recebi uma videomensagem, mas ainda nao processo video.'],
      ['animation', 'Recebi um GIF/animacao, mas ainda nao processo animacao.'],
      ['audio', 'Recebi um arquivo de audio (musica), mas ainda nao processo musica.'],
    ];
    for (const [kind, expected] of cases) {
      fakeBot.sendMessage.mockClear();
      await __telegramInternal.replyUnprocessableAttachment(42, kind);
      const sent = fakeBot.sendMessage.mock.calls[0][1] as string;
      expect(sent).toContain(expected);
      expect(sent).toContain('Posso trabalhar com PDF, DOCX, planilha (XLSX), CSV, TXT, MD, imagens e audio de voz.');
    }
  });

  it('tipo desconhecido cai em resposta generica de anexo (nunca silencio)', async () => {
    await __telegramInternal.replyUnprocessableAttachment(42, 'dice');
    const sent = fakeBot.sendMessage.mock.calls[0][1] as string;
    expect(sent).toContain('Recebi um anexo que ainda nao processo.');
  });
});


describe('audio de saida via base64 (AC-31)', () => {
  it('logout durante o agente descarta todos os efeitos e artefatos do turno antigo', async () => {
    let releaseQuery: () => void = () => {
      throw new Error('query ainda nao iniciou');
    };
    h.executeTelegramLaneQueryMock.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => {
        releaseQuery = () => resolve(undefined);
      }),
    );
    const metadata = JSON.stringify({
      artifacts: [{
        type: 'audio',
        data: { audioBase64: Buffer.from('audio antigo').toString('base64') },
      }],
    });
    h.prepareImpl.mockImplementation((sql: string) => ({
      get: () => (sql.includes('content, metadata')
        ? { id: 9, content: 'resposta antiga', metadata }
        : undefined),
      all: () => [],
      run: () => undefined,
    }));
    let active = true;

    const response = __telegramInternal.executeTelegramQueryForTests(
      'fala',
      'tg-session',
      42,
      'Breno',
      undefined,
      fakeBot as never,
      () => active,
    );
    await vi.waitFor(() => expect(h.executeTelegramLaneQueryMock).toHaveBeenCalledTimes(1));
    active = false;
    releaseQuery();

    await expect(response).resolves.toBe('');
    expect(fakeBot.sendVoice).not.toHaveBeenCalled();
    expect(fakeBot.sendMessage).not.toHaveBeenCalled();
    expect(fakeBot.sendDocument).not.toHaveBeenCalled();
    expect(fakeBot.sendPhoto).not.toHaveBeenCalled();
  });

  it('audioBase64 presente: envia da memoria SEM reler disco', async () => {
    const audioBase64 = Buffer.from('audio fake').toString('base64');
    const metadata = JSON.stringify({
      artifacts: [{
        type: 'audio',
        data: { audioBase64, mimeType: 'audio/mpeg', filePath: '/caminho/que/nao/existe.mp3' },
      }],
    });
    h.prepareImpl.mockImplementation((sql: string) => ({
      get: () => (sql.includes('content, metadata')
        ? { id: 9, content: 'segue o audio', metadata }
        : undefined),
      all: () => [],
      run: () => undefined,
    }));
    const readSpy = vi.spyOn(fs, 'readFileSync');

    await __telegramInternal.executeTelegramQueryForTests('fala', 'tg-session', 42, 'Breno');

    expect(fakeBot.sendVoice).toHaveBeenCalledTimes(1);
    const [, buf] = fakeBot.sendVoice.mock.calls[0];
    expect(Buffer.compare(buf as Buffer, Buffer.from('audio fake'))).toBe(0);
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it('sem base64: fallback releitura do filePath', async () => {
    const dir = makeTempDir();
    const audioPath = path.join(dir, 'voz.mp3');
    fs.writeFileSync(audioPath, 'bytes de audio');
    const metadata = JSON.stringify({
      artifacts: [{ type: 'audio', data: { filePath: audioPath } }],
    });
    h.prepareImpl.mockImplementation((sql: string) => ({
      get: () => (sql.includes('content, metadata')
        ? { id: 9, content: 'segue o audio', metadata }
        : undefined),
      all: () => [],
      run: () => undefined,
    }));

    await __telegramInternal.executeTelegramQueryForTests('fala', 'tg-session', 42, 'Breno');

    expect(fakeBot.sendVoice).toHaveBeenCalledTimes(1);
    const [, buf] = fakeBot.sendVoice.mock.calls[0];
    expect(Buffer.compare(buf as Buffer, Buffer.from('bytes de audio'))).toBe(0);
  });
});

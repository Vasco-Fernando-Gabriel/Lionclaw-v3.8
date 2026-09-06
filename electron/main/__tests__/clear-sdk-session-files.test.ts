
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';


const h = vi.hoisted(() => ({
  tmpHome: '',
  listActiveTelegramSessionsMock: vi.fn((): Array<{ id: string; sdkSessionId?: string }> => []),
}));


vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => h.tmpHome };
  return { ...mocked, default: mocked };
});

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

vi.mock('../paths', () => ({
  getLionClawHome: () => '/lionclaw-home',
}));

vi.mock('../db', () => ({
  getActiveChatSession: vi.fn(() => null),
  getSessionMessages: vi.fn(() => []),
  updateSessionStatus: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(() => undefined),
  purgeActivityLog: vi.fn(),
  listActiveTelegramSessions: () => h.listActiveTelegramSessionsMock(),
}));

vi.mock('../memory-pipeline', () => ({
  runCompaction: vi.fn(async () => undefined),
  resolveCompactionSelection: vi.fn(async () => ({ kind: 'claude' })),
}));

vi.mock('../memory-pipeline/oneshot-subscription', () => ({
  humanizeModelLabel: (s: string) => s,
}));

vi.mock('../orchestrator', () => ({ resetSdkSessionState: vi.fn() }));
vi.mock('../telegram-bridge', () => ({ onTelegramSessionCompacted: vi.fn() }));


import {
  clearSDKSessionFiles,
  getTelegramActiveThreadIds,
} from '../ipc/_shared/chat-compaction';


const SANITIZED_LIONCLAW_HOME = '-lionclaw-home';

function projectDir(): string {
  return path.join(h.tmpHome, '.claude', 'projects', SANITIZED_LIONCLAW_HOME);
}

function seedJsonlFiles(names: string[]): void {
  fs.mkdirSync(projectDir(), { recursive: true });
  for (const name of names) {
    fs.writeFileSync(path.join(projectDir(), name), '{}\n');
  }
}

function remainingFiles(): string[] {
  return fs.existsSync(projectDir()) ? fs.readdirSync(projectDir()).sort() : [];
}

beforeEach(() => {
  h.tmpHome = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'lionclaw-clear-sdk-test-'));
  h.listActiveTelegramSessionsMock.mockReset();
  h.listActiveTelegramSessionsMock.mockReturnValue([]);
});

afterEach(() => {
  fs.rmSync(h.tmpHome, { recursive: true, force: true });
});


describe('clearSDKSessionFiles - filtro de exclusao (SPEC 14-obs / AC-23)', () => {
  it('preserva o .jsonl do thread ativo do Telegram e apaga os demais', () => {
    seedJsonlFiles(['telegram-thread.jsonl', 'desktop-sess.jsonl', 'outra.jsonl']);
    fs.writeFileSync(path.join(projectDir(), 'nao-jsonl.txt'), 'x');

    clearSDKSessionFiles(['telegram-thread']);

    expect(remainingFiles()).toEqual(['nao-jsonl.txt', 'telegram-thread.jsonl']);
  });

  it('preserva MULTIPLOS threads (estado legado com varias sessoes telegram active)', () => {
    seedJsonlFiles(['thr-1.jsonl', 's2.jsonl', 'desktop.jsonl']);

    clearSDKSessionFiles(['thr-1', 's2']);

    expect(remainingFiles()).toEqual(['s2.jsonl', 'thr-1.jsonl']);
  });

  it('factory-reset (chamada SEM filtro) continua varrendo TODOS os .jsonl', () => {
    seedJsonlFiles(['telegram-thread.jsonl', 'desktop-sess.jsonl']);

    clearSDKSessionFiles();

    expect(remainingFiles()).toEqual([]);
  });

  it('lista vazia de preserve equivale ao comportamento legado (apaga tudo)', () => {
    seedJsonlFiles(['a.jsonl', 'b.jsonl']);

    clearSDKSessionFiles([]);

    expect(remainingFiles()).toEqual([]);
  });

  it('diretorio de projects ausente e no-op (nao lanca)', () => {
    expect(() => clearSDKSessionFiles(['qualquer'])).not.toThrow();
  });
});


describe('getTelegramActiveThreadIds (resolver sdk_session_id ?? sessionId)', () => {
  it('resolve sdkSessionId quando presente e cai no id da sessao quando NULL', () => {
    h.listActiveTelegramSessionsMock.mockReturnValue([
      { id: 's1', sdkSessionId: 'thr-1' },
      { id: 's2' },
    ]);

    expect(getTelegramActiveThreadIds()).toEqual(['thr-1', 's2']);
  });

  it('falha do DB degrada para lista vazia (best-effort, nunca lanca)', () => {
    h.listActiveTelegramSessionsMock.mockImplementation(() => {
      throw new Error('db off');
    });

    expect(getTelegramActiveThreadIds()).toEqual([]);
  });

  it('integracao: clearSDKSessionFiles(getTelegramActiveThreadIds()) preserva os threads do Telegram', () => {
    h.listActiveTelegramSessionsMock.mockReturnValue([
      { id: 's-tele', sdkSessionId: 'thr-uuid' },
    ]);
    seedJsonlFiles(['thr-uuid.jsonl', 's-desktop.jsonl']);

    clearSDKSessionFiles(getTelegramActiveThreadIds());

    expect(remainingFiles()).toEqual(['thr-uuid.jsonl']);
  });
});

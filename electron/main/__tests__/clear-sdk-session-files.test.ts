import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const h = vi.hoisted(() => ({
  tmpHome: '',
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
}));

vi.mock('../memory-pipeline', () => ({
  runCompaction: vi.fn(async () => undefined),
  resolveCompactionSelection: vi.fn(async () => ({ kind: 'claude' })),
}));

vi.mock('../memory-pipeline/oneshot-subscription', () => ({
  humanizeModelLabel: (s: string) => s,
}));

vi.mock('../orchestrator', () => ({ resetSdkSessionState: vi.fn() }));

import { clearSDKSessionFiles } from '../ipc/_shared/chat-compaction';

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

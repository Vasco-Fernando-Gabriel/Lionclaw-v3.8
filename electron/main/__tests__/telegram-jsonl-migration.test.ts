import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('../db', () => ({
  threadIdOf: (s: { id: string; sdkSessionId?: string | null }) => s.sdkSessionId ?? s.id,
  getSessionOrchestrator: () => null,
  listActiveTelegramSessions: vi.fn(() => []),
}));

import { migrateTelegramJsonlOnBoot, sanitizeClaudeProjectDir } from '../telegram-jsonl-migration';

const OLD_CWD = '/Users/teste/.lionclaw/background';
const NEW_CWD = '/Users/teste/.lionclaw';

let projectsRoot: string;
let oldDir: string;
let newDir: string;

beforeEach(() => {
  projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-jsonl-mig-'));
  oldDir = path.join(projectsRoot, sanitizeClaudeProjectDir(OLD_CWD));
  newDir = path.join(projectsRoot, sanitizeClaudeProjectDir(NEW_CWD));
  fs.mkdirSync(oldDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(projectsRoot, { recursive: true, force: true });
});

function runMigration(sessions: Array<{ id: string; sdkSessionId?: string }>) {
  return migrateTelegramJsonlOnBoot({
    projectsRoot,
    oldCwd: OLD_CWD,
    newCwd: NEW_CWD,
    sessions,
  });
}

describe('sanitizeClaudeProjectDir', () => {
  it('troca todo caractere nao-alfanumerico por "-" (padrao do Agent SDK)', () => {
    expect(sanitizeClaudeProjectDir('/Users/x/.lionclaw/background')).toBe('-Users-x--lionclaw-background');
    expect(sanitizeClaudeProjectDir('/Users/x/.lionclaw')).toBe('-Users-x--lionclaw');
  });
});

describe('migrateTelegramJsonlOnBoot (SPEC 10)', () => {
  it('move o jsonl da sessao ativa quando origem existe e destino nao', () => {
    fs.writeFileSync(path.join(oldDir, 'thread-a.jsonl'), 'CONTEUDO-A', 'utf-8');

    const result = runMigration([{ id: 's1', sdkSessionId: 'thread-a' }]);

    expect(result.moved).toBe(1);
    expect(fs.existsSync(path.join(oldDir, 'thread-a.jsonl'))).toBe(false);
    expect(fs.readFileSync(path.join(newDir, 'thread-a.jsonl'), 'utf-8')).toBe('CONTEUDO-A');
  });

  it('threadId = sdk_session_id ?? sessionId (fallback para o id da sessao)', () => {
    fs.writeFileSync(path.join(oldDir, 's-sem-sdk.jsonl'), 'X', 'utf-8');

    const result = runMigration([{ id: 's-sem-sdk' }]);

    expect(result.moved).toBe(1);
    expect(fs.existsSync(path.join(newDir, 's-sem-sdk.jsonl'))).toBe(true);
  });

  it('e idempotente: segunda rodada e no-op e o conteudo permanece intacto', () => {
    fs.writeFileSync(path.join(oldDir, 'thread-a.jsonl'), 'CONTEUDO-A', 'utf-8');
    const sessions = [{ id: 's1', sdkSessionId: 'thread-a' }];

    const first = runMigration(sessions);
    const second = runMigration(sessions);

    expect(first.moved).toBe(1);
    expect(second.moved).toBe(0);
    expect(second.skipped).toBe(1);
    expect(fs.readFileSync(path.join(newDir, 'thread-a.jsonl'), 'utf-8')).toBe('CONTEUDO-A');
  });

  it('NUNCA sobrescreve destino existente (move so quando destino nao existe)', () => {
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'thread-b.jsonl'), 'VELHO', 'utf-8');
    fs.writeFileSync(path.join(newDir, 'thread-b.jsonl'), 'VIVO-NO-DESTINO', 'utf-8');

    const result = runMigration([{ id: 's2', sdkSessionId: 'thread-b' }]);

    expect(result.moved).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fs.readFileSync(path.join(newDir, 'thread-b.jsonl'), 'utf-8')).toBe('VIVO-NO-DESTINO');
    expect(fs.readFileSync(path.join(oldDir, 'thread-b.jsonl'), 'utf-8')).toBe('VELHO');
  });

  it('arquivo ausente nos dois diretorios: segue em frente sem lancar', () => {
    const result = runMigration([{ id: 's3', sdkSessionId: 'thread-inexistente' }]);

    expect(result.moved).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('tolera VARIAS sessoes ativas (estado legado): migra cada uma independentemente', () => {
    fs.writeFileSync(path.join(oldDir, 'thread-a.jsonl'), 'A', 'utf-8');
    fs.writeFileSync(path.join(oldDir, 'thread-b.jsonl'), 'B', 'utf-8');

    const result = runMigration([
      { id: 's1', sdkSessionId: 'thread-a' },
      { id: 's2', sdkSessionId: 'thread-b' },
      { id: 's3', sdkSessionId: 'thread-sumiu' },
    ]);

    expect(result.moved).toBe(2);
    expect(result.skipped).toBe(1);
    expect(fs.existsSync(path.join(newDir, 'thread-a.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(newDir, 'thread-b.jsonl'))).toBe(true);
  });

  it('sem sessoes ativas: no-op total', () => {
    const result = runMigration([]);
    expect(result).toEqual({ moved: 0, skipped: 0 });
  });
});

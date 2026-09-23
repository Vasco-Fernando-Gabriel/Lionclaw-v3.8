import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

import {
  CURSOR_CHAT_RULES_FILENAME,
  CURSOR_CHAT_RULES_RELPATH,
  CURSOR_CHAT_TRANSIENT_RELPATHS,
  cleanupCursorChatWorkspaces,
  cursorChatInputTouchesRules,
  cursorChatInputTouchesWorkspacesRoot,
  cursorChatWorkspacesRoot,
  materializeCursorChatRules,
  resolveCursorChatWorkspace,
} from '../cursor-sdk/workspace';

let testHome: string;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-cursor-ws-'));
  process.env['NODE_ENV'] = 'test';
  process.env['LIONCLAW_TEST_HOME'] = testHome;
});

afterEach(() => {
  delete process.env['LIONCLAW_TEST_HOME'];
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('cursor chat workspace (rules materializadas, G13)', () => {
  it('gives each lane session its OWN workspace/cwd (isolamento por diretorio)', () => {
    const a = resolveCursorChatWorkspace('desktop', 'sessao-a');
    const b = resolveCursorChatWorkspace('desktop', 'sessao-b');
    const c = resolveCursorChatWorkspace('telegram', 'sessao-a');
    expect(a.workspaceDir).not.toBe(b.workspaceDir);
    expect(a.workspaceDir).not.toBe(c.workspaceDir);
    expect(resolveCursorChatWorkspace('desktop', 'sessao-a').workspaceDir).toBe(a.workspaceDir);
    expect(fs.existsSync(a.workspaceDir)).toBe(true);
    expect(a.workspaceDir.startsWith(cursorChatWorkspacesRoot())).toBe(true);
  });

  it('materializes the reserved rules file with alwaysApply frontmatter', () => {
    const ws = resolveCursorChatWorkspace('desktop', 'sessao-rules');
    materializeCursorChatRules(ws, 'IDENTIDADE DO LIONCLAW');
    expect(ws.rulesFilePath.endsWith(CURSOR_CHAT_RULES_FILENAME)).toBe(true);
    const body = fs.readFileSync(ws.rulesFilePath, 'utf8');
    expect(body.startsWith('---\nalwaysApply: true\n---')).toBe(true);
    expect(body).toContain('IDENTIDADE DO LIONCLAW');
    materializeCursorChatRules(ws, 'TURNO 2');
    expect(fs.readFileSync(ws.rulesFilePath, 'utf8')).toContain('TURNO 2');
  });

  it('keeps the rules file in the per-run transient list (nunca em entrega)', () => {
    expect(CURSOR_CHAT_TRANSIENT_RELPATHS).toContain(CURSOR_CHAT_RULES_RELPATH.replace(/\\/g, '/'));
  });

  it('detects tool inputs touching the session .cursor subtree (fonte protegida)', () => {
    const ws = resolveCursorChatWorkspace('desktop', 'sessao-guard');
    expect(cursorChatInputTouchesRules(ws, { file_path: ws.rulesFilePath })).toBe(true);
    expect(
      cursorChatInputTouchesRules(ws, {
        command: `echo hacked > ${ws.rulesFilePath}`,
      }),
    ).toBe(true);
    expect(cursorChatInputTouchesRules(ws, { file_path: '.cursor/rules/x.mdc' })).toBe(true);
    expect(cursorChatInputTouchesRules(ws, { file_path: path.join(testHome, 'USER.md') })).toBe(false);
    expect(cursorChatInputTouchesRules(ws, { command: 'git status' })).toBe(false);
  });

  it('protects the WHOLE workspaces root: rules de OUTRA sessao/lane tambem sao intocaveis', () => {
    const own = resolveCursorChatWorkspace('desktop', 'sessao-propria');
    const other = resolveCursorChatWorkspace('telegram', 'sessao-alheia');
    materializeCursorChatRules(other, 'IDENTIDADE DA OUTRA SESSAO');

    expect(cursorChatInputTouchesWorkspacesRoot({ file_path: other.rulesFilePath })).toBe(true);
    expect(
      cursorChatInputTouchesWorkspacesRoot({
        command: `echo hacked > ${other.rulesFilePath}`,
      }),
    ).toBe(true);
    expect(cursorChatInputTouchesWorkspacesRoot({ file_path: own.workspaceDir })).toBe(true);
    expect(
      cursorChatInputTouchesWorkspacesRoot({
        file_path: 'runtime/cursor-chat-workspaces/telegram/qualquer/.cursor/rules/x.mdc',
      }),
    ).toBe(true);
    expect(
      cursorChatInputTouchesWorkspacesRoot({
        file_path: [testHome, 'qualquer', '..', 'runtime', 'cursor-chat-workspaces', 'desktop', 'h', 'x.mdc'].join(
          path.sep,
        ),
      }),
    ).toBe(true);
    expect(cursorChatInputTouchesWorkspacesRoot({ file_path: path.join(testHome, 'USER.md') })).toBe(false);
    expect(cursorChatInputTouchesWorkspacesRoot({ file_path: 'USER.md' })).toBe(false);
    expect(cursorChatInputTouchesWorkspacesRoot({ command: 'git status' })).toBe(false);
  });

  it('boot cleanup removes every residual workspace', () => {
    const ws = resolveCursorChatWorkspace('cron', 'sessao-residuo');
    materializeCursorChatRules(ws, 'residuo');
    expect(fs.existsSync(ws.rulesFilePath)).toBe(true);
    cleanupCursorChatWorkspaces();
    expect(fs.existsSync(cursorChatWorkspacesRoot())).toBe(false);
  });
});

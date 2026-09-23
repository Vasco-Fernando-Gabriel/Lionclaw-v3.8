import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const bypassState = { value: true };
vi.mock('../db', () => ({
  insertAuditEntry: vi.fn(),
  getPermissionBypass: vi.fn(() => bypassState.value),
}));

vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));

vi.mock('../repo-profiler', () => ({ EXCLUDED_FROM_AUDIT_PATTERNS: [] }));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

import { createPermissionGuard } from '../permission-guard';

const WINDOW_UNAVAILABLE = 'Janela nao disponivel para confirmacao';

function makeGuard() {
  return createPermissionGuard(() => null);
}

const destructiveCases = [
  { label: 'rm -rf', tool: 'Bash', input: { command: 'rm -rf /Users/x/projeto' } },
  { label: 'rm simples', tool: 'Bash', input: { command: 'rm arquivo.txt' } },
  { label: 'sudo', tool: 'Bash', input: { command: 'sudo systemctl restart x' } },
  { label: 'dd if=', tool: 'Bash', input: { command: 'dd if=/dev/zero of=/dev/disk2' } },
  { label: 'escrita em .env', tool: 'Write', input: { file_path: '/Users/x/.env', content: 'X=1' } },
  { label: 'escrita em .pem', tool: 'Edit', input: { file_path: '/Users/x/key.pem' } },
  { label: 'MCP -delete', tool: 'mcp__notion__notion-delete', input: {} },
  { label: 'MCP send_email', tool: 'mcp__gmail__send_email', input: {} },
];

describe('permission-guard: toggle permission:bypass', () => {
  beforeEach(() => {
    bypassState.value = true;
  });

  describe('bypass ON (default): auto-aprova sem popup', () => {
    for (const { label, tool, input } of destructiveCases) {
      it(`allow para "${label}"`, async () => {
        bypassState.value = true;
        const guard = makeGuard();
        const result = await guard(tool, input as Record<string, unknown>);
        expect(result.behavior).toBe('allow');
      });
    }
  });

  describe('bypass OFF: roteia para confirmacao', () => {
    for (const { label, tool, input } of destructiveCases) {
      it(`confirma (nao bypassa) para "${label}"`, async () => {
        bypassState.value = false;
        const guard = makeGuard();
        const result = await guard(tool, input as Record<string, unknown>);
        expect(result.behavior).toBe('deny');
        expect((result as { behavior: 'deny'; message: string }).message).toBe(WINDOW_UNAVAILABLE);
      });
    }
  });

  describe('ortogonais ao toggle', () => {
    it('git destrutivo continua bloqueado mesmo com bypass ON', async () => {
      bypassState.value = true;
      const guard = makeGuard();
      const result = await guard('Bash', { command: 'git push --force origin main' });
      expect(result.behavior).toBe('deny');
      expect((result as { behavior: 'deny'; message: string }).message).toContain('git');
    });

    it('tool nao destrutiva (Read) e sempre allow, independente do toggle', async () => {
      bypassState.value = false;
      const guard = makeGuard();
      const result = await guard('Read', { file_path: '/Users/x/arquivo.ts' });
      expect(result.behavior).toBe('allow');
    });

    it('Bash inofensivo (ls) e allow mesmo com bypass OFF', async () => {
      bypassState.value = false;
      const guard = makeGuard();
      const result = await guard('Bash', { command: 'ls -la' });
      expect(result.behavior).toBe('allow');
    });
  });
});

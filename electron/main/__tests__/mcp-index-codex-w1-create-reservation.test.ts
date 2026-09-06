
import { describe, it, expect, vi } from 'vitest';

const dbRun = vi.hoisted(() => vi.fn());

vi.mock('../db', () => ({
  getDb: () => ({ prepare: () => ({ run: dbRun, all: () => [], get: () => undefined }) }),
  getSetting: () => undefined,
  getAllMCPServers: () => [],
}));

vi.mock('../secrets-vault', () => ({
  getSecret: async () => null,
}));

vi.mock('../app-version', () => ({
  getAppVersion: () => '0.0.0-test',
  formatAppVersionLabel: () => 'v0.0.0-test',
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createMCPServer } from '../mcp-manager';
import { CODEX_GATEWAY_SERVER_ID, MCP_GATEWAY_SERVER_ID } from '../mcp-display';

const base = {
  name: 'X',
  command: 'node',
  args: [] as string[],
  envKeys: [] as string[],
  isActive: true,
};

describe('createMCPServer reserva o id do gateway codex (P4)', () => {
  it('lanca para id lionclaw-gateway e NAO insere no DB', () => {
    expect(() => createMCPServer({ ...base, id: CODEX_GATEWAY_SERVER_ID })).toThrow(
      /lionclaw-gateway/,
    );
    expect(dbRun).not.toHaveBeenCalled();
  });

  it('id comum continua criavel (guard nao vaza para outros ids)', () => {
    const created = createMCPServer({ ...base, id: 'meu-server' });
    expect(created.id).toBe('meu-server');
    expect(dbRun).toHaveBeenCalledTimes(1);
  });

  it('constantes separadas por design: id codex novo, id claude/compat INTOCADO', () => {
    expect(CODEX_GATEWAY_SERVER_ID).toBe('lionclaw-gateway');
    expect(MCP_GATEWAY_SERVER_ID).toBe('gateway');
  });
});

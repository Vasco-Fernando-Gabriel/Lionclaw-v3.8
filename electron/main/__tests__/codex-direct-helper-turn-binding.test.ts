import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  servers: [] as Array<{ id: string; isActive: boolean; visibleTo?: 'all' | 'codex-lion-only' }>,
}));
vi.mock('../db', () => ({
  getSetting: (key: string) => state.settings.get(key),
  getAllMCPServers: () => state.servers,
}));

import { resolveChatCodexMcpComposition } from '../codex-chat-spawn-extras';
import { CODEX_GATEWAY_SERVER_ID } from '../mcp-display';

let codexHome: string;
const prevCodexHome = process.env.CODEX_HOME;

const MANAGED = [
  '# >>> LIONCLAW_MANAGED (do not edit manually)',
  '',
  `[mcp_servers.${CODEX_GATEWAY_SERVER_ID}]`,
  'enabled = false',
  'command = "node"',
  'args    = ["/x/gateway.js"]',
  '',
  '[mcp_servers.lionclaw-pipeline-control]',
  'command = "node"',
  'args    = ["/x/pipe.js"]',
  '',
  '[mcp_servers.google-drive]',
  'command = "node"',
  'args    = ["/x/drive.js"]',
  '',
  '# <<< LIONCLAW_MANAGED',
].join('\n');

const PIPE_SESSION = 'mcp_servers.lionclaw-pipeline-control.env.LIONCLAW_MCP_SESSION_ID="sess-1"';
const PIPE_LANE = 'mcp_servers.lionclaw-pipeline-control.env.LIONCLAW_MCP_LANE="desktop"';

beforeEach(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-binding-'));
  process.env.CODEX_HOME = codexHome;
  state.settings.clear();
  state.servers = [{ id: 'google-drive', isActive: true }];
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `${MANAGED}\n`, 'utf-8');
});

afterEach(() => {
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
  fs.rmSync(codexHome, { recursive: true, force: true });
});

describe('binding de turno nos helpers diretos do codex', () => {
  it('modo index injeta lane e sessionId no helper direto, nao so no gateway', () => {
    const c = resolveChatCodexMcpComposition({ lane: 'desktop', sessionId: 'sess-1' });
    expect(c.mode).toBe('index');
    expect(c.extraArgs).toContain(PIPE_SESSION);
    expect(c.extraArgs).toContain(PIPE_LANE);
    expect(c.extraArgs).toContain(`mcp_servers.${CODEX_GATEWAY_SERVER_ID}.env.LIONCLAW_MCP_SESSION_ID="sess-1"`);
  });

  it('modo full tambem injeta o binding', () => {
    state.settings.set('mcp_prompt_mode', 'full');
    const c = resolveChatCodexMcpComposition({ lane: 'desktop', sessionId: 'sess-1' });
    expect(c.mode).toBe('full');
    expect(c.extraArgs).toContain(PIPE_SESSION);
    expect(c.extraArgs).toContain(PIPE_LANE);
  });

  it('spawn de agente nomeado tambem carrega o binding', () => {
    const c = resolveChatCodexMcpComposition({
      agentId: 'algum-agente',
      lane: 'desktop',
      sessionId: 'sess-1',
    });
    expect(c.mode).toBe('full');
    expect(c.extraArgs).toContain(PIPE_SESSION);
  });

  it('server de negocio nao recebe binding', () => {
    const c = resolveChatCodexMcpComposition({ lane: 'desktop', sessionId: 'sess-1' });
    expect(c.extraArgs.join(' ')).not.toContain('google-drive.env');
  });

  it('sem lane e sem sessionId nao injeta env nenhum', () => {
    const c = resolveChatCodexMcpComposition();
    expect(c.extraArgs.join(' ')).not.toContain('.env.');
  });

  it('sessionId com caractere fora do padrao e ignorado', () => {
    const c = resolveChatCodexMcpComposition({ lane: 'desktop', sessionId: 'ses"s 1' });
    expect(c.extraArgs.join(' ')).not.toContain('LIONCLAW_MCP_SESSION_ID');
    expect(c.extraArgs).toContain(PIPE_LANE);
  });
});

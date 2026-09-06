
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  servers: [] as Array<{
    id: string;
    isActive: boolean;
    visibleTo?: 'all' | 'codex-lion-only';
  }>,
  throwOnGetSetting: false,
}));
vi.mock('../db', () => ({
  getSetting: (key: string) => {
    if (state.throwOnGetSetting) throw new Error('db closed');
    return state.settings.get(key);
  },
  getAllMCPServers: () => state.servers,
}));

import {
  resolveChatCodexMcpComposition,
  buildChatRepoContextFingerprint,
  buildChatThreadConfigSignature,
  type ChatCodexMcpComposition,
} from '../codex-chat-spawn-extras';
import { CODEX_GATEWAY_SERVER_ID } from '../mcp-display';


let codexHome: string;
const prevCodexHome = process.env.CODEX_HOME;

const MANAGED_WITH_GATEWAY = [
  '# >>> LIONCLAW_MANAGED (do not edit manually)',
  '',
  `[mcp_servers.${CODEX_GATEWAY_SERVER_ID}]`,
  'enabled = false',
  'command = "node"',
  'args    = ["/x/gateway.js"]',
  '',
  '[mcp_servers.google-drive]',
  'command = "node"',
  'args    = ["/x/drive.js"]',
  '',
  '[mcp_servers.lionclaw-agents]',
  'command = "node"',
  'args    = ["/x/agents.js"]',
  '',
  '[mcp_servers.shopify]',
  'command = "node"',
  'args    = ["/x/shopify.js"]',
  '',
  '# <<< LIONCLAW_MANAGED',
].join('\n');

function writeConfig(content: string): void {
  fs.writeFileSync(path.join(codexHome, 'config.toml'), content, 'utf-8');
}

function setIndexHappyPath(): void {
  state.settings.clear();
  state.throwOnGetSetting = false;
  state.servers = [
    { id: 'google-drive', isActive: true },
    { id: 'shopify', isActive: true, visibleTo: 'all' },
    { id: 'lionclaw-agents', isActive: true }, // helper direto: fora dos extras
    { id: 'lionclaw-user-question', isActive: true }, // helper direto
    { id: 'inativo', isActive: false }, // inativo: fora
  ];
  writeConfig(`${MANAGED_WITH_GATEWAY}\n`);
}

beforeEach(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-codex-home-'));
  process.env.CODEX_HOME = codexHome;
  setIndexHappyPath();
});

afterEach(() => {
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
  fs.rmSync(codexHome, { recursive: true, force: true });
});


describe('resolveChatCodexMcpComposition - modo index efetivo', () => {
  it('index ON + oficial ON + entry presente => enabled=false por server de negocio + gateway enabled=true', () => {
    const c = resolveChatCodexMcpComposition();
    expect(c.mode).toBe('index');
    expect(c.extraArgs).toEqual([
      '-c', 'mcp_servers.google-drive.enabled=false',
      '-c', 'mcp_servers.shopify.enabled=false',
      '-c', `mcp_servers.${CODEX_GATEWAY_SERVER_ID}.enabled=true`,
    ]);
    expect(c.extraArgs.join(' ')).not.toContain('lionclaw-agents');
    expect(c.extraArgs.join(' ')).not.toContain('lionclaw-user-question');
    expect(c.extraArgs.join(' ')).not.toContain(`${CODEX_GATEWAY_SERVER_ID}.enabled=false`);
    expect(c.fingerprint).toBe(
      JSON.stringify({ servers: ['google-drive', 'shopify'], gatewayEntry: true }),
    );
  });

  it('id nao-bare quotado identico ao header (contrato de quoting) e id patologico pulado', () => {
    state.servers.push(
      { id: 'meu server', isActive: true },
      { id: 'pato"logico', isActive: true },
    );
    writeConfig(
      `${MANAGED_WITH_GATEWAY.replace(
        '# <<< LIONCLAW_MANAGED',
        '[mcp_servers."meu server"]\ncommand = "node"\nargs    = ["/x/meu.js"]\n\n# <<< LIONCLAW_MANAGED',
      )}\n`,
    );
    const c = resolveChatCodexMcpComposition();
    expect(c.extraArgs).toContain('mcp_servers."meu server".enabled=false');
    expect(c.extraArgs.join(' ')).not.toContain('pato');
  });

  it('disable SO para entry comprovada no TOML: server ativo no DB fora do managed block nao gera -c (fixture item 2)', () => {
    state.servers.push({ id: 'so-no-db', isActive: true });
    const c = resolveChatCodexMcpComposition();
    expect(c.mode).toBe('index');
    expect(c.extraArgs.join(' ')).not.toContain('so-no-db');
    expect(c.fingerprint).toContain('so-no-db');
  });

  it('produtor da lane (secao 6): lane conhecida => env.LIONCLAW_MCP_LANE na entry do gateway', () => {
    for (const lane of ['desktop', 'telegram', 'cron'] as const) {
      const c = resolveChatCodexMcpComposition({ lane });
      expect(c.mode).toBe('index');
      expect(c.extraArgs).toContain(
        `mcp_servers.${CODEX_GATEWAY_SERVER_ID}.env.LIONCLAW_MCP_LANE="${lane}"`,
      );
    }
  });

  it('lane fora da allowlist ou ausente => extra de lane OMITIDO (fallback desktop no dispatch)', () => {
    const semLane = resolveChatCodexMcpComposition();
    const desconhecida = resolveChatCodexMcpComposition({ lane: 'lane-inventada' });
    for (const c of [semLane, desconhecida]) {
      expect(c.mode).toBe('index');
      expect(c.extraArgs.join(' ')).not.toContain('LIONCLAW_MCP_LANE');
    }
  });
});

describe('resolveChatCodexMcpComposition - gates => full COMPLETO (nunca metade)', () => {
  const expectFull = (c: ChatCodexMcpComposition): void => {
    expect(c).toEqual({ mode: 'full', extraArgs: [], fingerprint: null });
  };

  it("mcp_prompt_mode='full' => full", () => {
    state.settings.set('mcp_prompt_mode', 'full');
    expectFull(resolveChatCodexMcpComposition());
  });

  it('agentId (persona, P8) => full', () => {
    expectFull(resolveChatCodexMcpComposition({ agentId: 'meu-agente' }));
  });

  it('onboarding => full (gate conservador)', () => {
    expectFull(resolveChatCodexMcpComposition({ isOnboarding: true }));
  });

  it('guard anti-sync-falhou: entry ausente do managed block => full ruidoso', () => {
    writeConfig(
      [
        '# >>> LIONCLAW_MANAGED (do not edit manually)',
        '[mcp_servers.google-drive]',
        'command = "node"',
        '# <<< LIONCLAW_MANAGED',
        '',
      ].join('\n'),
    );
    expectFull(resolveChatCodexMcpComposition());
  });

  it('guard nao e enganado por entry homonima do USUARIO fora do managed block (colisao)', () => {
    writeConfig(
      [
        `[mcp_servers.${CODEX_GATEWAY_SERVER_ID}]`,
        'command = "meu-gateway-proprio"',
        '',
        '# >>> LIONCLAW_MANAGED (do not edit manually)',
        '[mcp_servers.google-drive]',
        'command = "node"',
        '# <<< LIONCLAW_MANAGED',
        '',
      ].join('\n'),
    );
    expectFull(resolveChatCodexMcpComposition());
  });

  it('config.toml ausente => full', () => {
    fs.rmSync(path.join(codexHome, 'config.toml'));
    expectFull(resolveChatCodexMcpComposition());
  });

  it('guard nao e enganado por server HOMONIMO do DB sincronizado DENTRO do managed block (colisao P4 DB-only)', () => {
    state.servers.push({ id: CODEX_GATEWAY_SERVER_ID, isActive: true });
    writeConfig(
      [
        '# >>> LIONCLAW_MANAGED (do not edit manually)',
        '',
        `[mcp_servers.${CODEX_GATEWAY_SERVER_ID}]`,
        'command = "meu-negocio"',
        'args    = ["/x/negocio.js"]',
        '',
        '[mcp_servers.google-drive]',
        'command = "node"',
        '',
        '# <<< LIONCLAW_MANAGED',
        '',
      ].join('\n'),
    );
    expectFull(resolveChatCodexMcpComposition());
  });

  it('homonimo INATIVO no DB tambem degrada (mesmo predicado da detecao do sync: qualquer server do DB)', () => {
    state.servers.push({ id: CODEX_GATEWAY_SERVER_ID, isActive: false });
    expectFull(resolveChatCodexMcpComposition());
  });

  it('getSetting lancando (DB indisponivel) => full, nunca excecao (contrato "nunca lanca")', () => {
    state.throwOnGetSetting = true;
    expect(() => resolveChatCodexMcpComposition()).not.toThrow();
    expectFull(resolveChatCodexMcpComposition());
  });
});


describe('buildChatThreadConfigSignature', () => {
  const base = {
    pipelineControl: null,
    dynamicWorkflows: null,
    onboarding: false,
    repoContextFingerprint: null,
  };

  it('modo full: JSON byte-identico ao literal historico (parity AC-C5)', () => {
    const full: ChatCodexMcpComposition = { mode: 'full', extraArgs: [], fingerprint: null };
    expect(buildChatThreadConfigSignature(base, full)).toBe(
      JSON.stringify({ pipelineControl: null, dynamicWorkflows: null, onboarding: false }),
    );
  });

  it('gatilho 1 (flip de modo): index <-> full divergem nos DOIS sentidos', () => {
    const index = resolveChatCodexMcpComposition();
    const sigIndex = buildChatThreadConfigSignature(base, index);
    state.settings.set('mcp_prompt_mode', 'full');
    const sigFull = buildChatThreadConfigSignature(base, resolveChatCodexMcpComposition());
    expect(sigIndex).not.toBe(sigFull);
    expect(sigIndex).toContain('"mcpMode":"index"');
    expect(sigFull).not.toContain('mcpMode');
  });

  it('gatilho 2 (instala/remove MCP): fingerprint diverge em modo index', () => {
    const before = buildChatThreadConfigSignature(base, resolveChatCodexMcpComposition());
    state.servers.push({ id: 'novo-mcp', isActive: true });
    const after = buildChatThreadConfigSignature(base, resolveChatCodexMcpComposition());
    expect(before).not.toBe(after);
    expect(after).toContain('novo-mcp');
  });

  it('gatilho 3 (visibilidade): fingerprint reflete SO os servers visiveis a surface codex', () => {
    const before = buildChatThreadConfigSignature(base, resolveChatCodexMcpComposition());
    state.servers = state.servers.map((s) =>
      s.id === 'shopify' ? { ...s, visibleTo: 'codex-lion-only' as const } : s,
    );
    const after = buildChatThreadConfigSignature(base, resolveChatCodexMcpComposition());
    expect(after).toBe(before);
    expect(after).toContain('shopify');
  });

  it('NEGATIVO (parity): em modo FULL instalar MCP NAO muda a assinatura', () => {
    state.settings.set('mcp_prompt_mode', 'full');
    const before = buildChatThreadConfigSignature(base, resolveChatCodexMcpComposition());
    state.servers.push({ id: 'novo-mcp', isActive: true });
    const after = buildChatThreadConfigSignature(base, resolveChatCodexMcpComposition());
    expect(after).toBe(before);
  });

  it('guard reprovado => assinatura full (prompt e spawn degradam JUNTOS)', () => {
    writeConfig('# sem managed block\n');
    const sig = buildChatThreadConfigSignature(base, resolveChatCodexMcpComposition());
    expect(sig).toBe(
      JSON.stringify({ pipelineControl: null, dynamicWorkflows: null, onboarding: false }),
    );
  });

  it('repo: fingerprint deterministico inclui identidade, root, status e stats', () => {
    const fingerprint = buildChatRepoContextFingerprint({
      repositoryId: 'repo-1',
      canonicalRootPath: '/workspace/repo',
      status: 'ready',
      statsResumo: '10 arquivos, 20 simbolos',
    });
    expect(fingerprint).toBe(
      JSON.stringify({
        repositoryId: 'repo-1',
        canonicalRootPath: '/workspace/repo',
        status: 'ready',
        statsResumo: '10 arquivos, 20 simbolos',
      }),
    );
    expect(buildChatRepoContextFingerprint(null)).toBeNull();
  });

  it('repo: mudanca de status/stats no mesmo cwd invalida a assinatura em full e index', () => {
    const ready = buildChatRepoContextFingerprint({
      repositoryId: 'repo-1',
      canonicalRootPath: '/workspace/repo',
      status: 'ready',
      statsResumo: '10 arquivos, 20 simbolos',
    });
    const stale = buildChatRepoContextFingerprint({
      repositoryId: 'repo-1',
      canonicalRootPath: '/workspace/repo',
      status: 'stale',
      statsResumo: '11 arquivos, 22 simbolos',
    });

    const index = resolveChatCodexMcpComposition();
    expect(
      buildChatThreadConfigSignature({ ...base, repoContextFingerprint: ready }, index),
    ).not.toBe(
      buildChatThreadConfigSignature({ ...base, repoContextFingerprint: stale }, index),
    );

    state.settings.set('mcp_prompt_mode', 'full');
    const full = resolveChatCodexMcpComposition();
    expect(
      buildChatThreadConfigSignature({ ...base, repoContextFingerprint: ready }, full),
    ).not.toBe(
      buildChatThreadConfigSignature({ ...base, repoContextFingerprint: stale }, full),
    );
  });
});


describe('wiring do turno codex (fonte unica da composicao, P7)', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'codex-sdk', 'index.ts'),
    'utf-8',
  );

  it('executeCodexSdkQuery computa a composicao UMA vez e a passa a assinatura', () => {
    expect(source.match(/resolveChatCodexMcpComposition\(/g)?.length).toBe(1);
    expect(source).toContain('buildChatThreadConfigSignature(');
  });

  it('as DUAS criacoes de sessao do turno recebem a mesma composicao', () => {
    expect(source.match(/mcpComposition,/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('a composicao recebe a LANE do turno (produtor da cadeia da lane, secao 6)', () => {
    expect(source).toContain('lane: lane.name');
  });
});

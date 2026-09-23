import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const state = vi.hoisted(() => ({ settings: new Map<string, string>() }));
vi.mock('../db', () => ({
  getSetting: (key: string) => state.settings.get(key),
}));

const official = vi.hoisted(() => {
  const createRun = vi.fn(async (opts: unknown) => ({ opts }));
  return {
    createRun,
    createCodexDriver: vi.fn(() => ({
      implementation: 'official-app-server',
      createRun,
      toSyncCodexSession: (handle: unknown) => ({
        threadId: null,
        handle,
        send: async () => ({}),
        reply: async () => ({}),
        close: () => undefined,
      }),
    })),
  };
});
vi.mock('../codex-runtime/factory', () => ({
  createCodexDriver: official.createCodexDriver,
}));

import {
  resolveCodexSessionForRun,
  __resetOfficialCodexDriverCacheForTests,
  type ResolveCodexSessionArgs,
} from '../agent-runtime/codex-session-factory';
import { listCodexManagedBlockServerNames, getOfficialPhaseCodexSpawnExtraArgs } from '../codex-pipeline-config';

const tmpHomes: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

function useCodexHome(configToml: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-w3-codex-'));
  tmpHomes.push(dir);
  if (configToml !== null) {
    fs.writeFileSync(path.join(dir, 'config.toml'), configToml, 'utf-8');
  }
  process.env.CODEX_HOME = dir;
  return dir;
}

afterAll(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  for (const dir of tmpHomes) fs.rmSync(dir, { recursive: true, force: true });
});

const CONFIG_WITH_MANAGED = [
  '[mcp_servers.meu-server-pessoal]',
  'command = "node"',
  '',
  '# >>> LIONCLAW_MANAGED (do not edit manually)',
  '[mcp_servers.google-drive]',
  'command = "node"',
  '[mcp_servers.google-drive.env]',
  'FOO = "bar"',
  '[mcp_servers."id com espaco"]',
  'command = "node"',
  '[mcp_servers.lionclaw-gateway]',
  'enabled = false',
  'command = "node"',
  '# <<< LIONCLAW_MANAGED',
  '',
].join('\n');

function args(over: Partial<ResolveCodexSessionArgs> = {}): ResolveCodexSessionArgs {
  return {
    surface: 'pipeline',
    mcpProfile: 'pipeline',
    sessionOptions: {
      cwd: '/tmp/x',
      model: 'gpt-5.5',
      systemPrompt: 'sys',
      projectId: 'proj-1',
    },
    ...over,
  };
}

function lastRunOpts(): { extraArgs?: string[]; key: { ownerKind: string } } {
  expect(official.createRun).toHaveBeenCalledTimes(1);
  return official.createRun.mock.calls[0][0] as { extraArgs?: string[]; key: { ownerKind: string } };
}

const CHAT_EXTRAS = ['-c', 'mcp_servers.google-drive.enabled=false', '-c', 'mcp_servers.lionclaw-gateway.enabled=true'];

beforeEach(() => {
  vi.clearAllMocks();
  state.settings.clear();
  __resetOfficialCodexDriverCacheForTests();
});

describe('codex-pipeline-config: lista e extras do managed block', () => {
  it('listCodexManagedBlockServerNames: so entries DENTRO do managed, sub-tabela colapsa, ordenado', () => {
    useCodexHome(CONFIG_WITH_MANAGED);
    expect(listCodexManagedBlockServerNames()).toEqual(['google-drive', 'id com espaco', 'lionclaw-gateway']);
  });

  it('sem markers no config => lista vazia (server pessoal do usuario fica de fora)', () => {
    useCodexHome('[mcp_servers.meu-server-pessoal]\ncommand = "node"\n');
    expect(listCodexManagedBlockServerNames()).toEqual([]);
  });

  it('config.toml ausente => lista vazia, nunca lanca', () => {
    useCodexHome(null);
    expect(listCodexManagedBlockServerNames()).toEqual([]);
  });

  it('getOfficialPhaseCodexSpawnExtraArgs: -c enabled=false por server do managed, INCLUINDO o gateway, quoting do header', () => {
    useCodexHome(CONFIG_WITH_MANAGED);
    expect(getOfficialPhaseCodexSpawnExtraArgs()).toEqual([
      '-c',
      'mcp_servers.google-drive.enabled=false',
      '-c',
      'mcp_servers."id com espaco".enabled=false',
      '-c',
      'mcp_servers.lionclaw-gateway.enabled=false',
    ]);
  });

  it('id patologico (com aspas) no managed e PULADO (mesma regra do sync: nao esta no TOML, nada a desligar)', () => {
    useCodexHome(
      [
        '# >>> LIONCLAW_MANAGED (do not edit manually)',
        '[mcp_servers.normal]',
        'command = "node"',
        '# <<< LIONCLAW_MANAGED',
        '',
      ].join('\n'),
    );
    expect(getOfficialPhaseCodexSpawnExtraArgs()).toEqual(['-c', 'mcp_servers.normal.enabled=false']);
  });
});

describe('AC-C11: composicao por ownerKind no driver oficial', () => {
  it('fase (ownerKind default pipeline) => createRun com frota ZERO do managed block, sem nenhum enabled=true', async () => {
    useCodexHome(CONFIG_WITH_MANAGED);
    await resolveCodexSessionForRun(args());
    const opts = lastRunOpts();
    expect(opts.key.ownerKind).toBe('pipeline');
    expect(opts.extraArgs).toEqual([
      '-c',
      'mcp_servers.google-drive.enabled=false',
      '-c',
      'mcp_servers."id com espaco".enabled=false',
      '-c',
      'mcp_servers.lionclaw-gateway.enabled=false',
    ]);
    expect((opts.extraArgs ?? []).some((a) => a.includes('enabled=true'))).toBe(false);
  });

  it('fase explicita (ownerKind "pipeline" no sessionOptions) => mesma frota zero', async () => {
    useCodexHome(CONFIG_WITH_MANAGED);
    await resolveCodexSessionForRun(
      args({ sessionOptions: { ...args().sessionOptions, ownerKind: 'pipeline', ownerId: 'agent:ph2' } }),
    );
    expect(lastRunOpts().extraArgs).toEqual(getOfficialPhaseCodexSpawnExtraArgs());
  });

  it('managed block ausente => fase oficial segue com extraArgs undefined (spawn byte-identico, parity)', async () => {
    useCodexHome('[mcp_servers.meu-server-pessoal]\ncommand = "node"\n');
    await resolveCodexSessionForRun(args());
    expect(lastRunOpts().extraArgs).toBeUndefined();
  });

  it('disableGlobalMcp (workflow node, CODEX_HOME dedicado sem servers) => NAO injeta -c de entry inexistente', async () => {
    useCodexHome(CONFIG_WITH_MANAGED);
    await resolveCodexSessionForRun(args({ disableGlobalMcp: true }));
    expect(lastRunOpts().extraArgs).toBeUndefined();
  });

  it('extras estruturais estampados num spawn de fase => falha RUIDOSA (composicao index e do chat, P6/P8)', async () => {
    useCodexHome(CONFIG_WITH_MANAGED);
    await expect(resolveCodexSessionForRun(args({ extraArgs: CHAT_EXTRAS }))).rejects.toThrow(/exclusiva do chat/);
    expect(official.createRun).not.toHaveBeenCalled();
  });
});

describe('nao-regressao W2: composicao do CHAT intacta', () => {
  it('chat em modo index (extras do caller) => createRun recebe EXATAMENTE os extras do W2, sem frota-zero por cima', async () => {
    useCodexHome(CONFIG_WITH_MANAGED);
    await resolveCodexSessionForRun(
      args({
        surface: 'chat',
        mcpProfile: 'chat',
        sessionOptions: { ...args().sessionOptions, ownerKind: 'chat', ownerId: 's1' },
        extraArgs: CHAT_EXTRAS,
      }),
    );
    const opts = lastRunOpts();
    expect(opts.key.ownerKind).toBe('chat');
    expect(opts.extraArgs).toEqual(CHAT_EXTRAS);
  });

  it('chat em modo FULL (sem extras) => extraArgs undefined mesmo com managed block cheio (nunca frota-zero no chat)', async () => {
    useCodexHome(CONFIG_WITH_MANAGED);
    await resolveCodexSessionForRun(
      args({
        surface: 'chat',
        mcpProfile: 'chat',
        sessionOptions: { ...args().sessionOptions, ownerKind: 'chat', ownerId: 's1' },
      }),
    );
    const opts = lastRunOpts();
    expect(opts.key.ownerKind).toBe('chat');
    expect(opts.extraArgs).toBeUndefined();
  });

  it('one-shot com ownerKind "chat" (protecao deliberada do slot) => sem frota-zero (paridade com o B6 legado)', async () => {
    useCodexHome(CONFIG_WITH_MANAGED);
    await resolveCodexSessionForRun(
      args({
        surface: 'one-shot',
        mcpProfile: 'one-shot',
        sessionOptions: { ...args().sessionOptions, ownerKind: 'chat', ownerId: 'oneshot' },
      }),
    );
    expect(lastRunOpts().extraArgs).toBeUndefined();
  });
});

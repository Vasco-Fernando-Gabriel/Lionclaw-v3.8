import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../db', () => ({ getSetting: vi.fn(() => ''), setSetting: vi.fn() }));
vi.mock('../secrets-vault', () => ({ getApiKey: vi.fn(async () => null) }));
vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  getClaudeCodeExecutablePath: vi.fn(() => '/fake/claude.exe'),
}));
vi.mock('../distribution-runtime', () => ({
  resolveInternalNodeBinary: vi.fn(() => '/fake/node'),
}));
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
  app: { isPackaged: false },
}));

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
vi.mock('fs', () => ({
  default: {
    existsSync: (...a: unknown[]) => existsSyncMock(...a),
    readFileSync: (...a: unknown[]) => readFileSyncMock(...a),
  },
  existsSync: (...a: unknown[]) => existsSyncMock(...a),
  readFileSync: (...a: unknown[]) => readFileSyncMock(...a),
}));

import { readClaudeCliVersion, registerClaudeCliHandlers } from '../ipc/claude-cli';
import { getClaudeCodeExecutablePath } from '../pipeline-shared/sdk-bootstrap';

describe('claude-cli:status - engine nao resolvido (D4 lanca)', () => {
  it('devolve installed:false com a mensagem, sem propagar excecao ao renderer', async () => {
    registerClaudeCliHandlers({} as never);
    const status = ipcHandlers.get('claude-cli:status');
    expect(typeof status).toBe('function');
    vi.mocked(getClaudeCodeExecutablePath).mockImplementationOnce(() => {
      throw new Error('Claude Code engine nao encontrado; candidatos tentados: a | b');
    });
    const result = (await status!()) as { installed: boolean; version: string | null; resolvedPath: string };
    expect(result.installed).toBe(false);
    expect(result.version).toBeNull();
    expect(result.resolvedPath).toContain('candidatos tentados');
  });

  it('claude-cli:test devolve ok:false com a mensagem quando nenhum engine resolve', async () => {
    registerClaudeCliHandlers({} as never);
    const test = ipcHandlers.get('claude-cli:test');
    vi.mocked(getClaudeCodeExecutablePath).mockImplementationOnce(() => {
      throw new Error('sem engine');
    });
    const result = (await test!()) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toContain('sem engine');
  });
});

function fakeChild(stdout: string, code: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code);
  });
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  existsSyncMock.mockReset();
  readFileSyncMock.mockReset();
});

describe('readClaudeCliVersion - entry NATIVO (SDK 0.3.x)', () => {
  it('executa <entry> --version SEM node e devolve o semver do engine', async () => {
    spawnMock.mockImplementation(() => fakeChild('2.1.257 (Claude Code)\n', 0));
    const entry = path.join('C:', 'x', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe');
    const version = await readClaudeCliVersion(entry);
    expect(version).toBe('2.1.257');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe(entry);
    expect(cmd.endsWith('node')).toBe(false);
    expect(args).toEqual(['--version']);
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('exit code != 0 devolve null (painel sem versao, nunca quebra)', async () => {
    spawnMock.mockImplementation(() => fakeChild('', 1));
    await expect(readClaudeCliVersion('/opt/claude')).resolves.toBeNull();
  });
});

describe('readClaudeCliVersion - entry .js LEGADO (cli.js)', () => {
  it('le o package.json adjacente e NAO spawna nada', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({ version: '0.2.74' }));
    const entry = path.join('/legacy', 'claude-agent-sdk', 'cli.js');
    const version = await readClaudeCliVersion(entry);
    expect(version).toBe('0.2.74');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(existsSyncMock).toHaveBeenCalledWith(path.join('/legacy', 'claude-agent-sdk', 'package.json'));
  });

  it('sem package.json adjacente devolve null', async () => {
    existsSyncMock.mockReturnValue(false);
    await expect(readClaudeCliVersion('/custom/cli.js')).resolves.toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

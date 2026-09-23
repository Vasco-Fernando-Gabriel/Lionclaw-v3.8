import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn<(key: string) => string | null>(),
  existsSync: vi.fn<(p: string) => boolean>(),
  resolvePackagedClaudeCliEntry: vi.fn<() => string>(),
  resolveInternalNodeBinary: vi.fn<() => string>(),
  isPackagedDistributionRuntime: vi.fn<() => boolean>(),
  minimalInternalRuntimeEnv: vi.fn<(node: string, base: unknown) => Record<string, string>>(),
  spawn: vi.fn<(...args: unknown[]) => unknown>(),
  getApiKey: vi.fn<() => Promise<string | null>>(),
  sdkResolve: null as null | ((id: string) => string),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../logger', () => ({ createLogger: () => mocks.logger }));
vi.mock('../db', () => ({ getSetting: (key: string) => mocks.getSetting(key) }));
vi.mock('../secrets-vault', () => ({ getApiKey: () => mocks.getApiKey() }));
vi.mock('fs', () => ({
  default: { existsSync: (p: string) => mocks.existsSync(p) },
  existsSync: (p: string) => mocks.existsSync(p),
}));
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => mocks.spawn(...args) }));
vi.mock('../distribution-runtime', async () => {
  const actual = await vi.importActual<typeof import('../distribution-runtime')>('../distribution-runtime');
  return {
    claudeAgentSdkEntryRelative: actual.claudeAgentSdkEntryRelative,
    distributionRuntimeTarget: actual.distributionRuntimeTarget,
    resolvePackagedClaudeCliEntry: () => mocks.resolvePackagedClaudeCliEntry(),
    resolveInternalNodeBinary: () => mocks.resolveInternalNodeBinary(),
    isPackagedDistributionRuntime: () => mocks.isPackagedDistributionRuntime(),
    minimalInternalRuntimeEnv: (node: string, base: unknown) => mocks.minimalInternalRuntimeEnv(node, base),
  };
});
vi.mock('module', async () => {
  const actual = await vi.importActual<typeof import('module')>('module');
  const createRequire = (url: string | URL) => {
    const real = actual.createRequire(url);
    const fake = ((id: string) => real(id)) as NodeRequire;
    fake.resolve = ((id: string, opts?: { paths?: string[] }) =>
      mocks.sdkResolve ? mocks.sdkResolve(id) : real.resolve(id, opts)) as NodeRequire['resolve'];
    return fake;
  };
  return { ...actual, default: { ...actual, createRequire }, createRequire };
});

import {
  getClaudeCodeExecutablePath,
  getClaudeSdkProcessOptions,
  isNativeClaudeEntry,
  SDK_JS_ENTRY_EXTENSIONS,
  ensureNodeInPath,
  ensureAuthForSDK,
} from '../pipeline-shared/sdk-bootstrap';
import { claudeAgentSdkEntryRelative, distributionRuntimeTarget } from '../distribution-runtime';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const NATIVE_RELATIVE = claudeAgentSdkEntryRelative(distributionRuntimeTarget());
const STAGED_ENTRY = path.join('/staged', 'claude-agent-sdk', NATIVE_RELATIVE);
const STAGED_ERROR = 'Claude CLI físico não encontrado; candidatos: /out/none';

function fakeSdkEntry(root: string): string {
  return path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
}

function fakeProcess(): unknown {
  return {
    stdin: {},
    stdout: {},
    killed: false,
    exitCode: null,
    kill: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sdkResolve = null;
  mocks.getSetting.mockReturnValue(null);
  mocks.existsSync.mockReturnValue(false);
  mocks.isPackagedDistributionRuntime.mockReturnValue(false);
  mocks.resolvePackagedClaudeCliEntry.mockImplementation(() => {
    throw new Error(STAGED_ERROR);
  });
  mocks.resolveInternalNodeBinary.mockImplementation(() => {
    throw new Error('Node interno não encontrado');
  });
  mocks.minimalInternalRuntimeEnv.mockImplementation((node) => ({
    PATH: path.dirname(node),
    MARK: 'minimal',
  }));
  mocks.spawn.mockImplementation(fakeProcess);
  mocks.getApiKey.mockResolvedValue(null);
});

describe('isNativeClaudeEntry (D3)', () => {
  it('lista de extensoes byte a byte igual ao engine (sem .cjs)', () => {
    expect([...SDK_JS_ENTRY_EXTENSIONS]).toEqual(['.js', '.mjs', '.tsx', '.ts', '.jsx']);
  });

  it('binario nativo => true; qualquer extensao JS do engine => false', () => {
    expect(isNativeClaudeEntry('C:\\x\\claude-agent-sdk-win32-x64\\claude.exe')).toBe(true);
    expect(isNativeClaudeEntry('/x/claude-agent-sdk-linux-x64/claude')).toBe(true);
    for (const ext of SDK_JS_ENTRY_EXTENSIONS) {
      expect(isNativeClaudeEntry(`/x/cli${ext}`)).toBe(false);
    }
    expect(isNativeClaudeEntry('/x/cli.cjs')).toBe(true);
  });
});

describe('getClaudeCodeExecutablePath - precedencia D4', () => {
  it('(1) override valido ganha do staged', () => {
    const custom = path.join('/custom', 'claude.exe');
    mocks.getSetting.mockImplementation((key) => (key === 'claude_cli_binary_path' ? custom : null));
    mocks.existsSync.mockImplementation((p) => p === custom);
    mocks.resolvePackagedClaudeCliEntry.mockReturnValue(STAGED_ENTRY);

    expect(getClaudeCodeExecutablePath()).toBe(custom);
    expect(mocks.resolvePackagedClaudeCliEntry).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('(2) override inexistente cai no staged e loga warn', () => {
    const custom = path.join('/custom', 'missing', 'claude.exe');
    mocks.getSetting.mockReturnValue(custom);
    mocks.existsSync.mockReturnValue(false);
    mocks.resolvePackagedClaudeCliEntry.mockReturnValue(STAGED_ENTRY);

    expect(getClaudeCodeExecutablePath()).toBe(STAGED_ENTRY);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { custom },
      expect.stringContaining('claude_cli_binary_path configurado mas nao e um arquivo existente'),
    );
  });

  it('(3) dev sem override e sem staged resolve o binario nativo em node_modules do repo', () => {
    const expected = path.join(REPO_ROOT, NATIVE_RELATIVE);
    mocks.existsSync.mockImplementation((p) => p === expected);

    const resolved = getClaudeCodeExecutablePath();
    expect(resolved).toBe(expected);
    expect(isNativeClaudeEntry(resolved)).toBe(true);
    expect(['claude', 'claude.exe']).toContain(path.basename(resolved));
    expect(resolved.endsWith('cli.js')).toBe(false);
  });

  it('(4) empacotado converte app.asar em app.asar.unpacked no path resolvido', () => {
    const resources = path.resolve('/app', 'resources');
    const unpacked = path.join(resources, 'app.asar.unpacked', NATIVE_RELATIVE);
    mocks.isPackagedDistributionRuntime.mockReturnValue(true);
    mocks.sdkResolve = () => fakeSdkEntry(path.join(resources, 'app.asar'));
    mocks.existsSync.mockImplementation((p) => p === unpacked);

    expect(getClaudeCodeExecutablePath()).toBe(unpacked);
    const probed = mocks.existsSync.mock.calls.map(([p]) => p);
    expect(probed.some((p) => p.includes(`${path.sep}app.asar${path.sep}`))).toBe(false);
  });

  it('(5) ausencia total lanca listando TODOS os candidatos tentados', () => {
    const custom = path.join('/custom', 'missing', 'claude.exe');
    const fakeRoot = path.resolve('/elsewhere', 'tree');
    mocks.getSetting.mockReturnValue(custom);
    mocks.sdkResolve = () => fakeSdkEntry(fakeRoot);
    mocks.existsSync.mockReturnValue(false);

    let message = '';
    try {
      getClaudeCodeExecutablePath();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Claude Code engine nao encontrado');
    expect(message).toContain(custom);
    expect(message).toContain(STAGED_ERROR);
    expect(message).toContain(path.join(fakeRoot, NATIVE_RELATIVE));
    expect(message).toContain(path.join(REPO_ROOT, NATIVE_RELATIVE));
  });
});

describe('getClaudeSdkProcessOptions - closure (D2) e log (D17)', () => {
  it('entry nativo => SEM spawnClaudeCodeProcess, Node interno nem consultado', () => {
    mocks.resolvePackagedClaudeCliEntry.mockReturnValue(STAGED_ENTRY);

    const opts = getClaudeSdkProcessOptions();
    expect(opts).toEqual({ pathToClaudeCodeExecutable: STAGED_ENTRY, executable: 'node' });
    expect('spawnClaudeCodeProcess' in opts).toBe(false);
    expect(mocks.resolveInternalNodeBinary).not.toHaveBeenCalled();
    expect(mocks.minimalInternalRuntimeEnv).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      { cliEntry: STAGED_ENTRY, source: 'staged', nativeEntry: true, packaged: false },
      'claude engine: entry resolvido',
    );
  });

  it('entry nativo em node_modules do repo loga source node_modules', () => {
    const expected = path.join(REPO_ROOT, NATIVE_RELATIVE);
    mocks.existsSync.mockImplementation((p) => p === expected);

    const opts = getClaudeSdkProcessOptions();
    expect(opts.spawnClaudeCodeProcess).toBeUndefined();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      { cliEntry: expected, source: 'node_modules', nativeEntry: true, packaged: false },
      'claude engine: entry resolvido',
    );
  });

  it('entry nativo extraido do asar loga source asar-unpacked e packaged true', () => {
    const resources = path.resolve('/app', 'resources');
    const unpacked = path.join(resources, 'app.asar.unpacked', NATIVE_RELATIVE);
    mocks.isPackagedDistributionRuntime.mockReturnValue(true);
    mocks.sdkResolve = () => fakeSdkEntry(path.join(resources, 'app.asar'));
    mocks.existsSync.mockImplementation((p) => p === unpacked);

    const opts = getClaudeSdkProcessOptions();
    expect(opts).toEqual({ pathToClaudeCodeExecutable: unpacked, executable: 'node' });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      { cliEntry: unpacked, source: 'asar-unpacked', nativeEntry: true, packaged: true },
      'claude engine: entry resolvido',
    );
  });

  it('entry .js com Node interno => closure spawna o Node interno com args intactos', () => {
    const legacy = path.join('/legacy', 'cli.js');
    const internalNode = path.join('/internal', 'node', 'node.exe');
    mocks.getSetting.mockReturnValue(legacy);
    mocks.existsSync.mockImplementation((p) => p === legacy);
    mocks.resolveInternalNodeBinary.mockReturnValue(internalNode);

    const opts = getClaudeSdkProcessOptions();
    expect(opts.pathToClaudeCodeExecutable).toBe(legacy);
    expect(opts.executable).toBe('node');
    expect(typeof opts.spawnClaudeCodeProcess).toBe('function');
    expect(mocks.logger.info).toHaveBeenCalledWith(
      { cliEntry: legacy, source: 'override', nativeEntry: false, packaged: false },
      'claude engine: entry resolvido',
    );

    const signal = new AbortController().signal;
    const args = [legacy, '--output-format', 'stream-json', '--verbose'];
    const spawnOptions: SpawnOptions = {
      command: 'node',
      args,
      cwd: '/work',
      env: { A: '1', PATH: '/host/bin' },
      signal,
    };
    const child = opts.spawnClaudeCodeProcess!(spawnOptions);
    expect(child).toBeDefined();
    expect(mocks.minimalInternalRuntimeEnv).toHaveBeenCalledWith(internalNode, spawnOptions.env);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [command, spawnedArgs, spawnConfig] = mocks.spawn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe(internalNode);
    expect(spawnedArgs).toBe(args);
    expect(spawnedArgs).toEqual([legacy, '--output-format', 'stream-json', '--verbose']);
    expect(spawnConfig).toEqual({
      cwd: '/work',
      env: { PATH: path.dirname(internalNode), MARK: 'minimal' },
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  });

  it('entry .js sem Node interno em dev => retorno legado sem closure', () => {
    const legacy = path.join('/legacy', 'cli.js');
    mocks.getSetting.mockReturnValue(legacy);
    mocks.existsSync.mockImplementation((p) => p === legacy);

    const opts = getClaudeSdkProcessOptions();
    expect(opts).toEqual({ pathToClaudeCodeExecutable: legacy, executable: 'node' });
    expect(mocks.resolveInternalNodeBinary).toHaveBeenCalledTimes(1);
  });

  it('entry .js sem Node interno no empacotado => fatal', () => {
    const legacy = path.join('/legacy', 'cli.js');
    mocks.isPackagedDistributionRuntime.mockReturnValue(true);
    mocks.getSetting.mockReturnValue(legacy);
    mocks.existsSync.mockImplementation((p) => p === legacy);

    expect(() => getClaudeSdkProcessOptions()).toThrow('Node interno não encontrado');
  });
});

describe('pipeline-shared/sdk-bootstrap - helpers de ambiente', () => {
  it('exports ensureNodeInPath as a sync function (idempotent guard)', () => {
    expect(typeof ensureNodeInPath).toBe('function');
    expect(() => ensureNodeInPath()).not.toThrow();
    expect(() => ensureNodeInPath()).not.toThrow();
  });

  it('exports ensureAuthForSDK as an async function', async () => {
    expect(typeof ensureAuthForSDK).toBe('function');
    await expect(ensureAuthForSDK()).resolves.toBeUndefined();
  });
});

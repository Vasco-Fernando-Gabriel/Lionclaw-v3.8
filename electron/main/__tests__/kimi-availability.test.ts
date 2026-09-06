
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  which: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  spawn: vi.fn(),
  isLoggedIn: vi.fn(),
}));
const getSettingMock = mocks.getSetting;
const whichMock = mocks.which;
const existsSyncMock = mocks.existsSync;
const readFileSyncMock = mocks.readFileSync;
const spawnMock = mocks.spawn;
const isLoggedInMock = mocks.isLoggedIn;

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({ getSetting: mocks.getSetting }));

vi.mock('which', () => ({ default: mocks.which }));

vi.mock('fs', () => ({
  default: {
    existsSync: (p: string) => mocks.existsSync(p),
    readFileSync: (p: string, enc?: unknown) => mocks.readFileSync(p, enc),
  },
  existsSync: (p: string) => mocks.existsSync(p),
  readFileSync: (p: string, enc?: unknown) => mocks.readFileSync(p, enc),
}));

vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => mocks.spawn(...args) }));

vi.mock('@moonshot-ai/kimi-agent-sdk', () => ({ isLoggedIn: () => mocks.isLoggedIn() }));

import {
  resolveKimiBinary,
  resolveKimiHome,
  buildKimiChildEnv,
  isKimiAvailable,
  inspectKimiManagedConfig,
  KimiAuthError,
  KimiUnavailableError,
} from '../agent-runtime/kimi-availability';

describe('Kimi official CLI home', () => {
  it('reutiliza a sessao oficial sem vazar segredos para o child', () => {
    expect(resolveKimiHome()).toBe(path.join(os.homedir(), '.kimi-code'));
    const env = buildKimiChildEnv({
      home: resolveKimiHome(),
      baseEnv: {
        HOME: os.homedir(),
        PATH: '/safe/bin',
        KIMI_API_KEY: 'secret',
        AWS_SECRET_ACCESS_KEY: 'secret',
      },
    });
    expect(env).toMatchObject({
      HOME: os.homedir(),
      PATH: '/safe/bin',
      KIMI_SHARE_DIR: path.join(os.homedir(), '.kimi-code'),
    });
    expect(env).not.toHaveProperty('KIMI_API_KEY');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });
});

function managedConfig(options: { oauth?: boolean; baseUrl?: string; model?: string } = {}): string {
  const oauth = options.oauth ?? true;
  const baseUrl = options.baseUrl ?? 'https://api.kimi.com/coding/v1';
  const model = options.model ?? 'kimi-code/kimi-for-coding';
  return [
    '[providers."managed:kimi-code"]',
    `base_url = "${baseUrl}"`,
    '',
    ...(oauth ? ['[providers."managed:kimi-code".oauth]', 'key = "oauth/kimi-code"', ''] : []),
    `[models."${model}"]`,
    'provider = "managed:kimi-code"',
    'capabilities = [ "thinking", "always_thinking", "tool_use" ]',
    ...(model === 'kimi-code/k3'
      ? ['support_efforts = [ "low", "high", "max" ]', 'default_effort = "max"']
      : []),
    '',
  ].join('\n');
}

function wireDedicatedConfig(content: string): void {
  const configPath = path.join(resolveKimiHome(), 'config.toml');
  existsSyncMock.mockImplementation((p: string) => p === configPath);
  readFileSyncMock.mockImplementation((p: string) => {
    if (p === configPath) return content;
    throw new Error(`unexpected readFileSync: ${p}`);
  });
}

function fakeVersionProc(out: string) {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  return {
    stdout: { on: (_e: string, cb: (b: Buffer) => void) => cb(Buffer.from(out)) },
    on: (event: string, cb: (arg?: unknown) => void) => {
      handlers[event] = cb;
      if (event === 'close') setTimeout(() => cb(), 0);
    },
    kill: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSettingMock.mockReturnValue(undefined);
  existsSyncMock.mockReturnValue(false);
  readFileSyncMock.mockImplementation((p: string) => {
    throw new Error(`unexpected readFileSync: ${p}`);
  });
  whichMock.mockRejectedValue(new Error('not found'));
  isLoggedInMock.mockReturnValue(false);
  spawnMock.mockReturnValue(fakeVersionProc('kimi 0.1.8'));
});

describe('KimiUnavailableError', () => {
  it('is a named Error subclass', () => {
    const e = new KimiUnavailableError('boom');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('KimiUnavailableError');
    expect(e.message).toBe('boom');
  });

  it('keeps auth failures distinguishable from generic availability failures', () => {
    const e = new KimiAuthError('login required');
    expect(e).toBeInstanceOf(KimiUnavailableError);
    expect(e.name).toBe('KimiAuthError');
  });
});

describe('resolveKimiBinary precedence (SPEC-011 §6.7 G-01)', () => {
  it('1) explicit setting path wins when it exists on disk', async () => {
    getSettingMock.mockReturnValue('/opt/custom/kimi');
    existsSyncMock.mockImplementation((p: string) => p === '/opt/custom/kimi');

    expect(await resolveKimiBinary()).toBe('/opt/custom/kimi');
    expect(whichMock).not.toHaveBeenCalled();
  });

  it('2) falls back to which(kimi) when no setting', async () => {
    getSettingMock.mockReturnValue(undefined);
    whichMock.mockResolvedValue('/usr/local/bin/kimi');

    expect(await resolveKimiBinary()).toBe('/usr/local/bin/kimi');
  });

  it('ignores a setting path that does not exist on disk and uses which', async () => {
    getSettingMock.mockReturnValue('/gone/kimi');
    existsSyncMock.mockReturnValue(false);
    whichMock.mockResolvedValue('/usr/local/bin/kimi');

    expect(await resolveKimiBinary()).toBe('/usr/local/bin/kimi');
  });

  it('returns null when nothing resolves (non-Windows)', async () => {
    whichMock.mockRejectedValue(new Error('not found'));
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      expect(await resolveKimiBinary()).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('3) Windows npm fallback probes %APPDATA%\\npm\\kimi.cmd', async () => {
    const original = process.platform;
    const originalAppData = process.env['APPDATA'];
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env['APPDATA'] = 'C:\\Users\\me\\AppData\\Roaming';
    whichMock.mockRejectedValue(new Error('not found'));
    existsSyncMock.mockImplementation((p: string) => p.endsWith('kimi.cmd'));

    try {
      const result = await resolveKimiBinary();
      expect(result).not.toBeNull();
      expect(result?.endsWith('kimi.cmd')).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
      if (originalAppData === undefined) delete process.env['APPDATA'];
      else process.env['APPDATA'] = originalAppData;
    }
  });
});

describe('isKimiAvailable authMode (SPEC-011 §7)', () => {
  it('logged in => subscription, installed true', async () => {
    whichMock.mockResolvedValue('/usr/local/bin/kimi');
    wireDedicatedConfig(managedConfig());

    const res = await isKimiAvailable();
    expect(res.installed).toBe(true);
    expect(res.authenticated).toBe(true);
    expect(res.authMode).toBe('subscription');
    expect(res.managedProviderVerified).toBe(true);
    expect(res.usable).toBe(true);
  });

  it('delega capabilities e effort ao handshake ACP em vez de reinterpretar config.toml', async () => {
    whichMock.mockResolvedValue('/usr/local/bin/kimi');
    wireDedicatedConfig(managedConfig({ model: 'kimi-code/k3' }));
    await expect(isKimiAvailable('kimi-code/k3')).resolves.toMatchObject({
      modelAvailable: true,
      usable: true,
    });

    wireDedicatedConfig(
      managedConfig({ model: 'kimi-code/k3' }).replace(
        'support_efforts = [ "low", "high", "max" ]',
        'support_efforts = [ "low", "high" ]',
      ),
    );
    await expect(isKimiAvailable('kimi-code/k3')).resolves.toMatchObject({
      modelAvailable: true,
      usable: true,
    });
  });

  it('ignora novas capabilities internas enquanto o alias managed continua configurado', () => {
    const before = managedConfig({ model: 'kimi-code/k3' });
    wireDedicatedConfig(before);
    const first = inspectKimiManagedConfig();

    wireDedicatedConfig(before.replace(
      'capabilities = [ "thinking", "always_thinking", "tool_use" ]',
      'capabilities = [ "thinking", "always_thinking", "tool_use", "future_capability" ]',
    ));
    const second = inspectKimiManagedConfig();

    expect(first.managedProviderVerified).toBe(true);
    expect(second.managedProviderVerified).toBe(true);
    expect(first.availableModels).toEqual(second.availableModels);
  });

  it('not logged in => none (no api-key fallback)', async () => {
    whichMock.mockResolvedValue('/usr/local/bin/kimi');
    isLoggedInMock.mockReturnValue(false);

    const res = await isKimiAvailable();
    expect(res.authenticated).toBe(false);
    expect(res.authMode).toBe('none');
  });

  it('installed:false when resolver returns null (no bundled bin)', async () => {
    whichMock.mockRejectedValue(new Error('not found'));
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const res = await isKimiAvailable();
      expect(res.installed).toBe(false);
      expect(res.version).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('reports a best-effort version when the binary resolves', async () => {
    whichMock.mockResolvedValue('/usr/local/bin/kimi');
    isLoggedInMock.mockReturnValue(true);
    spawnMock.mockReturnValue(fakeVersionProc('kimi 0.1.8'));

    const res = await isKimiAvailable();
    expect(res.version).toBe('kimi 0.1.8');
  });
});

describe('version probe Windows .cmd shell rule (SPEC-011 §6.7)', () => {
  it('uses shell:true when the binary path ends with .cmd on win32', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    getSettingMock.mockReturnValue('C:\\Users\\me\\AppData\\Roaming\\npm\\kimi.cmd');
    existsSyncMock.mockReturnValue(true);
    isLoggedInMock.mockReturnValue(true);
    spawnMock.mockReturnValue(fakeVersionProc('kimi 0.1.8'));

    try {
      await isKimiAvailable();
      const spawnOpts = spawnMock.mock.calls[0][2] as { shell: boolean };
      expect(spawnOpts.shell).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});

describe('detectKimiLogin config.toml fallback when SDK throws (ITEM 2 / S6)', () => {
  const kimiCodeConfig = path.join(resolveKimiHome(), 'config.toml');

  function makeSdkThrow(): void {
    isLoggedInMock.mockImplementation(() => {
      throw new Error('Cannot find module @moonshot-ai/kimi-agent-sdk');
    });
  }

  function wireConfigPresent(content: string): void {
    whichMock.mockResolvedValue('/usr/local/bin/kimi');
    existsSyncMock.mockImplementation((p: string) => p === kimiCodeConfig);
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === kimiCodeConfig) return content;
      throw new Error(`unexpected readFileSync: ${p}`);
    });
  }

  it('case 1: api_key sem OAuth nao e tratado como assinatura', async () => {
    makeSdkThrow();
    wireConfigPresent(
      [
        '[providers."managed:kimi-code"]',
        'base_url = "https://api.kimi.com/coding/v1"',
        'api_key = "sk-secret-value"',
        '',
        '[models.kimi]',
        'context = 200000',
        '',
      ].join('\n'),
    );

    const res = await isKimiAvailable();
    expect(res.installed).toBe(true);
    expect(res.authenticated).toBe(false);
    expect(res.authMode).toBe('none');
  });

  it('case 2: SDK throws + no provider / empty api_key / no oauth => authenticated false (no false positive)', async () => {
    makeSdkThrow();
    wireConfigPresent(
      [
        '[providers."managed:kimi-code"]',
        'base_url = "https://api.moonshot.cn"',
        'api_key = ""',
        '',
        '[models.kimi]',
        'api_key = "leaked-but-wrong-section"',
        'context = 200000',
        '',
      ].join('\n'),
    );

    const res = await isKimiAvailable();
    expect(res.installed).toBe(true);
    expect(res.authenticated).toBe(false);
    expect(res.authMode).toBe('none');
  });

  it('case 3: OAuth managed + base oficial + modelo allowlisted => authenticated/usable true', async () => {
    makeSdkThrow();
    wireConfigPresent(
      [
        '[providers."managed:kimi-code"]',
        'base_url = "https://api.kimi.com/coding/v1"',
        '',
        '[providers."managed:kimi-code".oauth]',
        'access_token = "tok-123"',
        'refresh_token = "ref-456"',
        '',
        '[models."kimi-code/kimi-for-coding"]',
        'provider = "managed:kimi-code"',
        'capabilities = [ "thinking", "always_thinking", "tool_use" ]',
        '',
      ].join('\n'),
    );

    const res = await isKimiAvailable();
    expect(res.installed).toBe(true);
    expect(res.authenticated).toBe(true);
    expect(res.authMode).toBe('subscription');
    expect(res.managedProviderVerified).toBe(true);
    expect(res.modelAvailable).toBe(true);
    expect(res.usable).toBe(true);
  });

  it('nao usa base_url do config como segunda autoridade sobre a sessao oficial', async () => {
    makeSdkThrow();
    wireConfigPresent(managedConfig({ baseUrl: 'https://proxy.example/v1' }));
    const res = await isKimiAvailable('kimi-code/kimi-for-coding');
    expect(res.authenticated).toBe(true);
    expect(res.authMode).toBe('subscription');
    expect(res.managedProviderVerified).toBe(true);
    expect(res.usable).toBe(true);
  });

  it('aceita campos internos criados pelo login oficial junto ao OAuth', async () => {
    makeSdkThrow();
    wireConfigPresent([
      '[providers."managed:kimi-code"]',
      'base_url = "https://api.kimi.com/coding/v1"',
      'api_key = "sk-byok"',
      '',
      '[providers."managed:kimi-code".oauth]',
      'access_token = "tok-123"',
      '',
      '[models."kimi-code/kimi-for-coding"]',
      'provider = "managed:kimi-code"',
      'capabilities = [ "thinking", "always_thinking", "tool_use" ]',
    ].join('\n'));

    await expect(isKimiAvailable('kimi-code/kimi-for-coding')).resolves.toMatchObject({
      authenticated: true,
      managedProviderVerified: true,
      usable: true,
    });
  });

  it('nao rejeita a sessao oficial porque o CLI possui providers auxiliares', async () => {
    makeSdkThrow();
    wireConfigPresent(`${managedConfig()}\n[providers.third_party]\nbase_url = "https://proxy.example/v1"\n`);

    await expect(isKimiAvailable('kimi-code/kimi-for-coding')).resolves.toMatchObject({
      authenticated: true,
      managedProviderVerified: true,
      usable: true,
    });
  });
});

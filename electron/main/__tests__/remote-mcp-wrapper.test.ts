import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

let SANDBOX = '';

beforeEach(() => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-remote-mcp-'));
  vi.spyOn(os, 'homedir').mockReturnValue(SANDBOX);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {}
  vi.resetModules();
});

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const BLOTATO_KEY_VAR = 'BLOTATO_API_KEY';
const SECRET_VALUE = 'blt-SECRET_VALUE_XYZ.abcdef.NEVER_TO_DISK';

import {
  generateRemoteMcpWrapperSource,
  ensureRemoteMcpWrapperSync,
  isSessionDirRemoteMcpWrapperEntry,
  resolveRemoteMcpWrapperPath,
  REMOTE_MCP_STARTUP_LOCK_DIRNAME,
  type RemoteMcpBridgeRuntime,
  type RemoteMcpDescriptor,
} from '../remote-mcp-wrapper';

function testRuntime(): RemoteMcpBridgeRuntime {
  return {
    command: process.execPath,
    proxyEntryPath: path.join(SANDBOX, 'fixtures', 'mcp-remote', 'proxy.js'),
    clientEntryPath: path.join(SANDBOX, 'fixtures', 'mcp-remote', 'client.js'),
    env: { ...process.env },
  };
}

function generateSource(descriptor: RemoteMcpDescriptor): string {
  return generateRemoteMcpWrapperSource(descriptor, testRuntime());
}

function ensureWrapper(descriptor: RemoteMcpDescriptor): string {
  return ensureRemoteMcpWrapperSync(descriptor, testRuntime());
}

function blotatoDescriptor(): RemoteMcpDescriptor {
  return {
    providerId: 'blotato',
    mcpUrl: 'https://mcp.blotato.com/mcp',
    runtimeSubdir: 'blotato',
    wrapperFileName: 'blotato-mcp-wrapper.js',
    auth: { mode: 'header', headerName: 'blotato-api-key', secretEnvVar: BLOTATO_KEY_VAR },
  };
}

function higgsfieldDescriptor(): RemoteMcpDescriptor {
  return {
    providerId: 'higgsfield',
    mcpUrl: 'https://mcp.higgsfield.ai/mcp',
    runtimeSubdir: 'higgsfield',
    wrapperFileName: 'higgsfield-mcp-wrapper.js',
    auth: { mode: 'session-dir', configDir: path.join(SANDBOX, '.lionclaw', 'runtime', 'higgsfield', 'mcp-auth') },
  };
}

function walk(dir: string, acc: string[]): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

describe('remote-mcp-wrapper :: modo header (Blotato)', () => {
  it('source referencia process.env e o NOME da env var (metadata, nao segredo)', () => {
    const src = generateSource(blotatoDescriptor());
    expect(src).toContain('process.env[API_KEY_VAR]');
    expect(src).toContain(BLOTATO_KEY_VAR);
  });

  it('anti-plaintext (NAO-tautologico): valor do segredo nunca aparece no source nem em disco', () => {
    const prev = process.env[BLOTATO_KEY_VAR];
    process.env[BLOTATO_KEY_VAR] = SECRET_VALUE;
    try {
      const src = generateSource(blotatoDescriptor());
      expect(src).not.toContain(SECRET_VALUE);

      ensureWrapper(blotatoDescriptor());

      const files = walk(SANDBOX, []);
      expect(files.length).toBeGreaterThan(0);
      const hits: string[] = [];
      for (const file of files) {
        let content: string;
        try {
          content = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (content.includes(SECRET_VALUE)) hits.push(file);
      }
      expect(hits).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env[BLOTATO_KEY_VAR];
      else process.env[BLOTATO_KEY_VAR] = prev;
    }
  });

  it('source contem preflight CR/LF (/[\\r\\n]/ + exit 2)', () => {
    const src = generateSource(blotatoDescriptor());
    expect(src).toContain('/[\\r\\n]/.test(apiKey)');
    expect(src).toContain('process.exit(2)');
  });

  it("source monta --header como HEADER_NAME + ': ' + ...", () => {
    const src = generateSource(blotatoDescriptor());
    expect(src).toContain("'--header'");
    expect(src).toContain("HEADER_NAME + ': ' + apiKey.trim()");
    expect(src).toContain('"blotato-api-key"');
  });

  it('source do modo header herda process.env direto no spawn (sem clonar)', () => {
    const src = generateSource(blotatoDescriptor());
    expect(src).toContain('const env = process.env;');
    expect(src).not.toContain('Object.assign');
    expect(src).not.toContain('MCP_REMOTE_CONFIG_DIR');
  });

  it('generateRemoteMcpWrapperSource LANCA quando headerName viola a regex', () => {
    const invalids = ['x: y', 'a\nb', 'has space', 'under_score', ''];
    for (const headerName of invalids) {
      const d: RemoteMcpDescriptor = {
        ...blotatoDescriptor(),
        auth: { mode: 'header', headerName, secretEnvVar: BLOTATO_KEY_VAR },
      };
      expect(() => generateSource(d)).toThrow(/headerName invalido/);
    }
  });

  it('aceita headerName valido (/^[A-Za-z0-9-]+$/)', () => {
    const d: RemoteMcpDescriptor = {
      ...blotatoDescriptor(),
      auth: { mode: 'header', headerName: 'X-Api-Key-2', secretEnvVar: BLOTATO_KEY_VAR },
    };
    expect(() => generateSource(d)).not.toThrow();
  });
});

describe('remote-mcp-wrapper :: paridade de runtime (comum aos dois modos)', () => {
  it('mapeia exit por sinal como 128 + 15 literal; code propagado; default exit(0)', () => {
    for (const d of [blotatoDescriptor(), higgsfieldDescriptor()]) {
      const src = generateSource(d);
      expect(src).toContain('if (code !== null) process.exit(code);');
      expect(src).toContain('if (signal) process.exit(128 + 15);');
      expect(src).toContain('process.exit(0);');
      expect(src).not.toContain('128 + signal');
    }
  });

  it('trata child.on(error) com exit 4', () => {
    for (const d of [blotatoDescriptor(), higgsfieldDescriptor()]) {
      const src = generateSource(d);
      expect(src).toContain("child.on('error'");
      expect(src).toContain('process.exit(4)');
    }
  });

  it('usa o Node atual para executar a closure física do bridge', () => {
    for (const d of [blotatoDescriptor(), higgsfieldDescriptor()]) {
      const src = generateSource(d);
      expect(src).toContain('const command = process.execPath;');
      expect(src).toContain('const MCP_REMOTE_ENTRY = ');
      expect(src).not.toContain("'npx'");
      expect(src).not.toContain('mcp-remote@latest');
    }
  });

  it('forward de SIGTERM/SIGINT via child.kill(signal)', () => {
    for (const d of [blotatoDescriptor(), higgsfieldDescriptor()]) {
      const src = generateSource(d);
      expect(src).toContain("process.on('SIGTERM'");
      expect(src).toContain("process.on('SIGINT'");
      expect(src).toContain('child.kill(signal)');
    }
  });

  it('args base sempre entry física + url + --silent', () => {
    for (const d of [blotatoDescriptor(), higgsfieldDescriptor()]) {
      const src = generateSource(d);
      expect(src).toContain('MCP_REMOTE_ENTRY');
      expect(src).toContain('MCP_URL');
      expect(src).toContain("'--silent'");
    }
  });
});

describe('remote-mcp-wrapper :: subprocess real do preflight (header, offline)', () => {
  it('CR/LF na credencial -> exit 2 via process.execPath', () => {
    const wrapperPath = ensureWrapper(blotatoDescriptor());
    const res = spawnSync(process.execPath, [wrapperPath], {
      env: { ...process.env, [BLOTATO_KEY_VAR]: 'abc\nx' },
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
  });

  it('credencial ausente -> exit 2 via process.execPath', () => {
    const wrapperPath = ensureWrapper(blotatoDescriptor());
    const env = { ...process.env };
    delete env[BLOTATO_KEY_VAR];
    const res = spawnSync(process.execPath, [wrapperPath], {
      env,
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
  });
});

describe('remote-mcp-wrapper :: modo session-dir (Higgsfield)', () => {
  it('source usa MCP_REMOTE_CONFIG_DIR clonando via Object.assign', () => {
    const src = generateSource(higgsfieldDescriptor());
    expect(src).toContain('MCP_REMOTE_CONFIG_DIR: AUTH_DIR');
    expect(src).toContain('Object.assign({}, process.env');
  });

  it('source mantem preflight hasTokenFile (*_tokens.json) com exit 2, sem embutir token', () => {
    const src = generateSource(higgsfieldDescriptor());
    expect(src).toContain('function hasTokenFile(dir)');
    expect(src).toContain("entry.name.endsWith('_tokens.json')");
    expect(src).toContain('if (!hasTokenFile(AUTH_DIR))');
    expect(src).toContain('process.exit(2)');
  });

  it('source contem mkdirSync(... mode: 0o700) APOS o preflight', () => {
    const src = generateSource(higgsfieldDescriptor());
    expect(src).toContain('fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })');
    const preflightIdx = src.indexOf('if (!hasTokenFile(AUTH_DIR))');
    const mkdirIdx = src.indexOf('fs.mkdirSync(AUTH_DIR');
    expect(preflightIdx).toBeGreaterThan(-1);
    expect(mkdirIdx).toBeGreaterThan(preflightIdx);
  });
});

describe('remote-mcp-wrapper :: filesystem (ensureRemoteMcpWrapperSync)', () => {
  it('escreve o wrapper em runtime/<subdir>/<file>', () => {
    const wrapperPath = ensureWrapper(blotatoDescriptor());
    const expected = resolveRemoteMcpWrapperPath(blotatoDescriptor());
    expect(wrapperPath).toBe(expected);
    expect(wrapperPath).toBe(path.join(SANDBOX, '.lionclaw', 'runtime', 'blotato', 'blotato-mcp-wrapper.js'));
    expect(fs.existsSync(wrapperPath)).toBe(true);
  });

  it('aplica mode 0700 no wrapper e no dir (non-win32)', () => {
    if (process.platform === 'win32') return;
    const wrapperPath = ensureWrapper(blotatoDescriptor());
    const fileMode = fs.statSync(wrapperPath).mode & 0o777;
    expect(fileMode).toBe(0o700);
    const dirMode = fs.statSync(path.dirname(wrapperPath)).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it('session-dir garante DOIS dirs 0700 (runtime root + configDir)', () => {
    const d = higgsfieldDescriptor();
    ensureWrapper(d);
    const root = path.join(SANDBOX, '.lionclaw', 'runtime', 'higgsfield');
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync((d.auth as { mode: 'session-dir'; configDir: string }).configDir)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      expect(fs.statSync((d.auth as { mode: 'session-dir'; configDir: string }).configDir).mode & 0o777).toBe(0o700);
    }
  });

  it('idempotente: segunda chamada reescreve sem erro com conteudo identico', () => {
    const wrapperPath = ensureWrapper(blotatoDescriptor());
    const first = fs.readFileSync(wrapperPath, 'utf8');
    const wrapperPath2 = ensureWrapper(blotatoDescriptor());
    const second = fs.readFileSync(wrapperPath2, 'utf8');
    expect(wrapperPath2).toBe(wrapperPath);
    expect(second).toBe(first);
  });

  it('full-tree scan: secret fake nao aparece em nenhum arquivo sob a sandbox', () => {
    const prev = process.env[BLOTATO_KEY_VAR];
    process.env[BLOTATO_KEY_VAR] = SECRET_VALUE;
    try {
      ensureWrapper(blotatoDescriptor());
      ensureWrapper(higgsfieldDescriptor());
      const files = walk(SANDBOX, []);
      expect(files.length).toBeGreaterThan(0);
      const hits: string[] = [];
      for (const file of files) {
        let content: string;
        try {
          content = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (content.includes(SECRET_VALUE)) hits.push(file);
      }
      expect(hits).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env[BLOTATO_KEY_VAR];
      else process.env[BLOTATO_KEY_VAR] = prev;
    }
  });
});

describe('remote-mcp-wrapper :: lock de arranque por auth dir (session-dir)', () => {
  function authDir(): string {
    return (higgsfieldDescriptor().auth as { mode: 'session-dir'; configDir: string }).configDir;
  }

  function writeFakeProxy(logFile: string, holdMs: number): void {
    const proxyPath = testRuntime().proxyEntryPath;
    fs.mkdirSync(path.dirname(proxyPath), { recursive: true });
    fs.writeFileSync(
      proxyPath,
      [
        "const fs = require('node:fs');",
        `const log = ${JSON.stringify(logFile)};`,
        "fs.appendFileSync(log, process.pid + ':start:' + Date.now() + String.fromCharCode(10));",
        `setTimeout(() => { fs.appendFileSync(log, process.pid + ':end:' + Date.now() + String.fromCharCode(10)); process.exit(0); }, ${holdMs});`,
      ].join('\n'),
    );
  }

  function runWrapper(wrapperPath: string): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [wrapperPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('exit', (code) => resolve({ code, stderr }));
    });
  }

  it('source adquire o lock com mkdirSync atomico, detecta dono morto e libera na saida', () => {
    const src = generateSource(higgsfieldDescriptor());
    expect(src).toContain(`path.join(AUTH_DIR, ${JSON.stringify(REMOTE_MCP_STARTUP_LOCK_DIRNAME)})`);
    expect(src).toContain('fs.mkdirSync(LOCK_DIR)');
    expect(src).toContain("err.code === 'EEXIST'");
    expect(src).toContain('process.kill(pid, 0)');
    expect(src).toContain("process.on('exit', releaseLock)");
    expect(src).toContain('tokenSignature(AUTH_DIR) !== tokensBefore');
    const lockIdx = src.indexOf('while (!tryAcquireLock())');
    const spawnIdx = src.indexOf('const child = spawn(');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(spawnIdx).toBeGreaterThan(lockIdx);
  });

  it('modo header nao ganha lock (sem auth dir compartilhado)', () => {
    const src = generateSource(blotatoDescriptor());
    expect(src).not.toContain('tryAcquireLock');
  });

  it('dois wrappers concorrentes: o segundo mcp-remote so inicia depois que o primeiro terminou', async () => {
    const dir = authDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'abc_tokens.json'), '{}');
    const logFile = path.join(SANDBOX, 'proxy.log');
    writeFakeProxy(logFile, 400);
    const wrapperPath = ensureWrapper(higgsfieldDescriptor());

    const [a, b] = await Promise.all([runWrapper(wrapperPath), runWrapper(wrapperPath)]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);

    const events = fs
      .readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [pid, kind, at] = line.split(':');
        return { pid, kind, at: Number(at) };
      });
    const starts = events.filter((e) => e.kind === 'start').sort((x, y) => x.at - y.at);
    const ends = events.filter((e) => e.kind === 'end').sort((x, y) => x.at - y.at);
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(starts[1].at).toBeGreaterThanOrEqual(ends[0].at);
    expect(fs.existsSync(path.join(dir, REMOTE_MCP_STARTUP_LOCK_DIRNAME))).toBe(false);
  }, 20000);

  it('lock deixado por processo morto e removido e o wrapper segue', async () => {
    const dir = authDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'abc_tokens.json'), '{}');
    const lockDir = path.join(dir, REMOTE_MCP_STARTUP_LOCK_DIRNAME);
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 999999999, at: Date.now() }));
    const logFile = path.join(SANDBOX, 'proxy.log');
    writeFakeProxy(logFile, 50);
    const wrapperPath = ensureWrapper(higgsfieldDescriptor());

    const startedAt = Date.now();
    const run = await runWrapper(wrapperPath);
    expect(run.code, run.stderr).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(false);
  }, 20000);

  it('token invalidado enquanto outro processo segura o lock: sai com 2 sem iniciar o mcp-remote', async () => {
    const dir = authDir();
    fs.mkdirSync(dir, { recursive: true });
    const tokenFile = path.join(dir, 'abc_tokens.json');
    fs.writeFileSync(tokenFile, '{}');
    const lockDir = path.join(dir, REMOTE_MCP_STARTUP_LOCK_DIRNAME);
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const logFile = path.join(SANDBOX, 'proxy.log');
    writeFakeProxy(logFile, 50);
    const wrapperPath = ensureWrapper(higgsfieldDescriptor());

    const pending = runWrapper(wrapperPath);
    await new Promise((resolve) => setTimeout(resolve, 600));
    fs.rmSync(tokenFile);
    fs.rmSync(lockDir, { recursive: true, force: true });
    const run = await pending;

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('aguardando outro processo');
    expect(run.stderr).toContain('invalidada por outro processo');
    expect(fs.existsSync(logFile)).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(false);
  }, 20000);

  it('isSessionDirRemoteMcpWrapperEntry reconhece so wrapper session-dir', () => {
    const higgs = ensureWrapper(higgsfieldDescriptor());
    const blotato = ensureWrapper(blotatoDescriptor());
    expect(isSessionDirRemoteMcpWrapperEntry(higgs)).toBe(true);
    expect(isSessionDirRemoteMcpWrapperEntry(blotato)).toBe(false);
    expect(isSessionDirRemoteMcpWrapperEntry(path.join(SANDBOX, 'nao-existe-mcp-wrapper.js'))).toBe(false);
    expect(isSessionDirRemoteMcpWrapperEntry(undefined)).toBe(false);
  });
});

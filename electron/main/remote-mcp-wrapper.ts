import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { resolveMcpServerEntry } from './mcp-path-resolver';
import {
  isPackagedDistributionRuntime,
  minimalInternalRuntimeEnv,
  resolveInternalNodeBinary,
} from './distribution-runtime';

const logger = createLogger('remote-mcp-wrapper');

const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;

export type RemoteMcpAuth =
  | {
      mode: 'header';
      headerName: string;
      secretEnvVar: string;
    }
  | {
      mode: 'session-dir';
      configDir: string;
    };

export interface RemoteMcpDescriptor {
  providerId: string;
  mcpUrl: string;
  runtimeSubdir: string;
  wrapperFileName: string;
  auth: RemoteMcpAuth;
}

export interface RemoteMcpBridgeRuntime {
  command: string;
  proxyEntryPath: string;
  clientEntryPath: string;
  env: NodeJS.ProcessEnv;
}

export function resolveRemoteMcpBridgeRuntime(): RemoteMcpBridgeRuntime {
  const relativeProxy = 'node_modules/mcp-remote/dist/proxy.js';
  const resolved = resolveMcpServerEntry('remote-bridge', relativeProxy);
  if (!resolved.entryPath) {
    throw new Error(`Runtime mcp-remote físico não encontrado; candidatos: ${resolved.candidates.join(', ')}`);
  }
  const proxyEntryPath = resolved.entryPath;
  const clientEntryPath = path.join(path.dirname(proxyEntryPath), 'client.js');
  if (!fs.statSync(clientEntryPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Runtime mcp-remote-client físico não encontrado: ${clientEntryPath}`);
  }
  const packaged = isPackagedDistributionRuntime();
  const command = packaged ? resolveInternalNodeBinary() : 'node';
  return {
    command,
    proxyEntryPath,
    clientEntryPath,
    env: packaged ? minimalInternalRuntimeEnv(command) : { ...process.env },
  };
}

export function resolveRemoteMcpWrapperPath(descriptor: RemoteMcpDescriptor): string {
  return path.join(getLionClawHome(), 'runtime', descriptor.runtimeSubdir, descriptor.wrapperFileName);
}

export const REMOTE_MCP_STARTUP_LOCK_DIRNAME = '.lionclaw-startup.lock';
export const REMOTE_MCP_SESSION_DIR_DISCOVERY_TIMEOUT_MS = 30000;

const sessionDirWrapperCache = new Map<string, { mtimeMs: number; value: boolean }>();

export function isSessionDirRemoteMcpWrapperEntry(entryPath: string | undefined): boolean {
  if (!entryPath || !entryPath.endsWith('-mcp-wrapper.js')) return false;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(entryPath).mtimeMs;
  } catch {
    return false;
  }
  const cached = sessionDirWrapperCache.get(entryPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;
  let value = false;
  try {
    value = fs.readFileSync(entryPath, 'utf8').includes('MCP_REMOTE_CONFIG_DIR');
  } catch {
    value = false;
  }
  sessionDirWrapperCache.set(entryPath, { mtimeMs, value });
  return value;
}

export function generateRemoteMcpWrapperSource(
  descriptor: RemoteMcpDescriptor,
  runtime: RemoteMcpBridgeRuntime = resolveRemoteMcpBridgeRuntime(),
): string {
  const { auth, mcpUrl, providerId } = descriptor;

  const runtimeTail = (
    command: string,
    args: string,
    env: string,
    hooks: { afterSpawn?: string; beforeExit?: string } = {},
  ): string => `const command = ${command};
const args = ${args};
const env = ${env};

const child = spawn(command, args, {
  stdio: 'inherit',
  env,
});
${hooks.afterSpawn ?? ''}
const forward = (signal) => {
  try { child.kill(signal); } catch (_err) { /* ignore */ }
};
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));

child.on('error', (err) => {
  ${hooks.beforeExit ?? ''}
  process.stderr.write('[lionclaw-${providerId}] falha ao iniciar mcp-remote: ' + err.message + '\\n');
  process.exit(4);
});

child.on('exit', (code, signal) => {
  ${hooks.beforeExit ?? ''}
  if (code !== null) process.exit(code);
  if (signal) process.exit(128 + 15);
  process.exit(0);
});
`;

  if (auth.mode === 'header') {
    if (!HEADER_NAME_RE.test(auth.headerName)) {
      throw new Error('headerName invalido: ' + auth.headerName);
    }

    return `#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

const MCP_URL = ${JSON.stringify(mcpUrl)};
const MCP_REMOTE_ENTRY = ${JSON.stringify(runtime.proxyEntryPath)};
const API_KEY_VAR = ${JSON.stringify(auth.secretEnvVar)};
const HEADER_NAME = ${JSON.stringify(auth.headerName)};

const apiKey = process.env[API_KEY_VAR];
if (!apiKey || !apiKey.trim()) {
  process.stderr.write('[lionclaw-${providerId}] ' + API_KEY_VAR + ' ausente. Cadastre em LionClaw > Vault > ${providerId}.\\n');
  process.exit(2);
}

// D4.2: rejeitar CR/LF no valor da credencial (defesa contra header injection).
if (/[\\r\\n]/.test(apiKey)) {
  process.stderr.write('[lionclaw-${providerId}] valor de credencial invalido (CR/LF nao permitido).\\n');
  process.exit(2);
}

${runtimeTail(
  `process.execPath`,
  `[
  MCP_REMOTE_ENTRY,
  MCP_URL,
  '--header', HEADER_NAME + ': ' + apiKey.trim(),
  '--silent',
]`,
  `process.env`,
)}`;
  }

  return `#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const AUTH_DIR = ${JSON.stringify(auth.configDir)};
const MCP_URL = ${JSON.stringify(mcpUrl)};
const MCP_REMOTE_ENTRY = ${JSON.stringify(runtime.proxyEntryPath)};

function hasTokenFile(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && hasTokenFile(full)) return true;
      if (entry.isFile() && entry.name.endsWith('_tokens.json')) return true;
    }
  } catch (_err) {
    return false;
  }
  return false;
}

if (!hasTokenFile(AUTH_DIR)) {
  process.stderr.write('[lionclaw-${providerId}] ${providerId} nao autenticado. Conecte em LionClaw > Vault > ${providerId}.\\n');
  process.exit(2);
}

fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });

const LOCK_DIR = path.join(AUTH_DIR, ${JSON.stringify(REMOTE_MCP_STARTUP_LOCK_DIRNAME)});
const LOCK_OWNER = path.join(LOCK_DIR, 'owner.json');
const LOCK_WAIT_MS = 45000;
const LOCK_STALE_MS = 60000;
const LOCK_HOLD_MS = 8000;
const LOCK_POLL_MS = 150;
let lockHeld = false;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err) && err.code === 'EPERM';
  }
}

function lockIsStale() {
  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(LOCK_OWNER, 'utf8'));
  } catch (_err) {
    owner = null;
  }
  if (owner && typeof owner.pid === 'number' && !pidAlive(owner.pid)) return true;
  try {
    return Date.now() - fs.statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS;
  } catch (_err) {
    return true;
  }
}

function tryAcquireLock() {
  try {
    fs.mkdirSync(LOCK_DIR);
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
  fs.writeFileSync(LOCK_OWNER, JSON.stringify({ pid: process.pid, at: Date.now() }));
  lockHeld = true;
  return true;
}

function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch (_err) { /* ignore */ }
}

function tokenSignature(dir) {
  const parts = [];
  const visit = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ${JSON.stringify(REMOTE_MCP_STARTUP_LOCK_DIRNAME)}) visit(full);
      } else if (entry.isFile() && entry.name.endsWith('_tokens.json')) {
        try {
          parts.push(full + ':' + fs.statSync(full).mtimeMs + ':' + fs.statSync(full).size);
        } catch (_err) { /* ignore */ }
      }
    }
  };
  visit(dir);
  return parts.sort().join('|');
}

const lockStartedAt = Date.now();
let waitNoticed = false;
while (!tryAcquireLock()) {
  if (lockIsStale()) {
    try {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    } catch (_err) { /* ignore */ }
    continue;
  }
  if (Date.now() - lockStartedAt > LOCK_WAIT_MS) {
    process.stderr.write('[lionclaw-${providerId}] outro processo segurou o arranque por mais de ' + LOCK_WAIT_MS + 'ms; seguindo sem lock.\\n');
    break;
  }
  if (!waitNoticed) {
    waitNoticed = true;
    process.stderr.write('[lionclaw-${providerId}] aguardando outro processo ${providerId} terminar o arranque (renovacao de token).\\n');
  }
  sleepSync(LOCK_POLL_MS);
}
process.on('exit', releaseLock);

if (!hasTokenFile(AUTH_DIR)) {
  releaseLock();
  process.stderr.write('[lionclaw-${providerId}] sessao ${providerId} invalidada por outro processo durante o arranque. Conecte em LionClaw > Vault > ${providerId}.\\n');
  process.exit(2);
}

${runtimeTail(
  `process.execPath`,
  `[MCP_REMOTE_ENTRY, MCP_URL, '--silent']`,
  `Object.assign({}, process.env, {
  MCP_REMOTE_CONFIG_DIR: AUTH_DIR,
})`,
  {
    afterSpawn: `
const tokensBefore = tokenSignature(AUTH_DIR);
const spawnedAt = Date.now();
const holdTimer = setInterval(() => {
  if (!lockHeld) {
    clearInterval(holdTimer);
    return;
  }
  if (Date.now() - spawnedAt >= LOCK_HOLD_MS || tokenSignature(AUTH_DIR) !== tokensBefore) {
    clearInterval(holdTimer);
    releaseLock();
  }
}, 250);
holdTimer.unref();
`,
    beforeExit: `releaseLock();`,
  },
)}`;
}

function ensurePrivateDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
  }
}

export function ensureRemoteMcpWrapperSync(
  descriptor: RemoteMcpDescriptor,
  runtime: RemoteMcpBridgeRuntime = resolveRemoteMcpBridgeRuntime(),
): string {
  const root = path.join(getLionClawHome(), 'runtime', descriptor.runtimeSubdir);
  ensurePrivateDirSync(root);
  if (descriptor.auth.mode === 'session-dir') {
    ensurePrivateDirSync(descriptor.auth.configDir);
  }

  const wrapperPath = resolveRemoteMcpWrapperPath(descriptor);
  fs.writeFileSync(wrapperPath, generateRemoteMcpWrapperSource(descriptor, runtime), {
    encoding: 'utf8',
    mode: 0o700,
  });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(wrapperPath, 0o700);
    } catch {}
  }

  logger.info({ providerId: descriptor.providerId, wrapperPath }, 'Remote MCP wrapper ensured');
  return wrapperPath;
}

import { createHash, randomUUID } from 'crypto';
import { fork, spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'path';
import {
  minimalInternalRuntimeEnv,
  resolveInternalNodeBinary,
  resolveOpenDesignSidecar,
  resolvePackagedCodeburnEntry,
  resolvePackagedMcpRuntime,
} from './distribution-runtime';
// @ts-expect-error módulo ESM compartilhado com o harness Node.
import { DISTRIBUTION_SMOKE_MCP_CORE_IDS } from '../../distribution/smoke-contract.mjs';
import { resolveRemoteMcpBridgeRuntime } from './remote-mcp-wrapper';

function checked(result: ReturnType<typeof spawnSync>, label: string): string {
  if (result.error || result.status !== 0) {
    throw new Error(`${label} falhou: ${result.error?.message ?? String(result.stderr ?? result.stdout)}`);
  }
  return String(result.stdout ?? '').trim();
}

function smokeRuntimeEnv(nodePath: string): Record<string, string> {
  return minimalInternalRuntimeEnv(nodePath);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`processo ${child.pid} não encerrou`)), timeoutMs);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}

async function stopTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore', timeout: 10_000,
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* já encerrou */ } }
  }
  try { await waitForExit(child, 5_000); } catch {
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* já encerrou */ } }
    }
    await waitForExit(child, 5_000);
  }
}

async function probeNativeAddons(): Promise<{ canvas: string; keytar: string }> {
  const canvasModule = await import('@napi-rs/canvas');
  const canvas = canvasModule.createCanvas(1, 1);
  if (canvas.width !== 1 || canvas.height !== 1 || typeof canvas.getContext('2d').fillRect !== 'function') {
    throw new Error('canvas nativo não criou contexto 2D real');
  }
  const importedKeytar = await import('keytar');
  const keytar = 'default' in importedKeytar ? importedKeytar.default : importedKeytar;
  if (!keytar || typeof keytar.getPassword !== 'function' || typeof keytar.setPassword !== 'function') {
    throw new Error('keytar nativo não expôs API esperada');
  }
  return { canvas: 'createCanvas(1,1)', keytar: 'native-api-loaded' };
}

async function probeExcalidrawRenderer(): Promise<'exportToSvg-svg'> {
  const { BrowserWindow } = await import('electron');
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  try {
    const html = `<!doctype html><html><body><div id="result"></div><script src="lionclaw-asset://host/excalidraw-bundle.js"></script></body></html>`;
    await Promise.race([
      win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Excalidraw bundle load timeout')), 20_000),
      ),
    ]);
    const tagName = await win.webContents.executeJavaScript(`(async () => {
      const api = globalThis.ExcalidrawBundle;
      if (!api || typeof api.exportToSvg !== 'function') throw new Error('ExcalidrawBundle.exportToSvg ausente');
      const svg = await api.exportToSvg({ elements: [], appState: { viewBackgroundColor: '#191919' }, files: {} });
      return svg && svg.tagName;
    })()`, true) as unknown;
    if (String(tagName).toLowerCase() !== 'svg') {
      throw new Error(`Excalidraw exportToSvg retornou ${String(tagName)}`);
    }
    return 'exportToSvg-svg';
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function probeCodeburn(smokeRoot: string): string {
  const node = resolveInternalNodeBinary();
  const entry = resolvePackagedCodeburnEntry();
  const home = path.join(smokeRoot, 'codeburn report home');
  const cache = path.join(home, '.cache', 'codeburn');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'litellm-pricing.json'), JSON.stringify({
    timestamp: Date.now(),
    data: {},
  }));
  const output = checked(spawnSync(node, [entry, 'report', '--format', 'json', '--period', 'today'], {
    env: { ...smokeRuntimeEnv(node), HOME: home, USERPROFILE: home },
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 60_000,
  }), 'Codeburn report');
  const report = JSON.parse(output) as { overview?: unknown; projects?: unknown };
  if (!report.overview || !Array.isArray(report.projects)) throw new Error('Codeburn report possui shape inválido');
  return 'report-json';
}

export function resolveDistributionSandboxChildEntry(directory = __dirname): string {
  const candidates = [
    path.join(directory, 'workflow-sandbox-child.js'),
    path.resolve(directory, '..', 'workflow-sandbox-child.js'),
  ].map((virtual) => virtual.includes('app.asar')
    ? virtual.replace('app.asar', 'app.asar.unpacked')
    : virtual);
  const entry = candidates.find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
  if (!entry) {
    throw new Error(`sandbox child físico ausente: ${candidates.join(', ')}`);
  }
  return entry;
}

async function probeSandboxChild(): Promise<string> {
  const entry = resolveDistributionSandboxChildEntry();
  const child = fork(entry, [], {
    execPath: process.execPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      LIONCLAW_WORKFLOW_SANDBOX_CHILD: '1',
    },
    silent: true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('sandbox child não emitiu hello')), 10_000);
      child.on('message', (message: unknown) => {
        const value = message as { t?: string; protocol?: number };
        if (value?.t === 'hello' && value.protocol === 1) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`sandbox child saiu antes do hello: ${code}`)); });
    });
    return 'hello-protocol-1';
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child, 5_000).catch(() => undefined);
  }
}

export function createMcpCoreProbeEndpoint(
  smokeRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!path.isAbsolute(smokeRoot)) {
    throw new Error('MCP core probe exige smokeRoot absoluto');
  }
  const root = path.resolve(smokeRoot);
  const runtimeDir = path.join(root, 'home', '.lionclaw', 'runtime');
  const endpointPath = path.join(runtimeDir, 'ipc-endpoint.json');
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const payload = platform === 'win32'
    ? { transport: 'pipe', address: `\\\\.\\pipe\\lionclaw-distribution-smoke-unreachable-${process.pid}` }
    : { transport: 'unix', address: path.join(root, 'mcp-core-probe-unreachable.sock') };
  fs.writeFileSync(endpointPath, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
  return endpointPath;
}

async function probeMcpCore(smokeRoot: string): Promise<Array<{ id: string; status: 'protocol-ok'; tools: number }>> {
  const endpointPath = createMcpCoreProbeEndpoint(smokeRoot);
  const results: Array<{ id: string; status: 'protocol-ok'; tools: number }> = [];
  try {
    for (const id of DISTRIBUTION_SMOKE_MCP_CORE_IDS) {
      const runtime = resolvePackagedMcpRuntime(id);
      const child = spawn(runtime.nodePath, [runtime.entryPath], {
        detached: process.platform !== 'win32',
        env: { ...runtime.env, ...smokeRuntimeEnv(runtime.nodePath) },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
      try {
        const tools = await new Promise<unknown[]>((resolve, reject) => {
          let buffer = '';
          let settled = false;
          const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            callback();
          };
          const send = (value: unknown): void => {
            child.stdin?.write(`${JSON.stringify(value)}\n`);
          };
          const timeout = setTimeout(() => finish(() => reject(
            new Error(`MCP core ${id} excedeu 12s: ${stderr.slice(-2_000)}`),
          )), 12_000);
          child.stdout?.setEncoding('utf8');
          child.stdout?.on('data', (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              let message: { id?: number; result?: { tools?: unknown[] } };
              try { message = JSON.parse(line) as typeof message; } catch { continue; }
              if (message.id === 1 && message.result) {
                send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
                send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
              }
              if (message.id === 2 && Array.isArray(message.result?.tools)) {
                const tools = message.result.tools;
                finish(() => resolve(tools));
              }
            }
          });
          child.once('error', (error) => finish(() => reject(error)));
          child.once('exit', (code, signal) => finish(() => reject(
            new Error(`MCP core ${id} saiu antes do handshake code=${code} signal=${signal}: ${stderr.slice(-2_000)}`),
          )));
          send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'distribution-smoke-final', version: '1' },
            },
          });
        });
        results.push({ id, status: 'protocol-ok', tools: tools.length });
      } finally {
        child.stdin?.end();
        await stopTree(child);
      }
    }
    return results;
  } finally {
    fs.rmSync(endpointPath, { force: true });
  }
}

export type RemoteBridgeProbeMessage =
  | { kind: 'initialized' }
  | { kind: 'tools'; tools: unknown[] }
  | { kind: 'ignore' };

export function classifyRemoteBridgeProbeMessage(
  message: Record<string, unknown>,
  expectedProtocol = '2024-11-05',
): RemoteBridgeProbeMessage {
  if (message['id'] !== 1 && message['id'] !== 2) return { kind: 'ignore' };
  if (message['jsonrpc'] !== '2.0') throw new Error('remote bridge retornou JSON-RPC inválido');
  if (message['error'] !== undefined) {
    throw new Error(`remote bridge retornou erro no id ${String(message['id'])}: ${JSON.stringify(message['error'])}`);
  }
  const result = message['result'];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`remote bridge retornou result inválido no id ${String(message['id'])}`);
  }
  const record = result as Record<string, unknown>;
  if (message['id'] === 1) {
    if (record['protocolVersion'] !== expectedProtocol ||
        !record['serverInfo'] || typeof record['serverInfo'] !== 'object' || Array.isArray(record['serverInfo']) ||
        !record['capabilities'] || typeof record['capabilities'] !== 'object' || Array.isArray(record['capabilities'])) {
      throw new Error('remote bridge initialize não comprovou protocolo/capabilities/serverInfo');
    }
    return { kind: 'initialized' };
  }
  if (!Array.isArray(record['tools'])) {
    throw new Error('remote bridge tools/list não retornou array de tools');
  }
  return { kind: 'tools', tools: record['tools'] };
}

async function probeRemoteMcpBridge(): Promise<{
  proxy: 'protocol-ok';
  clientEntrypoint: 'present';
  tools: number;
}> {
  const runtime = resolveRemoteMcpBridgeRuntime();
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      if (request.method !== 'POST') {
        response.statusCode = 404;
        response.end();
        return;
      }
      let message: Record<string, unknown>;
      try { message = JSON.parse(body) as Record<string, unknown>; } catch {
        response.statusCode = 400;
        response.end();
        return;
      }
      const headers = { 'content-type': 'application/json', 'mcp-session-id': 'lionclaw-smoke' };
      if (message['method'] === 'initialize') {
        const params = message['params'] as { protocolVersion?: string } | undefined;
        response.writeHead(200, headers);
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message['id'],
          result: {
            protocolVersion: params?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'lionclaw-remote-bridge-smoke', version: '1' },
          },
        }));
        return;
      }
      if (message['method'] === 'tools/list') {
        response.writeHead(200, headers);
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message['id'], result: { tools: [] } }));
        return;
      }
      response.writeHead(202, headers);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const child = spawn(runtime.command, [
    runtime.proxyEntryPath,
    `http://127.0.0.1:${address.port}/mcp`,
    '--allow-http',
    '--silent',
  ], {
    env: runtime.env,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const send = (message: Record<string, unknown>): void => {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };
  try {
    const tools = await new Promise<unknown[]>((resolve, reject) => {
      let settled = false;
      let toolsRequested = false;
      let consumedLines = 0;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const timeout = setTimeout(() => finish(() => reject(
        new Error(`remote bridge timeout: ${stderr.slice(-2_000)}`),
      )), 15_000);
      const inspect = (): void => {
        const lines = stdout.split(/\r?\n/);
        const completeCount = Math.max(0, lines.length - 1);
        for (const line of lines.slice(consumedLines, completeCount)) {
          if (!line.trim()) continue;
          let message: Record<string, unknown>;
          try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          try {
            const classified = classifyRemoteBridgeProbeMessage(message);
            if (classified.kind === 'initialized' && !toolsRequested) {
              toolsRequested = true;
              send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
              send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
            } else if (classified.kind === 'tools') {
              if (!toolsRequested) throw new Error('remote bridge respondeu tools/list antes do initialize válido');
              finish(() => resolve(classified.tools));
              return;
            }
          } catch (error) {
            finish(() => reject(error));
            return;
          }
        }
        consumedLines = completeCount;
      };
      child.stdout?.on('data', inspect);
      child.once('error', (error) => finish(() => reject(error)));
      child.once('exit', (code, signal) => finish(() => reject(
        new Error(`remote bridge saiu code=${code} signal=${signal}: ${stderr.slice(-2_000)}`),
      )));
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'lionclaw-distribution-smoke', version: '1' },
        },
      });
    });
    return { proxy: 'protocol-ok', clientEntrypoint: 'present', tools: tools.length };
  } finally {
    child.stdin?.end();
    await stopTree(child);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface OpenDesignReady { daemonUrl: string; webUrl: string; smokeIdentity: string }

export function requireLoopbackOrigin(value: string, label: string): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'http:' ||
      !['127.0.0.1', '::1'].includes(host) ||
      !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`LionDesign ${label} não é uma origem HTTP estritamente loopback`);
  }
  return url;
}

async function startOpenDesignProbe(smokeRoot: string): Promise<{
  result: { daemon: number; web: number; asset: string; proxy: number; lionDesign: true; sameDaemon: true; loopback: true };
  stop: () => Promise<void>;
  assertHealthy: () => void;
}> {
  const runtime = resolveOpenDesignSidecar();
  const smokeIdentity = randomUUID();
  const isolatedHome = path.join(smokeRoot, 'open-design-home');
  fs.mkdirSync(isolatedHome, { recursive: true });
  const proc = spawn(runtime.nodePath, [runtime.headlessPath], {
    cwd: runtime.root,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...smokeRuntimeEnv(runtime.nodePath),
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      NODE_ENV: 'production',
      NO_COLOR: '1',
      OD_DATA_DIR: path.join(smokeRoot, 'open-design-data'),
      OD_AGENT_HOME: isolatedHome,
      OD_EMBED_HOST: 'lionclaw',
      OD_NAMESPACE: `distribution-smoke-${process.pid}`,
      OD_PACKAGED_CONFIG_PATH: runtime.configPath,
      LIONCLAW_OD_SMOKE_IDENTITY: smokeIdentity,
    },
  });
  let stdout = '';
  let stderr = '';
  let terminalFailure: Error | null = null;
  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  proc.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  proc.once('exit', (code, signal) => {
    terminalFailure = new Error(`LionDesign encerrou code=${code} signal=${signal}: ${stderr.slice(-2_000)}`);
  });
  proc.once('error', (error) => { terminalFailure = error; });
  try {
    const ready = await new Promise<OpenDesignReady>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`LionDesign readiness timeout: ${stderr.slice(-2_000)}`)), 45_000);
      const inspect = (): void => {
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.startsWith('LIONCLAW_OPEN_DESIGN_READY=')) continue;
          clearTimeout(timeout);
          resolve(JSON.parse(line.slice('LIONCLAW_OPEN_DESIGN_READY='.length)) as OpenDesignReady);
          return;
        }
      };
      proc.stdout?.on('data', inspect);
      proc.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`LionDesign saiu antes do readiness code=${code} signal=${signal}: ${stderr.slice(-2_000)}`));
      });
      proc.once('error', (error) => { clearTimeout(timeout); reject(error); });
    });
    if (ready.smokeIdentity !== smokeIdentity) throw new Error('LionDesign readiness não preservou identidade do processo');
    const daemonUrl = requireLoopbackOrigin(ready.daemonUrl, 'daemonUrl');
    const webUrl = requireLoopbackOrigin(ready.webUrl, 'webUrl');
    const daemon = await fetch(new URL('/api/health', daemonUrl));
    const daemonHealth = await daemon.clone().json() as { smokeIdentity?: string };
    const web = await fetch(webUrl);
    const html = await web.text();
    const asset = html.match(/\/_next\/static\/[^"']+/)?.[0];
    if (!daemon.ok || !web.ok || !html.includes('LionDesign') || !asset) {
      throw new Error('LionDesign daemon/web/asset não ficou pronto');
    }
    const assetResponse = await fetch(new URL(asset, webUrl));
    const proxy = await fetch(new URL('/api/health', webUrl));
    const proxyHealth = await proxy.clone().json() as { smokeIdentity?: string };
    const icon = await fetch(new URL('/app-icon.svg', webUrl));
    const branding = JSON.parse(fs.readFileSync(path.join(runtime.root, 'branding-manifest.json'), 'utf8')) as {
      canonical?: { sha256?: string };
    };
    const iconHash = createHash('sha256').update(Buffer.from(await icon.arrayBuffer())).digest('hex');
    if (!assetResponse.ok || !proxy.ok || !icon.ok || iconHash !== branding.canonical?.sha256 ||
        daemonHealth.smokeIdentity !== smokeIdentity || proxyHealth.smokeIdentity !== smokeIdentity) {
      throw new Error('LionDesign asset/proxy/pata falhou');
    }
    return {
      result: {
        daemon: daemon.status,
        web: web.status,
        asset,
        proxy: proxy.status,
        lionDesign: true,
        sameDaemon: true,
        loopback: true,
      },
      stop: () => stopTree(proc),
      assertHealthy: () => {
        if (terminalFailure || proc.exitCode !== null || proc.killed) {
          throw terminalFailure ?? new Error(`LionDesign não permaneceu vivo (exitCode=${proc.exitCode})`);
        }
      },
    };
  } catch (error) {
    await stopTree(proc);
    throw error;
  }
}

export async function startDistributionSmokeComponentProbes(smokeRoot: string): Promise<{
  checks: Record<string, unknown>;
  stop: () => Promise<void>;
  assertHealthy: () => void;
}> {
  const nativeAddons = await probeNativeAddons();
  const excalidrawRenderer = await probeExcalidrawRenderer();
  const mcpCore = await probeMcpCore(smokeRoot);
  const remoteMcpBridge = await probeRemoteMcpBridge();
  const codeburn = probeCodeburn(smokeRoot);
  const sandboxChild = await probeSandboxChild();
  const openDesign = await startOpenDesignProbe(smokeRoot);
  return {
    checks: {
      nativeAddons,
      excalidrawRenderer,
      mcpCore,
      remoteMcpBridge,
      codeburn,
      sandboxChild,
      openDesign: openDesign.result,
    },
    stop: openDesign.stop,
    assertHealthy: openDesign.assertHealthy,
  };
}

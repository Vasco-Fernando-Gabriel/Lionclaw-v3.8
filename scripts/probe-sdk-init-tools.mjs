#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const outPath = arg('--out');
if (!outPath) {
  console.error('uso: node scripts/probe-sdk-init-tools.mjs --out <arquivo.json> [--model <id>] [--engine <path>]');
  process.exit(2);
}
const model = arg('--model', 'claude-opus-5');
const withCanUseTool = args.includes('--can-use-tool');
const permissionMode = arg('--permission-mode');

const require = createRequire(import.meta.url);
const sdkRoot = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
const sdkVersion = JSON.parse(readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')).version;

function resolveEngine() {
  const explicit = arg('--engine');
  if (explicit) return explicit;
  const legacy = path.join(sdkRoot, 'cli.js');
  if (existsSync(legacy)) return legacy;
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${bin}`,
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}-musl/${bin}`,
  ];
  for (const c of candidates) {
    try {
      return require.resolve(c);
    } catch {
    }
  }
  throw new Error(`engine nao encontrado: nem cli.js em ${sdkRoot} nem ${candidates.join(', ')}`);
}

const enginePath = resolveEngine();
const isJs = /\.(js|mjs|tsx|ts|jsx)$/.test(enginePath);
const engineSha256 = createHash('sha256').update(readFileSync(enginePath)).digest('hex');
const versionRun = isJs
  ? spawnSync(process.execPath, [enginePath, '--version'], { encoding: 'utf8' })
  : spawnSync(enginePath, ['--version'], { encoding: 'utf8' });
const engineVersion = (versionRun.stdout || versionRun.stderr || '').trim();

const options = {
  model,
  allowedTools: [],
  settingSources: [],
  mcpServers: {},
  maxTurns: 1,
  ...(permissionMode ? { permissionMode } : {}),
  ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
};
const runtimeOptions = withCanUseTool
  ? { canUseTool: async () => ({ behavior: 'allow' }) }
  : {};

const { query } = await import('@anthropic-ai/claude-agent-sdk');
const env = { ...process.env };
delete env.CLAUDECODE;
const abortController = new AbortController();
const q = query({
  prompt: 'ping',
  options: {
    ...options,
    ...runtimeOptions,
    abortController,
    pathToClaudeCodeExecutable: enginePath,
    ...(isJs ? { executable: 'node' } : {}),
    cwd: process.cwd(),
    env,
    stderr: (chunk) => process.stderr.write(`[engine] ${chunk}`),
  },
});

let init = null;
const timeout = setTimeout(() => {
  console.error('timeout de 120 s aguardando system:init');
  abortController.abort();
}, 120_000);

try {
  for await (const msg of q) {
    if (msg && msg.type === 'system' && msg.subtype === 'init') {
      init = msg;
      break;
    }
  }
} finally {
  clearTimeout(timeout);
  try {
    abortController.abort();
  } catch {
  }
  try {
    q.close?.();
  } catch {
  }
}

if (!init) {
  console.error('system:init nao recebido');
  process.exit(1);
}

const tools = Array.isArray(init.tools) ? [...init.tools].sort() : [];
const record = {
  sdkVersion,
  engineVersion,
  enginePath,
  engineSha256,
  capturedAt: new Date().toISOString(),
  options: { ...options, canUseTool: withCanUseTool },
  tools,
  slashCommands: Array.isArray(init.slash_commands) ? [...init.slash_commands].sort() : undefined,
  agents: Array.isArray(init.agents) ? [...init.agents].sort() : undefined,
};

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');
console.log(`ok: ${tools.length} tools de ${engineVersion} (sdk ${sdkVersion}) -> ${outPath}`);
console.log(tools.join(', '));

import { ChildProcess, spawn } from 'child_process';
import path from 'node:path';
import { getDb, getSetting } from './db';
import { getSecret, getSecretNonInteractive } from './secrets-vault';
import { createLogger } from './logger';
import type { ChatFeatureToggles, MCPServerConfig, OrchestratorRuntime } from '../../src/types';
import { Readable } from 'stream';
import { getAppVersion } from './app-version';
import { DETACH_FOR_TREE_KILL, killProcessTree } from './kill-process-tree';
import {
  isDirectMcpHelper,
  isChatTurnScopedMcpHelper,
} from './mcp-risk-patterns';
import { CODEX_GATEWAY_SERVER_ID, MCP_GATEWAY_SERVER_ID } from './mcp-display';
import {
  mintHelperToken,
  LIONCLAW_HELPER_TOKEN_ENV,
  CHAT_GATED_HELPER_IDS,
  ALWAYS_IDENTITY_HELPER_IDS,
  PROCESS_IDENTITY_HELPER_IDS,
} from './helper-identity';
import { getChatCapabilityForServer } from './chat-capability-gate';
import { resolveMcpServerEntry } from './mcp-path-resolver';
import {
  isPackagedDistributionRuntime,
  minimalInternalRuntimeEnv,
  resolveInternalNodeBinary,
} from './distribution-runtime';

const logger = createLogger('mcp');

const runningServers = new Map<string, ChildProcess>();
type SecretReader = (key: string) => Promise<string | null>;

function isInternalNodeCommand(command: string): boolean {
  const packaged = isPackagedDistributionRuntime();
  if (command === 'node' && !packaged) return false;
  const normalized = path.resolve(command);
  const looksInternal = command === 'node' ||
    normalized.includes(`${path.sep}runtime${path.sep}node${path.sep}`);
  try {
    return normalized === path.resolve(resolveInternalNodeBinary());
  } catch (error) {
    if (packaged && looksInternal) throw error;
    return false;
  }
}

function internalNodeOrDevelopmentNode(): string {
  try {
    return resolveInternalNodeBinary();
  } catch (error) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      if (require('electron')?.app?.isPackaged === true) throw error;
    } catch (electronError) {
      if (electronError === error) throw error;
    }
    return process.execPath;
  }
}

function resolveMcpRuntimeCommand(command: string): string {
  if (command !== 'node' || !isPackagedDistributionRuntime()) return command;
  return resolveInternalNodeBinary();
}

function mcpProcessEnv(command: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return isInternalNodeCommand(command)
    ? minimalInternalRuntimeEnv(command, base)
    : base;
}


export interface McpServerErrorState {
  status: 'error';
  error: string;
}

const serverErrorStates = new Map<string, McpServerErrorState>();

export type McpStatusChangedPayload = {
  id: string;
  status: 'running' | 'stopped' | 'error';
  error?: string;
};

let statusChangedEmitter: ((payload: McpStatusChangedPayload) => void) | null = null;

export function registerMcpStatusChangedEmitter(
  emit: ((payload: McpStatusChangedPayload) => void) | null,
): void {
  statusChangedEmitter = emit;
}

function emitStatusChanged(id: string): void {
  if (!statusChangedEmitter) return;
  const status = getServerStatus(id);
  const errorState = serverErrorStates.get(id);
  try {
    statusChangedEmitter({
      id,
      status,
      ...(status === 'error' && errorState ? { error: errorState.error } : {}),
    });
  } catch (error) {
    logger.warn({ id, error }, 'mcp:status-changed emit failed');
  }
}

function setServerErrorState(id: string, error: string): void {
  serverErrorStates.set(id, { status: 'error', error });
  emitStatusChanged(id);
}

function clearServerErrorState(id: string): void {
  if (serverErrorStates.delete(id)) {
    emitStatusChanged(id);
  }
}

export function getServerErrorState(id: string): McpServerErrorState | undefined {
  return serverErrorStates.get(id);
}

export async function startActiveMCPServers(): Promise<void> {
  const servers = getAllMCPServers().filter((s) => s.isActive);
  const uniqueKeys = [...new Set(servers.flatMap((server) => server.envKeys))];
  const bootSecrets = new Map<string, string | null>();
  for (const key of uniqueKeys) {
    const result = await getSecretNonInteractive(key);
    if (result.status === 'found') {
      bootSecrets.set(key, result.value);
    } else {
      bootSecrets.set(key, null);
      if (result.status === 'error') {
        logger.error(
          { key, code: result.code, reason: result.reason },
          'Segredo de boot indisponível sem interação; serviço dependente pode ficar offline',
        );
      }
    }
  }
  const readBootSecret: SecretReader = async (key) => bootSecrets.get(key) ?? null;

  for (const server of servers) {
    try {
      await startServer(server.id, readBootSecret);
    } catch (error) {
      logger.error({ id: server.id, error }, 'Failed to start MCP server');
    }
  }

  logger.info({ count: servers.length }, 'MCP servers started');

  discoverAllActiveMCPTools(readBootSecret).catch((err) => {
    logger.error({ err }, 'Background MCP tool discovery failed unexpectedly');
  });
}

export function stopAllMCPServers(): void {
  for (const [id, proc] of runningServers) {
    killProcessTree(proc);
    logger.info({ id }, 'MCP server stopped');
  }
  runningServers.clear();
}

export async function startServer(id: string, readSecret: SecretReader = getSecret): Promise<void> {
  if (runningServers.has(id)) {
    logger.warn({ id }, 'Server already running');
    return;
  }

  const config = getMCPServer(id);
  if (!config) throw new Error(`MCP server not found: ${id}`);

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of config.envKeys) {
    const value = await readSecret(key);
    if (value) {
      env[key] = value;
    } else {
      logger.warn({ id, key }, 'Secret not found for MCP server env var');
    }
  }

  const runtimeCommand = resolveMcpRuntimeCommand(config.command);
  const needsShell = process.platform === 'win32' && /^(npx|npm|pnpm|yarn)$/i.test(runtimeCommand);
  const proc = spawn(runtimeCommand, config.args, {
    env: mcpProcessEnv(runtimeCommand, env),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: needsShell,
    detached: DETACH_FOR_TREE_KILL,
  });

  proc.stdout?.on('data', (data: Buffer) => {
    logger.debug({ id, stdout: data.toString().substring(0, 200) }, 'MCP stdout');
  });

  proc.stderr?.on('data', (data: Buffer) => {
    logger.warn({ id, stderr: data.toString().substring(0, 200) }, 'MCP stderr');
  });

  proc.on('exit', (code) => {
    runningServers.delete(id);
    logger.info({ id, code }, 'MCP server exited');
    if (code !== 0 && code !== null) {
      setServerErrorState(id, `MCP-EXIT: processo encerrou com código ${code}`);
    } else {
      emitStatusChanged(id);
    }
  });

  proc.on('error', (error) => {
    runningServers.delete(id);
    logger.error({ id, error, code: 'MCP-START-FAIL' }, 'MCP server error');
    setServerErrorState(id, `MCP-START-FAIL: ${error.message}`);
  });

  runningServers.set(id, proc);
  clearServerErrorState(id);
  emitStatusChanged(id);
  logger.info({ id, command: config.command }, 'MCP server started');
}

export function stopServer(id: string): void {
  const proc = runningServers.get(id);
  if (proc) {
    killProcessTree(proc);
    runningServers.delete(id);
    logger.info({ id }, 'MCP server stopped');
  }
}

export async function restartServer(id: string): Promise<void> {
  stopServer(id);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await startServer(id);
}

export async function testServer(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const config = getMCPServer(id);
    if (!config) return { success: false, error: 'Server not found' };

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const key of config.envKeys) {
      const value = await getSecret(key);
      if (value) env[key] = value;
    }

    return new Promise((resolve) => {
      const runtimeCommand = resolveMcpRuntimeCommand(config.command);
      const proc = spawn(runtimeCommand, config.args, {
        env: mcpProcessEnv(runtimeCommand, env),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: DETACH_FOR_TREE_KILL,
      });
      const timeout = setTimeout(() => {
        killProcessTree(proc);
        resolve({ success: true }); // If it didn't crash in 3s, consider it working
      }, 3000);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      });

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0 && code !== null) {
          resolve({ success: false, error: `Exited with code ${code}` });
        }
      });
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export function getServerStatus(id: string): 'running' | 'stopped' | 'error' {
  if (runningServers.has(id)) return 'running';
  if (serverErrorStates.has(id)) return 'error';
  return 'stopped';
}

export async function getMCPConfigForAgent(
  agentId?: string,
  opts?: { surface?: OrchestratorRuntime; fullCatalog?: boolean; capabilities?: ChatFeatureToggles },
): Promise<Record<string, { command: string; args: string[]; env?: Record<string, string> }> | undefined> {
  const db = getDb();

  const surface = opts?.surface;
  const includeCodexLionOnly =
    surface === 'codex-sdk'
    || surface === 'lion-sdk'
    || surface === 'kimi-sdk'
    || surface === 'grok-sdk'
    || surface === 'cursor-sdk';
  const allowedVisibility: Array<'all' | 'codex-lion-only'> = includeCodexLionOnly
    ? ['all', 'codex-lion-only']
    : ['all'];

  let serverIds: string[] = [];
  if (agentId) {
    const agent = db.prepare('SELECT mcp_servers FROM agents WHERE id = ?').get(agentId) as { mcp_servers: string } | undefined;
    if (agent) {
      serverIds = JSON.parse(agent.mcp_servers);
    }
  }

  const hasExplicitAgentConfig = !!agentId && serverIds.length > 0;

  if (serverIds.length === 0) {
    if (agentId) return undefined;
    const servers = getAllMCPServers().filter((s) => s.isActive);
    serverIds = servers.map((s) => s.id);
  }

  if (serverIds.length === 0) return undefined;

  const config: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  for (const id of serverIds) {
    const server = getMCPServer(id);
    if (!server) continue;

    if (opts?.capabilities) {
      const gatedCapability = getChatCapabilityForServer(id);
      if (gatedCapability !== undefined && opts.capabilities[gatedCapability] === false) {
        continue;
      }
    }

    if (
      isChatTurnScopedMcpHelper(id) &&
      opts?.capabilities === undefined &&
      opts?.fullCatalog !== true
    ) {
      continue;
    }

    const serverVisibility = server.visibleTo ?? 'all';
    if (!allowedVisibility.includes(serverVisibility)) continue;

    const runtimeCommand = resolveMcpRuntimeCommand(server.command);
    const entry: { command: string; args: string[]; env?: Record<string, string> } = {
      command: runtimeCommand,
      args: server.args,
    };

    if (server.envKeys.length > 0) {
      const env: Record<string, string> = {};
      for (const key of server.envKeys) {
        const value = await getSecret(key);
        if (value) {
          env[key] = value;
        }
      }
      if (Object.keys(env).length > 0) entry.env = env;
    }

    if (isInternalNodeCommand(runtimeCommand)) {
      entry.env = minimalInternalRuntimeEnv(runtimeCommand, {
        ...process.env,
        ...entry.env,
      }) as Record<string, string>;
    }

    config[id] = entry;
  }

  if (
    surface === 'claude-sdk' ||
    surface === 'claude-compat-sdk' ||
    surface === 'kimi-sdk' ||
    surface === 'grok-sdk' ||
    surface === 'cursor-sdk' ||
    surface === 'lion-sdk'
  ) {
    for (const [id, entry] of Object.entries(config)) {
      if (ALWAYS_IDENTITY_HELPER_IDS.has(id.toLowerCase())) {
        config[id] = {
          ...entry,
          env: { ...entry.env, [LIONCLAW_HELPER_TOKEN_ENV]: mintHelperToken(id) },
        };
      }
    }
  }

  if (
    opts?.fullCatalog !== true &&
    !hasExplicitAgentConfig &&
    (surface === 'claude-sdk' || surface === 'claude-compat-sdk') &&
    readMcpPromptModeSafe() === 'index'
  ) {
    return buildIndexModeConfig(config, surface);
  }

  if (
    opts?.fullCatalog !== true &&
    (surface === 'claude-sdk' || surface === 'claude-compat-sdk')
  ) {
    for (const [id, entry] of Object.entries(config)) {
      if (CHAT_GATED_HELPER_IDS.has(id.toLowerCase())) {
        config[id] = {
          ...entry,
          env: { ...entry.env, [LIONCLAW_HELPER_TOKEN_ENV]: mintHelperToken(id) },
        };
      }
    }
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function readMcpPromptModeSafe(): 'index' | 'full' {
  try {
    return getSetting('mcp_prompt_mode') === 'full' ? 'full' : 'index';
  } catch {
    return 'full';
  }
}

export function resolveGatewayScriptPath(): string {
  let appPath: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { app?: { getAppPath: () => string } };
    if (electron?.app?.getAppPath) {
      appPath = electron.app.getAppPath();
    }
  } catch {
  }
  const { entryPath, candidates } = resolveMcpServerEntry(
    MCP_GATEWAY_SERVER_ID,
    `dist/${MCP_GATEWAY_SERVER_ID}/src/index.js`,
    { appPath, cwd: process.cwd() },
  );
  if (!entryPath) {
    logger.warn(
      { candidates },
      'Gateway MCP dist nao encontrado (rode o build dos MCPs); usando o primeiro candidato',
    );
    return candidates[0];
  }
  return entryPath;
}

function buildIndexModeConfig(
  legacyConfig: Record<string, { command: string; args: string[]; env?: Record<string, string> }>,
  surface: 'claude-sdk' | 'claude-compat-sdk',
): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
  const indexConfig: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};

  if (legacyConfig[MCP_GATEWAY_SERVER_ID]) {
    logger.warn(
      { surface },
      'MCP server "gateway" do DB colide com a entry sintetica do modo index; a sintetica prevalece',
    );
  }

  const gatewayNode = internalNodeOrDevelopmentNode();
  indexConfig[MCP_GATEWAY_SERVER_ID] = {
    command: gatewayNode,
    args: [resolveGatewayScriptPath()],
    env: {
      ...minimalInternalRuntimeEnv(gatewayNode),
      ELECTRON_RUN_AS_NODE: '1',
      LIONCLAW_MCP_SURFACE: surface,
      [LIONCLAW_HELPER_TOKEN_ENV]: mintHelperToken(MCP_GATEWAY_SERVER_ID),
    },
  };

  for (const [id, entry] of Object.entries(legacyConfig)) {
    if (id !== MCP_GATEWAY_SERVER_ID && isDirectMcpHelper(id)) {
      indexConfig[id] = PROCESS_IDENTITY_HELPER_IDS.has(id.toLowerCase())
        ? {
            ...entry,
            env: { ...entry.env, [LIONCLAW_HELPER_TOKEN_ENV]: mintHelperToken(id) },
          }
        : entry;
    }
  }

  return indexConfig;
}


export function buildMCPSpecForAgent(serverIds: string[]): Array<Record<string, { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }>> | undefined {
  if (serverIds.length === 0) return undefined;
  const specs: Array<Record<string, { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }>> = [];
  for (const id of serverIds) {
    const server = getMCPServer(id);
    if (server) {
      const runtimeCommand = resolveMcpRuntimeCommand(server.command);
      const entry: { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> } = {
        command: runtimeCommand,
        args: server.args,
      };
      if (isInternalNodeCommand(runtimeCommand)) {
        entry.env = minimalInternalRuntimeEnv(runtimeCommand) as Record<string, string>;
      }
      specs.push({ [id]: entry });
    }
  }
  return specs.length > 0 ? specs : undefined;
}


export interface MCPDiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface MCPToolRegistryEntry {
  mcpId: string;
  toolName: string;
  description: string | null;
  inputSchema: string | null;
  lastDiscoveredAt: string | null;
}

export function saveMCPToolsToRegistry(mcpId: string, tools: Array<string | MCPDiscoveredTool>): void {
  const db = getDb();
  const entries: MCPDiscoveredTool[] = tools.map((t) => (typeof t === 'string' ? { name: t } : t));
  const upsert = db.prepare(`
    INSERT INTO mcp_tool_registry (mcp_id, tool_name, description, input_schema, last_discovered_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(mcp_id, tool_name) DO UPDATE SET
      description = excluded.description,
      input_schema = excluded.input_schema,
      last_discovered_at = excluded.last_discovered_at
  `);
  const deleteAll = db.prepare('DELETE FROM mcp_tool_registry WHERE mcp_id = ?');
  const now = new Date().toISOString();

  const run = db.transaction(() => {
    if (entries.length === 0) {
      deleteAll.run(mcpId);
      return;
    }
    const placeholders = entries.map(() => '?').join(', ');
    db.prepare(`DELETE FROM mcp_tool_registry WHERE mcp_id = ? AND tool_name NOT IN (${placeholders})`)
      .run(mcpId, ...entries.map((e) => e.name));
    for (const entry of entries) {
      upsert.run(
        mcpId,
        entry.name,
        entry.description ?? null,
        entry.inputSchema !== undefined ? JSON.stringify(entry.inputSchema) : null,
        now,
      );
    }
  });
  run();
  logger.info({ mcpId, count: entries.length }, 'Saved MCP tools to registry');
}

export function getMCPToolsFromRegistry(serverIds: string[]): string[] {
  if (serverIds.length === 0) return [];
  const db = getDb();
  const placeholders = serverIds.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT mcp_id, tool_name FROM mcp_tool_registry WHERE mcp_id IN (${placeholders})`)
    .all(...serverIds) as Array<{ mcp_id: string; tool_name: string }>;

  return rows.map((r) => `mcp__${r.mcp_id}__${r.tool_name}`);
}

export function getMcpToolRegistryEntries(mcpId?: string): MCPToolRegistryEntry[] {
  const db = getDb();
  const baseSql =
    'SELECT mcp_id, tool_name, description, input_schema, last_discovered_at FROM mcp_tool_registry';
  const rows = (
    mcpId !== undefined
      ? db.prepare(`${baseSql} WHERE mcp_id = ? ORDER BY mcp_id, tool_name`).all(mcpId)
      : db.prepare(`${baseSql} ORDER BY mcp_id, tool_name`).all()
  ) as Array<{
    mcp_id: string;
    tool_name: string;
    description: string | null;
    input_schema: string | null;
    last_discovered_at: string | null;
  }>;

  return rows.map((r) => ({
    mcpId: r.mcp_id,
    toolName: r.tool_name,
    description: r.description,
    inputSchema: r.input_schema,
    lastDiscoveredAt: r.last_discovered_at,
  }));
}

export async function discoverAndSaveMCPTools(
  serverId: string,
  readSecret: SecretReader = getSecret,
): Promise<string[]> {
  const config = getMCPServer(serverId);
  if (!config) throw new Error(`MCP server not found: ${serverId}`);

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of config.envKeys) {
    const value = await readSecret(key);
    if (value) {
      env[key] = value;
    } else {
      logger.warn({ serverId, key }, 'Secret not found during tool discovery');
    }
  }

  return new Promise<string[]>((resolve, reject) => {
    const runtimeCommand = resolveMcpRuntimeCommand(config.command);
    const proc = spawn(runtimeCommand, config.args, {
      env: mcpProcessEnv(runtimeCommand, env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: DETACH_FOR_TREE_KILL,
    });

    const TIMEOUT_MS = 8000;
    let settled = false;
    let stdoutBuf = '';

    const finish = (tools: MCPDiscoveredTool[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(proc);
      saveMCPToolsToRegistry(serverId, tools);
      clearServerErrorState(serverId);
      resolve(tools.map((t) => t.name));
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(proc);
      setServerErrorState(serverId, `MCP-DISCOVERY-FAIL: ${err.message}`);
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(new Error(`Tool discovery timed out for server: ${serverId}`));
    }, TIMEOUT_MS);

    proc.on('error', (err) => fail(err));

    let initializeDone = false;

    (proc.stdout as Readable).on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue; // Not JSON — ignore (e.g. debug output)
        }

        if (!initializeDone && (msg['id'] as number) === 1 && msg['result'] !== undefined) {
          initializeDone = true;
          const toolsListRequest = JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
          });
          proc.stdin?.write(toolsListRequest + '\n');
        }

        if ((msg['id'] as number) === 2) {
          const result = msg['result'] as Record<string, unknown> | undefined;
          const rawTools = result?.['tools'];
          const tools: MCPDiscoveredTool[] = Array.isArray(rawTools)
            ? rawTools
                .map((t: unknown) => {
                  const tool = t as Record<string, unknown>;
                  return {
                    name: (tool['name'] as string) ?? '',
                    description:
                      typeof tool['description'] === 'string' ? tool['description'] : undefined,
                    inputSchema: tool['inputSchema'],
                  };
                })
                .filter((t) => t.name !== '')
            : [];
          finish(tools);
        }
      }
    });

    proc.on('exit', (code) => {
      if (!settled) {
        logger.warn(
          { serverId, exitCode: code, code: 'MCP-DISCOVERY-FAIL' },
          'MCP process exited before discovery completed',
        );
        fail(new Error(`MCP process exited before discovery completed (code=${code})`));
      }
    });

    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'lionclaw', version: getAppVersion() },
      },
    });
    proc.stdin?.write(initRequest + '\n');
  });
}

export async function discoverAllActiveMCPTools(readSecret: SecretReader = getSecret): Promise<void> {
  const servers = getAllMCPServers().filter((s) => s.isActive);
  logger.info({ count: servers.length }, 'Starting MCP tool discovery for all active servers');

  for (const server of servers) {
    try {
      const tools = await discoverAndSaveMCPTools(server.id, readSecret);
      logger.info({ serverId: server.id, toolCount: tools.length }, 'Tool discovery completed');
    } catch (err) {
      logger.error({ serverId: server.id, err }, 'Tool discovery failed for server');
    }
  }
}


export function getAllMCPServers(): MCPServerConfig[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM mcp_servers').all() as Array<Record<string, unknown>>;
  return rows.map(mapServer);
}

function getMCPServer(id: string): MCPServerConfig | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapServer(row) : undefined;
}

export function createMCPServer(config: Omit<MCPServerConfig, 'status'>): MCPServerConfig {
  if (config.id === CODEX_GATEWAY_SERVER_ID) {
    throw new Error(
      `id de MCP server reservado pelo LionClaw: ${CODEX_GATEWAY_SERVER_ID}`,
    );
  }
  const db = getDb();
  const visibleTo = config.visibleTo ?? 'all';
  const indexMode = config.indexMode ?? 'tools';
  db.prepare(`
    INSERT INTO mcp_servers (id, name, command, args, env_keys, is_active, visible_to, index_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    config.id,
    config.name,
    config.command,
    JSON.stringify(config.args),
    JSON.stringify(config.envKeys),
    config.isActive ? 1 : 0,
    visibleTo,
    indexMode,
  );
  return { ...config, visibleTo, indexMode, status: 'stopped' };
}

export function updateMCPServer(id: string, updates: Partial<MCPServerConfig>): MCPServerConfig {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.command !== undefined) { fields.push('command = ?'); values.push(updates.command); }
  if (updates.args !== undefined) { fields.push('args = ?'); values.push(JSON.stringify(updates.args)); }
  if (updates.envKeys !== undefined) { fields.push('env_keys = ?'); values.push(JSON.stringify(updates.envKeys)); }
  if (updates.isActive !== undefined) { fields.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }
  if (updates.visibleTo !== undefined) { fields.push('visible_to = ?'); values.push(updates.visibleTo); }
  if (updates.indexMode !== undefined) { fields.push('index_mode = ?'); values.push(updates.indexMode); }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  const server = getMCPServer(id);
  return { ...server!, status: getServerStatus(id) };
}

export function deleteMCPServer(id: string): void {
  stopServer(id);
  const db = getDb();
  db.prepare('DELETE FROM mcp_tool_registry WHERE mcp_id = ?').run(id);
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
}

function mapServer(row: Record<string, unknown>): MCPServerConfig {
  const id = row['id'] as string;
  const rawVisibility = row['visible_to'];
  const visibleTo: 'all' | 'codex-lion-only' =
    rawVisibility === 'codex-lion-only' ? 'codex-lion-only' : 'all';
  const rawIndexMode = row['index_mode'];
  const indexMode: 'tools' | 'server' = rawIndexMode === 'server' ? 'server' : 'tools';
  return {
    id,
    name: row['name'] as string,
    description: (row['description'] as string) || undefined,
    command: row['command'] as string,
    args: JSON.parse((row['args'] as string) || '[]'),
    envKeys: JSON.parse((row['env_keys'] as string) || '[]'),
    isActive: (row['is_active'] as number) === 1,
    visibleTo,
    indexMode,
    status: getServerStatus(id),
  };
}

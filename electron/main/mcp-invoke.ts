import type { BrowserWindow } from 'electron';
import { createLogger } from './logger';
import { getSetting } from './db';
import { createPermissionGuard } from './permission-guard';
import { assessMcpToolRisk } from './mcp-risk-patterns';
import { assertChatCapability } from './chat-capability-gate';
import { turnBindingFromContext, type McpInvocationContext } from './mcp-invocation-context';
import {
  getMCPConfigForAgent,
  getMcpToolRegistryEntries,
  discoverAndSaveMCPTools,
  type MCPToolRegistryEntry,
} from './mcp-manager';
import { setupMCPsForSession, teardownMCPsForSession, callMCPTool, type McpSessionClient } from './mcp-tool-bridge';
import type { OrchestratorRuntime } from '../../src/types';

const logger = createLogger('mcp-invoke');

export interface McpInvokeRequest {
  serverId: string;
  toolName: string;
  args: unknown;
  surface: string;
  sessionId: string;
  turnId: string;
  allowedServerIds: string[];
  context?: McpInvocationContext;
  signal?: AbortSignal;
}

export interface McpInvokeResult {
  content: string;
  isError?: boolean;
  displayName: string;
  _meta?: { code: string; capability: string };
}

const DEFAULT_INVOKE_TIMEOUT_MS = 60_000;
const DEFAULT_POOL_IDLE_TTL_MS = 300_000;
const SCHEMA_HINT_MAX_CHARS = 1200;
const SCHEMA_HINT_TRUNCATION_SUFFIX = '... [schema truncado]';
const DID_YOU_MEAN_MAX_PER_TURN = 3;
const DID_YOU_MEAN_CANDIDATES = 3;

const SCHEMA_UNAVAILABLE_MSG = 'schema indisponivel, re-discovery em andamento';

const TIMEOUT_ERROR_RE = /timeout aguardando resposta/i;
const UNKNOWN_TOOL_RE = /unknown tool|tool not found|no such tool|tool desconhecida/i;

function readPositiveIntSetting(key: string, fallback: number): number {
  const raw = Number.parseInt(getSetting(key) || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function getInvokeTimeoutMs(): number {
  return readPositiveIntSetting('mcp_invoke_timeout_ms', DEFAULT_INVOKE_TIMEOUT_MS);
}

function getPoolIdleTtlMs(): number {
  return readPositiveIntSetting('mcp_pool_idle_ttl_ms', DEFAULT_POOL_IDLE_TTL_MS);
}

let guardWindowSupplier: (() => BrowserWindow | null) | null = null;

export function initMcpInvoke(deps: { getWindow: () => BrowserWindow | null }): void {
  guardWindowSupplier = deps.getWindow;
  logger.info('Wrapper central de invoke MCP inicializado (permission guard por sessao)');
}

function resolveInvokeGuard(
  req: Pick<McpInvokeRequest, 'sessionId' | 'context'>,
): ReturnType<typeof createPermissionGuard> | null {
  if (!guardWindowSupplier) return null;
  return createPermissionGuard(guardWindowSupplier, { sessionId: req.context?.sessionId ?? req.sessionId });
}

interface PoolEntry {
  client: McpSessionClient;
  idleTimer: NodeJS.Timeout | null;
}

const pool = new Map<string, PoolEntry>();
const spawnLocks = new Map<string, Promise<PoolEntry>>();

function armIdleTimer(serverId: string, entry: PoolEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  const ttl = getPoolIdleTtlMs();
  entry.idleTimer = setTimeout(() => {
    void teardownPoolEntry(serverId, 'idle-ttl');
  }, ttl);
  entry.idleTimer.unref?.();
}

async function teardownPoolEntry(serverId: string, reason: string): Promise<void> {
  const entry = pool.get(serverId);
  if (!entry) return;
  pool.delete(serverId);
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  try {
    await teardownMCPsForSession(entry.client);
    logger.info({ serverId, reason }, 'Conexao MCP do pool derrubada');
  } catch (err) {
    logger.warn({ serverId, reason, err }, 'Erro no teardown da conexao MCP do pool');
  }
}

async function acquireConnection(serverId: string, surface: string): Promise<PoolEntry> {
  const existing = pool.get(serverId);
  if (existing) {
    armIdleTimer(serverId, existing);
    return existing;
  }

  const pending = spawnLocks.get(serverId);
  if (pending) return pending;

  const spawnPromise = (async (): Promise<PoolEntry> => {
    const config = await getMCPConfigForAgent(undefined, {
      surface: surface as OrchestratorRuntime,
      fullCatalog: true,
    });
    const spec = config?.[serverId];
    if (!spec) {
      throw new Error(`servidor MCP "${serverId}" nao esta disponivel para a superficie ${surface}`);
    }
    const { client, failures } = await setupMCPsForSession({ [serverId]: spec });
    if (client.connections.length === 0) {
      const cause = failures.find((failure) => failure.serverId === serverId)?.error;
      throw new Error(`MCP_SERVER_UNAVAILABLE: servidor "${serverId}" não iniciou${cause ? `: ${cause}` : ''}`);
    }
    const entry: PoolEntry = { client, idleTimer: null };
    pool.set(serverId, entry);
    armIdleTimer(serverId, entry);
    logger.info({ serverId, surface }, 'Servidor MCP spawnado on-demand para o pool');
    return entry;
  })();

  spawnLocks.set(serverId, spawnPromise);
  try {
    return await spawnPromise;
  } finally {
    spawnLocks.delete(serverId);
  }
}

interface TurnState {
  turnId: string;
  didYouMeanCount: number;
  rediscoveredServers: Set<string>;
}

const turnStates = new Map<string, TurnState>();

function getTurnState(sessionId: string, turnId: string): TurnState {
  const current = turnStates.get(sessionId);
  if (current && current.turnId === turnId) return current;
  const fresh: TurnState = { turnId, didYouMeanCount: 0, rediscoveredServers: new Set() };
  turnStates.set(sessionId, fresh);
  return fresh;
}

async function maybeRediscover(serverId: string, turn: TurnState, trigger: string): Promise<boolean> {
  if (turn.rediscoveredServers.has(serverId)) return false;
  turn.rediscoveredServers.add(serverId);
  try {
    await discoverAndSaveMCPTools(serverId);
    logger.info({ serverId, trigger }, 'Re-discovery on-demand concluido');
    return true;
  } catch (err) {
    logger.warn({ serverId, trigger, err }, 'Re-discovery on-demand falhou');
    return false;
  }
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

interface DidYouMeanCandidate {
  serverId: string;
  toolName: string;
  description: string | null;
  distance: number;
}

function nearestTools(toolName: string, entries: MCPToolRegistryEntry[], limit: number): DidYouMeanCandidate[] {
  const target = toolName.toLowerCase();
  return entries
    .map((e) => ({
      serverId: e.mcpId,
      toolName: e.toolName,
      description: e.description,
      distance: levenshtein(target, e.toolName.toLowerCase()),
    }))
    .sort((x, y) => x.distance - y.distance || x.toolName.localeCompare(y.toolName))
    .slice(0, limit);
}

function findDidYouMeanCandidates(
  serverId: string,
  toolName: string,
  allowedServerIds: string[],
): DidYouMeanCandidate[] {
  const sameServer = getMcpToolRegistryEntries(serverId);
  if (sameServer.length > 0) {
    return nearestTools(toolName, sameServer, DID_YOU_MEAN_CANDIDATES);
  }
  const allowed = new Set(allowedServerIds);
  const others = getMcpToolRegistryEntries().filter((e) => e.mcpId !== serverId && allowed.has(e.mcpId));
  return nearestTools(toolName, others, DID_YOU_MEAN_CANDIDATES);
}

function formatCandidateLine(serverId: string, c: DidYouMeanCandidate): string {
  const where = c.serverId === serverId ? '' : ` (servidor ${c.serverId})`;
  const desc = (c.description ?? '').trim();
  return `- ${c.toolName}${where}${desc ? `: ${desc}` : ''}`;
}

function didYouMeanResult(
  displayName: string,
  serverId: string,
  toolName: string,
  allowedServerIds: string[],
  turn: TurnState,
): McpInvokeResult {
  if (turn.didYouMeanCount >= DID_YOU_MEAN_MAX_PER_TURN) {
    return errorResult(
      displayName,
      `Tool "${toolName}" nao existe no servidor ${serverId} e o limite de ${DID_YOU_MEAN_MAX_PER_TURN} sugestoes did-you-mean por turno foi atingido. Pare de adivinhar nomes: consulte o indice de tools no prompt ou o schema da tool pela meta-tool de schema.`,
    );
  }
  turn.didYouMeanCount += 1;

  const candidates = findDidYouMeanCandidates(serverId, toolName, allowedServerIds);
  if (candidates.length === 0) {
    return errorResult(
      displayName,
      `Tool "${toolName}" nao encontrada no servidor ${serverId} e o catalogo ainda nao tem tools indexadas (${SCHEMA_UNAVAILABLE_MSG}). Tente novamente em instantes.`,
    );
  }
  const lines = [
    `Tool "${toolName}" nao existe no servidor ${serverId}. Voce quis dizer:`,
    ...candidates.map((c) => formatCandidateLine(serverId, c)),
    'Invoque novamente com o nome EXATO de uma tool existente.',
  ];
  return errorResult(displayName, lines.join('\n'));
}

function findRegistryEntry(serverId: string, toolName: string): MCPToolRegistryEntry | undefined {
  return getMcpToolRegistryEntries(serverId).find((e) => e.toolName === toolName);
}

function buildTruncatedSchemaHint(serverId: string, toolName: string): string {
  const entry = findRegistryEntry(serverId, toolName);
  if (!entry || !entry.inputSchema) {
    return `Schema da tool ${toolName}: ${SCHEMA_UNAVAILABLE_MSG}.`;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(entry.inputSchema) as Record<string, unknown>;
  } catch {
    return `Schema da tool ${toolName}: ${SCHEMA_UNAVAILABLE_MSG}.`;
  }

  const requiredRaw = parsed['required'];
  const required = Array.isArray(requiredRaw) ? requiredRaw.filter((r): r is string => typeof r === 'string') : [];
  const propsRaw = parsed['properties'];
  const props = propsRaw && typeof propsRaw === 'object' ? (propsRaw as Record<string, unknown>) : {};
  const propLines = Object.entries(props).map(([name, def]) => {
    const type =
      def && typeof def === 'object' && typeof (def as Record<string, unknown>)['type'] === 'string'
        ? ((def as Record<string, unknown>)['type'] as string)
        : 'any';
    return `${name}: ${type}`;
  });

  let text = [
    `Schema resumido de ${toolName} (servidor ${serverId}):`,
    `- required: ${required.length > 0 ? required.join(', ') : '(nenhum)'}`,
    `- propriedades: ${propLines.length > 0 ? propLines.join('; ') : '(nenhuma)'}`,
    'Dica: corrija os args conforme o schema acima e invoque novamente.',
  ].join('\n');

  if (text.length > SCHEMA_HINT_MAX_CHARS) {
    text = text.slice(0, SCHEMA_HINT_MAX_CHARS - SCHEMA_HINT_TRUNCATION_SUFFIX.length) + SCHEMA_HINT_TRUNCATION_SUFFIX;
  }
  return text;
}

function errorResult(displayName: string, message: string): McpInvokeResult {
  return { content: message, isError: true, displayName };
}

function schemaOnError(displayName: string, serverId: string, toolName: string, headline: string): McpInvokeResult {
  return errorResult(displayName, `${headline}\n\n${buildTruncatedSchemaHint(serverId, toolName)}`);
}

function flattenMcpContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    const v = value as { content?: Array<{ type?: string; text?: string }> } & Record<string, unknown>;
    if (Array.isArray(v.content)) {
      const parts = v.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).filter((s) => s.length > 0);
      if (parts.length > 0) return parts.join('\n');
    }
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

export async function invokeMcpTool(req: McpInvokeRequest): Promise<McpInvokeResult> {
  const { serverId, toolName, surface, sessionId, turnId, allowedServerIds } = req;
  const displayName = `mcp__${serverId}__${toolName}`;
  if (req.signal?.aborted) throw new Error(`Invocacao MCP cancelada: ${displayName}`);

  if (req.context !== undefined) {
    const gate = assertChatCapability({ serverId, toolName, context: req.context });
    if (!gate.ok) {
      logger.info(
        { serverId, toolName, code: gate.code, capability: gate.capability },
        'Invoke negado pelo gate de capability do chat',
      );
      return {
        content: gate.message,
        isError: true,
        displayName,
        _meta: { code: gate.code, capability: gate.capability },
      };
    }
  }

  if (!allowedServerIds.includes(serverId)) {
    logger.warn({ serverId, toolName, surface }, 'Invoke bloqueado: server fora do escopo da sessao');
    return errorResult(
      displayName,
      `Servidor MCP "${serverId}" fora do escopo desta sessao. Servidores permitidos: ${
        allowedServerIds.length > 0 ? allowedServerIds.join(', ') : '(nenhum)'
      }.`,
    );
  }

  const risk = assessMcpToolRisk(toolName);
  if (risk !== 'safe') {
    const guard = resolveInvokeGuard(req);
    if (!guard) {
      logger.error({ serverId, toolName }, 'Guard indisponivel (initMcpInvoke nao chamado no boot)');
      return errorResult(displayName, `Acao MCP de risco (${toolName}) bloqueada: wrapper de invoke nao inicializado.`);
    }
    const decision = await guard(displayName, toRecord(req.args));
    if (decision.behavior === 'deny') {
      logger.info({ serverId, toolName, risk }, 'Invoke negado pelo permission guard');
      return errorResult(
        displayName,
        `Invocacao de ${toolName} no servidor ${serverId} negada pelo guard de permissoes: ${decision.message || 'sem detalhes'}`,
      );
    }
  }

  const turn = getTurnState(sessionId, turnId);

  let serverEntries = getMcpToolRegistryEntries(serverId);
  let known = serverEntries.some((e) => e.toolName === toolName);
  if (!known) {
    const refreshed = await maybeRediscover(serverId, turn, 'registro-ausente');
    if (refreshed) {
      serverEntries = getMcpToolRegistryEntries(serverId);
      known = serverEntries.some((e) => e.toolName === toolName);
    }
    if (!known && serverEntries.length > 0) {
      return didYouMeanResult(displayName, serverId, toolName, allowedServerIds, turn);
    }
  }

  let entry: PoolEntry;
  try {
    entry = await acquireConnection(serverId, surface);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ serverId, toolName, err }, 'Falha ao obter conexao MCP para invoke');
    return errorResult(displayName, `Falha ao conectar no servidor MCP "${serverId}": ${message}`);
  }

  if (req.signal?.aborted) {
    await teardownPoolEntry(serverId, 'invoke-aborted-before-call');
    throw new Error(`Invocacao MCP cancelada: ${displayName}`);
  }

  const timeoutMs = getInvokeTimeoutMs();
  let raw: unknown;
  try {
    const binding = turnBindingFromContext(req.context);
    raw = await callMCPTool(entry.client, displayName, req.args ?? {}, {
      timeoutMs,
      ...(req.signal ? { signal: req.signal } : {}),
      ...(binding ? { binding } : {}),
    });
  } catch (err) {
    if (req.signal?.aborted) {
      await teardownPoolEntry(serverId, 'invoke-aborted');
      throw new Error(`Invocacao MCP cancelada: ${displayName}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (TIMEOUT_ERROR_RE.test(message)) {
      logger.warn({ serverId, toolName, timeoutMs }, 'Invoke MCP estourou o timeout');
      return schemaOnError(
        displayName,
        serverId,
        toolName,
        `Timeout de ${timeoutMs}ms excedido ao invocar ${toolName} no servidor ${serverId} (ajustavel no setting mcp_invoke_timeout_ms).`,
      );
    }
    if (UNKNOWN_TOOL_RE.test(message)) {
      await maybeRediscover(serverId, turn, 'server-respondeu-tool-desconhecida');
      return didYouMeanResult(displayName, serverId, toolName, allowedServerIds, turn);
    }
    logger.warn({ serverId, toolName, err }, 'Invoke MCP falhou (erro JSON-RPC/excecao)');
    return schemaOnError(
      displayName,
      serverId,
      toolName,
      `Erro ao invocar ${toolName} no servidor ${serverId}: ${message}`,
    );
  }

  armIdleTimer(serverId, entry);

  if (raw && typeof raw === 'object' && (raw as Record<string, unknown>)['isError'] === true) {
    const flat = flattenMcpContent(raw);
    if (UNKNOWN_TOOL_RE.test(flat)) {
      await maybeRediscover(serverId, turn, 'server-respondeu-tool-desconhecida');
      return didYouMeanResult(displayName, serverId, toolName, allowedServerIds, turn);
    }
    logger.warn({ serverId, toolName }, 'Invoke MCP retornou isError=true');
    return schemaOnError(
      displayName,
      serverId,
      toolName,
      `O servidor ${serverId} retornou erro para ${toolName}: ${flat || '(sem detalhes)'}`,
    );
  }

  return { content: flattenMcpContent(raw), displayName };
}

export function getMcpToolSchema(serverId: string, toolName: string): { content: string; isError?: boolean } {
  const entries = getMcpToolRegistryEntries(serverId);
  const entry = entries.find((e) => e.toolName === toolName);

  if (!entry) {
    if (entries.length === 0) {
      return {
        content: `Servidor ${serverId}: ${SCHEMA_UNAVAILABLE_MSG}. Tente novamente em instantes.`,
        isError: true,
      };
    }
    const candidates = nearestTools(toolName, entries, DID_YOU_MEAN_CANDIDATES);
    const lines = [
      `Tool "${toolName}" nao existe no servidor ${serverId}. Tools proximas:`,
      ...candidates.map((c) => formatCandidateLine(serverId, c)),
    ];
    return { content: lines.join('\n'), isError: true };
  }

  const lines: string[] = [`Tool: ${toolName}`, `Servidor: ${serverId}`];
  const desc = (entry.description ?? '').trim();
  if (desc) lines.push(`Descricao: ${desc}`);
  if (entry.inputSchema) {
    try {
      lines.push('Input schema (JSON):', JSON.stringify(JSON.parse(entry.inputSchema), null, 2));
    } catch {
      lines.push('Input schema (bruto):', entry.inputSchema);
    }
  } else {
    lines.push(`Input schema: ${SCHEMA_UNAVAILABLE_MSG}.`);
  }
  if (entry.lastDiscoveredAt) lines.push(`Descoberto em: ${entry.lastDiscoveredAt}`);
  return { content: lines.join('\n') };
}

export function _resetMcpInvokeForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error('_resetMcpInvokeForTesting can only be called in test environment');
  }
  for (const [, entry] of pool) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
  }
  pool.clear();
  spawnLocks.clear();
  turnStates.clear();
  guardWindowSupplier = null;
}

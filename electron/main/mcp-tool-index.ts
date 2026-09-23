import { createLogger } from './logger';
import { getAllMCPServers, getMcpToolRegistryEntries, type MCPToolRegistryEntry } from './mcp-manager';
import { isDirectMcpHelper, PROMPT_CATALOG_MCP_HELPERS } from './mcp-risk-patterns';

const logger = createLogger('mcp-tool-index');

export interface McpToolIndexOptions {
  invokeToolName: string;
  schemaToolName: string;
  excludeServerIds?: string[];
  chatSurface?: 'codex-sdk';
}

const DESC_MAX_CHARS = 80;
const DESC_MAX_WORDS = 12;

const MCP_TOKEN_RE = /mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+/g;

function truncateDescription(raw: string): string {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const words = normalized.split(' ');
  let out = words.length > DESC_MAX_WORDS ? words.slice(0, DESC_MAX_WORDS).join(' ') : normalized;
  if (out.length > DESC_MAX_CHARS) {
    const cut = out.slice(0, DESC_MAX_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    out = (lastSpace > DESC_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd();
  }
  return out.length < normalized.length ? `${out}...` : out;
}

function sanitizeMcpTokens(text: string, whitelist: ReadonlySet<string>): string {
  return text.replace(MCP_TOKEN_RE, (token) => {
    if (whitelist.has(token)) return token;
    const parts = token.split('__');
    const server = parts[1] ?? '';
    const tool = parts.slice(2).join('__');
    return server && tool ? `${server}: ${tool}` : '';
  });
}

export function buildMcpToolIndex(opts: McpToolIndexOptions): string {
  const { invokeToolName, schemaToolName } = opts;
  const excludeSet = new Set(opts.excludeServerIds ?? []);

  const servers = getAllMCPServers()
    .filter((s) => s.isActive)
    .filter((s) => !isDirectMcpHelper(s.id) && !excludeSet.has(s.id))
    .filter((s) => {
      if (opts.chatSurface !== 'codex-sdk') return true;
      const vis = s.visibleTo ?? 'all';
      return vis === 'all' || vis === 'codex-lion-only';
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const includedIds = new Set(servers.map((s) => s.id));
  const entriesByServer = new Map<string, MCPToolRegistryEntry[]>();
  for (const entry of getMcpToolRegistryEntries()) {
    if (!includedIds.has(entry.mcpId)) continue;
    const list = entriesByServer.get(entry.mcpId);
    if (list) list.push(entry);
    else entriesByServer.set(entry.mcpId, [entry]);
  }

  const allEntries = [...entriesByServer.values()].flat();
  const anyDescribed = allEntries.some((e) => (e.description ?? '').trim().length > 0);

  if (servers.length === 0 || allEntries.length === 0 || !anyDescribed) {
    logger.debug(
      { servers: servers.length, entries: allEntries.length },
      'MCP index em modo descoberta (registry vazio ou sem descriptions)',
    );
    return [
      'Catalogo MCP em descoberta: as tools dos servidores MCP ainda estao sendo indexadas.',
      `Enquanto isso, consulte o contrato de uma tool especifica com ${schemaToolName}(server, tool) e invoque com ${invokeToolName}(server, tool, args).`,
    ].join('\n');
  }

  const sections: string[] = [];
  for (const server of servers) {
    const entries = entriesByServer.get(server.id) ?? [];
    const purpose = truncateDescription(server.description || server.name);

    if (server.indexMode === 'server') {
      const count = entries.length > 0 ? `${entries.length} tools` : 'tools';
      sections.push(`${server.id}: ${purpose} (${count} via ${schemaToolName})`);
      continue;
    }

    const lines: string[] = [`${server.id}: ${purpose}`];
    if (entries.length === 0) {
      lines.push(`- (tools em descoberta; consulte ${schemaToolName})`);
    }
    for (const entry of entries) {
      const desc = (entry.description ?? '').trim();
      lines.push(desc ? `- ${entry.toolName}: ${truncateDescription(desc)}` : `- ${entry.toolName}`);
    }
    sections.push(lines.join('\n'));
  }

  const body = [
    'Servidores MCP disponiveis (catalogo resumido; schemas completos sob demanda):',
    '',
    sections.join('\n\n'),
    '',
    `Para executar uma tool: ${invokeToolName}(server, tool, args).`,
    `Para consultar o contrato completo de uma tool antes de usar: ${schemaToolName}(server, tool).`,
  ].join('\n');

  logger.debug({ servers: servers.length, tools: allEntries.length, chars: body.length }, 'MCP tool index montado');

  return sanitizeMcpTokens(body, new Set([invokeToolName, schemaToolName]));
}

export interface DirectHelperCatalogOptions {
  serverIds: readonly string[];
  invokeToolName: string;
}

export function buildDirectHelperCatalog(opts: DirectHelperCatalogOptions): string {
  const candidates = [...opts.serverIds]
    .filter((id) => PROMPT_CATALOG_MCP_HELPERS.has(id.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  if (candidates.length === 0) return '';

  const sections: string[] = [];
  for (const serverId of candidates) {
    const entries = getMcpToolRegistryEntries(serverId);
    if (entries.length === 0) {
      sections.push(
        `${serverId}: tools em descoberta; apos a discovery, invoque com ${opts.invokeToolName}(server, tool, args).`,
      );
      continue;
    }
    const lines: string[] = [`${serverId}:`];
    for (const entry of entries) {
      const desc = (entry.description ?? '').trim();
      lines.push(desc ? `- ${entry.toolName}: ${desc}` : `- ${entry.toolName}`);
    }
    sections.push(lines.join('\n'));
  }

  const body = [
    `Ferramentas de helper (description completa; invoque com ${opts.invokeToolName}(server, tool, args)):`,
    '',
    sections.join('\n\n'),
  ].join('\n');

  logger.debug(
    { helpers: candidates.length, chars: body.length },
    'catalogo de helpers DIRECT (description completa) montado',
  );

  return sanitizeMcpTokens(body, new Set([opts.invokeToolName]));
}

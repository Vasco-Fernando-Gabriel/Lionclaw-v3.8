import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '../logger';
import { getAllMCPServers } from '../db';
import type { MCPServerConfig } from '../../../src/types';
import { PROCESS_IDENTITY_HELPER_IDS } from '../helper-identity';
import { CODEX_GATEWAY_SERVER_ID } from '../mcp-display';
import { resolveGatewayScriptPath } from '../mcp-manager';
import { isPackagedDistributionRuntime, resolveInternalNodeBinary } from '../distribution-runtime';
import {
  tomlKeyForConfigPath,
  segmentDeclaresMcpServer,
  parseMcpServerHeaderName,
  LIONCLAW_MANAGED_BEGIN_MARKER,
  LIONCLAW_MANAGED_END_MARKER,
} from '../codex-pipeline-config';
import { deleteWrapper, generateWrapper, listWrappers, writeWrapper } from './mcp-wrapper-generator';

const logger = createLogger('codex-mcp-config-sync');

const BEGIN_MARKER = LIONCLAW_MANAGED_BEGIN_MARKER;
const END_MARKER = LIONCLAW_MANAGED_END_MARKER;

function getLionClawHome(): string {
  return path.join(os.homedir(), '.lionclaw');
}

function getCodexConfigDir(): string {
  return path.join(os.homedir(), '.codex');
}

function getCodexConfigFile(): string {
  return path.join(getCodexConfigDir(), 'config.toml');
}

function tomlEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function tomlString(s: string): string {
  return `"${tomlEscape(s)}"`;
}

function tomlStringArray(values: string[]): string {
  if (values.length === 0) return '[]';
  return `[${values.map((v) => tomlString(v)).join(', ')}]`;
}

interface ResolvedServer {
  id: string;
  command: string;
  args: string[];
  envKeys: string[];
  wrapperPath?: string;
}

function buildManagedBlock(
  servers: ResolvedServer[],
  gatewayWrapperPath: string | undefined,
  nodeCommand: string,
): string {
  const lines: string[] = [];
  lines.push(BEGIN_MARKER);

  if (gatewayWrapperPath) {
    const gatewayKey = tomlKeyForConfigPath(CODEX_GATEWAY_SERVER_ID);
    if (gatewayKey) {
      lines.push('');
      lines.push(`[mcp_servers.${gatewayKey}]`);
      lines.push('enabled = false');
      lines.push('default_tools_approval_mode = "approve"');
      lines.push('tool_timeout_sec = 360');
      lines.push(`command = ${tomlString(nodeCommand)}`);
      lines.push(`args    = ${tomlStringArray([gatewayWrapperPath])}`);
    }
  }

  const sorted = [...servers].sort((a, b) => a.id.localeCompare(b.id));
  for (const server of sorted) {
    const key = tomlKeyForConfigPath(server.id);
    if (!key) {
      logger.warn({ id: server.id }, 'id de MCP server nao representavel em key TOML; entry pulada no managed block');
      continue;
    }
    lines.push('');
    lines.push(`[mcp_servers.${key}]`);
    lines.push('default_tools_approval_mode = "approve"');
    if (server.id === 'lionclaw-pipeline-control') {
      lines.push('tool_timeout_sec = 2400');
    }
    if (server.wrapperPath) {
      lines.push(`command = ${tomlString(nodeCommand)}`);
      lines.push(`args    = ${tomlStringArray([server.wrapperPath])}`);
    } else {
      lines.push(`command = ${tomlString(server.command)}`);
      lines.push(`args    = ${tomlStringArray(server.args)}`);
    }
  }

  lines.push('');
  lines.push(END_MARKER);
  return lines.join('\n');
}

function splitExisting(content: string): { pre: string; post: string } {
  const beginIdx = content.indexOf(BEGIN_MARKER);
  if (beginIdx === -1) {
    return { pre: content, post: '' };
  }
  const endIdx = content.indexOf(END_MARKER, beginIdx);
  const endLineEnd = endIdx === -1 ? content.length : endIdx + END_MARKER.length;
  const pre = content.slice(0, beginIdx);
  let post = content.slice(endLineEnd);
  let extraBlocks = 0;
  for (;;) {
    const b = post.indexOf(BEGIN_MARKER);
    if (b === -1) break;
    const e = post.indexOf(END_MARKER, b);
    const cut = e === -1 ? post.length : e + END_MARKER.length;
    post = post.slice(0, b) + post.slice(cut);
    extraBlocks += 1;
  }
  if (extraBlocks > 0) {
    logger.warn({ extraBlocks }, 'config.toml tinha blocos LIONCLAW_MANAGED extras (corrupcao); removidos');
  }
  return { pre, post };
}

function stripOrphanMarkerLines(segment: string): string {
  if (!segment.includes(END_MARKER) && !segment.includes(BEGIN_MARKER)) return segment;
  const kept = segment
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t !== END_MARKER && t !== BEGIN_MARKER;
    })
    .join('\n');
  logger.warn('config.toml tinha marcador LIONCLAW_MANAGED orfao fora do bloco; removido');
  return kept;
}

function removeManagedIdSections(segment: string, ids: ReadonlySet<string>): { content: string; adopted: string[] } {
  if (segment.length === 0 || ids.size === 0) return { content: segment, adopted: [] };
  const out: string[] = [];
  const adopted = new Set<string>();
  let skipping = false;
  for (const line of segment.split('\n')) {
    if (/^\s*\[/.test(line)) {
      const id = parseMcpServerHeaderName(line);
      if (id !== null && ids.has(id)) {
        skipping = true;
        adopted.add(id);
        continue;
      }
      skipping = false;
      out.push(line);
      continue;
    }
    if (!skipping) out.push(line);
  }
  return { content: out.join('\n'), adopted: [...adopted].sort() };
}

function extractMcpServerSections(segment: string, id: string): string {
  if (segment.length === 0) return '';
  const captured: string[] = [];
  let capturing = false;
  for (const line of segment.split('\n')) {
    if (/^\s*\[/.test(line)) {
      capturing = parseMcpServerHeaderName(line) === id;
    }
    if (capturing) captured.push(line);
  }
  return captured.join('\n');
}

function findDuplicateMcpTableHeaders(content: string): string[] {
  const seen = new Map<string, number>();
  for (const line of content.split('\n')) {
    const m = /^\s*\[(mcp_servers\.[^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, n]) => n > 1)
    .map(([k]) => k)
    .sort();
}

const segmentDeclaresServer = segmentDeclaresMcpServer;

function ensureTrailingNewline(s: string): string {
  if (s.length === 0) return '';
  return s.endsWith('\n') ? s : `${s}\n`;
}

function ensureLeadingNewline(s: string): string {
  if (s.length === 0) return '';
  return s.startsWith('\n') ? s : `\n${s}`;
}

async function readExistingConfig(file: string): Promise<string> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.config.toml.tmp-${process.pid}-${Date.now()}`);
  await fs.promises.writeFile(tmp, content, { encoding: 'utf8' });
  await fs.promises.rename(tmp, file);
}

export async function syncCodexMcpConfig(): Promise<void> {
  const lionclawHome = getLionClawHome();
  const configFile = getCodexConfigFile();
  const nodeCommand = isPackagedDistributionRuntime() ? resolveInternalNodeBinary() : 'node';

  let all: MCPServerConfig[];
  try {
    all = getAllMCPServers();
  } catch (err) {
    logger.warn({ err }, 'getAllMCPServers failed; treating as empty');
    all = [];
  }
  const active = all.filter((s) => s.isActive);

  const existing = await readExistingConfig(configFile);
  const { pre: rawPre, post: rawPost } = splitExisting(existing);
  const pre = stripOrphanMarkerLines(rawPre);
  const post = stripOrphanMarkerLines(rawPost);
  const gatewayOutsideSections =
    extractMcpServerSections(pre, CODEX_GATEWAY_SERVER_ID) + extractMcpServerSections(post, CODEX_GATEWAY_SERVER_ID);
  const gatewayOutsideIsDebris =
    gatewayOutsideSections.length > 0 && gatewayOutsideSections.includes(`mcp-wrappers/${CODEX_GATEWAY_SERVER_ID}`);
  if (gatewayOutsideIsDebris) {
    logger.warn(
      { id: CODEX_GATEWAY_SERVER_ID },
      'entry stranded do gateway fora do managed block aponta pro wrapper do LionClaw; adotada (removida do corpo, recriada dentro do bloco)',
    );
  }
  const gatewayCollisionOutside = gatewayOutsideSections.length > 0 && !gatewayOutsideIsDebris;
  const gatewayCollisionDb = all.some((s) => s.id === CODEX_GATEWAY_SERVER_ID);
  const gatewayCollision = gatewayCollisionOutside || gatewayCollisionDb;
  if (gatewayCollision) {
    logger.error(
      {
        id: CODEX_GATEWAY_SERVER_ID,
        outsideManagedBlock: gatewayCollisionOutside,
        inDb: gatewayCollisionDb,
      },
      'colisao do id reservado do gateway codex; entry do gateway NAO sincronizada (config.toml permanece valido; modo index degrada para full no spawn)',
    );
  }

  const syncable = gatewayCollisionOutside ? active.filter((s) => s.id !== CODEX_GATEWAY_SERVER_ID) : active;

  const resolved: ResolvedServer[] = [];
  for (const server of syncable) {
    const envKeys = Array.isArray(server.envKeys) ? server.envKeys : [];
    const fetchHelperToken = PROCESS_IDENTITY_HELPER_IDS.has(server.id.toLowerCase());
    if (envKeys.length > 0 || fetchHelperToken) {
      const source = generateWrapper(server.id, server.command, server.args, envKeys, lionclawHome, {
        fetchHelperToken,
      });
      const wrapperPath = await writeWrapper(server.id, source, lionclawHome);
      resolved.push({
        id: server.id,
        command: server.command,
        args: server.args,
        envKeys,
        wrapperPath,
      });
    } else {
      resolved.push({
        id: server.id,
        command: server.command,
        args: server.args,
        envKeys: [],
      });
    }
  }

  let gatewayWrapperPath: string | undefined;
  if (!gatewayCollision) {
    const gatewaySource = generateWrapper(
      CODEX_GATEWAY_SERVER_ID,
      nodeCommand,
      [resolveGatewayScriptPath()],
      [],
      lionclawHome,
      { staticEnv: { LIONCLAW_MCP_SURFACE: 'codex-sdk' } },
    );
    gatewayWrapperPath = await writeWrapper(CODEX_GATEWAY_SERVER_ID, gatewaySource, lionclawHome);
  }

  const expectedWrappers = new Set(resolved.filter((r) => r.wrapperPath).map((r) => path.basename(r.wrapperPath!)));
  if (gatewayWrapperPath) {
    expectedWrappers.add(path.basename(gatewayWrapperPath));
  }
  const existingWrappers = await listWrappers(lionclawHome);
  for (const file of existingWrappers) {
    const basename = path.basename(file);
    if (!expectedWrappers.has(basename)) {
      await deleteWrapper(file);
      logger.info({ file }, 'Deleted orphan MCP wrapper');
    }
  }

  const managed = buildManagedBlock(resolved, gatewayWrapperPath, nodeCommand);

  const managedIds = new Set(resolved.map((r) => r.id));
  if (gatewayWrapperPath) managedIds.add(CODEX_GATEWAY_SERVER_ID);
  const preSweep = removeManagedIdSections(pre, managedIds);
  const postSweep = removeManagedIdSections(post, managedIds);
  for (const [segment, sweep] of [
    ['pre', preSweep],
    ['post', postSweep],
  ] as const) {
    if (sweep.adopted.length > 0) {
      logger.warn(
        { segment, adopted: sweep.adopted },
        'tabelas mcp_servers gerenciadas encontradas FORA do managed block (debris de reescrita); adotadas — versao canonica entra no bloco',
      );
    }
  }

  const preNorm = preSweep.content.length > 0 ? ensureTrailingNewline(preSweep.content) : '';
  const postNorm = postSweep.content.length > 0 ? ensureLeadingNewline(postSweep.content) : '';
  const next = `${preNorm}${managed}\n${postNorm}`.replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');

  if (next === existing) {
    logger.debug({ configFile, count: resolved.length }, 'codex config.toml already in sync');
    return;
  }

  const duplicates = findDuplicateMcpTableHeaders(next);
  if (duplicates.length > 0) {
    logger.error(
      { configFile, duplicates },
      'sync ABORTADO: resultado declararia tabela mcp_servers duplicada (hard-fail de parse do codex); config.toml preservado',
    );
    return;
  }

  await atomicWrite(configFile, next);
  logger.info({ configFile, count: resolved.length }, 'codex config.toml synced');
}

export const __internal = {
  buildManagedBlock,
  splitExisting,
  segmentDeclaresServer,
  stripOrphanMarkerLines,
  removeManagedIdSections,
  extractMcpServerSections,
  findDuplicateMcpTableHeaders,
  BEGIN_MARKER,
  END_MARKER,
};

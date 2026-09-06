#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = process.argv[2] ?? path.join(os.homedir(), '.lionclaw', 'data', 'lionclaw.db');

const DIRECT_MCP_HELPERS = new Set([
  'lionclaw-user-question',
  'local-agents',
  'codex-agents',
  'lionclaw-pipeline-control',
  'lionclaw-dynamic-workflows',
  'repo-graph',
  'lionclaw-agents',
  'lionclaw-skills',
  'lionclaw-toolscript',
]);

const DESC_MAX_CHARS = 80;
const DESC_MAX_WORDS = 12;

const tokens = (chars) => Math.round(chars / 4);
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('pt-BR') : n);

function sql(query) {
  if (!existsSync(DB_PATH)) {
    console.error(`DB nao encontrado: ${DB_PATH}`);
    process.exit(1);
  }
  const out = execFileSync('sqlite3', ['-readonly', '-json', DB_PATH, query], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
}

function truncateDescription(raw) {
  const normalized = String(raw).replace(/\s+/g, ' ').trim();
  const words = normalized.split(' ');
  let out = words.length > DESC_MAX_WORDS ? words.slice(0, DESC_MAX_WORDS).join(' ') : normalized;
  if (out.length > DESC_MAX_CHARS) {
    const cut = out.slice(0, DESC_MAX_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    out = (lastSpace > DESC_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd();
  }
  return out.length < normalized.length ? `${out}...` : out;
}


const registryCols = sql(`PRAGMA table_info(mcp_tool_registry);`).map((c) => c.name);
const serverCols = sql(`PRAGMA table_info(mcp_servers);`).map((c) => c.name);
const hasInputSchema = registryCols.includes('input_schema');
const hasIndexModeCol = serverCols.includes('index_mode');

const servers = sql(
  `SELECT id, name, COALESCE(description,'') AS description, is_active, visible_to${hasIndexModeCol ? ', index_mode' : ''} FROM mcp_servers ORDER BY id;`,
).map((s) => ({ ...s, index_mode: hasIndexModeCol ? s.index_mode : 'tools' }));

const registry = sql(
  `SELECT mcp_id, tool_name, COALESCE(description,'') AS description${hasInputSchema ? ", COALESCE(input_schema,'') AS input_schema" : ''} FROM mcp_tool_registry ORDER BY mcp_id, tool_name;`,
).map((r) => ({ ...r, input_schema: hasInputSchema ? r.input_schema : '' }));

const activeServers = servers.filter((s) => s.is_active === 1);
const byServer = new Map();
for (const r of registry) {
  if (!byServer.has(r.mcp_id)) byServer.set(r.mcp_id, []);
  byServer.get(r.mcp_id).push(r);
}

const describedCount = registry.filter((r) => r.description.trim().length > 0).length;
const schemaCount = registry.filter((r) => r.input_schema.trim().length > 0).length;


const businessServers = activeServers.filter((s) => !DIRECT_MCP_HELPERS.has(s.id));

function buildIndexText({ invokeToolName, schemaToolName, projectedDescChars = 0 }) {
  const sections = [];
  let toolCount = 0;
  for (const server of businessServers) {
    const entries = byServer.get(server.id) ?? [];
    const purpose = truncateDescription(server.description || server.name);
    if (server.index_mode === 'server') {
      const count = entries.length > 0 ? `${entries.length} tools` : 'tools';
      sections.push(`${server.id}: ${purpose} (${count} via ${schemaToolName})`);
      continue;
    }
    const lines = [`${server.id}: ${purpose}`];
    if (entries.length === 0) lines.push(`- (tools em descoberta; consulte ${schemaToolName})`);
    for (const e of entries) {
      toolCount += 1;
      const desc = e.description.trim()
        ? truncateDescription(e.description)
        : projectedDescChars > 0
          ? 'x'.repeat(projectedDescChars)
          : '';
      lines.push(desc ? `- ${e.tool_name}: ${desc}` : `- ${e.tool_name}`);
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
  return { body, toolCount };
}

const RUNTIMES = [
  { runtime: 'claude-sdk', invoke: 'mcp__gateway__mcp_invoke', schema: 'mcp__gateway__mcp_schema' },
  { runtime: 'claude-compat-sdk', invoke: 'mcp__gateway__mcp_invoke', schema: 'mcp__gateway__mcp_schema' },
  { runtime: 'kimi-sdk', invoke: 'mcp_invoke', schema: 'mcp_schema' },
  { runtime: 'lion-sdk', invoke: 'mcp_call', schema: 'mcp_schema' },
];


const KIMI_PASSTHROUGH_SCHEMA = '{"type":"object","additionalProperties":true}';
const KIMI_ENVELOPE_OVERHEAD = 50;
function kimiFullChars() {
  let chars = 0;
  let count = 0;
  for (const server of activeServers) {
    for (const e of byServer.get(server.id) ?? []) {
      const fullName = `mcp__${server.id}__${e.tool_name}`;
      const desc = `Tool MCP ${fullName} (servidor ${server.id}).`;
      chars += fullName.length + desc.length + KIMI_PASSTHROUGH_SCHEMA.length + KIMI_ENVELOPE_OVERHEAD;
      count += 1;
    }
  }
  return { chars, count };
}

function lionFullChars() {
  const lines = ['## Available MCP Tools', ''];
  lines.push('Use the `mcp_call({ server_id, tool, args })` tool with the EXACT server_id + tool names listed below.');
  lines.push('');
  for (const server of activeServers) {
    const entries = byServer.get(server.id) ?? [];
    if (entries.length === 0) continue;
    lines.push(`### server: \`${server.id}\``);
    for (const e of entries) {
      const desc = e.description.trim() ? ` - ${e.description.slice(0, 200)}` : '';
      lines.push(`- \`${e.tool_name}\`${desc}`);
      if (e.input_schema.trim()) {
        try {
          const schema = JSON.parse(e.input_schema);
          const required = new Set(schema.required ?? []);
          const props = schema.properties ?? {};
          const names = Object.keys(props);
          if (names.length > 0) {
            lines.push('  args:');
            for (const name of names) {
              const p = props[name] ?? {};
              const type = p.type ? `: ${p.type}` : '';
              const req = required.has(name) ? 'required' : 'optional';
              const argDesc = p.description ? ` - ${String(p.description).slice(0, 160)}` : '';
              lines.push(`  - \`${name}\`${type} (${req})${argDesc}`);
            }
          }
        } catch {
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n').length;
}

const CLAUDE_ENVELOPE_OVERHEAD = 60;
function claudeFullChars() {
  let chars = 0;
  let count = 0;
  for (const server of activeServers) {
    if (server.visible_to !== 'all') continue;
    for (const e of byServer.get(server.id) ?? []) {
      const fullName = `mcp__${server.id}__${e.tool_name}`;
      chars += fullName.length + e.description.length + e.input_schema.length + CLAUDE_ENVELOPE_OVERHEAD;
      count += 1;
    }
  }
  return { chars, count };
}

function claudeHelpersChars() {
  let chars = 0;
  for (const server of activeServers) {
    if (server.visible_to !== 'all') continue;
    if (!DIRECT_MCP_HELPERS.has(server.id)) continue;
    for (const e of byServer.get(server.id) ?? []) {
      const fullName = `mcp__${server.id}__${e.tool_name}`;
      chars += fullName.length + e.description.length + e.input_schema.length + CLAUDE_ENVELOPE_OVERHEAD;
    }
  }
  return chars;
}

function kimiHelpersChars() {
  let chars = 0;
  for (const server of activeServers) {
    if (!DIRECT_MCP_HELPERS.has(server.id)) continue;
    for (const e of byServer.get(server.id) ?? []) {
      const fullName = `mcp__${server.id}__${e.tool_name}`;
      const desc = `Tool MCP ${fullName} (servidor ${server.id}).`;
      chars += fullName.length + desc.length + KIMI_PASSTHROUGH_SCHEMA.length + KIMI_ENVELOPE_OVERHEAD;
    }
  }
  return chars;
}

const META_TOOLS_TOKENS = 200;


console.log('=== Medicao AC-1 — MCP Index + Invoke (chars/4) ===');
console.log(`DB: ${DB_PATH}`);
console.log(
  `Schema V126: input_schema=${hasInputSchema ? 'SIM' : 'NAO'} | index_mode=${hasIndexModeCol ? 'SIM' : 'NAO'}`,
);
console.log(
  `Registry: ${registry.length} tools em ${activeServers.length} servers ativos | descriptions populadas: ${describedCount}/${registry.length} | input_schemas: ${schemaCount}/${registry.length}`,
);
console.log(
  `Servers de negocio no indice (P4 helpers fora): ${businessServers.length} servers / ${businessServers.reduce((n, s) => n + (byServer.get(s.id)?.length ?? 0), 0)} tools`,
);
console.log('');

const degraded = !hasInputSchema || describedCount === 0;
if (degraded) {
  console.log('AVISO: o DB ainda nao tem as colunas/dados da V126 populados');
  console.log('(migration + discovery rodam no boot do app). Medicao DEGRADADA:');
  console.log('- indice estimado com descriptions VAZIAS (so nomes) + projecao com');
  console.log('  descriptions no teto de 80 chars (limite superior);');
  console.log('- full lion SUBESTIMADO (sem args/schemas); full claude/compat N/D.');
  console.log('>>> Rode o app 1x pos-merge para popular e repita a medicao. <<<');
  console.log('');
}

const kimiFull = kimiFullChars();
const lionFull = lionFullChars();
const claudeFull = claudeFullChars();
const kimiHelpers = kimiHelpersChars();
const claudeHelpers = claudeHelpersChars();

const rows = [];
for (const { runtime, invoke, schema } of RUNTIMES) {
  const idx = buildIndexText({ invokeToolName: invoke, schemaToolName: schema });
  const idxProjected = buildIndexText({
    invokeToolName: invoke,
    schemaToolName: schema,
    projectedDescChars: DESC_MAX_CHARS,
  });
  let indexTokens = tokens(idx.body.length);
  let indexNote = '';
  if (degraded) {
    indexNote = ` (projecao c/ descriptions: ~${fmt(tokens(idxProjected.body.length))})`;
  }
  let fullTokens;
  let fullNote = '';
  let after = indexTokens;
  if (runtime === 'kimi-sdk') {
    fullTokens = tokens(kimiFull.chars);
    fullNote = ` (${kimiFull.count} declaracoes cegas)`;
    after = indexTokens + META_TOOLS_TOKENS + tokens(kimiHelpers);
    indexNote += ` [indice + 2 meta-tools + helpers DIRECT materializados]`;
  } else if (runtime === 'lion-sdk') {
    fullTokens = tokens(lionFull);
    fullNote = degraded ? ' (SUBESTIMADO: sem descriptions/args pre-V126)' : ' (catalogo eager reconstruido do registry)';
    after = indexTokens; // mcp_call/mcp_schema sao tools nativas, sem bloco extra
  } else {
    if (claudeFull.count > 0 && hasInputSchema && schemaCount > 0) {
      fullTokens = tokens(claudeFull.chars);
      fullNote = ` (${claudeFull.count} tools, input_schemas completos)`;
    } else {
      fullTokens = null;
      fullNote = ' (N/D: sem input_schema no registry — rode o app pos-merge)';
    }
    after = indexTokens + META_TOOLS_TOKENS + tokens(claudeHelpers); // gateway + helpers DIRECT
    indexNote += ' [indice + meta-tools do gateway + helpers DIRECT diretos]';
  }
  rows.push({ runtime, fullTokens, fullNote, after, indexNote });
}

console.log('Runtime            | ANTES (full)      | DEPOIS (index)    | Reducao');
console.log('-------------------|-------------------|-------------------|--------');
for (const r of rows) {
  const before = r.fullTokens === null ? 'N/D' : `~${fmt(r.fullTokens)} tok`;
  const after = `~${fmt(r.after)} tok`;
  const reduction =
    r.fullTokens === null || r.fullTokens === 0
      ? 'N/D'
      : `${Math.round((1 - r.after / r.fullTokens) * 100)}%`;
  console.log(
    `${r.runtime.padEnd(19)}| ${before.padEnd(18)}| ${after.padEnd(18)}| ${reduction}`,
  );
}
console.log('');
for (const r of rows) {
  console.log(`- ${r.runtime}: full${r.fullNote}; index${r.indexNote}`);
}
console.log('');
console.log('Notas de metodologia:');
console.log('- tokens = chars/4 (AC-1); overheads de envelope documentados no fonte.');
console.log('- indice exclui DIRECT_MCP_HELPERS (P4) e respeita index_mode por server.');
console.log('- kimi full computavel pre-V126 (schema passthrough constante).');

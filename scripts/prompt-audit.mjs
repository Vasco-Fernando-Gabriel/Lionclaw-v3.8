import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { getEncoding } from 'js-tiktoken';

const enc = getEncoding('cl100k_base');
const tok = (s) => (s ? enc.encode(s).length : 0);
const home = os.homedir();
const lion = path.join(home, '.lionclaw');
const repo = path.join(home, 'Desktop', 'LionClaw');
const DB = path.join(lion, 'data', 'lionclaw.db');
const OUT = path.join(home, 'Downloads', 'lionclaw-prompt-audit');
fs.mkdirSync(OUT, { recursive: true });
const readSafe = (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } };
const sql = (q) => execSync(`sqlite3 -json "${DB}" "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

const cli = readSafe(path.join(repo, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'));
let preset = '';
const mi = cli.indexOf("You are Claude Code, Anthropic's official CLI");
if (mi !== -1) {
  const tail = cli.slice(mi, mi + 60000);
  const endIdx = tail.search(/`[,;)]/);
  preset = (endIdx > 0 ? tail.slice(0, endIdx) : tail.slice(0, 12000))
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\`/g, '`')
    .replace(/\\\$/g, '$').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

const pb = readSafe(path.join(repo, 'electron', 'main', 'prompt-builder.ts'));
function grabPushBlock(src, fnName) {
  const start = src.indexOf(`function ${fnName}`);
  if (start === -1) return '';
  const body = src.slice(start, src.indexOf('\nfunction ', start + 10) === -1 ? undefined : src.indexOf('\nfunction ', start + 10));
  const matches = [...body.matchAll(/(?:parts\.push|'[^']*'|"[^"]*")/g)];
  return matches.map(m => m[0].replace(/^parts\.push/, '').replace(/^\(?['"]/, '').replace(/['"]\)?$/, '')).join('\n');
}
const fixedOperational = grabPushBlock(pb, 'buildOperationalSection');
const fixedCapabilities = grabPushBlock(pb, 'buildCapabilitiesSection'); // texto fixo (sem MCP/skills dinamicos)
function grabArrayFn(src, fnName) {
  const start = src.indexOf(`export function ${fnName}`);
  if (start === -1) return '';
  const end = src.indexOf('\n}', start);
  return src.slice(start, end).replace(/\\'/g, "'");
}
const fixedPipeline = grabArrayFn(pb, 'buildPipelineControlSection');
const fixedDynamic = grabArrayFn(pb, 'buildDynamicWorkflowSection');

const agents = JSON.parse(sql("SELECT name,id,description,model,allowed_tools,skills,runtime FROM agents WHERE is_active=1 AND (runtime='cloud' OR runtime IS NULL) ORDER BY sort_order") || '[]');
const subagentsSection = agents.map(a => {
  const tools = a.allowed_tools ? JSON.parse(a.allowed_tools).join(', ') : 'todas';
  let l = `- **${a.name}** (id: \`${a.id}\`): ${a.description || ''}\n  Modelo: ${a.model} | Tools: ${tools}`;
  if (a.skills && a.skills !== '[]') l += ` | Skills: ${JSON.parse(a.skills).join(', ')}`;
  return l;
}).join('\n');
const mcps = JSON.parse(sql("SELECT name,id,description,command FROM mcp_servers WHERE is_active=1") || '[]');
const mcpSection = mcps.map(m => `- **${m.name}** (id: ${m.id}): ${m.description || m.command}`).join('\n');

const soul = readSafe(path.join(lion, 'SOUL.md'));
const rules = readSafe(path.join(lion, 'RULES.md'));
const user = readSafe(path.join(lion, 'USER.md'));
const mem = readSafe(path.join(lion, 'MEMORY.md'));
const claudeMd = readSafe(path.join(lion, 'CLAUDE.md'));

const R = [];
const add = (label, s) => R.push([label, tok(s)]);
R.push(['=== BLOCO 1: PRESET (harness, fixo — nao controlavel) ===', '']);
add('preset claude_code (~estimado)', preset);
R.push(['=== BLOCO 2: APPEND LionClaw (buildSystemPrompt) ===', '']);
add('  operational (fixo)', fixedOperational);
add('  capabilities texto fixo', fixedCapabilities);
add('  pipeline-control (fixo)', fixedPipeline);
add('  dynamic-workflow (fixo)', fixedDynamic);
add('  >> SUBAGENTES cloud (126 agentes, dinamico)', subagentsSection);
add('  MCPs ativos (23, dinamico)', mcpSection);
R.push(['=== BLOCO 3: CLAUDE.md (persona+memoria, controlavel) ===', '']);
add('  SOUL.md', soul);
add('  RULES.md', rules);
add('  >> USER.md', user);
add('  MEMORY.md', mem);
add('CLAUDE.md TOTAL', claudeMd);

const w = 46;
console.log(R.map(([l, t]) => `${String(l).padEnd(w)} ${t === '' ? '' : String(t).padStart(7) + ' tok'}`).join('\n'));

const presetT = tok(preset);
const appendT = tok(fixedOperational) + tok(fixedCapabilities) + tok(fixedPipeline) + tok(fixedDynamic) + tok(subagentsSection) + tok(mcpSection);
const claudeT = tok(claudeMd);
const grand = presetT + appendT + claudeT;
console.log('\n' + '-'.repeat(w));
console.log(`SUBTOTAL preset  (fixo)      : ${String(presetT).padStart(7)} tok`);
console.log(`SUBTOTAL append LionClaw     : ${String(appendT).padStart(7)} tok`);
console.log(`SUBTOTAL CLAUDE.md           : ${String(claudeT).padStart(7)} tok`);
console.log(`TOTAL system prompt (s/ tools): ${String(grand).padStart(7)} tok`);
console.log(`\nNOTA: schemas das tools (built-in + 200+ MCP tools deferidas) NAO contabilizados aqui`);
console.log(`      — sao o 4o bloco e costumam ser o MAIOR de todos no harness Claude Code.`);

const dump = [
  '#'.repeat(80),
  '# DUMP DO PROMPT REAL — LionClaw',
  '# Fonte no codigo: claude-compat-sdk/index.ts:714',
  "# systemPrompt = { type:'preset', preset:'claude_code', append: <BLOCO 2> } + CLAUDE.md(CWD) + tools",
  '#'.repeat(80), '',
  `\n${'='.repeat(70)}\n[BLOCO 1] PRESET claude_code (SDK) — ~${presetT} tok\n${'='.repeat(70)}\n`,
  preset,
  `\n${'='.repeat(70)}\n[BLOCO 2] APPEND LionClaw (buildSystemPrompt) — ${appendT} tok\n${'='.repeat(70)}\n`,
  '--- operational ---\n' + fixedOperational,
  '\n--- capabilities (fixo) ---\n' + fixedCapabilities,
  '\n--- pipeline-control ---\n' + fixedPipeline,
  '\n--- dynamic-workflow ---\n' + fixedDynamic,
  `\n--- SUBAGENTES cloud (${agents.length}) ---\n` + subagentsSection,
  `\n--- MCPs ativos (${mcps.length}) ---\n` + mcpSection,
  `\n${'='.repeat(70)}\n[BLOCO 3] CLAUDE.md auto-lido do CWD — ${claudeT} tok\n${'='.repeat(70)}\n`,
  claudeMd,
].join('\n');
fs.writeFileSync(path.join(OUT, 'prompt-real-dump.txt'), dump, 'utf-8');
fs.writeFileSync(path.join(OUT, 'relatorio-tokens.txt'),
  R.map(([l, t]) => `${String(l).padEnd(w)} ${t === '' ? '' : String(t).padStart(7) + ' tok'}`).join('\n') +
  `\n\nSUBTOTAIS:\n preset=${presetT}  append=${appendT}  claude.md=${claudeT}  TOTAL(s/tools)=${grand}\n`, 'utf-8');
console.log('\nArquivos: ' + OUT);

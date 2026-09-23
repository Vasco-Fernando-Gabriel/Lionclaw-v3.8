import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAIN = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(MAIN, rel), 'utf-8');

const compatSrc = read('claude-compat-sdk/index.ts');
const kimiSrc = read('kimi-sdk/index.ts');
const kimiSessionSrc = read('kimi-sdk/session.ts');
const acpTranslatorSrc = read('kimi-acp/acp-translator.ts');
const codexSrc = read('codex-sdk/index.ts');
const codexSessionSrc = read('codex-sdk/session.ts');
const orchestratorSrc = read('orchestrator.ts');
const dbSrc = read('db.ts');
const contractSrc = read('agent-runtime/cli-agentic/contract.ts');

describe('contexto-vivo §8 — compat: sem dupla contagem + subagente fora', () => {
  it('acumula agentico em EXATAMENTE 4 sites (args tool_use, args server_tool_use, result assistant, result user)', () => {
    const sites = compatSrc.match(/agenticTurnTokens \+=/g) ?? [];
    expect(sites.length).toBe(4);
  });

  it('todo site de acumulacao e guardado pela thread PRINCIPAL (parent_tool_use_id == null)', () => {
    const chunks = compatSrc.split('agenticTurnTokens +=');
    for (let i = 1; i < chunks.length; i++) {
      const before = chunks[i - 1].slice(-400);
      expect(before).toMatch(/if \(!(assistantParentToolUseId|userParentToolUseId)\)/);
    }
  });

  it('textos do assistant NAO alimentam o acumulador (vao ao DB -> bucket historico)', () => {
    expect(compatSrc).not.toMatch(/estimateAgenticContentTokens\(\s*assistantContent/);
    expect(compatSrc).not.toMatch(/agenticTurnTokens\s*\+=\s*estimateTokensRough/);
    expect(compatSrc).toMatch(/compatMessageTexts\.push\(assistantContent\)/);
  });

  it('indice MCP NAO e somado por fora no compat (ja vive DENTRO do fullSystemPrompt, §3.1)', () => {
    expect(compatSrc).toMatch(/systemPrompt: fullSystemPrompt/);
    expect(compatSrc).not.toMatch(/indexTokens|mcpIndexTokens/);
  });

  it('agent_defs = SO nome+descricao (o prompt do subagente nunca entra na janela principal, §3.3)', () => {
    const agentDefsBlock = compatSrc.slice(
      compatSrc.indexOf('agentDefsTokens: compositionAgentIds.reduce'),
      compatSrc.indexOf('agentDefsTokens: compositionAgentIds.reduce') + 500,
    );
    expect(agentDefsBlock).toContain('.description');
    expect(agentDefsBlock).not.toContain('.prompt');
    expect(agentDefsBlock).not.toContain('.systemPrompt');
  });
});

describe('contexto-vivo §8 — compat: compact_boundary zera/rebaseia', () => {
  it('compact_boundary zera base + turno e avanca o fence', () => {
    const idx = compatSrc.indexOf("subtype === 'compact_boundary'");
    expect(idx).toBeGreaterThan(-1);
    const block = compatSrc.slice(idx, idx + 2200);
    expect(block).toContain('agenticBaseTokens = 0');
    expect(block).toContain('agenticTurnTokens = 0');
    expect(block).toContain('boundaryFenceMessageId = boundaryLastMsgId');
    expect(block).toContain('effectiveThreadResetId = boundaryLastMsgId');
  });

  it('acumulador + fence persistem NA MESMA escrita (1 UPDATE no sucesso do turno)', () => {
    const writes = compatSrc.match(/setSessionAgenticContextTokens\(/g) ?? [];
    expect(writes.length).toBe(1);
    expect(compatSrc).toMatch(
      /setSessionAgenticContextTokens\(\s*sessionId,\s*agenticBaseTokens \+ agenticTurnTokens,\s*boundaryFenceMessageId/,
    );
  });

  it('setter do db grava fence na MESMA escrita e NUNCA toca billing/contador ativo', () => {
    const idx = dbSrc.indexOf('export function setSessionAgenticContextTokens');
    expect(idx).toBeGreaterThan(-1);
    const fn = dbSrc.slice(idx, idx + 900);
    expect(fn).toContain('agentic_context_tokens_est = ?');
    expect(fn).toContain('thread_reset_message_id = ?');
    expect(fn).not.toContain('input_tokens');
    expect(fn).not.toContain('cost_usd');
    expect(fn).not.toContain('active_context_tokens_est');
  });
});

describe('contexto-vivo §8 — compat: fence (compactacao E reset-sem-compactacao)', () => {
  it('historico do PISO usa getSessionMessagesAfterFence com max(compacted_up_to, thread_reset)', () => {
    expect(compatSrc).toMatch(
      /resolveHistoryFence\(\s*sessionRow\?\.compactedUpToMessageId \?\? null,\s*effectiveThreadResetId,?\s*\)/,
    );
    expect(compatSrc).toContain('getSessionMessagesAfterFence(sessionId, historyFence)');
  });

  it('thread recriada SEM compactacao grava thread_reset_message_id; com pendingSeed NAO grava', () => {
    expect(compatSrc).toMatch(
      /resetSessionAgenticContext\(\s*sessionId,\s*pendingSeed \? \{\} : \{ threadResetMessageId: preTurnLastMessageId \},?\s*\)/,
    );
  });

  it('regra por CONDICAO do reset (§3.6): shouldContinueSession === false OU pendingSeed presente', () => {
    expect(compatSrc).toContain('const threadRecreated = !shouldContinueSession || pendingSeed !== null;');
  });

  it('seed/rolling_summary contam no historico sem dupla contagem (um OU outro)', () => {
    const idx = compatSrc.indexOf('if (pendingSeed) {\n      compatMessageTexts.push(pendingSeed);');
    expect(idx).toBeGreaterThan(-1);
    expect(compatSrc).toMatch(
      /\} else if \(sessionRow\?\.rollingSummary\) \{\s*compatMessageTexts\.push\(sessionRow\.rollingSummary\);/,
    );
  });

  it('getSessionMessagesAfterFence e ADITIVA: fence null degenera em getSessionMessages (callers atuais intocados)', () => {
    const idx = dbSrc.indexOf('export function getSessionMessagesAfterFence');
    expect(idx).toBeGreaterThan(-1);
    const fn = dbSrc.slice(idx, idx + 600);
    expect(fn).toContain('if (fenceMessageId === null) return getSessionMessages(sessionId);');
    expect(fn).toContain('id > ?');
  });
});

describe('contexto-vivo §8 — regime efemero (kimi/codex): turno 2 nao carrega turno 1', () => {
  it('kimi: contador declarado POR-TURNO dentro do executor; nunca le/persiste acumulador de sessao', () => {
    expect(kimiSrc).toContain('let agenticTurnTokens = 0;');
    expect(kimiSrc).not.toContain('agenticContextTokensEst');
    expect(kimiSrc).not.toContain('setSessionAgenticContextTokens');
    expect(kimiSrc).not.toContain('resetSessionAgenticContext');
    expect(kimiSrc).toMatch(/agenticTokens: agenticTurnTokens/);
  });

  it('codex: contador do turno POR-TURNO; acumulador persistente SO no caminho oficial (thread viva)', () => {
    expect(codexSrc).toContain('let agenticTurnTokens = 0;');
    expect(codexSrc).toContain('setSessionAgenticContextTokens(');
    expect(codexSrc).toContain('agenticContextTokensEst');
    expect(codexSrc).toContain('floorAgenticTokens = agenticTurnTokens;');
    expect(codexSrc).toMatch(/agenticTokens: floorAgenticTokens/);
  });

  it('kimi: extensao ADITIVA — onToolUseIO com input E output separados, forwarding no session.send', () => {
    expect(contractSrc).toMatch(
      /onToolUseIO\?: \(tool: string, input: unknown, output: unknown, toolCallId\?: string\) => void;/,
    );
    expect(contractSrc).toMatch(/onToolUseComplete\?: \(tool: string, input: unknown, toolCallId\?: string\) => void;/);
    expect(acpTranslatorSrc).toContain('cb?.onToolUseIO?.(');
    expect(kimiSessionSrc).toContain('onToolUseIO: callbacks.onToolUseIO');
    expect(kimiSrc).toMatch(
      /onToolUseIO: \(tool: string, input: unknown, output: unknown, toolCallId\?: string\) => \{/,
    );
  });

  it('codex legacy: PISO por-turno SEM args (gap aceito §4) — so o result alimenta o contador', () => {
    expect(codexSrc).toMatch(/agenticTurnTokens \+= estimateAgenticContentTokens\(result\);/);
    expect(codexSrc).not.toContain('onToolUseIO');
    expect(codexSessionSrc).toContain('onContextMeta');
    expect(codexSessionSrc).toContain("await import('../mcp-manager')");
  });

  it('codex oficial INTOCADO: tokenUsage.last (response.lastUsage) segue a fonte preferida', () => {
    expect(codexSrc).toContain('response.lastUsage');
    expect(codexSrc).toMatch(/normalizeUsage\(response\.lastUsage, 'codex'\)/);
  });
});

describe('contexto-vivo §8 — invariantes (byte-identicos por regra)', () => {
  const specSymbols = [
    'estimateStrongFloor',
    'estimateAgenticContentTokens',
    'setSessionAgenticContextTokens',
    'resetSessionAgenticContext',
    'getSessionMessagesAfterFence',
    'resolveHistoryFence',
    'agenticTurnTokens',
    'agentic_context_tokens_est',
    'thread_reset_message_id',
    'CLI_PRESET_TOKENS',
    'KIMI_PRESET_TOKENS',
    'CODEX_PRESET_TOKENS',
  ];

  it('orchestrator.ts (path claude-sdk) sem NENHUM simbolo novo da SPEC', () => {
    for (const sym of specSymbols) {
      expect(orchestratorSrc.includes(sym), `orchestrator.ts nao pode conter ${sym}`).toBe(false);
    }
  });

  it('billing intocado: updateSessionTokens nao referencia as colunas novas da V130', () => {
    const idx = dbSrc.indexOf('export function updateSessionTokens');
    expect(idx).toBeGreaterThan(-1);
    const fn = dbSrc.slice(idx, idx + 800);
    expect(fn).not.toContain('agentic_context_tokens_est');
    expect(fn).not.toContain('thread_reset_message_id');
  });

  it('compat: billing continua recebendo o resultUsage SEMPRE (reconciliacao por max)', () => {
    expect(compatSrc).toContain('updateSessionTokens(');
    expect(compatSrc).toMatch(/totalInputTokens = Math\.max\(totalInputTokens, rInput\);/);
  });

  it('compat: ordem das fontes intacta — lastMainUsage > resultUsage (turno simples) > PISO', () => {
    expect(compatSrc).toContain('const singleRequestTurn = mainRequestCount <= 1;');
    expect(compatSrc).toMatch(/singleRequestTurn && resultUsage\s*\?\s*normalizeUsage\(resultUsage, 'anthropic'\)/);
    expect(compatSrc).toMatch(
      /reconcileActiveContext\(\s*realPromptTokens,\s*realOutputTokens,\s*compatContextEstimate,?\s*\)/,
    );
  });

  it('logger TEMPORARIO "CTX-COMPAT-FIX diag" foi REMOVIDO', () => {
    expect(compatSrc).not.toContain("'CTX-COMPAT-FIX diag'");
  });
});

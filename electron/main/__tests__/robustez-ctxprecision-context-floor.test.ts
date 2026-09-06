import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  normalizeUsage,
  canonicalPromptTokens,
  estimateRequestTokens,
  reconcileActiveContext,
} from '../agent-runtime/context-measure';
import { activeToolSchemasJson } from '../agent-runtime/tool-schemas';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(__dirname, '..');

const SYSTEM_PROMPT = 'S'.repeat(92_000); // ~23.000 tokens
const HISTORY_TEXTS = [
  'U'.repeat(88_000), // turno de usuario grande (~22K tokens)
  'A'.repeat(60_000), // resposta anterior (~15K tokens)
];
const ASSISTANT_RESPONSE = 'R'.repeat(4_000); // ~1.000 tokens
const ENABLED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'WebFetch',
  'TodoWrite',
  'NotebookEdit',
];

describe('activeToolSchemasJson — bucket de schemas do PISO (Hermes str(tools))', () => {
  it('serializa full schema para builtins conhecidos e stub {name} para o resto', () => {
    const json = activeToolSchemasJson(ENABLED_TOOLS);
    expect(json).not.toBe('');
    const parsed = JSON.parse(json) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(ENABLED_TOOLS.length);
    expect(json).toContain('file_path');
    expect(json).toContain('"name":"TodoWrite"');
  });

  it('lista vazia -> string vazia (sem bucket, nao explode)', () => {
    expect(activeToolSchemasJson([])).toBe('');
  });

  it('escala com a contagem de tools (50+ tools = 20-30K invisiveis, #14695)', () => {
    const few = activeToolSchemasJson(['Read']).length;
    const many = activeToolSchemasJson(
      Array.from({ length: 50 }, (_, i) => `mcp_tool_${i}`),
    ).length;
    expect(many).toBeGreaterThan(few);
  });
});

describe('MINOR-1 — compat: contexto vivo NUNCA vira o odometro do resultUsage', () => {
  const lastMainUsageRaw: Record<string, number> | null = null; // GLM/MiniMax
  const resultUsage = {
    input_tokens: 646_000,
    cache_read_input_tokens: 40_000,
    cache_creation_input_tokens: 0,
    output_tokens: 12_000,
  };

  const compatContextEstimate = estimateRequestTokens({
    systemPrompt: SYSTEM_PROMPT,
    messageTexts: [...HISTORY_TEXTS, ASSISTANT_RESPONSE],
    toolSchemasJson: activeToolSchemasJson(ENABLED_TOOLS),
    imageCount: 0,
  });

  it('o odometro (resultUsage agregado) seria ~686K — NAO pode ser o contexto', () => {
    const odometer = canonicalPromptTokens(normalizeUsage(resultUsage, 'anthropic'));
    expect(odometer).toBe(686_000);
  });

  it('sem usage por-request, o contexto vivo = PISO do payload (odometro ignorado)', () => {
    const primaryUsage = lastMainUsageRaw; // <- SEM `?? resultUsage`
    const canonical = primaryUsage ? normalizeUsage(primaryUsage, 'anthropic') : null;
    const realPromptTokens = canonical ? canonicalPromptTokens(canonical) : 0;
    const realOutputTokens = canonical ? 12_000 : 0;
    const live = reconcileActiveContext(
      realPromptTokens,
      realOutputTokens,
      compatContextEstimate,
    );

    expect(live).not.toBe(686_000);
    expect(live).toBeLessThan(200_000);
    const oldSubcount = estimateRequestTokens({
      messageTexts: ['oi', ASSISTANT_RESPONSE],
    });
    expect(oldSubcount).toBeLessThan(2_000);
    expect(live).toBeGreaterThan(oldSubcount * 20);
    expect(live).toBe(compatContextEstimate);
    expect(live).toBeGreaterThan(50_000); // ~60K: system+historico
  });

  it('quando o provider POPULA usage por-request, o real (nao-odometro) vence', () => {
    const perRequest = {
      input_tokens: 11_016,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 0,
      output_tokens: 161,
    };
    const canonical = normalizeUsage(perRequest, 'anthropic');
    const live = reconcileActiveContext(
      canonicalPromptTokens(canonical),
      161,
      compatContextEstimate,
    );
    expect(live).toBe(51_016 + 161);
  });
});

describe('MINOR-2 — PISO inclui system prompt E schemas (nao mais subcount)', () => {
  const full = estimateRequestTokens({
    systemPrompt: SYSTEM_PROMPT,
    messageTexts: [...HISTORY_TEXTS, ASSISTANT_RESPONSE],
    toolSchemasJson: activeToolSchemasJson(ENABLED_TOOLS),
  });

  it('remover o system prompt derruba o PISO em ~23K tokens (system contado)', () => {
    const withoutSystem = estimateRequestTokens({
      messageTexts: [...HISTORY_TEXTS, ASSISTANT_RESPONSE],
      toolSchemasJson: activeToolSchemasJson(ENABLED_TOOLS),
    });
    expect(full - withoutSystem).toBe(Math.ceil(SYSTEM_PROMPT.length / 4));
    expect(full - withoutSystem).toBeGreaterThan(20_000);
  });

  it('remover os schemas derruba o PISO (schemas contados)', () => {
    const withoutSchemas = estimateRequestTokens({
      systemPrompt: SYSTEM_PROMPT,
      messageTexts: [...HISTORY_TEXTS, ASSISTANT_RESPONSE],
    });
    expect(full).toBeGreaterThan(withoutSchemas);
  });

  it('imagem entra FLAT (~1500), nao os bytes', () => {
    const base = estimateRequestTokens({ messageTexts: ['x'] });
    const withImg = estimateRequestTokens({ messageTexts: ['x'], imageCount: 1 });
    expect(withImg - base).toBe(1500);
  });
});

describe('source-guard — call sites alimentam a fonte certa', () => {
  const read = (rel: string) => fs.readFileSync(path.join(MAIN, rel), 'utf8');

  it('compat: fonte 1 = lastMainUsageRaw por VALOR; resultUsage SO em turno simples (nunca odometro)', () => {
    const src = read('claude-compat-sdk/index.ts');
    expect(src).toContain("normalizeUsage(lastMainUsageRaw, 'anthropic')");
    expect(src).toContain('const singleRequestTurn = mainRequestCount <= 1;');
    expect(src).toMatch(/singleRequestTurn && resultUsage/);
  });

  it('compat: PISO FORTE alimenta system + historico apos FENCE + schemas MCP reais (SPEC contexto-vivo)', () => {
    const src = read('claude-compat-sdk/index.ts');
    expect(src).toContain('estimateStrongFloor');
    expect(src).toContain('systemPrompt: fullSystemPrompt');
    expect(src).toContain('getSessionMessagesAfterFence(sessionId, historyFence)');
    expect(src).toContain('serializeMcpSchemasForContext');
    expect(src).not.toContain('activeToolSchemasJson');
  });

  it('codex/kimi: PISO FORTE por-turno (preset do CLI + buckets da sessao + agentico do turno)', () => {
    for (const rel of ['codex-sdk/index.ts', 'kimi-sdk/index.ts']) {
      const src = read(rel);
      expect(src).toContain('estimateStrongFloor');
    }
    expect(read('kimi-sdk/index.ts')).toContain('agenticTokens: agenticTurnTokens');
    expect(read('kimi-sdk/index.ts')).toContain('KIMI_PRESET_TOKENS');
    const codexSrc = read('codex-sdk/index.ts');
    expect(codexSrc).toContain('agenticTokens: floorAgenticTokens');
    expect(codexSrc).toContain('floorAgenticTokens = agenticTurnTokens;');
    expect(codexSrc).toContain('setSessionAgenticContextTokens(');
    expect(codexSrc).toContain('CODEX_PRESET_TOKENS');
  });

  it('lion: PISO usa o array REAL de schemas em memoria', () => {
    const src = read('lion-sdk/index.ts');
    expect(src).toContain('toolSchemas.length ? JSON.stringify(toolSchemas) : undefined');
  });
});

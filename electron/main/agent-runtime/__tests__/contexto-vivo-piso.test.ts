import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  estimateStrongFloor,
  estimateAgenticContentTokens,
  resolveHistoryFence,
  computeCompositionSignature,
  getOrComputeCompositionStatic,
  estimateTokensRough,
  CLI_PRESET_TOKENS,
  CLI_BUILTIN_SCHEMAS_TOKENS,
  KIMI_PRESET_TOKENS,
  CODEX_PRESET_TOKENS,
  CONTEXT_CALIBRATION_SDK_VERSION,
  IMAGE_TOKEN_COST,
  __clearCompositionCacheForTests,
  __compositionCacheStatsForTests,
  type CompositionSignatureParts,
} from '../context-measure';
import { serializeMcpSchemasForContext, GATEWAY_META_TOOL_SCHEMAS, type McpRegistryToolRow } from '../tool-schemas';

const MCP_FIXTURE_ROWS: McpRegistryToolRow[] = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'ctx-piso-mcp-registry-index-composition.json'), 'utf-8'),
);

describe('contexto-vivo §8 — convergencia do PISO forte (ancora real, compat)', () => {
  const REAL_SIMPLE_TURN_PROMPT_TOKENS = 52748;

  it('turno simples: piso_forte em [80%, 110%] do resultUsage real (fixture diferente da calibracao)', () => {
    const systemPrompt = 'p'.repeat(45472);
    const settingsFilesTokens = Math.ceil(26917 / 4) + Math.ceil(824 / 4);
    const mcpJson = serializeMcpSchemasForContext(MCP_FIXTURE_ROWS, {
      includeGatewayMeta: true,
    });
    expect(mcpJson.length).toBeGreaterThan(20000);
    const agentDefsTokens = 5304;
    const messageTexts = ['u'.repeat(120), 'a'.repeat(100)];

    const floor = estimateStrongFloor({
      systemPrompt,
      presetTokens: CLI_PRESET_TOKENS,
      builtinSchemasTokens: CLI_BUILTIN_SCHEMAS_TOKENS,
      settingsFilesTokens,
      mcpSchemasJson: mcpJson,
      agentDefsTokens,
      messageTexts,
      agenticTokens: 0, // turno simples
      imageCount: 0,
    });

    const lower = Math.floor(REAL_SIMPLE_TURN_PROMPT_TOKENS * 0.8);
    const upper = Math.ceil(REAL_SIMPLE_TURN_PROMPT_TOKENS * 1.1);
    expect(floor).toBeGreaterThanOrEqual(lower);
    expect(floor).toBeLessThanOrEqual(upper);
    expect(floor).toBeGreaterThan(40000);
  });

  it('guarda da calibracao (§7): residuo real = CLI_PRESET + CLI_BUILTIN_SCHEMAS, versao do SDK pinada', () => {
    expect(CLI_PRESET_TOKENS + CLI_BUILTIN_SCHEMAS_TOKENS).toBe(22433);
    expect(CONTEXT_CALIBRATION_SDK_VERSION).toBe('0.3.257');
    expect(KIMI_PRESET_TOKENS).toBeGreaterThan(0);
    expect(CODEX_PRESET_TOKENS).toBeGreaterThan(0);
  });
});

describe('contexto-vivo §8 — agentico nao desaba', () => {
  it('turno com N tool args/results conhecidos -> contexto ~ soma esperada (ordem certa, nao 12k)', () => {
    let agentic = 0;
    for (let i = 0; i < 14; i++) {
      agentic += estimateAgenticContentTokens({ file_path: `/x/${'f'.repeat(190)}` });
      agentic += estimateAgenticContentTokens('r'.repeat(15000));
    }
    expect(agentic).toBeGreaterThan(50000);

    const floor = estimateStrongFloor({
      systemPromptTokens: 11368,
      presetTokens: CLI_PRESET_TOKENS,
      builtinSchemasTokens: CLI_BUILTIN_SCHEMAS_TOKENS,
      messageTexts: ['pergunta', 'resposta final'],
      agenticTokens: agentic,
    });
    expect(floor).toBeGreaterThanOrEqual(11368 + CLI_PRESET_TOKENS + CLI_BUILTIN_SCHEMAS_TOKENS + agentic);
    expect(floor).toBeGreaterThan(80000);
  });

  it('buckets sao independentes: textos de mensagem NAO entram no agentico (sem dupla contagem)', () => {
    const verboseText = 'texto intermediario verboso do assistant '.repeat(200);
    const base = estimateStrongFloor({ messageTexts: [verboseText], agenticTokens: 0 });
    const withAgentic = estimateStrongFloor({
      messageTexts: [verboseText],
      agenticTokens: 1000,
    });
    expect(withAgentic - base).toBe(1000);
    expect(base).toBe(estimateTokensRough(verboseText));
  });
});

describe('contexto-vivo §8 — imagem flat', () => {
  it('tool result com imagem base64 soma 1500 flat, nao ~500k (sem loop de compactacao)', () => {
    const twoMbBase64 = 'A'.repeat(2 * 1024 * 1024);
    const toolResultBlocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: twoMbBase64 } },
      { type: 'text', text: 'screenshot capturado' },
    ];
    const tokens = estimateAgenticContentTokens(toolResultBlocks);
    expect(tokens).toBe(IMAGE_TOKEN_COST + Math.ceil('screenshot capturado'.length / 4));
    expect(tokens).toBeLessThan(2000);
  });

  it('objeto de imagem unico tambem e flat; string base64 crua (sem shape) segue char/4', () => {
    expect(estimateAgenticContentTokens({ type: 'image', data: 'B'.repeat(100000) })).toBe(IMAGE_TOKEN_COST);
  });

  it('fronteira de bookkeeping (§3.5): imagens_flat da formula cobre SO attachments', () => {
    const agentic = estimateAgenticContentTokens([{ type: 'image' }]);
    const floor = estimateStrongFloor({
      messageTexts: [],
      agenticTokens: agentic,
      imageCount: 1,
    });
    expect(floor).toBe(2 * IMAGE_TOKEN_COST);
  });

  it('valor nao-serializavel nunca lanca (conta 0)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => estimateAgenticContentTokens(circular)).not.toThrow();
    expect(estimateAgenticContentTokens(circular)).toBe(0);
    expect(estimateAgenticContentTokens(null)).toBe(0);
    expect(estimateAgenticContentTokens(undefined)).toBe(0);
  });
});

describe('contexto-vivo §8 — fence do historico (§3.4)', () => {
  const mkMessages = (ids: number[]) => ids.map((id) => ({ id, content: 'm'.repeat(400) }));

  const historyTokensAfterFence = (msgs: Array<{ id: number; content: string }>, fence: number | null) =>
    estimateStrongFloor({
      messageTexts: msgs.filter((m) => fence === null || m.id > fence).map((m) => m.content),
    });

  it('pos-COMPACTACAO: fence = compacted_up_to_message_id — o historico contado nao re-infla', () => {
    const msgs = mkMessages([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const fence = resolveHistoryFence(8, null);
    expect(fence).toBe(8);
    expect(historyTokensAfterFence(msgs, fence)).toBe(200);
  });

  it('pos-RESET-SEM-COMPACTACAO: fence = thread_reset_message_id — sem historico fantasma', () => {
    const msgs = mkMessages([1, 2, 3, 4, 5]);
    const fence = resolveHistoryFence(null, 5);
    expect(fence).toBe(5);
    expect(historyTokensAfterFence(msgs, fence)).toBe(0);
  });

  it('fence = max(compactacao, reset); null quando nenhum existe (sessao inteira conta)', () => {
    expect(resolveHistoryFence(3, 7)).toBe(7);
    expect(resolveHistoryFence(9, 2)).toBe(9);
    expect(resolveHistoryFence(null, null)).toBeNull();
    expect(resolveHistoryFence(undefined, undefined)).toBeNull();
    expect(resolveHistoryFence(0, null)).toBe(0);
  });
});

describe('contexto-vivo §8 — performance do cache por assinatura (§5)', () => {
  const baseParts: CompositionSignatureParts = {
    runtimeKey: 'claude-compat-sdk:zai',
    sdkVersion: CONTEXT_CALIBRATION_SDK_VERSION,
    mcpServerIds: ['gateway', 'repo-graph', 'lionclaw-toolscript'],
    mode: 'index',
    capabilityKey: 'null',
    systemPromptLength: 45472,
    agentIds: ['a1', 'a2'],
  };
  const compute = () => ({
    settingsFilesTokens: 6936,
    mcpSchemasTokens: 6500,
    agentDefsTokens: 5304,
  });

  beforeEach(() => {
    __clearCompositionCacheForTests();
  });

  it('turnos consecutivos sem mudanca de composicao hitam o cache (1 compute so)', () => {
    let computeCalls = 0;
    const counted = () => {
      computeCalls += 1;
      return compute();
    };
    const sig = computeCompositionSignature(baseParts);
    const first = getOrComputeCompositionStatic(sig, counted);
    const second = getOrComputeCompositionStatic(sig, counted);
    const third = getOrComputeCompositionStatic(sig, counted);
    expect(computeCalls).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(__compositionCacheStatsForTests()).toEqual({ hits: 2, misses: 1 });
  });

  it('mudou toggle de capability -> assinatura muda -> recomputa', () => {
    const sigA = computeCompositionSignature(baseParts);
    const sigB = computeCompositionSignature({ ...baseParts, capabilityKey: 'pc:0' });
    expect(sigB).not.toBe(sigA);
    getOrComputeCompositionStatic(sigA, compute);
    getOrComputeCompositionStatic(sigB, compute);
    expect(__compositionCacheStatsForTests().misses).toBe(2);
  });

  it('mudou o fullSystemPrompt (length) mid-sessao -> recomputa (nunca serve stale)', () => {
    const sigA = computeCompositionSignature(baseParts);
    const sigB = computeCompositionSignature({ ...baseParts, systemPromptLength: 45473 });
    expect(sigB).not.toBe(sigA);
  });

  it('assinatura e insensivel a ORDEM dos ids (sem miss falso)', () => {
    const sigA = computeCompositionSignature(baseParts);
    const sigB = computeCompositionSignature({
      ...baseParts,
      mcpServerIds: ['lionclaw-toolscript', 'gateway', 'repo-graph'],
      agentIds: ['a2', 'a1'],
    });
    expect(sigB).toBe(sigA);
  });
});

describe('contexto-vivo §3.2 — serializacao MCP mode-aware', () => {
  it('serializa o input_schema INTEIRO do registry (nao o stub de nomes)', () => {
    const json = serializeMcpSchemasForContext(MCP_FIXTURE_ROWS);
    const parsed = JSON.parse(json) as Array<{ function: { name: string; parameters?: unknown } }>;
    expect(parsed.length).toBe(MCP_FIXTURE_ROWS.length);
    const withParams = parsed.filter((e) => e.function.parameters !== undefined);
    expect(withParams.length).toBeGreaterThan(20);
    expect(parsed[0].function.name).toMatch(/^mcp__[a-z-]+__/);
  });

  it('modo index inclui os 2 meta-tools do gateway sintetico; schema invalido nao lanca', () => {
    const rows: McpRegistryToolRow[] = [{ mcpId: 'x', toolName: 'bad', description: null, inputSchema: '{nao-e-json' }];
    const json = serializeMcpSchemasForContext(rows, { includeGatewayMeta: true });
    const parsed = JSON.parse(json) as Array<{ function: { name: string } }>;
    expect(parsed.length).toBe(GATEWAY_META_TOOL_SCHEMAS.length + 1);
    expect(parsed.map((e) => e.function.name)).toContain('mcp__gateway__mcp_invoke');
    expect(parsed.map((e) => e.function.name)).toContain('mcp__gateway__mcp_schema');
  });

  it('sem entries -> string vazia (bucket 0 no PISO)', () => {
    expect(serializeMcpSchemasForContext([])).toBe('');
    expect(estimateStrongFloor({ mcpSchemasJson: '' })).toBe(0);
  });
});

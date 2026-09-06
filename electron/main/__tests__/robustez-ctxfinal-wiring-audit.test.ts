import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

function readSource(relPath: string): string {
  return fs.readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');
}

function activeContextRegion(src: string): string {
  const start = src.indexOf('setSessionActiveContextTokens(sessionId');
  const end = src.indexOf('maybeCompactChatSession');
  return start > -1 && end > start ? src.slice(start, end) : src;
}

describe('CTX-FINAL wiring — compat (GLM/MiniMax)', () => {
  const src = readSource('../claude-compat-sdk/index.ts');
  it('importa o helper compartilhado', () => {
    expect(src).toContain("from '../agent-runtime/context-measure'");
    expect(src).toContain('reconcileActiveContext');
    expect(src).toContain('normalizeUsage');
  });
  it('o contador ativo NAO usa mais estimateTokens(finalMessage + assistantContent)', () => {
    expect(src).not.toContain('estimateTokens(finalMessage + assistantContent)');
  });
  it('normaliza usage shape Anthropic (ultima request principal, por VALOR — nao odometro)', () => {
    expect(src).toContain("normalizeUsage(lastMainUsageRaw, 'anthropic')");
    expect(src).toContain('reconcileActiveContext');
    expect(src).toContain('lastMainUsageRaw');
  });
});

describe('CTX-FINAL wiring — codex (tokenUsage.last)', () => {
  const src = readSource('../codex-sdk/index.ts');
  it('importa o helper compartilhado', () => {
    expect(src).toContain('from "../agent-runtime/context-measure"');
  });
  it('o contador ativo NAO usa mais estimateTokens(prompt + persistedFinalText)', () => {
    const region = activeContextRegion(src);
    expect(region).not.toContain('estimateTokens(prompt + persistedFinalText)');
  });
  it('usa response.lastUsage normalizado como shape codex', () => {
    const region = activeContextRegion(src);
    expect(region).toContain('response.lastUsage');
    expect(region).toContain('normalizeUsage(response.lastUsage, "codex")');
    expect(region).toContain('reconcileActiveContext');
  });
});

describe('CTX-FINAL wiring — kimi', () => {
  const src = readSource('../kimi-sdk/index.ts');
  it('importa o helper e reconcilia usage vs PISO FORTE (SPEC contexto-vivo)', () => {
    expect(src).toContain('from "../agent-runtime/context-measure"');
    expect(src).toContain('reconcileActiveContext');
    expect(src).toContain('estimateStrongFloor');
  });
});

describe('CTX-FINAL wiring — lion', () => {
  const idx = readSource('../lion-sdk/index.ts');
  const runtime = readSource('../lion-sdk/runtime.ts');
  it('index.ts reconcilia lastContextTokens (real) vs PISO estimado', () => {
    expect(idx).toContain("from '../agent-runtime/context-measure'");
    expect(idx).toContain('result.lastContextTokens');
    expect(idx).toContain('reconcileActiveContext');
    expect(idx).not.toContain('Math.ceil((promptChars + assistantText.length) / 4)');
  });
  it('runtime.ts expoe lastContextTokens = ultima request (nao o odometro agregado)', () => {
    expect(runtime).toContain('lastContextTokens');
    expect(runtime).toContain('lastContextTokens = turnUsage.inputTokens + turnUsage.outputTokens');
  });
});

describe('CTX-FINAL wiring — claude-sdk (orchestrator) INTOCADO (referencia)', () => {
  const src = readSource('../orchestrator.ts');
  it('segue com lastMainContextInput + lastMainOutput (usage real da ultima request principal)', () => {
    expect(src).toContain('setSessionActiveContextTokens(sessionId, lastMainContextInput + lastMainOutput)');
  });
  it('NAO importa o helper novo (o caminho claude ja era correto; nao regride)', () => {
    expect(src).not.toContain("from './agent-runtime/context-measure'");
    expect(src).not.toContain('reconcileActiveContext');
  });
});

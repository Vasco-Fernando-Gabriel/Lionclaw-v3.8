
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexTokenUsage } from '../codex-runtime/types';
import {
  ZERO_CODEX_USAGE,
  codexUsageDelta,
  settleChatCodexBilling,
} from '../codex-sdk/chat-billing';

const usage = (partial: Partial<CodexTokenUsage>): CodexTokenUsage => ({
  ...ZERO_CODEX_USAGE,
  ...partial,
});

describe('chat-billing — codexUsageDelta', () => {
  it('delta por-campo entre dois odometros', () => {
    const d = codexUsageDelta(
      usage({ inputTokens: 1200, cachedInputTokens: 300, outputTokens: 80, totalTokens: 1580 }),
      usage({ inputTokens: 1000, cachedInputTokens: 250, outputTokens: 50, totalTokens: 1300 }),
    );
    expect(d).toEqual(
      usage({ inputTokens: 200, cachedInputTokens: 50, outputTokens: 30, totalTokens: 280 }),
    );
  });

  it('clampa negativo em 0 (odometro regredido nunca vira delta negativo)', () => {
    const d = codexUsageDelta(ZERO_CODEX_USAGE, usage({ inputTokens: 500, totalTokens: 500 }));
    expect(d).toEqual(ZERO_CODEX_USAGE);
  });
});

describe('chat-billing — F1 boundary: baseline MONOTONICO', () => {
  const billed520k = usage({
    inputTokens: 480_000,
    cachedInputTokens: 200_000,
    outputTokens: 40_000,
    totalTokens: 520_000,
  });

  it('turno normal: delta correto e baseline avanca para o odometro novo', () => {
    const next = usage({
      inputTokens: 489_000,
      cachedInputTokens: 205_000,
      outputTokens: 41_000,
      totalTokens: 530_000,
    });
    const settled = settleChatCodexBilling(next, billed520k);
    expect(settled.delta.totalTokens).toBe(10_000);
    expect(settled.delta.inputTokens).toBe(9_000);
    expect(settled.nextBaseline).toBe(next);
  });

  it('turno com usage ZERADO (STOP cedo, texto parcial persistido): delta 0 e baseline PRESERVADO', () => {
    const settled = settleChatCodexBilling(ZERO_CODEX_USAGE, billed520k);
    expect(settled.delta).toEqual(ZERO_CODEX_USAGE);
    expect(settled.nextBaseline).toBe(billed520k);
    expect(settled.nextBaseline.totalTokens).toBe(520_000);
  });

  it('turno SEGUINTE ao usage zerado fatura so o avanco real (nao o odometro inteiro)', () => {
    const afterZero = settleChatCodexBilling(ZERO_CODEX_USAGE, billed520k).nextBaseline;
    const odometer531k = usage({
      inputTokens: 489_500,
      cachedInputTokens: 205_500,
      outputTokens: 41_500,
      totalTokens: 531_000,
    });
    const settled = settleChatCodexBilling(odometer531k, afterZero);
    expect(settled.delta.totalTokens).toBe(11_000);
    expect(settled.delta.totalTokens).not.toBe(531_000);
    expect(settled.nextBaseline).toBe(odometer531k);
  });

  it('odometro PARCIALMENTE regredido (menor, nao-zero) tambem preserva o baseline', () => {
    const regressed = usage({ inputTokens: 100, totalTokens: 100 });
    const settled = settleChatCodexBilling(regressed, billed520k);
    expect(settled.delta).toEqual(ZERO_CODEX_USAGE);
    expect(settled.nextBaseline).toBe(billed520k);
  });

  it('odometro IGUAL ao baseline: delta 0 e baseline avanca (>=, refresh de referencia ok)', () => {
    const same = { ...billed520k };
    const settled = settleChatCodexBilling(same, billed520k);
    expect(settled.delta).toEqual(ZERO_CODEX_USAGE);
    expect(settled.nextBaseline).toBe(same);
  });
});


const codexSrc = readFileSync(join(__dirname, '..', 'codex-sdk', 'index.ts'), 'utf-8');

describe('codex-sdk wiring — thread persistente (F1/F2/F3/F7)', () => {
  it('F1/F7: executor usa settleChatCodexBilling e so avanca o baseline DEPOIS de updateSessionTokens', () => {
    expect(codexSrc).toContain('settleChatCodexBilling(response.usage, persistentEntry.billedUsage)');
    const billIdx = codexSrc.indexOf('updateSessionTokens(sessionId, u.inputTokens');
    const advanceIdx = codexSrc.indexOf('persistentEntry.billedUsage = settledBilling.nextBaseline');
    expect(billIdx).toBeGreaterThan(-1);
    expect(advanceIdx).toBeGreaterThan(billIdx);
    expect(codexSrc).not.toContain('persistentEntry.billedUsage = response.usage');
  });

  it('F2a: cache persistente EXCLUSIVO da lane desktop (cron/telegram = create+close por turno)', () => {
    expect(codexSrc).toContain('const persistentChatThread = lane.name === "desktop";');
  });

  it('F2b: cap LRU no cache, com eviction fechando o processo', () => {
    expect(codexSrc).toContain('CHAT_CODEX_SESSION_CACHE_MAX = 4');
    expect(codexSrc).toMatch(/while \(chatCodexSessionCache\.size > CHAT_CODEX_SESSION_CACHE_MAX\)/);
    expect(codexSrc).toContain('"lru-evicted"');
  });

  it('F3: reset fecha SO as threads da lane que esta resetando', () => {
    expect(codexSrc).toMatch(
      /closeAllCachedChatCodexSessions\(`reset-sdk-session-state:\$\{lane\.name\}`, lane\.name\)/,
    );
    expect(codexSrc).toMatch(/if \(laneName !== undefined && entry\.lane !== laneName\) continue;/);
  });

  it('F4: reuse invalida por configSignature (capabilities + onboarding), alem de model/provider/cwd', () => {
    expect(codexSrc).toContain('cachedEntry.configSignature !== threadConfigSignature');
  });

  it('repo baseline entra 1x por thread: pulado no REUSE, presente na criacao e na recovery SC-1', () => {
    expect(codexSrc).toContain(
      'const skipRepoBaselineOnReuse = persistentChatThread && reuseLiveThread;',
    );
    expect(codexSrc).toContain('if (repoCtx && !skipRepoBaselineOnReuse)');
    expect(codexSrc).toContain('let recoveryBaseline = repoBaseline;');
    expect(codexSrc).toContain('if (!recoveryBaseline && repoCtx)');
  });
});

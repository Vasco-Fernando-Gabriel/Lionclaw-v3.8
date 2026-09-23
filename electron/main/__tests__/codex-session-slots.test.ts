import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CodexSessionSlotGate,
  CodexSessionsExhaustedError,
  DEFAULT_CODEX_SESSION_WAIT_MS,
  pickIdleCodexSessionToEvict,
  readCodexSessionWaitMs,
} from '../codex-sdk/session-slots';
import { DRIVE_PARALLEL_TURNS_MAX, MAX_DESKTOP_LANES } from '../lanes';

function gateWith(max: number) {
  const cache: string[] = [];
  const inFlight = new Set<string>();
  const evict = vi.fn((id: string) => {
    const idx = cache.indexOf(id);
    if (idx >= 0) cache.splice(idx, 1);
  });
  const gate = new CodexSessionSlotGate({
    max,
    listCachedOldestFirst: () => [...cache],
    isTurnInFlight: (id) => inFlight.has(id),
    evict,
  });
  return { gate, cache, inFlight, evict };
}

describe('RM9/V4 - cache Codex = processos vivos (AC-21d)', () => {
  it('teto derivado: CHAT_CODEX_SESSION_CACHE_MAX >= MAX_DESKTOP_LANES + drives(2) + telegram(1) + cron(1)', () => {
    const src = readFileSync(join(__dirname, '..', 'codex-sdk', 'index.ts'), 'utf8');
    expect(src).toMatch(/CHAT_CODEX_SESSION_CACHE_MAX =\s+MAX_DESKTOP_LANES \+ DRIVE_PARALLEL_TURNS_MAX \+ 1 \+ 1;/);
    expect(src).not.toMatch(/CHAT_CODEX_SESSION_CACHE_MAX = \d+;/);
    expect(DRIVE_PARALLEL_TURNS_MAX).toBe(2);
    const derived = MAX_DESKTOP_LANES + DRIVE_PARALLEL_TURNS_MAX + 1 + 1;
    expect(derived).toBeGreaterThanOrEqual(MAX_DESKTOP_LANES + 2 + 1 + 1);
    expect(derived).toBe(6);
  });

  it('pickIdleCodexSessionToEvict pula threads com turno em voo e devolve a mais antiga ociosa', () => {
    const inFlight = new Set(['a', 'b']);
    expect(pickIdleCodexSessionToEvict(['a', 'b', 'c', 'd'], (id) => inFlight.has(id))).toBe('c');
    expect(pickIdleCodexSessionToEvict(['a', 'b'], (id) => inFlight.has(id))).toBeNull();
    expect(pickIdleCodexSessionToEvict([], () => false)).toBeNull();
  });

  it('enforceCap NUNCA fecha thread em voo: com 3 acima do teto e a mais antiga em voo, evicta as ociosas seguintes', () => {
    const { gate, cache, inFlight, evict } = gateWith(2);
    cache.push('old-in-flight', 'idle-1', 'idle-2', 'newest');
    inFlight.add('old-in-flight');
    gate.enforceCap('lru-evicted');
    expect(evict.mock.calls.map((c) => c[0])).toEqual(['idle-1', 'idle-2']);
    expect(cache).toEqual(['old-in-flight', 'newest']);
  });

  it('enforceCap com TODAS em voo: nada e fechado mesmo acima do teto', () => {
    const { gate, cache, inFlight, evict } = gateWith(1);
    cache.push('a', 'b', 'c');
    for (const id of cache) inFlight.add(id);
    gate.enforceCap('lru-evicted');
    expect(evict).not.toHaveBeenCalled();
    expect(cache).toEqual(['a', 'b', 'c']);
  });

  it('reserve com vaga ou com ociosa evictavel resolve na hora; sessao ja cacheada nunca espera', async () => {
    const { gate, cache, inFlight, evict } = gateWith(2);
    await gate.reserve('n1', 10, 'lru-evicted');
    expect(evict).not.toHaveBeenCalled();
    cache.push('a', 'b');
    inFlight.add('a');
    await gate.reserve('n2', 10, 'lru-evicted');
    expect(evict).toHaveBeenCalledWith('b', 'lru-evicted');
    cache.push('n2');
    inFlight.add('n2');
    await expect(gate.reserve('a', 10, 'lru-evicted')).resolves.toBeUndefined();
    expect(evict).toHaveBeenCalledTimes(1);
  });

  it('todas ocupadas: espera ate codex_session_wait_ms e falha tipada codex_sessions_exhausted; nada e fechado', async () => {
    const { gate, cache, inFlight, evict } = gateWith(2);
    cache.push('a', 'b');
    inFlight.add('a');
    inFlight.add('b');
    const err = await gate.reserve('n', 25, 'lru-evicted').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodexSessionsExhaustedError);
    expect((err as CodexSessionsExhaustedError).code).toBe('codex_sessions_exhausted');
    expect(evict).not.toHaveBeenCalled();
    expect(cache).toEqual(['a', 'b']);
    expect(gate.hasWaiters()).toBe(false);
  });

  it('todas ocupadas, um turno termina dentro do prazo: a espera acorda, evicta a que ficou ociosa e a criacao segue', async () => {
    const { gate, cache, inFlight, evict } = gateWith(2);
    cache.push('a', 'b');
    inFlight.add('a');
    inFlight.add('b');
    const pending = gate.reserve('n', 500, 'lru-evicted');
    await new Promise((r) => setTimeout(r, 5));
    expect(gate.hasWaiters()).toBe(true);
    inFlight.delete('b');
    gate.notifySlotFreed();
    await expect(pending).resolves.toBeUndefined();
    expect(evict).toHaveBeenCalledWith('b', 'lru-evicted');
    expect(cache).toEqual(['a']);
  });

  it('readCodexSessionWaitMs: default 30 s e override positivo pelo setting', () => {
    expect(readCodexSessionWaitMs(() => undefined)).toBe(DEFAULT_CODEX_SESSION_WAIT_MS);
    expect(DEFAULT_CODEX_SESSION_WAIT_MS).toBe(30_000);
    expect(readCodexSessionWaitMs(() => '5000')).toBe(5000);
    expect(readCodexSessionWaitMs(() => 'abc')).toBe(30_000);
    expect(readCodexSessionWaitMs(() => '-1')).toBe(30_000);
  });
});


import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  deriveKimiSessionDir,
  snapshotKimiWireOffsets,
  readKimiWireUsageDelta,
} from '../wire-usage';

function usageRecordLine(u: {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}): string {
  return JSON.stringify({
    type: 'usage.record',
    model: 'kimi-code/kimi-for-coding',
    usage: u,
    usageScope: 'turn',
    time: Date.now(),
  }) + '\n';
}

function wrappedStepEndLine(u: {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'step.end', uuid: 'u-1', turnId: '0', step: 1, usage: u, finishReason: 'stop' },
    time: Date.now(),
  }) + '\n';
}

describe('deriveKimiSessionDir', () => {
  it('monta wd_<basename>_<sha256(absPath)[0:12]>/session_<id> (casos reais)', () => {
    expect(deriveKimiSessionDir('/kimi-home', '/home/user', 'abc')).toBe(
      '/kimi-home/sessions/wd_user_b98d692c4574/session_abc',
    );
    expect(deriveKimiSessionDir('/kimi-home', '/home/user/.lionclaw', 's-1')).toBe(
      '/kimi-home/sessions/wd_.lionclaw_5ded2264f6d0/session_s-1',
    );
  });

  it('lowercaseia o slug mas hasheia o caminho com case original (casos reais)', () => {
    expect(deriveKimiSessionDir('/kimi-home', '/home/user/Desktop', 's-2')).toBe(
      '/kimi-home/sessions/wd_desktop_9ae915cd60b5/session_s-2',
    );
    expect(deriveKimiSessionDir('/kimi-home', '/home/user/NeonChatKIMI', 's-3')).toBe(
      '/kimi-home/sessions/wd_neonchatkimi_e327a52495f2/session_s-3',
    );
  });

  it('normaliza trailing slash (mesmo hash com e sem barra final)', () => {
    expect(deriveKimiSessionDir('/h', '/home/user/', 'x')).toBe(
      deriveKimiSessionDir('/h', '/home/user', 'x'),
    );
  });
});

describe('snapshot de offsets + delta do turno', () => {
  let tmp: string;
  let sessionDir: string;
  let mainWire: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-wire-test-'));
    sessionDir = path.join(tmp, 'sessions', 'wd_proj_abc123def456', 'session_s-1');
    mainWire = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    fs.mkdirSync(path.dirname(mainWire), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('conteudo anterior ao snapshot do turno e IGNORADO; anexado e contado UMA vez', () => {
    fs.writeFileSync(
      mainWire,
      usageRecordLine({ inputOther: 9_999, output: 9_999, inputCacheRead: 9_999, inputCacheCreation: 0 }),
    );

    const snapshot = snapshotKimiWireOffsets(sessionDir);
    expect(snapshot).not.toBeNull();

    fs.appendFileSync(
      mainWire,
      usageRecordLine({ inputOther: 100, output: 50, inputCacheRead: 1_000, inputCacheCreation: 200 }) +
        usageRecordLine({ inputOther: 30, output: 20, inputCacheRead: 2_000, inputCacheCreation: 0 }),
    );

    const usage = readKimiWireUsageDelta(snapshot!);
    expect(usage).toEqual({
      inputTokens: 100 + 1_000 + 200 + 30 + 2_000,
      outputTokens: 70,
      cacheReadTokens: 3_000,
      cacheCreationTokens: 200,
    });
  });

  it('step.end embrulhado em context.append_loop_event NAO duplica o usage.record', () => {
    const snapshot = snapshotKimiWireOffsets(sessionDir);
    const u = { inputOther: 100, output: 40, inputCacheRead: 500, inputCacheCreation: 0 };
    fs.appendFileSync(mainWire, usageRecordLine(u) + wrappedStepEndLine(u));

    const usage = readKimiWireUsageDelta(snapshot!);
    expect(usage).toEqual({
      inputTokens: 600,
      outputTokens: 40,
      cacheReadTokens: 500,
      cacheCreationTokens: 0,
    });
  });

  it('arquivo NOVO de subagente criado durante o turno entra com offset 0', () => {
    const snapshot = snapshotKimiWireOffsets(sessionDir);

    const subWire = path.join(sessionDir, 'agents', 'agent-0', 'wire.jsonl');
    fs.mkdirSync(path.dirname(subWire), { recursive: true });
    fs.writeFileSync(
      subWire,
      usageRecordLine({ inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 }),
    );

    const usage = readKimiWireUsageDelta(snapshot!);
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('arquivo truncado/rotacionado (tamanho < offset) falha SEGURO -> null, nunca negativo', () => {
    fs.writeFileSync(
      mainWire,
      usageRecordLine({ inputOther: 100, output: 50, inputCacheRead: 0, inputCacheCreation: 0 }),
    );
    const snapshot = snapshotKimiWireOffsets(sessionDir);

    fs.writeFileSync(mainWire, ''); // rotacao/truncamento mid-turno

    expect(readKimiWireUsageDelta(snapshot!)).toBeNull();
  });

  it('arquivo do snapshot deletado (rotacao) -> null', () => {
    fs.writeFileSync(
      mainWire,
      usageRecordLine({ inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }),
    );
    const snapshot = snapshotKimiWireOffsets(sessionDir);

    fs.rmSync(mainWire);

    expect(readKimiWireUsageDelta(snapshot!)).toBeNull();
  });

  it('diretorio da sessao inexistente -> snapshot null (not_reported, sem glob de fallback)', () => {
    expect(snapshotKimiWireOffsets(path.join(tmp, 'sessions', 'wd_x_000', 'session_nope'))).toBeNull();
  });

  it('invalida o delta inteiro quando ha usage.record parcial no fim', () => {
    const snapshot = snapshotKimiWireOffsets(sessionDir);
    fs.appendFileSync(
      mainWire,
      '{"type":"config.update","profileName":"agent"}\n' +
        usageRecordLine({ inputOther: 7, output: 3, inputCacheRead: 0, inputCacheCreation: 0 }) +
        '{"type":"usage.record","usage":{"inputOther":999', // parcial (escrita em andamento)
    );

    expect(readKimiWireUsageDelta(snapshot!)).toBeNull();
  });

  it.each([
    { inputOther: -1, output: 3, inputCacheRead: 0, inputCacheCreation: 0 },
    { inputOther: 1.5, output: 3, inputCacheRead: 0, inputCacheCreation: 0 },
    { inputOther: 1, output: Number.POSITIVE_INFINITY, inputCacheRead: 0, inputCacheCreation: 0 },
  ])('invalida dimensao ausente, negativa, fracionaria ou nao finita: %j', (usage) => {
    const snapshot = snapshotKimiWireOffsets(sessionDir);
    fs.appendFileSync(mainWire, JSON.stringify({
      type: 'usage.record',
      model: 'kimi-code/kimi-for-coding',
      usage,
      usageScope: 'turn',
    }) + '\n');

    expect(readKimiWireUsageDelta(snapshot!)).toBeNull();
  });

  it('invalida usage.record sem uma dimensao obrigatoria', () => {
    const snapshot = snapshotKimiWireOffsets(sessionDir);
    fs.appendFileSync(mainWire, JSON.stringify({
      type: 'usage.record',
      usageScope: 'turn',
      usage: { inputOther: 1, output: 1, inputCacheRead: 0 },
    }) + '\n');

    expect(readKimiWireUsageDelta(snapshot!)).toBeNull();
  });

  it('invalida total de input que diverge do breakdown inclusivo', () => {
    const snapshot = snapshotKimiWireOffsets(sessionDir);
    fs.appendFileSync(mainWire, JSON.stringify({
      type: 'usage.record',
      usageScope: 'turn',
      usage: {
        inputOther: 7,
        inputCacheRead: 2,
        inputCacheCreation: 1,
        inputTokens: 999,
        output: 3,
      },
    }) + '\n');

    expect(readKimiWireUsageDelta(snapshot!)).toBeNull();
  });

  it('turno sem nada anexado -> zeros (usage reportado vazio, nao null)', () => {
    fs.writeFileSync(
      mainWire,
      usageRecordLine({ inputOther: 5, output: 5, inputCacheRead: 0, inputCacheCreation: 0 }),
    );
    const snapshot = snapshotKimiWireOffsets(sessionDir);

    expect(readKimiWireUsageDelta(snapshot!)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

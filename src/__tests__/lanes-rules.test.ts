import { describe, expect, it } from 'vitest';
import type { OpenChatSession } from '@/types';
import {
  laneUiState,
  resolveNewChatAction,
  staleLaneDays,
  normalizeStaleLaneDays,
  pickMostRecentLane,
  laneErrorTitle,
} from '@/lib/lanes';

function lane(over: Partial<OpenChatSession> & { id: string; laneBadge: number }): OpenChatSession {
  return {
    title: `Conversa ${over.laneBadge}`,
    orchestrator: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-sonnet-4-6' },
    messageCount: 3,
    lastUserMessageAt: '2026-09-08T10:00:00.000Z',
    createdAt: '2026-09-08T09:00:00.000Z',
    updatedAt: '2026-09-08T10:00:00.000Z',
    state: 'idle',
    drive: null,
    ...over,
  };
}

describe('5.5a: regra do botao Novo Chat (AC-4, lado UI)', () => {
  it('0 lanes = cria a Lane 1', () => {
    expect(resolveNewChatAction([], {}, 2)).toEqual({ kind: 'create' });
  });

  it('1 lane vazia com N=2 = seleciona a vazia sem criar', () => {
    const empty = lane({ id: 'a', laneBadge: 1, messageCount: 0, lastUserMessageAt: null });
    expect(resolveNewChatAction([empty], {}, 2)).toEqual({ kind: 'select', sessionId: 'a' });
  });

  it('1 lane com mensagens com N=2 = cria a proxima', () => {
    expect(resolveNewChatAction([lane({ id: 'a', laneBadge: 1 })], {}, 2)).toEqual({ kind: 'create' });
  });

  it('N lanes com pelo menos uma disponivel = popup', () => {
    const lanes = [lane({ id: 'a', laneBadge: 1 }), lane({ id: 'b', laneBadge: 2, state: 'streaming' })];
    expect(resolveNewChatAction(lanes, {}, 2)).toEqual({ kind: 'choose' });
  });

  it('N lanes sem disponivel = desabilitado com motivo', () => {
    const lanes = [lane({ id: 'a', laneBadge: 1, messageCount: 0 }), lane({ id: 'b', laneBadge: 2, state: 'drive' })];
    const action = resolveNewChatAction(lanes, {}, 2);
    expect(action.kind).toBe('disabled');
    if (action.kind === 'disabled') expect(action.reason).toMatch(/Nenhuma lane disponivel/);
  });

  it('itera sobre N (N=3): 2 lanes com mensagens ainda criam, 3 abrem popup', () => {
    const two = [lane({ id: 'a', laneBadge: 1 }), lane({ id: 'b', laneBadge: 2 })];
    expect(resolveNewChatAction(two, {}, 3)).toEqual({ kind: 'create' });
    const three = [...two, lane({ id: 'c', laneBadge: 3 })];
    expect(resolveNewChatAction(three, {}, 3)).toEqual({ kind: 'choose' });
  });

  it('lane em Clear pelo compaction:active conta como ocupada mesmo com state idle', () => {
    const lanes = [lane({ id: 'a', laneBadge: 1 }), lane({ id: 'b', laneBadge: 2 })];
    const compactions = {
      a: { phase: 'queued' as const, modelLabel: '', source: 'lionclaw' as const },
      b: { phase: 'running' as const, modelLabel: 'haiku', source: 'lionclaw' as const },
    };
    expect(laneUiState(lanes[0], compactions.a)).toBe('em Clear');
    expect(resolveNewChatAction(lanes, compactions, 2).kind).toBe('disabled');
  });
});

describe('5.5: estados de cada lane no popup', () => {
  it('mapeia state/messageCount para o rotulo de UI', () => {
    expect(laneUiState(lane({ id: 'a', laneBadge: 1 }))).toBe('disponivel');
    expect(laneUiState(lane({ id: 'a', laneBadge: 1, messageCount: 0 }))).toBe('vazia');
    expect(laneUiState(lane({ id: 'a', laneBadge: 1, state: 'streaming' }))).toBe('ocupada');
    expect(laneUiState(lane({ id: 'a', laneBadge: 1, state: 'queued' }))).toBe('ocupada');
    expect(laneUiState(lane({ id: 'a', laneBadge: 1, state: 'clearing' }))).toBe('em Clear');
    expect(laneUiState(lane({ id: 'a', laneBadge: 1, state: 'drive' }))).toBe('drive ativo');
    expect(laneUiState(lane({ id: 'a', laneBadge: 1, state: 'interrupted' }))).toBe('Clear interrompido');
  });

  it('Compactacao in-place do SDK conta como ocupada, nao como em Clear', () => {
    const sdk = { phase: 'running' as const, modelLabel: '', source: 'sdk' as const };
    expect(laneUiState(lane({ id: 'a', laneBadge: 1 }), sdk)).toBe('ocupada');
  });
});

describe('5.9: aviso de lane parada', () => {
  const now = Date.parse('2026-09-08T12:00:00.000Z');

  it('lane com ultima mensagem humana ha 10 dias e limiar 7 = aviso com 10 dias', () => {
    const l = lane({ id: 'a', laneBadge: 1, lastUserMessageAt: '2026-08-29T12:00:00.000Z' });
    expect(staleLaneDays(l, 7, now)).toBe(10);
  });

  it('lane recente ou vazia nao recebe aviso', () => {
    expect(
      staleLaneDays(lane({ id: 'a', laneBadge: 1, lastUserMessageAt: '2026-09-07T12:00:00.000Z' }), 7, now),
    ).toBeNull();
    expect(staleLaneDays(lane({ id: 'a', laneBadge: 1, messageCount: 0, lastUserMessageAt: null }), 7, now)).toBeNull();
    expect(staleLaneDays(lane({ id: 'a', laneBadge: 1, lastUserMessageAt: null }), 7, now)).toBeNull();
  });

  it('normaliza o setting chat_stale_lane_days (default 7)', () => {
    expect(normalizeStaleLaneDays(undefined)).toBe(7);
    expect(normalizeStaleLaneDays('abc')).toBe(7);
    expect(normalizeStaleLaneDays(0)).toBe(7);
    expect(normalizeStaleLaneDays('14')).toBe(14);
    expect(normalizeStaleLaneDays(3.9)).toBe(3);
  });
});

describe('10.1: selecao no boot pela lane com lastUserMessageAt mais recente', () => {
  it('escolhe a lane com ultima mensagem humana mais recente', () => {
    const older = lane({ id: 'a', laneBadge: 1, lastUserMessageAt: '2026-09-01T00:00:00.000Z' });
    const newer = lane({ id: 'b', laneBadge: 2, lastUserMessageAt: '2026-09-07T00:00:00.000Z' });
    expect(pickMostRecentLane([older, newer])?.id).toBe('b');
    expect(pickMostRecentLane([])).toBeNull();
  });
});

describe('erros tipados viram titulos claros', () => {
  it('cobre os codigos do main e cai no fallback para desconhecido', () => {
    expect(laneErrorTitle('lanes_full', 'x')).toBe('Lanes ocupadas');
    expect(laneErrorTitle('session_clearing', 'x')).toBe('Lane em Clear');
    expect(laneErrorTitle('turn_did_not_settle', 'x')).toBe('Turno nao assentou');
    expect(laneErrorTitle('COMPACT-MEMORY-FAILED', 'x')).toBe('Clear recusado: memoria falhou');
    expect(laneErrorTitle('nope', 'fallback')).toBe('fallback');
    expect(laneErrorTitle(undefined, 'fallback')).toBe('fallback');
  });
});

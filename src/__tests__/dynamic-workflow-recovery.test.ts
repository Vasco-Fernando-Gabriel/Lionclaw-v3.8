import { describe, it, expect } from 'vitest';


import {
  appendMaestroNarratorDelta,
  sealMaestroStreamingBubble,
  deriveMaestroThreadFromMessages,
  deriveCloserThreadFromMessages,
  deriveNarrationLinesFromMessages,
  deriveNodeStreamsFromMessages,
  deriveGateDecisionsFromEvents,
  reconcileMaestroThread,
  reconcileCloserThread,
  NARRATION_FEED_LIMIT,
  type MaestroThreadMessage,
  type CloserThreadMessage,
} from '@/stores/dynamic-workflow-store';
import type { DynamicWorkflowMessage, DynamicWorkflowEvent } from '@/types';

function msg(
  id: number,
  partial: Partial<DynamicWorkflowMessage>,
): DynamicWorkflowMessage {
  return {
    id,
    runId: 'run-1',
    nodeId: null,
    role: 'assistant',
    source: 'runner',
    kind: 'text',
    content: '',
    toolCallsJson: null,
    agentId: null,
    createdAt: `2026-01-01T00:00:0${id}.000Z`,
    ...partial,
  };
}

describe('SM-18: appendMaestroNarratorDelta (uma bolha que cresce)', () => {
  it('o primeiro delta abre UMA bolha do Maestro marcada streaming', () => {
    const out = appendMaestroNarratorDelta([], 'Ola');
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('maestro');
    expect(out[0].content).toBe('Ola');
    expect(out[0].streaming).toBe(true);
  });

  it('deltas seguintes do MESMO turno CRESCEM a mesma bolha (nao criam nova)', () => {
    let t: MaestroThreadMessage[] = [];
    t = appendMaestroNarratorDelta(t, 'O cod');
    t = appendMaestroNarratorDelta(t, 'er ter');
    t = appendMaestroNarratorDelta(t, 'minou.');
    expect(t).toHaveLength(1);
    expect(t[0].content).toBe('O coder terminou.');
    expect(t[0].streaming).toBe(true);
  });

  it('apos um eco do usuario, o proximo delta abre uma bolha NOVA', () => {
    let t: MaestroThreadMessage[] = appendMaestroNarratorDelta([], 'resposta 1');
    t = sealMaestroStreamingBubble(t);
    t = [...t, { id: 'u1', role: 'user', content: 'e agora?' }];
    t = appendMaestroNarratorDelta(t, 'resposta 2');
    expect(t.map((m) => m.role)).toEqual(['maestro', 'user', 'maestro']);
    expect(t[0].content).toBe('resposta 1');
    expect(t[0].streaming).toBe(false);
    expect(t[2].content).toBe('resposta 2');
  });

  it('delta vazio nao altera a thread', () => {
    const t: MaestroThreadMessage[] = [{ id: 'm', role: 'maestro', content: 'x', streaming: true }];
    expect(appendMaestroNarratorDelta(t, '')).toBe(t);
  });
});

describe('timeline cronologica persistida por node', () => {
  it('reidrata texto e tools nas posicoes UTF-16 gravadas pelo main process', () => {
    const streams = deriveNodeStreamsFromMessages([
      msg(91, {
        nodeId: 'coder',
        source: 'agent',
        kind: 'node-output',
        agentId: 'harness-coder',
        content: 'antesdepois',
        toolCallsJson: JSON.stringify([
          { tool: 'Read', input: '/repo/a.ts', textOffset: 5, sequence: 0 },
        ]),
      }),
    ]);

    expect(streams.coder.text).toBe('antesdepois');
    expect(streams.coder.timeline.map((block) => block.kind)).toEqual(['text', 'tool', 'text']);
    expect(streams.coder.timeline[0]).toMatchObject({ kind: 'text', content: 'antes' });
    expect(streams.coder.timeline[1]).toMatchObject({ kind: 'tool', tool: 'Read' });
    expect(streams.coder.timeline[2]).toMatchObject({ kind: 'text', content: 'depois' });
  });

  it('usa apenas a saida mais recente do mesmo node ao reabrir o run', () => {
    const streams = deriveNodeStreamsFromMessages([
      msg(92, { nodeId: 'coder', source: 'agent', kind: 'node-output', content: 'antiga' }),
      msg(93, { nodeId: 'coder', source: 'agent', kind: 'node-output', content: 'nova' }),
    ]);

    expect(streams.coder.text).toBe('nova');
  });
});

describe('SM-18: sealMaestroStreamingBubble', () => {
  it('sela a bolha do Maestro em construcao', () => {
    const t: MaestroThreadMessage[] = [{ id: 'm', role: 'maestro', content: 'oi', streaming: true }];
    const out = sealMaestroStreamingBubble(t);
    expect(out[0].streaming).toBe(false);
    expect(out[0].content).toBe('oi');
  });

  it('no-op quando a ultima nao e maestro streaming', () => {
    const t: MaestroThreadMessage[] = [{ id: 'u', role: 'user', content: 'oi' }];
    expect(sealMaestroStreamingBubble(t)).toBe(t);
  });

  it('no-op em thread vazia', () => {
    expect(sealMaestroStreamingBubble([])).toEqual([]);
  });
});

describe('SM-10/SM-22: deriveMaestroThreadFromMessages (re-hidratacao do DB)', () => {
  it('mapeia eco humano (kind maestro-chat) e resposta (kind maestro-reply)', () => {
    const messages = [
      msg(1, { role: 'user', source: 'human', kind: 'maestro-chat', content: 'como ta?' }),
      msg(2, { role: 'assistant', source: 'workflow-orchestrator-agent', kind: 'maestro-reply', content: 'rodando bem.' }),
    ];
    const out = deriveMaestroThreadFromMessages(messages);
    expect(out).toEqual([
      { id: 'db-1', role: 'user', content: 'como ta?' },
      { id: 'db-2', role: 'maestro', content: 'rodando bem.' },
    ]);
    expect(out[1].streaming).toBeUndefined();
  });

  it('IGNORA mensagens do closer/composer/agente (cada thread tem seu derive)', () => {
    const messages = [
      msg(1, { role: 'user', source: 'human', kind: 'text', content: 'msg do closer' }),
      msg(2, { role: 'assistant', source: 'closer', content: 'resposta do closer' }),
      msg(3, { role: 'assistant', source: 'agent', kind: 'node', content: 'stream de node' }),
    ];
    expect(deriveMaestroThreadFromMessages(messages)).toEqual([]);
  });
});

describe('SM-10/SM-22: deriveCloserThreadFromMessages (re-hidratacao do DB)', () => {
  it('mapeia eco humano (source human, kind text) e resposta (source closer)', () => {
    const messages = [
      msg(1, { role: 'user', source: 'human', kind: 'text', content: 'ajusta o botao' }),
      msg(2, { role: 'assistant', source: 'closer', content: 'feito, ve o diff.' }),
    ];
    expect(deriveCloserThreadFromMessages(messages)).toEqual([
      { id: 'db-1', role: 'human', content: 'ajusta o botao' },
      { id: 'db-2', role: 'closer', content: 'feito, ve o diff.' },
    ]);
  });

  it('NAO captura o eco do Maestro (kind maestro-chat) como humano do closer', () => {
    const messages = [
      msg(1, { role: 'user', source: 'human', kind: 'maestro-chat', content: 'fala com o maestro' }),
    ];
    expect(deriveCloserThreadFromMessages(messages)).toEqual([]);
  });
});

describe('SM-22: reconcileMaestroThread (revisita vs reload ao vivo)', () => {
  it('revisita (thread vazio em memoria) usa o DB puro', () => {
    const fromDb: MaestroThreadMessage[] = [
      { id: 'db-1', role: 'user', content: 'oi' },
      { id: 'db-2', role: 'maestro', content: 'ola' },
    ];
    expect(reconcileMaestroThread([], fromDb)).toEqual(fromDb);
  });

  it('reload AO VIVO preserva a bolha do Maestro streaming ainda nao gravada', () => {
    const current: MaestroThreadMessage[] = [
      { id: 'db-1', role: 'user', content: 'oi' },
      { id: 'db-2', role: 'maestro', content: 'ola' },
      { id: 'live', role: 'maestro', content: 'em voo...', streaming: true },
    ];
    const fromDb: MaestroThreadMessage[] = [
      { id: 'db-1', role: 'user', content: 'oi' },
      { id: 'db-2', role: 'maestro', content: 'ola' },
    ];
    const out = reconcileMaestroThread(current, fromDb);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ id: 'live', role: 'maestro', content: 'em voo...', streaming: true });
  });

  it('preserva o eco humano otimista que o DB ainda nao refletiu', () => {
    const current: MaestroThreadMessage[] = [
      { id: 'db-1', role: 'maestro', content: 'resposta antiga' },
      { id: 'opt', role: 'user', content: 'pergunta nova' },
    ];
    const fromDb: MaestroThreadMessage[] = [
      { id: 'db-1', role: 'maestro', content: 'resposta antiga' },
    ];
    const out = reconcileMaestroThread(current, fromDb);
    expect(out.map((m) => m.content)).toEqual(['resposta antiga', 'pergunta nova']);
  });

  it('idempotente: turno selado e ja no DB nao duplica', () => {
    const fromDb: MaestroThreadMessage[] = [
      { id: 'db-1', role: 'user', content: 'pergunta' },
      { id: 'db-2', role: 'maestro', content: 'resposta' },
    ];
    const current: MaestroThreadMessage[] = [
      { id: 'u', role: 'user', content: 'pergunta' },
      { id: 'm', role: 'maestro', content: 'resposta', streaming: false },
    ];
    expect(reconcileMaestroThread(current, fromDb)).toEqual(fromDb);
  });
});

describe('SM-22: reconcileCloserThread', () => {
  it('preserva o eco humano otimista nao refletido no DB', () => {
    const current: CloserThreadMessage[] = [
      { id: 'db-1', role: 'closer', content: 'walkthrough' },
      { id: 'opt', role: 'human', content: 'muda isto' },
    ];
    const fromDb: CloserThreadMessage[] = [
      { id: 'db-1', role: 'closer', content: 'walkthrough' },
    ];
    const out = reconcileCloserThread(current, fromDb);
    expect(out.map((m) => m.content)).toEqual(['walkthrough', 'muda isto']);
  });

  it('idempotente quando o DB ja absorveu tudo', () => {
    const fromDb: CloserThreadMessage[] = [
      { id: 'db-1', role: 'human', content: 'oi' },
      { id: 'db-2', role: 'closer', content: 'resposta' },
    ];
    const current: CloserThreadMessage[] = [
      { id: 'h', role: 'human', content: 'oi' },
      { id: 'c', role: 'closer', content: 'resposta' },
    ];
    expect(reconcileCloserThread(current, fromDb)).toEqual(fromDb);
  });
});


describe('E6.1/T11: deriveNarrationLinesFromMessages (cockpit re-hidrata do DB)', () => {
  it('extrai as bolhas de narracao do Maestro (marco + reply) como linhas do feed', () => {
    const messages = [
      msg(1, { role: 'user', source: 'human', kind: 'maestro-chat', content: 'e ai?' }),
      msg(2, {
        role: 'assistant',
        source: 'workflow-orchestrator-agent',
        kind: 'narrator',
        content: 'coder terminou a sprint 1.',
      }),
      msg(3, {
        role: 'assistant',
        source: 'workflow-orchestrator-agent',
        kind: 'maestro-reply',
        content: 'aprovei o plano.',
      }),
    ];
    expect(deriveNarrationLinesFromMessages(messages)).toEqual([
      'coder terminou a sprint 1.',
      'aprovei o plano.',
    ]);
  });

  it('um run REABERTO com narracao persistida NAO fica em branco (T11)', () => {
    const persisted = [
      msg(1, {
        role: 'assistant',
        source: 'workflow-orchestrator-agent',
        kind: 'narrator',
        content: 'fase de planejamento concluida.',
      }),
    ];
    const lines = deriveNarrationLinesFromMessages(persisted);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[lines.length - 1]).toBe('fase de planejamento concluida.');
  });

  it('IGNORA mensagens nao-narracao (closer/node) e linhas vazias', () => {
    const messages = [
      msg(1, { role: 'assistant', source: 'closer', content: 'walkthrough' }),
      msg(2, { role: 'assistant', source: 'agent', kind: 'node', content: 'stream' }),
      msg(3, {
        role: 'assistant',
        source: 'workflow-orchestrator-agent',
        kind: 'narrator',
        content: '   ',
      }),
    ];
    expect(deriveNarrationLinesFromMessages(messages)).toEqual([]);
  });

  it('retem so as ultimas NARRATION_FEED_LIMIT linhas (a cauda = a mais recente)', () => {
    const messages = Array.from({ length: NARRATION_FEED_LIMIT + 3 }, (_, i) =>
      msg(i + 1, {
        role: 'assistant',
        source: 'workflow-orchestrator-agent',
        kind: 'narrator',
        content: `linha ${i + 1}`,
      }),
    );
    const lines = deriveNarrationLinesFromMessages(messages);
    expect(lines).toHaveLength(NARRATION_FEED_LIMIT);
    expect(lines[lines.length - 1]).toBe(`linha ${NARRATION_FEED_LIMIT + 3}`);
    expect(lines[0]).toBe('linha 4');
  });
});


function evt(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
): DynamicWorkflowEvent {
  return {
    id: seq,
    runId: 'run-1',
    nodeId: null,
    phaseId: null,
    seq,
    type,
    payloadJson: JSON.stringify(payload),
    createdAt: `2026-01-01T00:00:0${seq}.000Z`,
  };
}

describe('E6.1: deriveGateDecisionsFromEvents (deliberacao do driver no cockpit)', () => {
  it('extrai gateId + decisao + decidedBy de gate-approved/rejected/decision-received', () => {
    const events = [
      evt(1, 'node-started', { nodeId: 'coder' }), // ignorado
      evt(2, 'gate-approved', {
        gateId: 'gate-plan-review-orchestrator',
        approvedBy: 'orchestrator',
      }),
      evt(3, 'gate-decision-received', {
        gateId: 'gate-delivery-orchestrator',
        decision: 'approve',
        decidedBy: 'orchestrator',
      }),
      evt(4, 'gate-rejected', {
        gateId: 'gate-plan-review-human',
        decidedBy: 'human',
      }),
    ];
    const out = deriveGateDecisionsFromEvents(events);
    expect(out).toEqual([
      {
        id: 'gate-dec-2',
        gateId: 'gate-plan-review-orchestrator',
        decision: 'approved',
        decidedBy: 'orchestrator',
        at: '2026-01-01T00:00:02.000Z',
      },
      {
        id: 'gate-dec-3',
        gateId: 'gate-delivery-orchestrator',
        decision: 'approve',
        decidedBy: 'orchestrator',
        at: '2026-01-01T00:00:03.000Z',
      },
      {
        id: 'gate-dec-4',
        gateId: 'gate-plan-review-human',
        decision: 'rejected',
        decidedBy: 'human',
        at: '2026-01-01T00:00:04.000Z',
      },
    ]);
  });

  it('o driver aparece (decidedBy) sem o usuario ir ao chat principal', () => {
    const out = deriveGateDecisionsFromEvents([
      evt(1, 'gate-approved', { gateId: 'g1', approvedBy: 'orchestrator' }),
    ]);
    expect(out[0].decidedBy).toBe('orchestrator');
  });

  it('payload corrompido nao lanca (best-effort)', () => {
    const broken: DynamicWorkflowEvent = {
      id: 1,
      runId: 'run-1',
      nodeId: null,
      phaseId: null,
      seq: 1,
      type: 'gate-approved',
      payloadJson: '{not json',
      createdAt: '2026-01-01T00:00:01.000Z',
    };
    const out = deriveGateDecisionsFromEvents([broken]);
    expect(out).toHaveLength(1);
    expect(out[0].gateId).toBe('gate'); // fallback
    expect(out[0].decision).toBe('approved');
  });

  it('sem eventos de gate retorna vazio', () => {
    expect(deriveGateDecisionsFromEvents([evt(1, 'node-completed', {})])).toEqual([]);
  });
});

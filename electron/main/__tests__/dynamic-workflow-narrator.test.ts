import { describe, it, expect, vi } from 'vitest';
import {
  WorkflowNarrator,
  buildNarratorPrompt,
  NARRATOR_MIN_INTERVAL_MS,
  NARRATOR_MARK_EVENT_TYPES,
  NARRATOR_FORCE_EVENT_TYPES,
  type WorkflowNarratorDeps,
  type NarrateFn,
} from '../dynamic-workflows/workflow-narrator';
import { dynamicWorkflowNarrator, DYNAMIC_WORKFLOW_NARRATOR_ID } from '../seed-agents/dynamic-workflow-narrator';
import type { DynamicWorkflowEvent } from '../../../src/types/dynamic-workflow';

const STREAM_CHANNEL = 'dynamic-workflow:stream';
const EM_DASH = String.fromCharCode(0x2014);

function makeEvent(type: string, nodeId?: string): DynamicWorkflowEvent {
  return {
    id: 1,
    runId: 'run-1',
    nodeId: nodeId ?? null,
    phaseId: null,
    seq: 1,
    type,
    payloadJson: '{}',
    createdAt: '2026-06-13T00:00:00.000Z',
  };
}

interface Harness {
  narrator: WorkflowNarrator;
  narrate: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  insertMessage: ReturnType<typeof vi.fn>;
  setNow: (ms: number) => void;
}

function makeNarrator(opts?: { narrate?: NarrateFn; insertMessage?: WorkflowNarratorDeps['insertMessage'] }): Harness {
  let nowMs = 1_000_000;
  const narrate: ReturnType<typeof vi.fn> = opts?.narrate
    ? (vi.fn(opts.narrate) as ReturnType<typeof vi.fn>)
    : (vi.fn<NarrateFn>(async () => ({ text: 'Implementando a feature agora.' })) as ReturnType<typeof vi.fn>);
  const emit = vi.fn();
  const insertMessage =
    opts?.insertMessage !== undefined
      ? (vi.fn(opts.insertMessage) as ReturnType<typeof vi.fn>)
      : (vi.fn() as ReturnType<typeof vi.fn>);
  const deps: WorkflowNarratorDeps = {
    narrate: narrate as unknown as NarrateFn,
    emit,
    insertMessage: insertMessage as WorkflowNarratorDeps['insertMessage'],
    now: () => nowMs,
  };
  const narrator = new WorkflowNarrator(deps);
  return { narrator, narrate, emit, insertMessage, setNow: (ms) => (nowMs = ms) };
}

const signal = new AbortController().signal;

describe('WorkflowNarrator - decisao (throttle + marco)', () => {
  it('narra o primeiro marco e faz broadcast do chunk narrator', async () => {
    const h = makeNarrator();
    await h.narrator.narrateMark({ runId: 'run-1', eventType: 'node-started', recentEvents: [] }, signal);
    expect(h.narrate).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledTimes(1);
    const [channel, chunk] = h.emit.mock.calls[0] as [string, Record<string, unknown>];
    expect(channel).toBe(STREAM_CHANNEL);
    expect(chunk.kind).toBe('narrator');
    expect(chunk.type).toBe('text');
    expect(chunk.runId).toBe('run-1');
    expect(chunk.content).toBe('Implementando a feature agora.');
    expect(chunk.final).toBe(true);
    expect(h.insertMessage).toHaveBeenCalledTimes(1);
    const persisted = (h.insertMessage.mock.calls[0] as [Record<string, unknown>])[0];
    expect(persisted.runId).toBe('run-1');
    expect(persisted.role).toBe('assistant');
    expect(persisted.source).toBe('workflow-orchestrator-agent');
    expect(persisted.kind).toBe('narrator');
    expect(persisted.content).toBe('Implementando a feature agora.');
  });

  it('marco normal dentro da janela de throttle NAO narra de novo', async () => {
    const h = makeNarrator();
    await h.narrator.narrateMark({ runId: 'run-1', eventType: 'node-started', recentEvents: [] }, signal);
    h.setNow(1_000_000 + NARRATOR_MIN_INTERVAL_MS - 1);
    await h.narrator.narrateMark({ runId: 'run-1', eventType: 'node-completed', recentEvents: [] }, signal);
    expect(h.narrate).toHaveBeenCalledTimes(1);
  });

  it('apos a janela, marco normal narra de novo', async () => {
    const h = makeNarrator();
    await h.narrator.narrateMark({ runId: 'run-1', eventType: 'node-started', recentEvents: [] }, signal);
    h.setNow(1_000_000 + NARRATOR_MIN_INTERVAL_MS + 1);
    await h.narrator.narrateMark({ runId: 'run-1', eventType: 'node-completed', recentEvents: [] }, signal);
    expect(h.narrate).toHaveBeenCalledTimes(2);
  });

  it('marco FORTE (gate/falha) fura o throttle', async () => {
    const h = makeNarrator();
    await h.narrator.narrateMark({ runId: 'run-1', eventType: 'node-started', recentEvents: [] }, signal);
    await h.narrator.narrateMark({ runId: 'run-1', eventType: 'node-failed', recentEvents: [] }, signal);
    expect(h.narrate).toHaveBeenCalledTimes(2);
  });

  it('throttle e POR RUN (runs distintos nao se bloqueiam)', async () => {
    const h = makeNarrator();
    await h.narrator.narrateMark({ runId: 'run-A', eventType: 'node-started', recentEvents: [] }, signal);
    await h.narrator.narrateMark({ runId: 'run-B', eventType: 'node-started', recentEvents: [] }, signal);
    expect(h.narrate).toHaveBeenCalledTimes(2);
  });

  it('evento fora dos marcos conhecidos NAO narra', async () => {
    const h = makeNarrator();
    await h.narrator.narrateMark({ runId: 'run-1', eventType: 'autonomy-changed', recentEvents: [] }, signal);
    expect(h.narrate).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('texto vazio do modelo NAO faz broadcast', async () => {
    const h = makeNarrator({ narrate: vi.fn<NarrateFn>(async () => ({ text: '   ' })) });
    await h.narrator.narrateMark({ runId: 'run-1', eventType: 'node-started', recentEvents: [] }, signal);
    expect(h.emit).not.toHaveBeenCalled();
  });
});

describe('WorkflowNarrator - best-effort (nunca derruba o run)', () => {
  it('narrador desligado (sem narrate) e no-op total', async () => {
    const emit = vi.fn();
    const narrator = new WorkflowNarrator({ emit });
    expect(narrator.enabled).toBe(false);
    await narrator.narrateMark({ runId: 'run-1', eventType: 'node-started', recentEvents: [] }, signal);
    expect(emit).not.toHaveBeenCalled();
  });

  it('narrate que lanca NAO propaga (best-effort)', async () => {
    const h = makeNarrator({
      narrate: vi.fn<NarrateFn>(async () => {
        throw new Error('modelo caiu');
      }),
    });
    await expect(
      h.narrator.narrateMark({ runId: 'run-1', eventType: 'node-failed', recentEvents: [] }, signal),
    ).resolves.toBeUndefined();
    expect(h.emit).not.toHaveBeenCalled();
  });
});

describe('buildNarratorPrompt - digest', () => {
  it('inclui marco, fase, node+agente, eventos recentes e trecho do node', () => {
    const prompt = buildNarratorPrompt({
      runId: 'run-1',
      eventType: 'node-started',
      phaseId: 'implement',
      nodeId: 'coder',
      agentId: 'dynamic-workflow-coder',
      recentEvents: [makeEvent('run-started'), makeEvent('node-started', 'coder')],
      nodeStreamExcerpt: 'editando src/feature.ts',
    });
    expect(prompt).toContain('node-started');
    expect(prompt).toContain('implement');
    expect(prompt).toContain('coder');
    expect(prompt).toContain('dynamic-workflow-coder');
    expect(prompt).toContain('editando src/feature.ts');
    expect(prompt).toContain('UMA frase');
    expect(prompt).toContain('mudou');
    expect(prompt).toMatch(/NAO redescreva o projeto/i);
  });

  it('digest pobre (so marco) ainda gera prompt valido', () => {
    const prompt = buildNarratorPrompt({
      runId: 'run-1',
      eventType: 'phase-changed',
      recentEvents: [],
    });
    expect(prompt).toContain('phase-changed');
    expect(prompt.length).toBeGreaterThan(0);
  });
});

describe('conjuntos de marcos', () => {
  it('force marks sao subconjunto dos marcos conhecidos', () => {
    for (const t of NARRATOR_FORCE_EVENT_TYPES) {
      expect(NARRATOR_MARK_EVENT_TYPES.has(t)).toBe(true);
    }
  });
});

describe('WorkflowNarrator - SM-32 (persiste + best-effort)', () => {
  it('narrateMark persiste APOS o emit (ordem emit -> persist)', async () => {
    const order: string[] = [];
    const h = makeNarrator({
      insertMessage: () => {
        order.push('persist');
      },
    });
    h.emit.mockImplementation((..._args: unknown[]) => {
      order.push('emit');
    });
    await h.narrator.narrateMark({ runId: 'run-1', eventType: 'node-started', recentEvents: [] }, signal);
    expect(order).toEqual(['emit', 'persist']);
  });

  it('insertMessage que lanca NAO derruba o run (best-effort do try/catch externo)', async () => {
    const h = makeNarrator({
      insertMessage: () => {
        throw new Error('db caiu');
      },
    });
    await expect(
      h.narrator.narrateMark({ runId: 'run-1', eventType: 'node-started', recentEvents: [] }, signal),
    ).resolves.toBeUndefined();
    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it('sem insertMessage nas deps, o broadcast ainda funciona (backward compat)', async () => {
    const emit = vi.fn();
    const narrator = new WorkflowNarrator({
      narrate: async () => ({ text: 'narracao sem persist' }),
      emit,
    });
    await narrator.narrateMark({ runId: 'run-1', eventType: 'node-started', recentEvents: [] }, signal);
    expect(emit).toHaveBeenCalledTimes(1);
    const [, chunk] = emit.mock.calls[0] as [string, Record<string, unknown>];
    expect(chunk.content).toBe('narracao sem persist');
  });

  it('texto vazio NAO persiste (guard identico ao do broadcast)', async () => {
    const h = makeNarrator({
      narrate: async () => ({ text: '   ' }),
    });
    await h.narrator.narrateMark({ runId: 'run-1', eventType: 'node-started', recentEvents: [] }, signal);
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.insertMessage).not.toHaveBeenCalled();
  });

  it('persiste com nodeId quando presente no NarratorDigestInput', async () => {
    const h = makeNarrator();
    await h.narrator.narrateMark(
      { runId: 'run-1', eventType: 'node-started', nodeId: 'coder', recentEvents: [] },
      signal,
    );
    const persisted = (h.insertMessage.mock.calls[0] as [Record<string, unknown>])[0];
    expect(persisted.nodeId).toBe('coder');
  });
});

describe('seed dynamic-workflow-narrator', () => {
  it('e read-only, modelo barato, sem ferramentas e squad dynamic-workflow', () => {
    expect(dynamicWorkflowNarrator.id).toBe(DYNAMIC_WORKFLOW_NARRATOR_ID);
    expect(dynamicWorkflowNarrator.squad).toBe('dynamic-workflow');
    expect(dynamicWorkflowNarrator.runtime).toBe('cloud');
    expect(dynamicWorkflowNarrator.allowedTools).toEqual([]);
    expect(dynamicWorkflowNarrator.mcpServers).toEqual([]);
    expect(dynamicWorkflowNarrator.effort).toBe('low');
    expect(dynamicWorkflowNarrator.thinking).toBe('disabled');
    expect(dynamicWorkflowNarrator.maxTurns).toBeLessThanOrEqual(2);
    expect(dynamicWorkflowNarrator.isActive).toBe(true);
  });

  it('SM-23: o prompt do seed pede DELTA por marco e proibe re-descrever o projeto', () => {
    const sp = dynamicWorkflowNarrator.systemPrompt;
    expect(sp).toContain('UMA frase');
    expect(sp).toMatch(/NAO redescreva o projeto inteiro/i);
    expect(sp).not.toContain('escrever 1 ou 2 frases');
  });

  it('zero em-dash no texto do seed', () => {
    const text = [
      dynamicWorkflowNarrator.id,
      dynamicWorkflowNarrator.name,
      dynamicWorkflowNarrator.description,
      dynamicWorkflowNarrator.systemPrompt,
    ].join('\n');
    expect(text.includes(EM_DASH)).toBe(false);
  });
});

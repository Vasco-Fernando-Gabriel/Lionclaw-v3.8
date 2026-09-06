
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  savePipelineMessage: vi.fn(),
  insertEnrichMessage: vi.fn(),
  insertHarnessRound: vi.fn().mockReturnValue({
    id: 'mock-round-id',
    sprintId: 'mock-sprint',
    roundNumber: 1,
  }),
  updateHarnessRound: vi.fn().mockReturnValue({
    id: 'mock-round-id',
    sprintId: 'mock-sprint',
    roundNumber: 1,
  }),
}));

import { persistMessage, persistHarnessRound } from '../pipeline-shared/persist';
import {
  savePipelineMessage as dbSavePipelineMessage,
  insertEnrichMessage as dbInsertEnrichMessage,
  insertHarnessRound as dbInsertHarnessRound,
  updateHarnessRound as dbUpdateHarnessRound,
} from '../db';

describe('persistMessage — pipeline target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delega pra savePipelineMessage com payload minimo', () => {
    persistMessage(
      { kind: 'pipeline', projectId: 'proj-1', phaseNumber: 2 },
      'assistant',
      'hello world',
    );

    expect(dbSavePipelineMessage).toHaveBeenCalledTimes(1);
    expect(dbSavePipelineMessage).toHaveBeenCalledWith({
      projectId: 'proj-1',
      phaseNumber: 2,
      role: 'assistant',
      content: 'hello world',
      toolCalls: undefined,
      sprintIndex: undefined,
      roundIndex: undefined,
      agentId: undefined,
    });
    expect(dbInsertEnrichMessage).not.toHaveBeenCalled();
  });

  it('propaga toolCalls completos (com output/isError)', () => {
    const toolCalls = [
      { tool: 'Read', input: { path: '/x' }, output: 'file content', isError: false },
      { tool: 'Write', input: { path: '/y', content: 'data' } },
    ];

    persistMessage(
      { kind: 'pipeline', projectId: 'proj-1', phaseNumber: 2 },
      'assistant',
      'output text',
      { toolCalls },
    );

    expect(dbSavePipelineMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCalls,
      }),
    );
  });

  it('propaga sprintIndex/roundIndex/agentId (caso harness)', () => {
    persistMessage(
      {
        kind: 'pipeline',
        projectId: 'proj-1',
        phaseNumber: 13,
        sprintIndex: 0,
        roundIndex: 1,
        agentId: 'harness-coder',
      },
      'user',
      'coder prompt',
    );

    expect(dbSavePipelineMessage).toHaveBeenCalledWith({
      projectId: 'proj-1',
      phaseNumber: 13,
      role: 'user',
      content: 'coder prompt',
      toolCalls: undefined,
      sprintIndex: 0,
      roundIndex: 1,
      agentId: 'harness-coder',
    });
  });
});

describe('persistMessage — enrich target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delega pra insertEnrichMessage sem toolCalls', () => {
    persistMessage(
      { kind: 'enrich', sessionId: 'sess-1', phase: 'validator' },
      'user',
      'user message',
    );

    expect(dbInsertEnrichMessage).toHaveBeenCalledTimes(1);
    expect(dbInsertEnrichMessage).toHaveBeenCalledWith(
      'sess-1',
      'validator',
      'user',
      'user message',
      undefined,
    );
    expect(dbSavePipelineMessage).not.toHaveBeenCalled();
  });

  it('propaga toolCalls fazendo strip de output/isError', () => {
    const inputToolCalls = [
      { tool: 'Read', input: { path: '/x' }, output: 'content', isError: false },
      { tool: 'Edit', input: { path: '/y', old: 'a', new: 'b' } },
    ];

    persistMessage(
      { kind: 'enrich', sessionId: 'sess-1', phase: 'enricher' },
      'assistant',
      'agent output',
      { toolCalls: inputToolCalls },
    );

    expect(dbInsertEnrichMessage).toHaveBeenCalledWith(
      'sess-1',
      'enricher',
      'assistant',
      'agent output',
      [
        { tool: 'Read', input: { path: '/x' } },
        { tool: 'Edit', input: { path: '/y', old: 'a', new: 'b' } },
      ],
    );
  });

  it('aceita ambas as fases (validator + enricher)', () => {
    persistMessage(
      { kind: 'enrich', sessionId: 's', phase: 'validator' },
      'user',
      'v',
    );
    persistMessage(
      { kind: 'enrich', sessionId: 's', phase: 'enricher' },
      'user',
      'e',
    );

    expect(dbInsertEnrichMessage).toHaveBeenCalledTimes(2);
    expect(dbInsertEnrichMessage).toHaveBeenNthCalledWith(1, 's', 'validator', 'user', 'v', undefined);
    expect(dbInsertEnrichMessage).toHaveBeenNthCalledWith(2, 's', 'enricher', 'user', 'e', undefined);
  });
});

describe('persistHarnessRound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('insert delega pra db.insertHarnessRound', () => {
    const result = persistHarnessRound.insert({
      sprintId: 'sprint-1',
      roundNumber: 2,
    });

    expect(dbInsertHarnessRound).toHaveBeenCalledTimes(1);
    expect(dbInsertHarnessRound).toHaveBeenCalledWith({
      sprintId: 'sprint-1',
      roundNumber: 2,
    });
    expect(result.id).toBe('mock-round-id');
  });

  it('update delega pra db.updateHarnessRound', () => {
    const updates = {
      verdict: 'pass' as const,
      coderInputTokens: 100,
      coderOutputTokens: 50,
      completedAt: '2026-05-03T12:00:00Z',
    };

    const result = persistHarnessRound.update('round-id-x', updates);

    expect(dbUpdateHarnessRound).toHaveBeenCalledTimes(1);
    expect(dbUpdateHarnessRound).toHaveBeenCalledWith('round-id-x', updates);
    expect(result.id).toBe('mock-round-id');
  });

  it('insert + update funcionam em sequencia (uso real)', () => {
    const round = persistHarnessRound.insert({ sprintId: 's', roundNumber: 1 });
    persistHarnessRound.update(round.id, { verdict: 'fail', feedbackSummary: 'oops' });

    expect(dbInsertHarnessRound).toHaveBeenCalledTimes(1);
    expect(dbUpdateHarnessRound).toHaveBeenCalledTimes(1);
    expect(dbUpdateHarnessRound).toHaveBeenCalledWith('mock-round-id', {
      verdict: 'fail',
      feedbackSummary: 'oops',
    });
  });
});

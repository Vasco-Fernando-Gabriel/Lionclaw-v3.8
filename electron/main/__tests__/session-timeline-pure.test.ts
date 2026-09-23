import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

vi.mock('../logger', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  }),
}));

vi.mock('../db', () => ({
  deleteSessionsByIds: vi.fn(),
  getTimelineTurnsAfterFence: vi.fn(),
  insertTimelineEvent: vi.fn(),
  insertTimelineTurn: vi.fn(),
  setTimelineTurnAssistantMessageId: vi.fn(),
  setTimelineTurnMetrics: vi.fn(),
  setTimelineTurnStatus: vi.fn(),
}));

import {
  TOOLS_BLOCK_MAX_CHARS,
  extractTouchedFiles,
  formatToolsBlock,
  formatTouchedFilesLine,
  groupMessageIntervals,
  isCoveredByTimeline,
  resolveTimelineAnchor,
  selectExactCompleteRun,
  selectLatestRun,
} from '../session-timeline';
import type { ChatMessage, TimelineEvent, TimelineTurnWithEvents } from '../../../src/types';

function message(id: number, role: ChatMessage['role'], createdAt: string, content = `msg-${id}`): ChatMessage {
  return { id, sessionId: 's', role, content, createdAt };
}

function event(partial: Partial<TimelineEvent> & Pick<TimelineEvent, 'kind'>): TimelineEvent {
  return {
    id: 0,
    runId: 'run',
    sessionId: 's',
    seq: 0,
    toolUseId: null,
    toolName: null,
    content: '',
    toolCallsJson: null,
    reasoningContent: null,
    isError: false,
    originalBytes: null,
    spillPath: null,
    createdAt: '2026-01-01 10:00:00',
    ...partial,
  };
}

function run(partial: Partial<TimelineTurnWithEvents> = {}): TimelineTurnWithEvents {
  return {
    seqId: 1,
    runId: 'run',
    sessionId: 's',
    turnIndex: 0,
    anchorMessageId: 1,
    currentUserMessageId: 1,
    assistantMessageId: null,
    origin: 'turn',
    runtime: 'lion-sdk',
    fidelity: 'exact',
    status: 'complete',
    cwd: null,
    textTokensEst: null,
    toolTokensEst: null,
    createdAt: '2026-01-01 10:00:00',
    events: [],
    ...partial,
  };
}

describe('groupMessageIntervals', () => {
  it('abre um intervalo por user, ignora system e desempata created_at igual por id', () => {
    const intervals = groupMessageIntervals([
      message(3, 'assistant', '2026-01-01 10:00:01'),
      message(2, 'user', '2026-01-01 10:00:01'),
      message(1, 'system', '2026-01-01 10:00:00'),
      message(5, 'user', '2026-01-01 10:00:02'),
      message(4, 'assistant', '2026-01-01 10:00:01'),
    ]);

    expect(intervals.map((interval) => interval.messages.map((m) => m.id))).toEqual([[2, 3, 4], [5]]);
    expect(intervals[0].user?.id).toBe(2);
    expect(intervals[1].user?.id).toBe(5);
  });

  it('historico que comeca em assistant rende um fragmento inicial sem user', () => {
    const intervals = groupMessageIntervals([
      message(1, 'assistant', '2026-01-01 10:00:00'),
      message(2, 'assistant', '2026-01-01 10:00:01'),
      message(3, 'user', '2026-01-01 10:00:02'),
    ]);

    expect(intervals).toHaveLength(2);
    expect(intervals[0].user).toBeNull();
    expect(intervals[0].messages.map((m) => m.id)).toEqual([1, 2]);
    expect(intervals[1].user?.id).toBe(3);
  });

  it('lista vazia rende nenhum intervalo', () => {
    expect(groupMessageIntervals([])).toEqual([]);
  });
});

describe('politicas de selecao de run', () => {
  const covered = (seqId: number, status: 'complete' | 'interrupted' = 'complete') =>
    run({
      seqId,
      runId: `run-${seqId}`,
      status,
      events: [
        event({ kind: 'assistant_step', toolCallsJson: '[{"id":"t1"}]' }),
        event({ kind: 'tool_result', toolUseId: 't1', content: 'ok' }),
      ],
    });

  it('selectExactCompleteRun devolve o maior seqId entre complete + exact + coberto', () => {
    const runs = [covered(10), covered(30), covered(20)];
    expect(selectExactCompleteRun(runs)?.runId).toBe('run-30');
  });

  it('selectExactCompleteRun descarta interrupted, observed e cobertura incompleta', () => {
    const uncovered = run({
      seqId: 99,
      runId: 'sem-result',
      events: [
        event({ kind: 'assistant_step', toolCallsJson: '[{"id":"t1"},{"id":"t2"}]' }),
        event({ kind: 'tool_result', toolUseId: 't1', content: 'ok' }),
      ],
    });
    const observed = run({ seqId: 98, runId: 'observed', fidelity: 'observed' });
    const interrupted = covered(97, 'interrupted');

    expect(selectExactCompleteRun([uncovered, observed, interrupted])).toBeNull();
    expect(selectExactCompleteRun([])).toBeNull();
  });

  it('isCoveredByTimeline recusa id nulo, tool_result com toolUseId nulo e JSON invalido', () => {
    expect(
      isCoveredByTimeline(
        run({
          events: [
            event({ kind: 'assistant_step', toolCallsJson: '[{"function":{"name":"Read"}}]' }),
            event({ kind: 'tool_result', toolUseId: null, content: 'ok' }),
          ],
        }),
      ),
    ).toBe(false);

    expect(isCoveredByTimeline(run({ events: [event({ kind: 'assistant_step', toolCallsJson: 'nao e json' })] }))).toBe(
      false,
    );

    expect(isCoveredByTimeline(run({ events: [event({ kind: 'user', content: 'oi' })] }))).toBe(true);
  });

  it('selectLatestRun devolve o maior seqId de qualquer status e null com lista vazia', () => {
    const runs = [
      run({ seqId: 5, runId: 'a', status: 'complete' }),
      run({ seqId: 40, runId: 'b', status: 'interrupted', fidelity: 'observed' }),
      run({ seqId: 7, runId: 'c' }),
    ];
    expect(selectLatestRun(runs)?.runId).toBe('b');
    expect(selectLatestRun([])).toBeNull();
  });
});

describe('formatToolsBlock', () => {
  it('CLI: pareia por tool_use_id, args mais recente vence e quebras do result viram espaco', () => {
    const block = formatToolsBlock(
      run({
        runtime: 'codex',
        fidelity: 'observed',
        events: [
          event({ kind: 'tool_call', seq: 0, toolUseId: 't1', toolName: 'Read', content: '{"file_path":"a.ts"}' }),
          event({
            kind: 'tool_call_args',
            seq: 1,
            toolUseId: 't1',
            toolName: 'Read',
            content: '{"file_path":"a.ts","limit":10}',
          }),
          event({ kind: 'tool_result', seq: 2, toolUseId: 't1', toolName: 'Read', content: 'linha 1\nlinha 2' }),
        ],
      }),
    );

    expect(block).toBe('Tools:\n- Read({"file_path":"a.ts","limit":10}) -> linha 1 linha 2');
  });

  it('lion-sdk: usa assistant_step.tool_calls e serializa arguments objeto', () => {
    const block = formatToolsBlock(
      run({
        events: [
          event({
            kind: 'assistant_step',
            seq: 0,
            toolCallsJson: JSON.stringify([
              { id: 't1', function: { name: 'Read', arguments: { file_path: 'a.ts' } } },
              { id: 't2', function: { name: 'Grep', arguments: '{"pattern":"x"}' } },
            ]),
          }),
          event({ kind: 'tool_result', seq: 1, toolUseId: 't1', toolName: 'Read', content: '120 linhas' }),
        ],
      }),
    );

    expect(block).toBe(
      'Tools:\n- Read({"file_path":"a.ts"}) -> 120 linhas\n- Grep({"pattern":"x"}) -> (sem resultado)',
    );
  });

  it('persisted-output, is_error, args vazios e tool_result orfao', () => {
    const block = formatToolsBlock(
      run({
        runtime: 'grok',
        fidelity: 'observed',
        events: [
          event({ kind: 'tool_call', seq: 0, toolUseId: 'b1', toolName: 'Bash', content: '{"command":"npm test"}' }),
          event({
            kind: 'tool_result',
            seq: 1,
            toolUseId: 'b1',
            toolName: 'Bash',
            content: '<persisted-output>\nOutput too large\n</persisted-output>',
            originalBytes: 35533,
          }),
          event({ kind: 'tool_call', seq: 2, toolUseId: 'g1', toolName: 'Glob', content: '' }),
          event({ kind: 'tool_result', seq: 3, toolUseId: 'g1', toolName: 'Glob', content: 'quebrou', isError: true }),
          event({ kind: 'tool_result', seq: 4, toolUseId: 'orfao', toolName: 'Write', content: 'gravado' }),
        ],
      }),
    );

    expect(block.split('\n')).toEqual([
      'Tools:',
      '- Bash({"command":"npm test"}) -> [persisted 34.7KB]',
      '- Glob() -> ERRO: quebrou',
      '- Write(?) -> gravado',
    ]);
  });

  it('dois eventos com tool_use_id nulo nunca casam e o primeiro result de um id vence', () => {
    const block = formatToolsBlock(
      run({
        runtime: 'kimi',
        fidelity: 'observed',
        events: [
          event({ kind: 'tool_call', seq: 0, toolUseId: null, toolName: 'Read', content: '{}' }),
          event({ kind: 'tool_result', seq: 1, toolUseId: null, toolName: 'Read', content: 'primeiro' }),
          event({ kind: 'tool_call', seq: 2, toolUseId: 'x', toolName: 'Edit', content: '{}' }),
          event({ kind: 'tool_result', seq: 3, toolUseId: 'x', toolName: 'Edit', content: 'vence' }),
          event({ kind: 'tool_result', seq: 4, toolUseId: 'x', toolName: 'Edit', content: 'perde' }),
        ],
      }),
    );

    expect(block.split('\n')).toEqual([
      'Tools:',
      '- Read({}) -> (sem resultado)',
      '- Read(?) -> primeiro',
      '- Edit({}) -> vence',
    ]);
  });

  it('corta args a 200 e result a 300 unidades UTF-16', () => {
    const block = formatToolsBlock(
      run({
        runtime: 'codex',
        fidelity: 'observed',
        events: [
          event({ kind: 'tool_call', seq: 0, toolUseId: 't1', toolName: 'Read', content: 'a'.repeat(500) }),
          event({ kind: 'tool_result', seq: 1, toolUseId: 't1', toolName: 'Read', content: 'b'.repeat(900) }),
        ],
      }),
    );

    expect(block).toBe(`Tools:\n- Read(${'a'.repeat(200)}) -> ${'b'.repeat(300)}`);
  });

  it('respeita o teto de 1500 contando cabecalho, marcador de omissao e (interrompido)', () => {
    const events: TimelineEvent[] = [];
    for (let index = 0; index < 40; index++) {
      events.push(
        event({
          kind: 'tool_call',
          seq: index * 2,
          toolUseId: `t${index}`,
          toolName: 'Bash',
          content: `{"command":"${'x'.repeat(120)}"}`,
        }),
        event({
          kind: 'tool_result',
          seq: index * 2 + 1,
          toolUseId: `t${index}`,
          toolName: 'Bash',
          content: `resultado ${index}`,
        }),
      );
    }

    const block = formatToolsBlock(run({ runtime: 'codex', fidelity: 'observed', status: 'interrupted', events }));
    const lines = block.split('\n');

    expect(block.length).toBeLessThanOrEqual(TOOLS_BLOCK_MAX_CHARS);
    expect(lines[0]).toBe('Tools:');
    expect(lines[1]).toMatch(/^- \[\.\.\. \d+ tools omitidas \.\.\.\]$/);
    expect(lines[lines.length - 1]).toBe('(interrompido)');
    expect(lines[lines.length - 2]).toContain('resultado 39');

    const omitted = Number(/\[\.\.\. (\d+) tools omitidas/.exec(lines[1])?.[1]);
    expect(omitted + (lines.length - 3)).toBe(40);
  });

  it('run sem tools rende bloco vazio', () => {
    expect(formatToolsBlock(run({ events: [event({ kind: 'user', content: 'oi' })] }))).toBe('');
  });
});

describe('extractTouchedFiles e formatTouchedFilesLine', () => {
  const CWD = path.resolve('/repo');

  it('so tools de arquivo entram, relativiza ao cwd e normaliza barras', () => {
    const files = extractTouchedFiles(
      run({
        cwd: CWD,
        events: [
          event({
            kind: 'assistant_step',
            seq: 0,
            toolCallsJson: JSON.stringify([
              { id: 'r1', function: { name: 'Read', arguments: { file_path: path.join(CWD, 'src', 'a.ts') } } },
              { id: 'w1', function: { name: 'Write', arguments: { file_path: path.join(CWD, 'src', 'b', 'c.ts') } } },
              {
                id: 'n1',
                function: { name: 'NotebookEdit', arguments: { notebook_path: path.join(CWD, 'nb.ipynb') } },
              },
              {
                id: 'g1',
                function: { name: 'Grep', arguments: { pattern: 'x', file_path: path.join(CWD, 'nao.ts') } },
              },
              {
                id: 'b1',
                function: { name: 'Bash', arguments: { command: 'ls', file_path: path.join(CWD, 'nunca.ts') } },
              },
              { id: 'o1', function: { name: 'Edit', arguments: { file_path: path.resolve('/fora', 'x.ts') } } },
            ]),
          }),
          event({ kind: 'tool_result', seq: 1, toolUseId: 'r1', content: 'ok' }),
          event({ kind: 'tool_result', seq: 2, toolUseId: 'w1', content: 'ok' }),
          event({ kind: 'tool_result', seq: 3, toolUseId: 'n1', content: 'ok' }),
          event({ kind: 'tool_result', seq: 4, toolUseId: 'g1', content: 'ok' }),
          event({ kind: 'tool_result', seq: 5, toolUseId: 'b1', content: 'ok' }),
          event({ kind: 'tool_result', seq: 6, toolUseId: 'o1', content: 'ok' }),
        ],
      }),
    );

    expect(files).toEqual([
      'src/a.ts',
      'src/b/c.ts',
      'nb.ipynb',
      path.resolve('/fora', 'x.ts').split(path.sep).join('/'),
    ]);
    expect(formatTouchedFilesLine(files)).toBe(`[arquivos tocados: ${files.join(', ')}]`);
  });

  it('is_error exclui o caminho, Codex sem args nao rende nada e a deduplicacao mantem a primeira ocorrencia', () => {
    const files = extractTouchedFiles(
      run({
        runtime: 'codex',
        fidelity: 'observed',
        cwd: CWD,
        events: [
          event({
            kind: 'tool_call',
            seq: 0,
            toolUseId: 'e1',
            toolName: 'Edit',
            content: JSON.stringify({ file_path: path.join(CWD, 'erro.ts') }),
          }),
          event({ kind: 'tool_result', seq: 1, toolUseId: 'e1', toolName: 'Edit', content: 'falhou', isError: true }),
          event({ kind: 'tool_call', seq: 2, toolUseId: 'c1', toolName: 'Read', content: '' }),
          event({ kind: 'tool_result', seq: 3, toolUseId: 'c1', toolName: 'Read', content: 'ok' }),
          event({
            kind: 'tool_call',
            seq: 4,
            toolUseId: 'd1',
            toolName: 'Read',
            content: JSON.stringify({ file_path: path.join(CWD, 'dup.ts') }),
          }),
          event({ kind: 'tool_result', seq: 5, toolUseId: 'd1', toolName: 'Read', content: 'ok' }),
          event({
            kind: 'tool_call',
            seq: 6,
            toolUseId: 'd2',
            toolName: 'Edit',
            content: JSON.stringify({ file_path: path.join(CWD, 'dup.ts') }),
          }),
          event({ kind: 'tool_result', seq: 7, toolUseId: 'd2', toolName: 'Edit', content: 'ok' }),
        ],
      }),
    );

    expect(files).toEqual(['dup.ts']);
    expect(formatTouchedFilesLine([])).toBe('');
  });

  it('limita a 20 caminhos e acrescenta o token +N', () => {
    const events: TimelineEvent[] = [];
    const calls: unknown[] = [];
    for (let index = 0; index < 23; index++) {
      calls.push({ id: `t${index}`, function: { name: 'Read', arguments: { file_path: `rel-${index}.ts` } } });
      events.push(event({ kind: 'tool_result', seq: index + 1, toolUseId: `t${index}`, content: 'ok' }));
    }
    const files = extractTouchedFiles(
      run({
        cwd: null,
        events: [event({ kind: 'assistant_step', seq: 0, toolCallsJson: JSON.stringify(calls) }), ...events],
      }),
    );

    expect(files).toHaveLength(21);
    expect(files[0]).toBe('rel-0.ts');
    expect(files[19]).toBe('rel-19.ts');
    expect(files[20]).toBe('+3');
  });
});

describe('resolveTimelineAnchor (matriz 4.5)', () => {
  it("origin 'turn' com user persistido devolve o mesmo id nos tres campos", () => {
    expect(resolveTimelineAnchor({ origin: 'turn', persistedUserMessageId: 42, answeredUserMessageId: 7 })).toEqual({
      anchorMessageId: 42,
      currentUserMessageId: 42,
      excludeUserMessageId: 42,
    });
  });

  it("origin 'turn' com falha de persistencia devolve tudo NULL", () => {
    expect(resolveTimelineAnchor({ origin: 'turn', persistedUserMessageId: null, answeredUserMessageId: 7 })).toEqual({
      anchorMessageId: null,
      currentUserMessageId: null,
      excludeUserMessageId: null,
    });
  });

  it("origin 'retry' usa answeredUserMessageId e zera currentUserMessageId", () => {
    expect(resolveTimelineAnchor({ origin: 'retry', persistedUserMessageId: 99, answeredUserMessageId: 12 })).toEqual({
      anchorMessageId: 12,
      currentUserMessageId: null,
      excludeUserMessageId: 12,
    });
    expect(resolveTimelineAnchor({ origin: 'retry', persistedUserMessageId: 99, answeredUserMessageId: null })).toEqual(
      { anchorMessageId: null, currentUserMessageId: null, excludeUserMessageId: null },
    );
  });

  it.each(['system-event', 'swarm', 'cron', 'telegram'] as const)(
    "origin '%s' devolve NULL/NULL/NULL mesmo com ids informados",
    (origin) => {
      expect(resolveTimelineAnchor({ origin, persistedUserMessageId: 5, answeredUserMessageId: 6 })).toEqual({
        anchorMessageId: null,
        currentUserMessageId: null,
        excludeUserMessageId: null,
      });
    },
  );
});

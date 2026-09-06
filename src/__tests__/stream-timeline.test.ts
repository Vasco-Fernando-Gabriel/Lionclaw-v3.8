import { describe, expect, it } from 'vitest';
import {
  appendTimelineText,
  appendTimelineTool,
  applyTimelineToolResult,
  finishTimeline,
  replaceTimelineText,
  timelineFromPersisted,
} from '@/lib/stream-timeline';

describe('stream timeline reducer', () => {
  it('preserva texto -> tool -> texto', () => {
    let timeline = appendTimelineText([], 'antes');
    timeline = appendTimelineTool(timeline, { tool: 'Read', input: {}, toolCallId: 'r1' });
    timeline = appendTimelineText(timeline, 'depois');
    expect(timeline.map((block) => block.kind)).toEqual(['text', 'tool', 'text']);
    expect(timeline.map((block) => block.kind === 'text' ? block.content : block.tool)).toEqual([
      'antes',
      'Read',
      'depois',
    ]);
  });

  it('mostra tool imediatamente antes do primeiro texto', () => {
    let timeline = appendTimelineTool([], { tool: 'Search', input: null });
    timeline = appendTimelineText(timeline, 'achei');
    expect(timeline.map((block) => block.kind)).toEqual(['tool', 'text']);
  });

  it('tools paralelas terminam fora de ordem sem mudar de posição', () => {
    let timeline = appendTimelineTool([], { tool: 'Read', toolCallId: 'a' });
    timeline = appendTimelineTool(timeline, { tool: 'Read', toolCallId: 'b' });
    timeline = applyTimelineToolResult(timeline, { toolCallId: 'b', result: 'B' });
    timeline = applyTimelineToolResult(timeline, { toolCallId: 'a', result: 'A' });
    expect(timeline.filter((block) => block.kind === 'tool').map((block) => block.toolCallId)).toEqual(['a', 'b']);
    expect(timeline.filter((block) => block.kind === 'tool').map((block) => block.result)).toEqual(['A', 'B']);
  });

  it('fallback sem id só casa quando há uma candidata', () => {
    let one = appendTimelineTool([], { tool: 'Bash' });
    one = applyTimelineToolResult(one, { tool: 'Bash', result: 'ok' });
    expect(one[0]).toMatchObject({ status: 'done', correlation: 'matched' });

    let many = appendTimelineTool([], { tool: 'Bash' });
    many = appendTimelineTool(many, { tool: 'Bash' });
    many = applyTimelineToolResult(many, { tool: 'Bash', result: 'ambíguo' });
    expect(many).toHaveLength(3);
    expect(many.slice(0, 2).map((block) => block.kind === 'tool' && block.status)).toEqual(['running', 'running']);
    expect(many[2]).toMatchObject({ kind: 'tool', correlation: 'unmatched', status: 'done' });
  });

  it('finaliza blocos sem reordenar', () => {
    let timeline = appendTimelineText([], 'texto');
    timeline = appendTimelineTool(timeline, { tool: 'Read' });
    expect(finishTimeline(timeline).map((block) => block.status)).toEqual(['done', 'done']);
  });

  it('reidrata offsets UTF-16 e mantém legado compatível', () => {
    const content = 'A😀BC';
    const modern = timelineFromPersisted(
      content,
      [{ tool: 'Read', input: {}, textOffset: 3, sequence: 1, toolCallId: 'r' }],
      'm1',
    );
    expect(modern.map((block) => block.kind === 'text' ? block.content : block.tool)).toEqual(['A😀', 'Read', 'BC']);
    const legacy = timelineFromPersisted(content, [{ tool: 'Read', input: {} }], 'm2');
    expect(legacy.map((block) => block.kind)).toEqual(['tool', 'text']);
  });

  it('replace_content remove marcador interno sem jogar todas as tools para o topo', () => {
    let timeline = appendTimelineText([], 'antes ');
    timeline = appendTimelineTool(timeline, { tool: 'Read', toolCallId: 'r' });
    timeline = appendTimelineText(timeline, 'ONBOARDING_DATA:{...} depois');
    timeline = appendTimelineTool(timeline, { tool: 'Write', toolCallId: 'w' });

    const replaced = replaceTimelineText(timeline, 'antes  depois');
    expect(replaced.map((block) => block.kind === 'text' ? block.content : block.tool)).toEqual([
      'antes ',
      'Read',
      ' depois',
      'Write',
    ]);
  });
});

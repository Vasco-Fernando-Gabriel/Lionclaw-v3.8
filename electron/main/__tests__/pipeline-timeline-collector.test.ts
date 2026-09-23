import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumePipelineTimeline,
  recordPipelineTimelineEvent,
  resetPipelineTimeline,
} from '../pipeline-engine/timeline-collector';

describe('pipeline timeline collector', () => {
  beforeEach(() => resetPipelineTimeline('project', 4));

  it('calcula textOffset UTF-16 no main e combina os detalhes finais', () => {
    recordPipelineTimelineEvent({ projectId: 'project', phase: 4, type: 'text', content: 'A😀' });
    recordPipelineTimelineEvent({ projectId: 'project', phase: 4, type: 'tool_call', tool: 'Read', toolCallId: 'r1' });
    recordPipelineTimelineEvent({ projectId: 'project', phase: 4, type: 'text', content: 'BC' });
    recordPipelineTimelineEvent({ projectId: 'project', phase: 4, type: 'tool_call', tool: 'Bash', toolCallId: 'b1' });

    expect(
      consumePipelineTimeline('project', 4, [
        { tool: 'Read', input: { file: 'a.ts' }, toolCallId: 'r1' },
        { tool: 'Bash', input: { command: 'npm test' }, toolCallId: 'b1', isError: true },
      ]),
    ).toEqual([
      expect.objectContaining({ tool: 'Read', toolCallId: 'r1', sequence: 0, textOffset: 3, status: 'done' }),
      expect.objectContaining({ tool: 'Bash', toolCallId: 'b1', sequence: 1, textOffset: 5, status: 'error' }),
    ]);
  });

  it('limpa o turno ao consumir e não reaproveita offset em retry', () => {
    recordPipelineTimelineEvent({ projectId: 'project', phase: 4, type: 'text', content: 'antigo' });
    recordPipelineTimelineEvent({ projectId: 'project', phase: 4, type: 'tool_call', tool: 'Read' });
    expect(consumePipelineTimeline('project', 4, undefined)?.[0].textOffset).toBe(6);

    recordPipelineTimelineEvent({ projectId: 'project', phase: 4, type: 'tool_call', tool: 'Write' });
    expect(consumePipelineTimeline('project', 4, undefined)?.[0].textOffset).toBe(0);
  });

  it('remapeia offsets quando o texto persistido remove um marcador interno', () => {
    recordPipelineTimelineEvent({ projectId: 'project', phase: 4, type: 'text', content: 'antes ' });
    recordPipelineTimelineEvent({ projectId: 'project', phase: 4, type: 'tool_call', tool: 'Read' });
    recordPipelineTimelineEvent({ projectId: 'project', phase: 4, type: 'text', content: 'MARKER depois' });
    recordPipelineTimelineEvent({ projectId: 'project', phase: 4, type: 'tool_call', tool: 'Write' });

    expect(consumePipelineTimeline('project', 4, undefined, 'antes  depois')).toEqual([
      expect.objectContaining({ tool: 'Read', textOffset: 6 }),
      expect.objectContaining({ tool: 'Write', textOffset: 13 }),
    ]);
  });
});

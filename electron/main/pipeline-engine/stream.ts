
import { emitIPC } from '../pipeline-shared/ipc-emitter';
import { getHarnessSprints } from '../db';
import { recordPipelineTimelineEvent } from './timeline-collector';

export interface PipelineStreamChunk {
  projectId: string;
  phase: number;
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'thinking' | 'error';
  content?: string;
  tool?: string;
  toolCallId?: string;
  isError?: boolean;
  message?: string;
  metadata?: { agent?: string; round?: number };
  auditAgentId?: string;
  auditAgentSlug?: string;
}

export function emitPipelineStream(chunk: PipelineStreamChunk): void {
  recordPipelineTimelineEvent(chunk);
  emitIPC('pipeline:stream', chunk);
}

export function emitPipelineSprintsLoaded(projectId: string): void {
  const sprints = getHarnessSprints(projectId);
  emitIPC('pipeline:sprints-loaded', {
    projectId,
    sprints: sprints.map((s) => ({
      index: s.sprintIndex,
      name: s.name,
      status: s.status,
      coderAgentId: s.coderAgentId,
      evaluatorAgentId: s.evaluatorAgentId,
      sprintJsonId: s.sprintJsonId,
      sprintId: s.id,
    })),
  });
}

export function makeConversationOnText(args: {
  projectId: string;
  phase: number;
  accumulatedRef: { text: string; completed: boolean };
  phaseCompleteMarker: string;
  onPhaseComplete: () => void;
}): (chunk: string) => void {
  const { projectId, phase, accumulatedRef, phaseCompleteMarker, onPhaseComplete } = args;
  return (chunk: string) => {
    const combined = accumulatedRef.text + chunk;
    accumulatedRef.text = combined;

    if (!accumulatedRef.completed && combined.includes(phaseCompleteMarker)) {
      accumulatedRef.completed = true;
      onPhaseComplete();
    }

    const cleaned = chunk.replace(phaseCompleteMarker, '');
    if (cleaned.length > 0) {
      emitPipelineStream({ projectId, phase, type: 'text', content: cleaned });
    }
  };
}

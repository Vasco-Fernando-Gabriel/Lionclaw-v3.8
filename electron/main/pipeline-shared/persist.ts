import { persistSwarmChatMessage } from './chat-persist';

import {
  insertEnrichMessage as dbInsertEnrichMessage,
  insertHarnessRound as dbInsertHarnessRound,
  persistClaimedHarnessEvaluatorCompletion as dbPersistClaimedHarnessEvaluatorCompletion,
  savePipelineMessage as dbSavePipelineMessage,
  updateHarnessRound as dbUpdateHarnessRound,
} from '../db';
import type { HarnessEvaluatorPipelineMessage, HarnessEvaluatorRoundCompletion } from '../db';
import { createLogger } from '../logger';
import { textProbe } from './text-probe';
import { brandLionDesignText } from '../liondesign-branding';
import type { PersistedTimelineToolCall } from '../../../src/types/stream-timeline';
import { consumePipelineTimeline } from '../pipeline-engine/timeline-collector';

const logger = createLogger('pipeline-persist');

export type PersistMessageTarget =
  | {
      kind: 'chat';
      sessionId: string;
      swarmDelivery: { runId: string; terminalRevision: number; claimId: string };
      messageKind: 'event' | 'response';
      serializedMetadata?: string;
    }
  | {
      kind: 'pipeline';
      projectId: string;
      phaseNumber: number;
      sprintIndex?: number;
      roundIndex?: number;
      agentId?: string;
    }
  | {
      kind: 'enrich';
      sessionId: string;
      phase: 'validator' | 'enricher';
    };

export interface PersistMessageMetadata {
  toolCalls?: PersistedTimelineToolCall[];
}

export function persistMessage(
  target: PersistMessageTarget,
  role: 'user' | 'assistant' | 'system',
  content: string,
  metadata?: PersistMessageMetadata,
): void {
  if (target.kind === 'chat') {
    if (role !== (target.messageKind === 'event' ? 'system' : 'assistant'))
      throw new Error('Papel incompatível com mensagem Swarm.');
    persistSwarmChatMessage(target, role as 'system' | 'assistant', content);
    return;
  }
  if (role === 'system') throw new Error('Evento de sistema só é válido no domínio chat.');
  const presentedContent = brandLionDesignText(content);
  logger.debug({ kind: target.kind, role, probe: textProbe(presentedContent) }, '(F8) persistMessage entrada');
  if (target.kind === 'pipeline') {
    const toolCalls =
      role === 'assistant'
        ? consumePipelineTimeline(target.projectId, target.phaseNumber, metadata?.toolCalls, presentedContent)
        : metadata?.toolCalls;
    dbSavePipelineMessage({
      projectId: target.projectId,
      phaseNumber: target.phaseNumber,
      role,
      content: presentedContent,
      toolCalls,
      sprintIndex: target.sprintIndex,
      roundIndex: target.roundIndex,
      agentId: target.agentId,
    });
    return;
  }

  if (target.kind === 'enrich') {
    const enrichToolCalls = metadata?.toolCalls?.map((tc) => ({
      tool: tc.tool,
      input: tc.input,
    }));
    dbInsertEnrichMessage(target.sessionId, target.phase, role, presentedContent, enrichToolCalls);
    return;
  }

  const _exhaustive: never = target;
  throw new Error(`Unsupported persist target: ${String(_exhaustive)}`);
}

export const persistHarnessRound = {
  insert: dbInsertHarnessRound,
  update: dbUpdateHarnessRound,
};

export function persistClaimedHarnessEvaluatorCompletion(data: {
  projectId: string;
  checkpointId: string;
  roundId: string;
  resume: unknown;
  round: HarnessEvaluatorRoundCompletion;
  pipelineMessage?: Omit<HarnessEvaluatorPipelineMessage, 'content' | 'toolCalls'> & {
    content: string;
    toolCalls?: PersistedTimelineToolCall[];
  };
}) {
  const pipelineMessage = data.pipelineMessage
    ? (() => {
        const content = brandLionDesignText(data.pipelineMessage.content);
        return {
          ...data.pipelineMessage,
          content,
          toolCalls: consumePipelineTimeline(
            data.pipelineMessage.projectId,
            data.pipelineMessage.phaseNumber,
            data.pipelineMessage.toolCalls,
            content,
          ),
        };
      })()
    : undefined;
  return dbPersistClaimedHarnessEvaluatorCompletion({
    projectId: data.projectId,
    checkpointId: data.checkpointId,
    roundId: data.roundId,
    resume: data.resume,
    round: data.round,
    ...(pipelineMessage ? { pipelineMessage } : {}),
  });
}

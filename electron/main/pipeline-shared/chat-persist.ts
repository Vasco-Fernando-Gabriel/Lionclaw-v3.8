import { persistSwarmChatMessageOnce } from '../db';

export interface SwarmChatTarget {
  kind: 'chat';
  sessionId: string;
  swarmDelivery: { runId: string; terminalRevision: number; claimId: string };
  messageKind: 'event' | 'response';
  serializedMetadata?: string;
}
export function persistSwarmChatMessage(target: SwarmChatTarget, role: 'system' | 'assistant', content: string): void {
  if (role !== (target.messageKind === 'event' ? 'system' : 'assistant')) {
    throw new Error('Papel incompatível com a mensagem Swarm.');
  }
  persistSwarmChatMessageOnce({
    ...target.swarmDelivery,
    sessionId: target.sessionId,
    kind: target.messageKind,
    content,
    metadata: target.serializedMetadata,
  });
}

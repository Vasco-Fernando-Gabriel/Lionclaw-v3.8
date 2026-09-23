import { createLogger } from '../logger';
import { releaseSwarmDelivery, getSwarmDelivery, getSession, completeSwarmDelivery } from '../db';
import { persistSwarmChatMessage } from '../pipeline-shared/chat-persist';
import type { QueryOptions } from '../orchestrator';

export function persistSwarmResponse(
  options: Pick<QueryOptions, 'swarmDelivery'>,
  sessionId: string,
  content: string,
  metadata?: string,
): boolean {
  if (!options.swarmDelivery) return false;
  persistSwarmChatMessage(
    {
      kind: 'chat',
      sessionId,
      swarmDelivery: options.swarmDelivery,
      messageKind: 'response',
      serializedMetadata: metadata,
    },
    'assistant',
    content,
  );
  return true;
}

const logger = createLogger('swarm-chat-persistence');
const pendingReleases = new Map<string, { delivery: NonNullable<QueryOptions['swarmDelivery']>; reason: string }>();

export function releaseSwarmTurn(options: Pick<QueryOptions, 'swarmDelivery'>, reason: string): void {
  if (!options.swarmDelivery) return;
  const { runId, terminalRevision, claimId } = options.swarmDelivery;
  const key = `${runId}/${terminalRevision}/${claimId}`;
  try {
    releaseSwarmDelivery(runId, terminalRevision, claimId, reason);
    pendingReleases.delete(key);
  } catch (error) {
    pendingReleases.set(key, { delivery: options.swarmDelivery, reason });
    logger.warn({ err: error, runId }, 'Liberação de claim Swarm aguardando recuperação do banco');
  }
}

export function canBeginSwarmTurn(options: Pick<QueryOptions, 'swarmDelivery' | 'sessionId'>): boolean {
  if (!options.swarmDelivery) return true;
  const { runId, terminalRevision, claimId } = options.swarmDelivery;
  try {
    const delivery = getSwarmDelivery(runId, terminalRevision);
    if (
      !delivery ||
      delivery.state !== 'claimed' ||
      delivery.claimId !== claimId ||
      delivery.sessionId !== options.sessionId
    )
      return false;
    const session = getSession(delivery.sessionId);
    if (!session || session.status === 'trashed') {
      completeSwarmDelivery(runId, terminalRevision, claimId, 'undeliverable', 'Sessão removida antes da agregação');
      return false;
    }
    return true;
  } catch (error) {
    releaseSwarmTurn(options, 'Banco indisponível na admissão da agregação');
    logger.warn({ err: error, runId }, 'Agregação Swarm adiada até recuperar o banco');
    return false;
  }
}

export function flushSwarmTurnReleases(): void {
  for (const pending of [...pendingReleases.values()])
    releaseSwarmTurn({ swarmDelivery: pending.delivery }, pending.reason);
}

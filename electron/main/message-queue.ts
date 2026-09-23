import { createLogger } from './logger';
import type { ChatFeatureToggles } from '../../src/types';
import type { InternalCapabilityCoordinator } from './chat-capability-lease';
import type { ChatCapabilityName } from './chat-capability-context';

const logger = createLogger('message-queue');

export interface QueuedMessage {
  message: string;
  options: {
    sessionId?: string;
    swarmDelivery?: { runId: string; terminalRevision: number; claimId: string };
    agentId?: string;
    silent?: boolean;
    displayMessage?: string;
    origin?: 'user' | 'system-event';
    skipUserMessagePersistence?: boolean;
    driveProjectId?: string;
    drivePhase?: number;
    driveTurnId?: string;
    driveEpoch?: string;
    internalLeaseToken?: string;
    leaseCoordinator?: InternalCapabilityCoordinator;
    leaseCapability?: ChatCapabilityName;
    featureToggles?: ChatFeatureToggles;
    authorizationGeneration?: number;
    attachments?: Array<{
      id: string;
      type: string;
      filename: string;
      mimeType: string;
      data: string;
      size: number;
      preview?: string;
    }>;
  };
  enqueuedAt: number;
}

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private _processing = false;
  private _processingStartedAt: number | null = null;

  get isProcessing(): boolean {
    return this._processing;
  }

  set isProcessing(value: boolean) {
    if (value === this._processing) return;
    this._processing = value;
    this._processingStartedAt = value ? Date.now() : null;
  }

  get processingStartedAt(): number | null {
    return this._processingStartedAt;
  }

  get processingDurationMs(): number {
    return this._processingStartedAt ? Date.now() - this._processingStartedAt : 0;
  }

  enqueue(item: QueuedMessage): void {
    this.queue.push(item);
    logger.info({ queueLength: this.queue.length, message: item.message.substring(0, 80) }, 'Message enqueued');
  }

  dequeue(): QueuedMessage | undefined {
    return this.queue.shift();
  }

  peek(): QueuedMessage | undefined {
    return this.queue[0];
  }

  get length(): number {
    return this.queue.length;
  }

  clear(): QueuedMessage[] {
    const discarded = this.queue;
    const cleared = this.queue.length;
    this.queue = [];
    if (cleared > 0) {
      logger.info({ cleared }, 'Queue cleared');
    }
    return discarded;
  }

  drain(predicate?: (item: QueuedMessage) => boolean): QueuedMessage[] {
    if (!predicate) {
      const drained = this.queue;
      this.queue = [];
      if (drained.length > 0) {
        logger.info({ cleared: drained.length }, 'Queue drained');
      }
      return drained;
    }
    const drained: QueuedMessage[] = [];
    const kept: QueuedMessage[] = [];
    for (const item of this.queue) {
      (predicate(item) ? drained : kept).push(item);
    }
    this.queue = kept;
    if (drained.length > 0) {
      logger.info({ cleared: drained.length, kept: kept.length }, 'Queue drained by predicate');
    }
    return drained;
  }

  some(predicate: (item: QueuedMessage) => boolean): boolean {
    return this.queue.some(predicate);
  }
}

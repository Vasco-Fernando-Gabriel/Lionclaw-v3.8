

export interface PipelinePhaseChangedEvent {
  projectId: string;
  phase: number | null;
  phaseName?: string;
  status?: string;
  awaitingUser?: boolean;
  currentModel?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PipelineStreamEvent {
  projectId: string;
  phase: number;
  type: 'text' | 'tool_call' | 'done' | 'thinking' | 'error';
  content?: string;
  tool?: string;
  message?: string;
  metadata?: { agent?: string; round?: number };
  auditAgentId?: string;
  auditAgentSlug?: string;
}

export interface PipelineSprintCompleteEvent {
  projectId: string;
  sprintIndex: number;
  sprintName?: string;
  verdict?: string;
  rounds?: number;
  metrics?: Record<string, unknown>;
}

export interface PipelineErrorEvent {
  projectId: string;
  phase?: number | null;
  error?: string;
}

export interface PipelineAgentCompletedEvent {
  projectId: string;
}

export interface PipelineDocumentUpdatedEvent {
  projectId: string;
  path: string;
  content?: string;
}

export interface PipelineResetCompleteEvent {
  projectId: string;
  phase: number;
}

export interface PipelineSprintResetEvent {
  projectId: string;
  sprintIndex: number;
}

export interface PipelineHumanMessageEvent {
  projectId: string;
  content: string;
}

export interface PipelineBusEvents {
  'pipeline:phase-changed': PipelinePhaseChangedEvent;
  'pipeline:stream': PipelineStreamEvent;
  'pipeline:sprint-complete': PipelineSprintCompleteEvent;
  'pipeline:error': PipelineErrorEvent;
  'pipeline:agent-completed': PipelineAgentCompletedEvent;
  'pipeline:document-updated': PipelineDocumentUpdatedEvent;
  'pipeline:reset-complete': PipelineResetCompleteEvent;
  'pipeline:sprint-reset': PipelineSprintResetEvent;
  'pipeline:human-message': PipelineHumanMessageEvent;
}

export type PipelineBusChannel = keyof PipelineBusEvents;

type AnyListener = (payload: unknown) => void;

class PipelineEventBus {
  private listeners = new Map<string, Set<AnyListener>>();

  on<K extends PipelineBusChannel>(
    event: K,
    listener: (payload: PipelineBusEvents[K]) => void,
  ): () => void;
  on(event: string, listener: (payload: unknown) => void): () => void;
  on(event: string, listener: (payload: never) => void): () => void {
    const wrapped = listener as AnyListener;
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set<AnyListener>();
      this.listeners.set(event, set);
    }
    set.add(wrapped);
    return () => this.off(event, wrapped);
  }

  off(event: string, listener: (payload: never) => void): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(listener as AnyListener);
    if (set.size === 0) this.listeners.delete(event);
  }

  emit<K extends PipelineBusChannel>(event: K, payload: PipelineBusEvents[K]): void;
  emit(event: string, payload: unknown): void;
  emit(event: string, payload: unknown): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const listener of Array.from(set)) {
      try {
        listener(payload);
      } catch {
      }
    }
  }

  _resetForTesting(): void {
    if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
      throw new Error('_resetForTesting can only be called in test environment');
    }
    this.listeners.clear();
  }
}

export const pipelineEventBus = new PipelineEventBus();

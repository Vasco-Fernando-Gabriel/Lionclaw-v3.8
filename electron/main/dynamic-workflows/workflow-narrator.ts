
import { createLogger } from '../logger';
import type {
  DynamicWorkflowEvent,
  DynamicWorkflowStreamChunk,
  DynamicWorkflowMessageInsertInput,
} from './types';

const logger = createLogger('dynamic-workflow-narrator');

export const NARRATOR_MIN_INTERVAL_MS = 8000;

export const NARRATOR_MARK_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'run-started',
  'node-started',
  'node-completed',
  'node-failed',
  'phase-changed',
  'gate-blocked',
  'gate-approved',
  'gate-rejected',
  'run-delivered',
  'run-finished',
  'run-blocked-snapshot',
]);

export const NARRATOR_FORCE_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'node-failed',
  'gate-blocked',
  'gate-approved',
  'gate-rejected',
  'run-delivered',
  'run-blocked-snapshot',
]);

export interface NarratorDigestInput {
  runId: string;
  eventType: string;
  phaseId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  recentEvents: DynamicWorkflowEvent[];
  nodeStreamExcerpt?: string | null;
}

export interface NarrateResult {
  text: string;
}

export type NarrateFn = (input: {
  runId: string;
  prompt: string;
  abortSignal: AbortSignal;
}) => Promise<NarrateResult>;

export interface WorkflowNarratorDeps {
  narrate?: NarrateFn;
  emit: (channel: string, payload: unknown) => void;
  insertMessage?: (input: DynamicWorkflowMessageInsertInput) => unknown;
  now?: () => number;
}

const STREAM_CHANNEL = 'dynamic-workflow:stream';

const NODE_EXCERPT_MAX = 600;
const RECENT_EVENTS_IN_DIGEST = 6;

export function buildNarratorPrompt(input: NarratorDigestInput): string {
  const lines: string[] = [];
  lines.push('Estado atual do workflow (digest do motor):');
  lines.push(`- Marco: ${input.eventType}`);
  if (input.phaseId) lines.push(`- Fase atual: ${input.phaseId}`);
  if (input.nodeId) {
    const agentPart = input.agentId ? ` (agente: ${input.agentId})` : '';
    lines.push(`- Node corrente: ${input.nodeId}${agentPart}`);
  }
  const recent = input.recentEvents.slice(-RECENT_EVENTS_IN_DIGEST);
  if (recent.length > 0) {
    lines.push('- Ultimos eventos (mais antigo -> mais recente):');
    for (const ev of recent) {
      const node = ev.nodeId ? ` node=${ev.nodeId}` : '';
      lines.push(`  - ${ev.type}${node}`);
    }
  }
  if (input.nodeStreamExcerpt && input.nodeStreamExcerpt.trim().length > 0) {
    const excerpt = input.nodeStreamExcerpt.trim().slice(-NODE_EXCERPT_MAX);
    lines.push('- Trecho recente do que o agente do node esta produzindo:');
    lines.push(`  """${excerpt}"""`);
  }
  lines.push('');
  lines.push(
    'Escreva UMA frase curta em PT-BR dizendo SO o que mudou NESTE marco (o passo que acabou de acontecer). NAO redescreva o projeto inteiro nem repita o objetivo do workflow: o humano ja sabe o que esta sendo construido. Foque no delta deste marco. Devolva apenas a frase.',
  );
  return lines.join('\n');
}

export class WorkflowNarrator {
  private readonly deps: WorkflowNarratorDeps;
  private readonly now: () => number;
  private readonly lastNarrationAt = new Map<string, number>();

  constructor(deps: WorkflowNarratorDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  get enabled(): boolean {
    return typeof this.deps.narrate === 'function';
  }

  shouldNarrate(runId: string, eventType: string): boolean {
    if (!this.enabled) return false;
    if (!NARRATOR_MARK_EVENT_TYPES.has(eventType)) return false;
    if (NARRATOR_FORCE_EVENT_TYPES.has(eventType)) return true;
    const last = this.lastNarrationAt.get(runId);
    if (last === undefined) return true;
    return this.now() - last >= NARRATOR_MIN_INTERVAL_MS;
  }

  async narrateMark(input: NarratorDigestInput, abortSignal: AbortSignal): Promise<void> {
    try {
      if (!this.shouldNarrate(input.runId, input.eventType)) return;
      const narrate = this.deps.narrate;
      if (!narrate) return;
      this.lastNarrationAt.set(input.runId, this.now());
      const prompt = buildNarratorPrompt(input);
      const result = await narrate({ runId: input.runId, prompt, abortSignal });
      const text = (result?.text ?? '').trim();
      if (text.length === 0) return;
      const chunk: DynamicWorkflowStreamChunk = {
        kind: 'narrator',
        runId: input.runId,
        type: 'text',
        content: text,
        final: true,
      };
      this.deps.emit(STREAM_CHANNEL, chunk);
      if (this.deps.insertMessage) {
        this.deps.insertMessage({
          runId: input.runId,
          nodeId: input.nodeId ?? null,
          role: 'assistant',
          source: 'workflow-orchestrator-agent',
          kind: 'narrator',
          content: text,
        });
      }
    } catch (err) {
      logger.warn(
        { err, runId: input.runId, eventType: input.eventType },
        'narracao falhou (ignorada; run segue sem narrar)',
      );
    }
  }

  forget(runId: string): void {
    this.lastNarrationAt.delete(runId);
  }
}

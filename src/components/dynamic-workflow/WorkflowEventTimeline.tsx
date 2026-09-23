import { useEffect, useRef } from 'react';
import { Check, Clock, CornerDownLeft, ListEnd, TriangleAlert, X } from 'lucide-react';
import type { DynamicWorkflowEvent } from '@/types';
import type { CockpitNodeRun } from '@/types/dynamic-workflow-cockpit';
import { dayLabel, formatLocalTime, parseSqliteUtc } from '@/lib/sqlite-time';
import type { ComposerFeedItem } from './InterventionComposer';
import { nodeDisplayName, shortNodeId } from './DynamicWorkflowNodeTimeline';

export type TimelineSeverity = 'ok' | 'attention' | 'failed' | 'neutral';

export interface TimelineFeedItem extends ComposerFeedItem {
  label?: string;
  phaseId?: string | null;
  nodeLabel?: string;
  attempt?: number;
  details?: string[];
  severity?: TimelineSeverity;
}

const HUMAN_LABELS: Record<string, string> = {
  'run-started': 'run iniciado',
  'run-paused': 'run pausado',
  'run-aborted': 'run abortado',
  'run-failed': 'run falhou',
  'run-delivered': 'entrega pronta',
  'run-finished': 'run encerrado',
  'run-blocked-provider': 'bloqueado pelo provedor',
  'resume-requested': 'retomada pedida',
  'pause-requested': 'pausa pedida',
  'phase-changed': 'nova fase',
  'node-started': 'node iniciou',
  'node-completed': 'node concluiu',
  'node-cache-hit': 'node reusado do cache',
  'node-failed': 'node falhou',
  'node-retry-scheduled': 'retry agendado',
  'node-stalled': 'node sem progresso',
  'gate-blocked': 'gate aberto',
  'gate-approved': 'gate aprovado',
  'gate-rejected': 'gate rejeitado',
  'gate-orphan-discarded': 'gate orfao descartado',
  'green-check': 'verificacao deterministica',
  'checkpoint-saved': 'checkpoint salvo',
  'coordinator-finished': 'coordenador terminou',
  'sandbox-killed': 'sandbox encerrado',
  'wake-planned': 'orquestrador acordado',
  'wake-completed': 'turno do orquestrador encerrado',
  'wake-runaway': 'runaway de wakes',
  'rerun-requested': 'rerun pedido',
  'question-pending': 'pergunta ao usuario',
  'intervention': 'intervencao',
};

export function humanEventLabel(type: string): string | null {
  return HUMAN_LABELS[type] ?? null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parsePayload(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return asRecord(JSON.parse(json));
  } catch {
    return null;
  }
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}c`;
  return `$${usd.toFixed(3)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return sec > 0 ? `${min}m${String(sec).padStart(2, '0')}s` : `${min}m`;
}

function excerpt(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

export function eventSeverity(type: string, payload: Record<string, unknown> | null): TimelineSeverity {
  switch (type) {
    case 'node-failed':
    case 'run-failed':
    case 'run-blocked-provider':
    case 'node-stalled':
    case 'sandbox-killed':
    case 'gate-rejected':
    case 'wake-runaway':
    case 'run-aborted':
      return 'failed';
    case 'gate-blocked': {
      const sem = str(payload?.semaphore);
      if (sem) return sem === 'VERDE' ? 'ok' : 'attention';
      return 'failed';
    }
    case 'green-check':
      if (payload?.inconclusive === true) return 'attention';
      return payload?.ok === true ? 'ok' : 'attention';
    case 'node-retry-scheduled':
    case 'wake-planned':
    case 'rerun-requested':
    case 'question-pending':
      return 'attention';
    case 'node-completed':
    case 'node-cache-hit': {
      const p1 = num(payload?.p1Count);
      return p1 !== null && p1 > 0 ? 'attention' : 'ok';
    }
    case 'gate-approved':
    case 'run-delivered':
    case 'run-finished':
    case 'coordinator-finished':
    case 'checkpoint-saved':
      return 'ok';
    default:
      return 'neutral';
  }
}

export function describeEventPayload(type: string, payload: Record<string, unknown> | null): string[] {
  if (!payload) return [];
  const out: string[] = [];
  const phase = str(payload.phase);
  if (type === 'phase-changed' && phase) out.push(phase);
  const gateId = str(payload.gateId);
  if (gateId) out.push(gateId);
  const semaphore = str(payload.semaphore);
  if (semaphore) out.push(`SEMAFORO: ${semaphore}`);
  if (type === 'green-check') {
    if (payload.inconclusive === true) out.push('inconclusivo');
    else if (payload.ok === true) out.push('verde');
    else {
      const red = num(payload.redCount);
      out.push(red !== null ? `vermelho (${red} check${red === 1 ? '' : 's'})` : 'vermelho');
    }
  }
  const failureClass = str(payload.failureClass);
  if (failureClass) out.push(`classe ${failureClass}`);
  const duration = num(payload.durationMs);
  if (duration !== null && duration > 0) out.push(formatDuration(duration));
  const cost = num(payload.costUsd);
  if (cost !== null && cost > 0) out.push(formatCost(cost));
  const backoff = num(payload.backoffMs);
  if (backoff !== null && backoff > 0) out.push(`backoff ${formatDuration(backoff)}`);
  const verdict = asRecord(payload.validatorVerdict);
  if (verdict) {
    const v = str(verdict.verdict);
    const p1 = num(payload.p1Count);
    if (v) out.push(p1 !== null ? `${v}, ${p1} P1` : v);
  }
  const touchedTotal = num(payload.touchedFilesTotal);
  if (touchedTotal !== null && touchedTotal > 0) {
    out.push(`${touchedTotal} arquivo${touchedTotal === 1 ? '' : 's'}`);
  }
  const sha = str(payload.worktreeCommitSha);
  if (sha) out.push(sha.slice(0, 8));
  const reason = str(payload.reason);
  if (reason && type.startsWith('wake-')) out.push(reason);
  const error =
    str(payload.error) ??
    str(payload.nodeError) ??
    str(payload.errorMessage) ??
    (asRecord(payload.nodeError) ? str(asRecord(payload.nodeError)!.message) : null);
  if (error) out.push(excerpt(error));
  const digest = str(payload.outputDigest);
  if (digest) out.push(excerpt(digest, 160));
  return out;
}

export function timelineItemFromEvent(
  ev: DynamicWorkflowEvent,
  nameOf: (nodeId: string) => string | null = () => null,
): TimelineFeedItem {
  const payload = parsePayload(ev.payloadJson);
  const nodeId = ev.nodeId ?? str(payload?.nodeId) ?? null;
  const attempt = num(payload?.attempt);
  const phaseId = ev.phaseId ?? (ev.type === 'phase-changed' ? str(payload?.phase) : null);
  const payloadLabel = str(payload?.label);
  const payloadAgent = str(payload?.agentId);
  const nodeLabel = nodeId ? (payloadLabel ?? nameOf(nodeId) ?? payloadAgent ?? shortNodeId(nodeId)) : undefined;
  return {
    id: `ev-${ev.id}`,
    kind: 'event',
    text: ev.type,
    nodeId,
    at: ev.createdAt,
    label: humanEventLabel(ev.type) ?? undefined,
    phaseId,
    nodeLabel,
    attempt: attempt ?? undefined,
    details: describeEventPayload(ev.type, payload),
    severity: eventSeverity(ev.type, payload),
  };
}

export function buildTimelineFeed(
  events: DynamicWorkflowEvent[],
  nodeRuns: CockpitNodeRun[],
  limit = 200,
): TimelineFeedItem[] {
  const names = new Map<string, string>();
  for (const nr of nodeRuns) {
    const name = nodeDisplayName(nr);
    if (name !== shortNodeId(nr.nodeId) || !names.has(nr.nodeId)) names.set(nr.nodeId, name);
  }
  return events.slice(-limit).map((ev) => timelineItemFromEvent(ev, (id) => names.get(id) ?? null));
}

export interface WorkflowEventTimelineProps {
  feed: TimelineFeedItem[];
  timeZone?: string;
}

function SeverityIcon({ item }: { item: TimelineFeedItem }) {
  if (item.kind === 'human') return <CornerDownLeft size={11} className="text-amber-400" />;
  switch (item.severity) {
    case 'failed':
      return <X size={11} strokeWidth={3} className="text-red-400" />;
    case 'attention':
      return <TriangleAlert size={11} className="text-amber-400" />;
    case 'ok':
      return <Check size={11} strokeWidth={3} className="text-green-400" />;
    default:
      return <Clock size={11} className="text-zinc-500" />;
  }
}

function rowTone(item: TimelineFeedItem): string {
  if (item.kind === 'human') return 'text-amber-200';
  switch (item.severity) {
    case 'failed':
      return 'text-red-200';
    case 'attention':
      return 'text-amber-100';
    default:
      return 'text-zinc-300';
  }
}

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'phase'; key: string; label: string }
  | { kind: 'item'; key: string; item: TimelineFeedItem; time: string };

export function layoutTimelineRows(feed: TimelineFeedItem[], timeZone?: string): Row[] {
  const rows: Row[] = [];
  let lastDay: string | null = null;
  let lastPhase: string | null = null;
  const opts = timeZone ? { timeZone } : undefined;
  for (const item of feed) {
    const date = parseSqliteUtc(item.at);
    if (date) {
      const day = dayLabel(date, opts);
      if (day !== lastDay) {
        rows.push({ kind: 'day', key: `day-${day}-${item.id}`, label: day });
        lastDay = day;
      }
    }
    const phase = item.phaseId ?? null;
    if (phase && phase !== lastPhase) {
      rows.push({ kind: 'phase', key: `phase-${phase}-${item.id}`, label: phase });
      lastPhase = phase;
    }
    rows.push({ kind: 'item', key: item.id, item, time: date ? formatLocalTime(date, opts) : '' });
  }
  return rows;
}

export function WorkflowEventTimeline({ feed, timeZone }: WorkflowEventTimelineProps) {
  const feedEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ block: 'end' });
  }, [feed.length]);

  const rows = layoutTimelineRows(feed, timeZone);

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-zinc-800 bg-zinc-950/40" data-testid="event-timeline">
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 shrink-0">
        <ListEnd size={11} className="text-zinc-500 shrink-0" />
        <span className="text-[10px] uppercase tracking-wide text-zinc-500 font-medium">Linha do tempo</span>
        <span className="font-mono text-[10px] text-zinc-500">{feed.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 flex flex-col gap-1" data-testid="timeline-feed">
        {feed.length === 0 ? (
          <p className="text-[12px] text-zinc-400" data-testid="timeline-empty">
            Eventos e intervencoes do run aparecem aqui.
          </p>
        ) : (
          rows.map((row) => {
            if (row.kind === 'day') {
              return (
                <div
                  key={row.key}
                  className="mt-1 flex items-center gap-2 text-[11px] text-zinc-400"
                  data-testid="timeline-day"
                >
                  <span className="h-px flex-1 bg-zinc-800" />
                  <span className="font-mono">{row.label}</span>
                  <span className="h-px flex-1 bg-zinc-800" />
                </div>
              );
            }
            if (row.kind === 'phase') {
              return (
                <div
                  key={row.key}
                  className="mt-1 text-[11px] uppercase tracking-wider text-zinc-400 font-medium"
                  data-testid="timeline-phase"
                  title={row.label}
                >
                  {row.label}
                </div>
              );
            }
            const { item } = row;
            return (
              <div
                key={row.key}
                className={`flex items-start gap-2 text-[11px] ${rowTone(item)}`}
                data-testid="timeline-item"
                data-severity={item.kind === 'human' ? 'human' : (item.severity ?? 'neutral')}
              >
                <span className="mt-0.5 shrink-0">
                  <SeverityIcon item={item} />
                </span>
                <span className="min-w-0 flex-1 break-words">
                  {item.kind === 'human' ? (
                    <span>{item.text}</span>
                  ) : (
                    <>
                      {/* Tipo CRU visivel (mono) + label humano ao lado. */}
                      <span className="font-mono text-[11px] text-zinc-500">{item.text}</span>
                      {item.label && <span className="ml-1.5 text-zinc-300">{item.label}</span>}
                    </>
                  )}
                  {item.nodeId && (
                    <span
                      className="ml-1 font-mono text-[11px] text-zinc-500"
                      title={item.nodeId}
                      data-testid="timeline-node"
                    >
                      [{item.nodeLabel ?? item.nodeId}
                      {typeof item.attempt === 'number' ? ` #${item.attempt}` : ''}]
                    </span>
                  )}
                  {item.details && item.details.length > 0 && (
                    <span className="block text-[11px] text-zinc-400">{item.details.join(' · ')}</span>
                  )}
                </span>
                {row.time && (
                  <span
                    className="ml-auto shrink-0 font-mono text-[11px] text-zinc-500"
                    title={item.at}
                    data-testid="timeline-time"
                  >
                    {row.time}
                  </span>
                )}
              </div>
            );
          })
        )}
        <div ref={feedEndRef} />
      </div>
    </div>
  );
}

import { createHash } from 'node:crypto';
import type { DynamicWorkflowEvent, OutcomeDigest, OutcomeVerdict } from '../../../src/types/dynamic-workflow';
import { isBoundaryGateId, isFailureGateId, failureGateId, CC_DELIVERY_GATE_ID } from './types';
import { toLocalShort } from './local-time';

export type { OutcomeDigest, OutcomeVerdict };

export const CODE_WRITER_AGENT_IDS: ReadonlySet<string> = new Set<string>([
  'dynamic-workflow-coder',
  'dynamic-workflow-coder-codex',
  'dynamic-workflow-coder-glm',
  'dynamic-workflow-fixer',
]);

const DOC_FILE_EXTENSIONS = new Set(['.md', '.txt', '.json']);

export function isCodeFilePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('docs/') || normalized.includes('/docs/')) return false;
  const dot = normalized.lastIndexOf('.');
  const ext = dot >= 0 ? normalized.slice(dot).toLowerCase() : '';
  return !DOC_FILE_EXTENSIONS.has(ext);
}

export function isCodeWriterPayload(payload: Record<string, unknown>): boolean {
  if (payload.access !== 'workspace-write') return false;
  const agentId = str(payload.agentId);
  if (agentId && CODE_WRITER_AGENT_IDS.has(agentId)) return true;
  const touched = payload.touchedFiles;
  if (Array.isArray(touched)) {
    return touched.some((f) => typeof f === 'string' && isCodeFilePath(f));
  }
  return false;
}

export type WakeReason = 'needs-decision' | 'blocked' | 'needs-human' | 'boundary';

const WAKE_REASON_RANK: Record<WakeReason, number> = {
  boundary: 0,
  'needs-decision': 1,
  blocked: 2,
  'needs-human': 3,
};

export function worstWakeReason(a: WakeReason, b: WakeReason): WakeReason {
  return WAKE_REASON_RANK[a] >= WAKE_REASON_RANK[b] ? a : b;
}

export type BoundarySemaphore = 'VERDE' | 'ATENCAO' | 'SEM VEREDITO' | 'DECISAO NECESSARIA' | 'DECISAO HUMANA';

export interface SinceStats {
  nodes: number;
  green: number;
  attention: number;
  pending: number;
  failed: number;
  costUsd: number;
  durationMs: number;
}

export interface OutcomeFinding {
  severity: string;
  where: string;
  problem: string;
}

export interface RefuterVerdictEcho {
  where: string;
  problem: string;
  verdict: 'real' | 'false' | 'fixed' | 'still-real';
}

export type FindingLedgerStatus = 'open' | 'open-real' | 'refuted' | 'fixed' | 'advisory';

export interface FindingLedgerEntry {
  key: string;
  severity: string;
  status: FindingLedgerStatus;
  where: string;
  problem: string;
}

function parsePayload(event: DynamicWorkflowEvent): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.payloadJson || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function findingKey(where: string, problem: string): string {
  return createHash('sha256').update(`${where}|${problem}`).digest('hex').slice(0, 8);
}

export function extractValidatorFindings(
  value: unknown,
  cap = 30,
): { findings: OutcomeFinding[]; total: number; p1: number; p2: number; p3: number } | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.verdict !== 'string' || !Array.isArray(obj.findings)) return null;
  const all: OutcomeFinding[] = [];
  let p1 = 0;
  let p2 = 0;
  let p3 = 0;
  for (const raw of obj.findings as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    const severity = str(f.severity) ?? '?';
    if (severity === 'P1') p1 += 1;
    else if (severity === 'P2') p2 += 1;
    else if (severity === 'P3') p3 += 1;
    all.push({
      severity,
      where: str(f.where) ?? '',
      problem: str(f.problem) ?? '',
    });
  }
  return { findings: all.slice(0, cap), total: all.length, p1, p2, p3 };
}

export function extractRefuterVerdicts(value: unknown, cap = 30): RefuterVerdictEcho[] | null {
  if (!value || typeof value !== 'object') return null;
  let items: unknown[];
  if (Array.isArray(value)) {
    items = value;
  } else {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.refutations)) items = obj.refutations as unknown[];
    else if (typeof obj.verdict === 'string' && typeof obj.where === 'string') items = [obj];
    else return null;
  }
  const out: RefuterVerdictEcho[] = [];
  let sawVerdict = false;
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const verdictRaw = str(r.verdict);
    if (!verdictRaw) continue;
    sawVerdict = true;
    const where = str(r.where);
    const problem = str(r.problem);
    if (!where || !problem) continue;
    const verdict = normalizeRefuterVerdict(verdictRaw);
    if (!verdict) continue;
    out.push({ where, problem, verdict });
    if (out.length >= cap) break;
  }
  return sawVerdict ? out : null;
}

function normalizeRefuterVerdict(v: string): RefuterVerdictEcho['verdict'] | null {
  switch (v) {
    case 'real':
    case 'fixed':
    case 'still-real':
      return v;
    case 'false':
    case 'ruido':
      return 'false';
    default:
      return null;
  }
}

export function summarizeParsedOutput(parsed: unknown): string {
  const cap = 200;
  const clip = (s: string): string => (s.length > cap ? `${s.slice(0, cap - 3)}...` : s);
  const tail = (s: string): string => {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > 160 ? `...${flat.slice(-157)}` : flat;
  };
  if (parsed === null || parsed === undefined) return '';
  if (typeof parsed === 'string') return clip(tail(parsed));
  if (typeof parsed !== 'object') return clip(String(parsed));

  const validator = extractValidatorFindings(parsed);
  if (validator) {
    const verdict = str((parsed as Record<string, unknown>).verdict) ?? '?';
    return clip(
      `verdict=${verdict} findings=${validator.total} P1=${validator.p1} P2=${validator.p2} P3=${validator.p3}`,
    );
  }
  const refuter = extractRefuterVerdicts(parsed);
  if (refuter) {
    const counts = new Map<string, number>();
    for (const r of refuter) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
    const parts = [...counts.entries()].map(([k, v]) => `${k}=${v}`);
    return clip(`refutations=${refuter.length} ${parts.join(' ')}`.trim());
  }
  if (Array.isArray(parsed)) return clip(`array[${parsed.length}]`);
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === 'output' && typeof obj.output === 'string') {
    return clip(tail(obj.output));
  }
  return clip(`{${keys.join(', ')}}`);
}

const OUTCOME_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'node-completed',
  'node-cache-hit',
  'node-retry-scheduled',
  'node-failed',
  'green-check',
  'run-blocked-provider',
  'node-stalled',
  'sandbox-killed',
  'run-failed',
  'gate-blocked',
  'wake-runaway',
]);

export const BOUNDARY_EVENT_TYPES: ReadonlySet<string> = new Set<string>(['phase-changed', 'coordinator-finished']);

export interface WakeSignal {
  reason: WakeReason;
  gateId?: string;
  nodeId?: string;
}

export function deriveWakeSignal(event: DynamicWorkflowEvent): WakeSignal | null {
  if (BOUNDARY_EVENT_TYPES.has(event.type)) return { reason: 'boundary' };
  const outcome = deriveOutcome(event);
  if (!outcome) return null;
  switch (outcome.verdict) {
    case 'needs-decision':
      return { reason: 'needs-decision', ...(outcome.nodeId ? { nodeId: outcome.nodeId } : {}) };
    case 'blocked':
      return outcome.wakes && outcome.gateId ? { reason: 'blocked', gateId: outcome.gateId } : null;
    case 'needs-human':
      return { reason: 'needs-human' };
    default:
      return null;
  }
}

export function deriveOutcome(event: DynamicWorkflowEvent): OutcomeDigest | null {
  if (!OUTCOME_EVENT_TYPES.has(event.type)) return null;
  const payload = parsePayload(event);
  const atLocal = toLocalShort(event.createdAt);
  const base: OutcomeDigest = {
    seq: event.seq,
    type: event.type,
    at: event.createdAt,
    ...(atLocal ? { atLocal } : {}),
    nodeId: event.nodeId ?? undefined,
    phaseId: event.phaseId ?? undefined,
    agentId: str(payload.agentId),
    label: str(payload.label),
    attempt: num(payload.attempt),
    verdict: 'green',
    wakes: false,
    durationMs: num(payload.durationMs),
    costUsd: num(payload.costUsd),
    failureClass: str(payload.failureClass),
    errorExcerpt: excerpt(str(payload.error) ?? str(payload.nodeError) ?? str(payload.message)),
    outputDigest: str(payload.outputDigest),
  };
  switch (event.type) {
    case 'node-completed':
    case 'node-cache-hit': {
      const p1 = num(payload.p1Count) ?? countP1(payload.findings);
      base.verdict = p1 > 0 ? 'attention' : 'green';
      if (p1 > 0) base.p1Count = p1;
      return base;
    }
    case 'node-retry-scheduled':
      base.verdict = 'pending';
      return base;
    case 'node-failed':
      base.verdict = 'attention';
      base.precursor = true;
      return base;
    case 'sandbox-killed':
      base.verdict = 'attention';
      base.precursor = true;
      base.errorExcerpt = excerpt(str(payload.reason));
      return base;
    case 'green-check': {
      const ok = payload.ok === true && payload.inconclusive !== true;
      base.verdict = ok ? 'green' : 'attention';
      if (!ok) {
        const red = Array.isArray(payload.redChecks)
          ? (payload.redChecks as Array<Record<string, unknown>>).map((c) => str(c.id) ?? '?').join(', ')
          : '';
        base.errorExcerpt = excerpt(
          payload.inconclusive === true ? 'green-check inconclusivo' : `green-check vermelho: ${red}`,
        );
      }
      return base;
    }
    case 'run-blocked-provider':
      if (str(payload.gateId)) {
        base.verdict = 'attention';
        base.precursor = true;
        base.gateId = str(payload.gateId);
        return base;
      }
      base.verdict = 'needs-decision';
      base.wakes = true;
      return base;
    case 'node-stalled':
      base.verdict = 'attention';
      base.precursor = true;
      return base;
    case 'run-failed':
      base.verdict = 'needs-decision';
      base.wakes = true;
      base.suggestion = 'resume';
      return base;
    case 'gate-blocked': {
      const gateId = str(payload.gateId);
      base.verdict = 'blocked';
      base.gateId = gateId;
      base.wakes = payload.mode === 'orchestrator' && !!gateId;
      return base;
    }
    case 'wake-runaway':
      base.verdict = 'needs-human';
      base.wakes = true;
      return base;
    default:
      return null;
  }
}

function countP1(findings: unknown): number {
  if (!Array.isArray(findings)) return 0;
  return findings.filter((f) => !!f && typeof f === 'object' && (f as Record<string, unknown>).severity === 'P1')
    .length;
}

function excerpt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

export function findWindowStartSeq(events: DynamicWorkflowEvent[]): number {
  let start = 0;
  let frozen: number | null = null;
  for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
    if (ev.type === 'wake-completed') {
      const p = parsePayload(ev);
      if (p.outcome === 'executed' && frozen === null && ev.seq > start) start = ev.seq;
    } else if (ev.type === 'gate-approved') {
      const gateId = str(parsePayload(ev).gateId);
      if (gateId && (isBoundaryGateId(gateId) || gateId === CC_DELIVERY_GATE_ID) && ev.seq > start) {
        start = ev.seq;
        frozen = null;
      }
    } else if (ev.type === 'gate-rejected') {
      const gateId = str(parsePayload(ev).gateId);
      if (gateId && isBoundaryGateId(gateId) && frozen === null) frozen = start;
    } else if (ev.type === 'resume-requested') {
      if (parsePayload(ev).acceptBoundary === true && ev.seq > start) {
        start = ev.seq;
        frozen = null;
      }
    }
  }
  return frozen ?? start;
}

export function eventsSince(events: DynamicWorkflowEvent[], afterSeq: number): DynamicWorkflowEvent[] {
  return events.filter((e) => e.seq > afterSeq).sort((a, b) => a.seq - b.seq);
}

export function deriveOutcomesSince(events: DynamicWorkflowEvent[], lastAckSeq: number): OutcomeDigest[] {
  const out: OutcomeDigest[] = [];
  for (const ev of eventsSince(events, lastAckSeq)) {
    const o = deriveOutcome(ev);
    if (o) out.push(o);
  }
  return out;
}

const NODE_OUTCOME_TYPES: ReadonlySet<string> = new Set<string>(['node-completed', 'node-cache-hit', 'node-failed']);

export function computeSinceStats(outcomes: OutcomeDigest[]): SinceStats {
  const stats: SinceStats = {
    nodes: 0,
    green: 0,
    attention: 0,
    pending: 0,
    failed: 0,
    costUsd: 0,
    durationMs: 0,
  };
  for (const o of outcomes) {
    if (NODE_OUTCOME_TYPES.has(o.type)) {
      stats.nodes += 1;
      stats.costUsd += o.costUsd ?? 0;
      stats.durationMs += o.durationMs ?? 0;
      if (o.type === 'node-failed') stats.failed += 1;
      else if (o.verdict === 'green') stats.green += 1;
      else if (o.verdict === 'attention') stats.attention += 1;
    } else if (o.type === 'node-retry-scheduled') {
      stats.pending += 1;
    } else if (o.type === 'green-check' && o.verdict === 'attention') {
      stats.attention += 1;
    }
  }
  stats.costUsd = Math.round(stats.costUsd * 10000) / 10000;
  return stats;
}

export function buildFindingLedger(windowEvents: DynamicWorkflowEvent[]): Map<string, FindingLedgerEntry> {
  const ledger = new Map<string, FindingLedgerEntry>();
  for (const ev of windowEvents) {
    if (ev.type !== 'node-completed' && ev.type !== 'node-cache-hit') continue;
    const payload = parsePayload(ev);
    if (Array.isArray(payload.findings)) {
      for (const raw of payload.findings as unknown[]) {
        if (!raw || typeof raw !== 'object') continue;
        const f = raw as Record<string, unknown>;
        const where = str(f.where) ?? '';
        const problem = str(f.problem) ?? '';
        const severity = str(f.severity) ?? '?';
        const key = findingKey(where, problem);
        const existing = ledger.get(key);
        if (severity !== 'P1') {
          if (!existing) ledger.set(key, { key, severity, status: 'advisory', where, problem });
          continue;
        }
        if (!existing || existing.status === 'advisory') {
          ledger.set(key, { key, severity, status: 'open', where, problem });
        }
      }
    }
    if (Array.isArray(payload.refuterVerdicts)) {
      for (const raw of payload.refuterVerdicts as unknown[]) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        const where = str(r.where);
        const problem = str(r.problem);
        const verdict = str(r.verdict);
        if (!where || !problem || !verdict) continue;
        const key = findingKey(where, problem);
        const existing = ledger.get(key);
        const severity = existing?.severity ?? 'P1';
        switch (verdict) {
          case 'false':
          case 'ruido':
            ledger.set(key, { key, severity, status: 'refuted', where, problem });
            break;
          case 'fixed':
            ledger.set(key, { key, severity, status: 'fixed', where, problem });
            break;
          case 'real':
          case 'still-real':
            if (!existing || existing.status === 'open' || existing.status === 'open-real') {
              ledger.set(key, { key, severity, status: 'open-real', where, problem });
            }
            break;
          default:
            break;
        }
      }
    }
  }
  return ledger;
}

export function openP1Findings(ledger: Map<string, FindingLedgerEntry>): FindingLedgerEntry[] {
  return [...ledger.values()].filter((e) => e.severity === 'P1' && (e.status === 'open' || e.status === 'open-real'));
}

const DECISION_RESOLVER_TYPES: ReadonlySet<string> = new Set<string>([
  'resume-requested',
  'run-started',
  'run-recovered-from-terminal',
]);

export interface BoundaryAssessment {
  semaphore: BoundarySemaphore;
  since: SinceStats;
  outcomes: OutcomeDigest[];
  openP1: FindingLedgerEntry[];
  pendingRetries: string[];
  unresolvedFailures: string[];
  unresolvedDecisions: OutcomeDigest[];
  writerCount: number;
  lastGreenCheckOk: boolean | null;
  reasons: string[];
}

export function assessBoundary(
  windowEvents: DynamicWorkflowEvent[],
  opts?: {
    history?: DynamicWorkflowEvent[];
  },
): BoundaryAssessment {
  void opts;
  const events = [...windowEvents].sort((a, b) => a.seq - b.seq).filter((e) => e.type !== 'node-cache-hit');
  const outcomes: OutcomeDigest[] = [];
  for (const ev of events) {
    const o = deriveOutcome(ev);
    if (o) outcomes.push(o);
  }
  const since = computeSinceStats(outcomes);
  const reasons: string[] = [];

  const humans = outcomes.filter((o) => o.verdict === 'needs-human');
  const unresolvedDecisions: OutcomeDigest[] = [];
  for (const o of outcomes) {
    if (o.verdict === 'needs-decision') {
      const resolved = events.some((e) => e.seq > o.seq && DECISION_RESOLVER_TYPES.has(e.type));
      if (!resolved) unresolvedDecisions.push(o);
    } else if (o.verdict === 'blocked' && o.gateId) {
      const gateId = o.gateId;
      const resolved = events.some((e) => {
        if (e.seq <= o.seq) return false;
        if (e.type !== 'gate-approved' && e.type !== 'gate-rejected' && e.type !== 'gate-decision-received') {
          return false;
        }
        return str(parsePayload(e).gateId) === gateId;
      });
      if (!resolved) unresolvedDecisions.push(o);
    }
  }

  const completedAfter = (nodeId: string, seq: number): boolean =>
    events.some(
      (e) => e.seq > seq && e.nodeId === nodeId && (e.type === 'node-completed' || e.type === 'node-cache-hit'),
    );
  const rescheduledAfter = (nodeId: string, seq: number): boolean =>
    events.some((e) => {
      if (e.seq <= seq) return false;
      if (e.type === 'resume-requested') return true;
      if (e.type === 'rerun-requested') {
        return e.nodeId === nodeId || str(parsePayload(e).nodeId) === nodeId;
      }
      if (e.type === 'gate-approved') return str(parsePayload(e).gateId) === failureGateId(nodeId);
      return false;
    });
  const pendingRetries: string[] = [];
  const unresolvedFailures: string[] = [];
  for (const o of outcomes) {
    if (!o.nodeId) continue;
    if (o.type === 'node-retry-scheduled' && !completedAfter(o.nodeId, o.seq)) {
      pendingRetries.push(o.nodeId);
    } else if (o.type === 'node-failed' && !completedAfter(o.nodeId, o.seq) && !rescheduledAfter(o.nodeId, o.seq)) {
      unresolvedFailures.push(o.nodeId);
    }
  }

  let writerCount = 0;
  let lastGreenCheckOk: boolean | null = null;
  for (const ev of events) {
    if (ev.type === 'node-completed') {
      if (isCodeWriterPayload(parsePayload(ev))) writerCount += 1;
    } else if (ev.type === 'green-check') {
      const p = parsePayload(ev);
      lastGreenCheckOk = p.ok === true && p.inconclusive !== true;
    }
  }

  const openP1 = openP1Findings(buildFindingLedger(events));

  let semaphore: BoundarySemaphore;
  if (humans.length > 0) {
    semaphore = 'DECISAO HUMANA';
    reasons.push('wake-runaway na janela');
  } else if (unresolvedDecisions.length > 0) {
    semaphore = 'DECISAO NECESSARIA';
    reasons.push(`${unresolvedDecisions.length} decisao(oes) pendente(s)`);
  } else {
    if (openP1.length > 0) reasons.push(`${openP1.length} P1 aberto(s) no ledger`);
    if (pendingRetries.length > 0) reasons.push(`retry pendente: ${pendingRetries.join(', ')}`);
    if (unresolvedFailures.length > 0) reasons.push(`node falhou sem conclusao: ${unresolvedFailures.join(', ')}`);
    if (lastGreenCheckOk === false) reasons.push('ultimo green-check vermelho/inconclusivo');
    if (reasons.length > 0) {
      semaphore = 'ATENCAO';
    } else if (writerCount > 0 && lastGreenCheckOk === null) {
      semaphore = 'SEM VEREDITO';
      reasons.push(`${writerCount} writer(s) sem green-check na janela`);
    } else {
      semaphore = 'VERDE';
    }
  }

  return {
    semaphore,
    since,
    outcomes,
    openP1,
    pendingRetries,
    unresolvedFailures,
    unresolvedDecisions,
    writerCount,
    lastGreenCheckOk,
    reasons,
  };
}

export function computeBoundarySemaphore(windowEvents: DynamicWorkflowEvent[]): BoundarySemaphore {
  return assessBoundary(windowEvents).semaphore;
}

export interface WakePromptInput {
  runId: string;
  reason: WakeReason;
  semaphore: BoundarySemaphore;
  since: SinceStats;
  outcomes: OutcomeDigest[];
  pendingDecision?: { type: string; id: string; prompt: string } | null;
  gateId?: string;
  detail?: string;
}

export const WAKE_PROMPT_MAX_OUTCOMES = 12;

const VERDICT_RANK: Record<OutcomeVerdict, number> = {
  'needs-human': 0,
  blocked: 1,
  'needs-decision': 2,
  attention: 3,
  pending: 4,
  green: 5,
};

export function selectOutcomesForPrompt(
  outcomes: OutcomeDigest[],
  cap = WAKE_PROMPT_MAX_OUTCOMES,
): { shown: OutcomeDigest[]; omitted: number } {
  const nonGreen = outcomes
    .filter((o) => o.verdict !== 'green')
    .sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || a.seq - b.seq);
  const greens = outcomes.filter((o) => o.verdict === 'green').sort((a, b) => b.seq - a.seq);
  const shown = [...nonGreen.slice(0, cap)];
  const room = cap - shown.length;
  if (room > 0) shown.push(...greens.slice(0, room).reverse());
  return { shown, omitted: Math.max(0, outcomes.length - shown.length) };
}

function formatOutcomeLine(o: OutcomeDigest): string {
  const who = o.label ?? o.agentId ?? o.nodeId ?? null;
  const parts = [`- ${o.atLocal ? `[${o.atLocal}] ` : ''}[${o.verdict}] ${o.type}`];
  if (who !== null && who !== o.type) parts.push(who);
  if (o.attempt !== undefined) parts.push(`#${o.attempt}`);
  if (o.phaseId) parts.push(`fase=${o.phaseId}`);
  if (o.durationMs !== undefined) parts.push(`${Math.round(o.durationMs / 1000)}s`);
  if (o.costUsd !== undefined) parts.push(`$${o.costUsd.toFixed(2)}`);
  if (o.failureClass) parts.push(`classe=${o.failureClass}`);
  if (o.gateId) parts.push(`gate=${o.gateId}`);
  if (o.p1Count) parts.push(`P1=${o.p1Count}`);
  let line = parts.join(' ');
  if (o.outputDigest) line += `\n    saida: ${o.outputDigest}`;
  if (o.errorExcerpt) line += `\n    erro: ${o.errorExcerpt}`;
  return line;
}

function reasonLine(input: WakePromptInput): string {
  switch (input.reason) {
    case 'blocked':
      return `parou num gate tecnico que VOCE conduz como driver (mode: orchestrator): \`${input.gateId ?? input.pendingDecision?.id ?? '?'}\`.`;
    case 'needs-decision':
      return 'teve um desfecho que exige DECISAO do driver (bloqueio de provedor, node travado ou run falho).';
    case 'needs-human':
      return `estourou o anti-runaway de wakes e foi PAUSADO pelo host${input.detail ? ` (${input.detail})` : ''}. Este turno e SOMENTE LEITURA.`;
    case 'boundary':
      return 'chegou a uma fronteira (fim de fase / fim do coordenador).';
  }
}

function actionsBlock(input: WakePromptInput): string[] {
  if (input.semaphore === 'VERDE') {
    return [`SEMAFORO: VERDE. Tudo convergiu na janela: responda 'ok, seguindo'. Nao chame tools.`];
  }
  const lines = [
    `SEMAFORO: ${input.semaphore}`,
    `ANTES de qualquer acao chame \`dynamic_workflow_inspect("${input.runId}")\` para ler o estado FRESCO do run (pendingDecision, since, lastOutcomes, ultimo green-check).`,
  ];
  if (input.semaphore === 'DECISAO HUMANA') {
    lines.push(
      'So `dynamic_workflow_inspect` esta disponivel neste turno. Resuma a situacao ao dono em ate 5 linhas e pare; o run fica pausado ate uma acao humana.',
    );
    return lines;
  }
  lines.push(
    'Depois decida: aprovar o gate pendente (`dynamic_workflow_approve`, decision approve = continuar; reject = pausar), `dynamic_workflow_intervene` (pause/resume/rerun-node {nodeId, instruction}/switch-agent/adjust-next-node), ou `dynamic_workflow_abort`.',
  );
  if (input.reason === 'blocked') {
    lines.push(
      `Aprove apenas o gate que for o \`pendingDecision\` corrente do run \`${input.runId}\`. Nao da push - a entrega e merge LOCAL e reversivel.`,
    );
  }
  const failureGate = input.gateId ?? input.pendingDecision?.id;
  if (input.reason === 'blocked' && failureGate && isFailureGateId(failureGate)) {
    lines.push(
      `GATE DE FALHA \`${failureGate}\`: o coordenador esta PARADO nesse node ate a sua decisao. Decida com ` +
        `\`dynamic_workflow_approve("${input.runId}", "${failureGate}", { decision: "approve", payload: { action } })\` onde action e: ` +
        `"retry" (nova attempt do MESMO node agora; opcional payload.instruction vira [AJUSTE DO ORQUESTRADOR]), ` +
        `"switch-agent" (+ payload.agentType; troca e retenta), ` +
        `"skip" (devolve null ao workflow.js e segue; o trabalho da attempt falha e descartado), ` +
        `"abort" (aborta o run). \`decision: "reject"\` equivale a abort.`,
    );
  }
  if (input.semaphore === 'SEM VEREDITO') {
    lines.push('Nunca aprove SEM VEREDITO sem antes reexecutar o verificador ou justificar em 1 frase.');
  }
  return lines;
}

export function buildWakePrompt(input: WakePromptInput): string {
  const lines: string[] = [];
  lines.push(`O workflow dinamico \`${input.runId}\` ${reasonLine(input)}`);
  lines.push('');
  const s = input.since;
  lines.push('DESDE O ULTIMO WAKE:');
  lines.push(
    `- ${s.nodes} node(s): ${s.green} verde(s), ${s.attention} com atencao, ${s.failed} falha(s), ${s.pending} retry pendente(s); custo $${s.costUsd.toFixed(2)}, tempo ${Math.round(s.durationMs / 1000)}s`,
  );
  const { shown, omitted } = selectOutcomesForPrompt(input.outcomes);
  for (const o of shown) lines.push(formatOutcomeLine(o));
  if (omitted > 0) lines.push(`- (+${omitted} desfecho(s) verde(s) omitido(s))`);
  if (input.pendingDecision) {
    lines.push('');
    lines.push(
      `DECISAO PENDENTE: ${input.pendingDecision.type} \`${input.pendingDecision.id}\` - ${input.pendingDecision.prompt}`,
    );
  }
  lines.push('');
  lines.push(...actionsBlock(input));
  return lines.join('\n');
}

export interface WakeRunawayCounters {
  wakesTotal: number;
  wakesSinceProgress: number;
}

export interface WakeRunawayLimits {
  maxWakesPerRun: number;
  maxWakesSemProgresso: number;
}

export const DEFAULT_WAKE_RUNAWAY_LIMITS: WakeRunawayLimits = {
  maxWakesPerRun: 120,
  maxWakesSemProgresso: 6,
};

export type WakeRunawayVerdict =
  { runaway: false } | { runaway: true; reason: 'max-wakes-per-run' | 'max-wakes-sem-progresso' };

export function checkWakeRunaway(
  counters: WakeRunawayCounters,
  limits: WakeRunawayLimits = DEFAULT_WAKE_RUNAWAY_LIMITS,
): WakeRunawayVerdict {
  if (counters.wakesTotal > limits.maxWakesPerRun) {
    return { runaway: true, reason: 'max-wakes-per-run' };
  }
  if (counters.wakesSinceProgress > limits.maxWakesSemProgresso) {
    return { runaway: true, reason: 'max-wakes-sem-progresso' };
  }
  return { runaway: false };
}

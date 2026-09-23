import type { OpenChatSession } from '../types';

export const MAX_DESKTOP_LANES = 2;

export const DEFAULT_CHAT_STALE_LANE_DAYS = 7;

export type LaneCompactionPhase = 'queued' | 'running';

export interface LaneCompactionInfo {
  phase: LaneCompactionPhase | null;
  modelLabel: string;
  source: 'lionclaw' | 'sdk';
}

export type LaneUiState = 'disponivel' | 'vazia' | 'ocupada' | 'em Clear' | 'drive ativo' | 'Clear interrompido';

export const LANE_UI_STATE_REASON: Record<Exclude<LaneUiState, 'disponivel'>, string> = {
  vazia: 'Lane vazia: nao ha o que salvar em memoria.',
  ocupada: 'Lane ocupada: espere o turno terminar ou pare-o.',
  'em Clear': 'Clear em andamento nesta lane.',
  'drive ativo': 'Drive de pipeline ativo: pare o drive antes.',
  'Clear interrompido': 'Clear interrompido: use "Refazer Clear".',
};

export function laneUiState(
  lane: Pick<OpenChatSession, 'state' | 'messageCount'>,
  compaction?: LaneCompactionInfo | null,
): LaneUiState {
  if (lane.state === 'interrupted') return 'Clear interrompido';
  if (lane.state === 'clearing' || (compaction && compaction.source === 'lionclaw')) return 'em Clear';
  if (lane.state === 'streaming' || lane.state === 'queued' || compaction) return 'ocupada';
  if (lane.state === 'drive') return 'drive ativo';
  if (lane.messageCount === 0) return 'vazia';
  return 'disponivel';
}

export const LANE_TITLE_MAX_CHARS = 40;

export function truncateLaneTitle(title: string): string {
  if (title.length <= LANE_TITLE_MAX_CHARS) return title;
  return `${title.slice(0, LANE_TITLE_MAX_CHARS)}...`;
}

export function laneLabel(lane: Pick<OpenChatSession, 'laneBadge' | 'title'>): string {
  const title = truncateLaneTitle(lane.title?.trim() || 'Nova conversa');
  return `Lane ${lane.laneBadge}: ${title}`;
}

export type NewChatAction =
  | { kind: 'create' }
  | { kind: 'select'; sessionId: string }
  | { kind: 'choose' }
  | { kind: 'disabled'; reason: string };

export function resolveNewChatAction(
  lanes: readonly OpenChatSession[],
  compactions: Readonly<Record<string, LaneCompactionInfo | undefined>>,
  maxLanes: number = MAX_DESKTOP_LANES,
): NewChatAction {
  if (lanes.length === 0) return { kind: 'create' };
  if (lanes.length < maxLanes) {
    const empty = lanes.find((lane) => laneUiState(lane, compactions[lane.id]) === 'vazia');
    if (empty) return { kind: 'select', sessionId: empty.id };
    return { kind: 'create' };
  }
  const available = lanes.some((lane) => laneUiState(lane, compactions[lane.id]) === 'disponivel');
  if (available) return { kind: 'choose' };
  return {
    kind: 'disabled',
    reason: 'Nenhuma lane disponivel para Clear: todas estao vazias, ocupadas, em Clear ou com drive ativo.',
  };
}

export function staleLaneDays(
  lane: Pick<OpenChatSession, 'lastUserMessageAt' | 'messageCount'>,
  thresholdDays: number,
  now: number = Date.now(),
): number | null {
  if (lane.messageCount === 0 || !lane.lastUserMessageAt) return null;
  const last = Date.parse(lane.lastUserMessageAt);
  if (Number.isNaN(last)) return null;
  const days = Math.floor((now - last) / 86_400_000);
  if (days < thresholdDays) return null;
  return days;
}

export function normalizeStaleLaneDays(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CHAT_STALE_LANE_DAYS;
  return Math.floor(n);
}

export function pickMostRecentLane(lanes: readonly OpenChatSession[]): OpenChatSession | null {
  let best: OpenChatSession | null = null;
  let bestTs = -Infinity;
  for (const lane of lanes) {
    const raw = lane.lastUserMessageAt ?? lane.createdAt;
    const ts = Date.parse(raw);
    const value = Number.isNaN(ts) ? -Infinity : ts;
    if (best === null || value > bestTs) {
      best = lane;
      bestTs = value;
    }
  }
  return best;
}

export const CHAT_LANE_ERROR_TITLES: Record<string, string> = {
  session_required: 'Sem lane selecionada',
  session_not_found: 'Conversa nao encontrada',
  session_not_active: 'Conversa encerrada',
  lane_required: 'Conversa aberta sem lane',
  lanes_full: 'Lanes ocupadas',
  provider_locked: 'Provider travado',
  invalid_selection: 'Selecao invalida',
  model_not_in_provider: 'Modelo fora do provider da lane',
  effort_not_supported: 'Effort nao suportado pelo modelo',
  turn_binding_required: 'Sem turno em voo',
  session_clearing: 'Lane em Clear',
  orchestrator_unconfigured: 'Orquestrador nao configurado',
  session_busy: 'Lane ocupada',
  drive_active: 'Drive ativo',
  empty_session: 'Lane vazia',
  turn_did_not_settle: 'Turno nao assentou',
  clear_cancelled: 'Clear cancelado',
  clear_not_queued: 'Clear nao esta na fila',
  lane_busy: 'Lane ja dirige um pipeline',
  drive_owned_by_other_lane: 'Pipeline dirigido por outra lane',
  drive_scope_violation: 'Pipeline fora desta lane',
  drive_uniqueness_violated: 'Drive duplicado na mesma lane',
  drive_turn_in_flight: 'Turno de drive em voo',
  'COMPACT-SUMMARY-FAILED': 'Clear recusado: sumarizador falhou',
  'COMPACT-MEMORY-FAILED': 'Clear recusado: memoria falhou',
  clear_failed: 'Clear falhou',
};

export function laneErrorTitle(code: string | undefined, fallback: string): string {
  if (!code) return fallback;
  return CHAT_LANE_ERROR_TITLES[code] ?? fallback;
}

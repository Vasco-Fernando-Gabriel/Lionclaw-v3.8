import type {
  ChatLaneErrorCode,
  LaneSessionState,
  OrchestratorProvider,
  OrchestratorRuntime,
  SessionOrchestrator,
} from '../../src/types';

export type { ChatLaneErrorCode, LaneSessionState, SessionOrchestrator };

export const MAX_DESKTOP_LANES = 2;

export const DRIVE_PARALLEL_TURNS_MAX = 2;

export const DRIVE_PARALLEL_TURNS_SETTING_KEY = 'drive_parallel_turns';

export const DYNAMIC_WORKFLOW_DRIVE_SESSION_ID_PREFIX = 'dw-drive-';

export class SessionRequiredError extends Error {
  readonly code = 'session_required' as const;

  constructor(laneName: string, source: string) {
    super(`Lane '${laneName}' exige options.sessionId explicito (guard de sessao, session_required; ${source})`);
    this.name = 'SessionRequiredError';
  }
}

export function isDynamicWorkflowDriveSessionId(sessionId: string): boolean {
  return sessionId.startsWith(DYNAMIC_WORKFLOW_DRIVE_SESSION_ID_PREFIX);
}

export const LANE_TITLE_MAX_CHARS = 40;

export interface LaneLabelSessionRow {
  laneBadge: number | null;
  title?: string | null;
}

export interface ResolveLaneLabelDeps {
  getOpenLaneSessionById: (sessionId: string) => LaneLabelSessionRow | null;
  getSession: (sessionId: string) => { id: string } | undefined;
}

export function truncateLaneTitle(title: string): string {
  if (title.length <= LANE_TITLE_MAX_CHARS) return title;
  return `${title.slice(0, LANE_TITLE_MAX_CHARS)}...`;
}

export function resolveLaneLabel(sessionId: string, deps: ResolveLaneLabelDeps): string {
  const lane = deps.getOpenLaneSessionById(sessionId);
  if (lane && lane.laneBadge !== null) {
    const title = truncateLaneTitle(lane.title?.trim() || 'Nova conversa');
    return `Lane ${lane.laneBadge}: "${title}"`;
  }
  if (lane) return 'conversa desconhecida';
  if (deps.getSession(sessionId)) return 'uma conversa encerrada';
  return 'conversa desconhecida';
}

export function pickFreeLaneBadge(takenBadges: Iterable<number>, maxLanes: number = MAX_DESKTOP_LANES): number | null {
  const taken = new Set<number>();
  for (const badge of takenBadges) taken.add(badge);
  for (let badge = 1; badge <= maxLanes; badge++) {
    if (!taken.has(badge)) return badge;
  }
  return null;
}

export interface LaneMigrationCandidate {
  id: string;
  messageCount: number;
}

export interface LaneMigrationPlan {
  badges: Array<{ id: string; badge: number }>;
  archive: string[];
  openWithoutLane: string[];
}

export function planLaneMigration(
  candidatesMostRecentFirst: readonly LaneMigrationCandidate[],
  maxLanes: number = MAX_DESKTOP_LANES,
): LaneMigrationPlan {
  const plan: LaneMigrationPlan = { badges: [], archive: [], openWithoutLane: [] };
  candidatesMostRecentFirst.forEach((candidate, index) => {
    if (index < maxLanes) {
      plan.badges.push({ id: candidate.id, badge: index + 1 });
      return;
    }
    if (candidate.messageCount === 0) {
      plan.archive.push(candidate.id);
      return;
    }
    plan.openWithoutLane.push(candidate.id);
  });
  return plan;
}

export function effortSettingKeyForRuntime(runtime: OrchestratorRuntime): string | null {
  switch (runtime) {
    case 'claude-sdk':
      return 'orchestrator_effort';
    case 'codex-sdk':
      return 'orchestrator_codex_effort';
    case 'kimi-sdk':
      return 'orchestrator_kimi_effort';
    case 'grok-sdk':
      return 'orchestrator_grok_effort';
    case 'claude-compat-sdk':
    case 'cursor-sdk':
    case 'lion-sdk':
      return null;
    default: {
      const _exhaustive: never = runtime;
      return _exhaustive;
    }
  }
}

export function buildDefaultOrchestratorColumns(
  readSetting: (key: string) => string | undefined,
): SessionOrchestrator | null {
  const runtime = (readSetting('orchestrator_runtime') || '').trim() as OrchestratorRuntime | '';
  const provider = (readSetting('orchestrator_provider') || '').trim() as OrchestratorProvider | '';
  const model = (readSetting('orchestrator_model') || '').trim();
  if (!runtime || !provider || !model) return null;
  const effortKey = effortSettingKeyForRuntime(runtime);
  const effort = effortKey ? (readSetting(effortKey) || '').trim() : '';
  return { runtime, provider, model, ...(effort ? { effort } : {}) };
}

export function pickMostRecentLane<T extends { lastUserMessageAt: string | null }>(lanes: readonly T[]): T | null {
  let best: T | null = null;
  for (const lane of lanes) {
    if (!best) {
      best = lane;
      continue;
    }
    if ((lane.lastUserMessageAt ?? '') > (best.lastUserMessageAt ?? '')) best = lane;
  }
  return best;
}

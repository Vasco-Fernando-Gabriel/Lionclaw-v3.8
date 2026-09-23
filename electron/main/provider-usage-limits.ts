import { execFile } from 'node:child_process';
import { access, open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from './logger';
import { getSetting } from './db';
import { getSecret } from './secrets-vault';
import { resolveKimiHome } from './agent-runtime/kimi-availability';
import type { ProviderUsageLimits, ProviderUsageWindow, UsageLimitsResponse } from '../../src/types';

const logger = createLogger('provider-usage-limits');
const execFileAsync = promisify(execFile);

const USAGE_FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function windowLabel(minutes: number | null, fallback: string): string {
  if (minutes === null) return fallback;
  if (minutes === 10_080) return 'Semanal';
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hora' : `${hours} horas`;
  }
  return `${minutes} min`;
}

function epochToIso(value: unknown): string | null {
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const ms = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function newestCodexSession(root: string): Promise<string | null> {
  let newest: { path: string; mtime: number } | null = null;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const info = await stat(full);
          if (!newest || info.mtimeMs > newest.mtime) {
            newest = { path: full, mtime: info.mtimeMs };
          }
        } catch {}
      }
    }
  };
  await walk(root, 0);
  return newest ? (newest as { path: string }).path : null;
}

interface CodexRateLimitWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

export function codexWindow(
  id: string,
  fallbackLabel: string,
  raw: CodexRateLimitWindow | undefined,
): ProviderUsageWindow | null {
  if (!raw || typeof raw.used_percent !== 'number') return null;
  const minutes = typeof raw.window_minutes === 'number' ? raw.window_minutes : null;
  return {
    id,
    label: windowLabel(minutes, fallbackLabel),
    usedPercent: clampPercent(raw.used_percent),
    resetsAt: epochToIso(raw.resets_at),
  };
}

const CODEX_TAIL_BYTES = 8 * 1024 * 1024;

async function readFileTail(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    if (length <= 0) return '';
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function codexLimits(options?: {
  sessionsRoot?: string;
  tailBytes?: number;
}): Promise<ProviderUsageLimits> {
  const sessionsRoot = options?.sessionsRoot ?? join(homedir(), '.codex', 'sessions');
  const file = await newestCodexSession(sessionsRoot);
  if (!file) {
    return {
      provider: 'codex',
      status: 'unavailable',
      reason: 'Nenhuma sessao do Codex encontrada — rode o Codex uma vez.',
      windows: [],
    };
  }
  const content = await readFileTail(file, options?.tailBytes ?? CODEX_TAIL_BYTES);
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.includes('"rate_limits"')) continue;
    try {
      const parsed = JSON.parse(line) as {
        payload?: { rate_limits?: Record<string, unknown> };
      };
      const limits = parsed.payload?.rate_limits;
      if (!limits) continue;
      const windows = [
        codexWindow('primary', '5 horas', limits.primary as CodexRateLimitWindow),
        codexWindow('secondary', 'Semanal', limits.secondary as CodexRateLimitWindow),
      ].filter((w): w is ProviderUsageWindow => w !== null);
      if (windows.length === 0) continue;
      return {
        provider: 'codex',
        status: 'ok',
        planType: typeof limits.plan_type === 'string' ? limits.plan_type : null,
        windows,
      };
    } catch {}
  }
  return {
    provider: 'codex',
    status: 'unavailable',
    reason: 'Sessao do Codex sem snapshot de limites ainda.',
    windows: [],
  };
}

interface ClaudeOauthCreds {
  accessToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
}

async function readClaudeCreds(): Promise<ClaudeOauthCreds | null> {
  let raw: string | null = null;
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { windowsHide: true },
      );
      raw = stdout.trim();
    } catch {
      raw = null;
    }
  }
  if (!raw) {
    try {
      raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8');
    } catch {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: ClaudeOauthCreds };
    return parsed.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

function claudeWindowLabel(id: string): string {
  if (id === 'five_hour') return '5 horas';
  if (id === 'seven_day') return 'Semanal';
  if (id.startsWith('seven_day_')) {
    const suffix = id.slice('seven_day_'.length);
    return `${suffix.charAt(0).toUpperCase()}${suffix.slice(1)} semanal`;
  }
  return id.replace(/_/g, ' ');
}

async function claudeLimits(creds: ClaudeOauthCreds): Promise<ProviderUsageLimits> {
  if (typeof creds.expiresAt === 'number' && creds.expiresAt < Date.now()) {
    return {
      provider: 'claude',
      status: 'unavailable',
      reason: 'Token do Claude expirado — rode um turno com o Claude para renova-lo.',
      planType: creds.subscriptionType ?? null,
      windows: [],
    };
  }
  try {
    const response = await fetchWithTimeout('https://api.anthropic.com/api/oauth/usage', {
      Authorization: `Bearer ${creds.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    });
    if (!response.ok) {
      return {
        provider: 'claude',
        status: 'unavailable',
        reason: `Consulta de uso do Claude falhou (HTTP ${response.status}).`,
        planType: creds.subscriptionType ?? null,
        windows: [],
      };
    }
    const data = (await response.json()) as Record<string, unknown>;
    const windows: ProviderUsageWindow[] = [];

    if (Array.isArray(data.limits)) {
      for (const entry of data.limits) {
        if (entry === null || typeof entry !== 'object') continue;
        const record = entry as {
          kind?: unknown;
          percent?: unknown;
          resets_at?: unknown;
          scope?: { model?: { display_name?: unknown } } | null;
        };
        if (typeof record.percent !== 'number') continue;
        const kind = typeof record.kind === 'string' ? record.kind : 'limite';
        const scopeName =
          typeof record.scope?.model?.display_name === 'string' ? record.scope.model.display_name : null;
        const label =
          kind === 'session'
            ? '5 horas'
            : kind === 'weekly_all'
              ? 'Semanal'
              : scopeName
                ? `${scopeName} semanal`
                : kind.replace(/_/g, ' ');
        windows.push({
          id: scopeName ? `${kind}:${scopeName}` : kind,
          label,
          usedPercent: clampPercent(record.percent),
          resetsAt: typeof record.resets_at === 'string' ? record.resets_at : epochToIso(record.resets_at),
        });
      }
    }

    if (windows.length === 0) {
      for (const [key, value] of Object.entries(data)) {
        if (value === null || typeof value !== 'object') continue;
        const record = value as { utilization?: unknown; resets_at?: unknown };
        if (typeof record.utilization !== 'number') continue;
        windows.push({
          id: key,
          label: claudeWindowLabel(key),
          usedPercent: clampPercent(record.utilization),
          resetsAt: typeof record.resets_at === 'string' ? record.resets_at : epochToIso(record.resets_at),
        });
      }
    }
    if (windows.length === 0) {
      return {
        provider: 'claude',
        status: 'unavailable',
        reason: 'Resposta de uso do Claude sem janelas reconheciveis.',
        planType: creds.subscriptionType ?? null,
        windows: [],
      };
    }
    return {
      provider: 'claude',
      status: 'ok',
      planType: creds.subscriptionType ?? null,
      windows,
    };
  } catch (error) {
    return {
      provider: 'claude',
      status: 'unavailable',
      reason:
        error instanceof Error && error.name === 'AbortError'
          ? 'Consulta de uso do Claude excedeu o tempo limite.'
          : 'Nao foi possivel consultar o uso do Claude.',
      planType: creds.subscriptionType ?? null,
      windows: [],
    };
  }
}

interface GlmLimitEntry {
  type?: unknown;
  unit?: unknown;
  number?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
}

export function glmWindow(entry: GlmLimitEntry): ProviderUsageWindow | null {
  if (entry.type !== 'TOKENS_LIMIT' || typeof entry.percentage !== 'number') {
    return null;
  }
  const isFiveHour = entry.unit === 3 && entry.number === 5;
  const isWeekly = entry.unit === 6 && entry.number === 1;
  if (!isFiveHour && !isWeekly) return null;
  return {
    id: isFiveHour ? 'five_hour' : 'seven_day',
    label: isFiveHour ? '5 horas' : 'Semanal',
    usedPercent: clampPercent(entry.percentage),
    resetsAt: epochToIso(entry.nextResetTime),
  };
}

async function glmLimits(apiKey: string): Promise<ProviderUsageLimits> {
  try {
    const response = await fetchWithTimeout('https://api.z.ai/api/monitor/usage/quota/limit', {
      Authorization: apiKey,
      'Accept-Language': 'en-US,en',
      'Content-Type': 'application/json',
    });
    if (!response.ok) {
      return {
        provider: 'glm',
        status: 'unavailable',
        reason: `Consulta de uso do GLM falhou (HTTP ${response.status}).`,
        windows: [],
      };
    }
    const json = (await response.json()) as Record<string, unknown>;
    if (json.success === false) {
      return {
        provider: 'glm',
        status: 'unavailable',
        reason: `Consulta de uso do GLM recusada (${String(json.msg ?? json.code ?? 'erro')}).`,
        windows: [],
      };
    }
    const payload = json.data !== null && typeof json.data === 'object' ? (json.data as Record<string, unknown>) : json;
    const entries = Array.isArray(payload.limits) ? (payload.limits as GlmLimitEntry[]) : [];
    const windows = entries.map(glmWindow).filter((w): w is ProviderUsageWindow => w !== null);
    if (windows.length === 0) {
      return {
        provider: 'glm',
        status: 'unavailable',
        reason: 'Resposta de uso do GLM sem janelas reconheciveis.',
        windows: [],
      };
    }
    return { provider: 'glm', status: 'ok', windows };
  } catch (error) {
    return {
      provider: 'glm',
      status: 'unavailable',
      reason:
        error instanceof Error && error.name === 'AbortError'
          ? 'Consulta de uso do GLM excedeu o tempo limite.'
          : 'Nao foi possivel consultar o uso do GLM.',
      windows: [],
    };
  }
}

interface MinimaxModelRemains {
  model_name?: unknown;
  current_interval_total_count?: unknown;
  current_weekly_total_count?: unknown;
  current_interval_remaining_percent?: unknown;
  current_weekly_remaining_percent?: unknown;
}

export function minimaxUsedPercent(
  entries: MinimaxModelRemains[],
  remainingKey: 'current_interval_remaining_percent' | 'current_weekly_remaining_percent',
  totalKey: 'current_interval_total_count' | 'current_weekly_total_count',
): number | null {
  const used = (entry: MinimaxModelRemains): number | null => {
    const remaining = entry[remainingKey];
    return typeof remaining === 'number' ? clampPercent(100 - remaining) : null;
  };
  const provisioned = entries.filter((entry) => {
    const total = entry[totalKey];
    return typeof total === 'number' && total > 0;
  });
  const pool = provisioned.length > 0 ? provisioned : entries;
  const values = pool.map(used).filter((v): v is number => v !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

async function minimaxLimits(apiKey: string): Promise<ProviderUsageLimits> {
  try {
    const response = await fetchWithTimeout('https://www.minimax.io/v1/token_plan/remains', {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    });
    if (!response.ok) {
      return {
        provider: 'minimax',
        status: 'unavailable',
        reason: `Consulta de uso do MiniMax falhou (HTTP ${response.status}).`,
        windows: [],
      };
    }
    const json = (await response.json()) as Record<string, unknown>;
    const baseResp = json.base_resp as { status_code?: unknown; status_msg?: unknown } | undefined;
    if (baseResp && typeof baseResp.status_code === 'number' && baseResp.status_code !== 0) {
      return {
        provider: 'minimax',
        status: 'unavailable',
        reason: `Consulta de uso do MiniMax recusada (${String(baseResp.status_msg ?? baseResp.status_code)}).`,
        windows: [],
      };
    }
    const payload = json.data !== null && typeof json.data === 'object' ? (json.data as Record<string, unknown>) : json;
    const entries = Array.isArray(payload.model_remains) ? (payload.model_remains as MinimaxModelRemains[]) : [];
    const windows: ProviderUsageWindow[] = [];
    const fiveHour = minimaxUsedPercent(entries, 'current_interval_remaining_percent', 'current_interval_total_count');
    if (fiveHour !== null) {
      windows.push({
        id: 'five_hour',
        label: '5 horas',
        usedPercent: fiveHour,
        resetsAt: null,
      });
    }
    const weekly = minimaxUsedPercent(entries, 'current_weekly_remaining_percent', 'current_weekly_total_count');
    if (weekly !== null) {
      windows.push({
        id: 'seven_day',
        label: 'Semanal',
        usedPercent: weekly,
        resetsAt: null,
      });
    }
    if (windows.length === 0) {
      return {
        provider: 'minimax',
        status: 'unavailable',
        reason: 'Resposta de uso do MiniMax sem janelas reconheciveis.',
        windows: [],
      };
    }
    return { provider: 'minimax', status: 'ok', windows };
  } catch (error) {
    return {
      provider: 'minimax',
      status: 'unavailable',
      reason:
        error instanceof Error && error.name === 'AbortError'
          ? 'Consulta de uso do MiniMax excedeu o tempo limite.'
          : 'Nao foi possivel consultar o uso do MiniMax.',
      windows: [],
    };
  }
}

interface KimiUsageDetail {
  limit?: unknown;
  used?: unknown;
  resetTime?: unknown;
}

function kimiCounter(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function kimiWindow(id: string, label: string, detail: KimiUsageDetail | null | undefined): ProviderUsageWindow | null {
  if (!detail) return null;
  const limit = kimiCounter(detail.limit);
  const used = kimiCounter(detail.used);
  if (limit === null || used === null || limit <= 0) return null;
  return {
    id,
    label,
    usedPercent: clampPercent(Math.round((used / limit) * 100)),
    resetsAt: typeof detail.resetTime === 'string' ? detail.resetTime : null,
  };
}

function kimiDurationLabel(duration: number, timeUnit: string): string {
  if (timeUnit === 'TIME_UNIT_MINUTE') {
    if (duration % 60 === 0) {
      const hours = duration / 60;
      return hours === 1 ? '1 hora' : `${hours} horas`;
    }
    return `${duration} min`;
  }
  return `${duration} ${timeUnit.replace('TIME_UNIT_', '').toLowerCase()}`;
}

export function parseKimiUsages(json: Record<string, unknown>): {
  windows: ProviderUsageWindow[];
  planType: string | null;
} {
  const windows: ProviderUsageWindow[] = [];
  const weekly = kimiWindow('subscription', 'Semanal', json.usage as KimiUsageDetail | null);
  if (weekly) windows.push(weekly);
  if (Array.isArray(json.limits)) {
    for (const entry of json.limits) {
      if (entry === null || typeof entry !== 'object') continue;
      const record = entry as {
        window?: { duration?: unknown; timeUnit?: unknown } | null;
        detail?: KimiUsageDetail | null;
      };
      const duration = typeof record.window?.duration === 'number' ? record.window.duration : null;
      const timeUnit = typeof record.window?.timeUnit === 'string' ? record.window.timeUnit : 'TIME_UNIT_MINUTE';
      if (duration === null) continue;
      const window = kimiWindow(`window_${duration}_${timeUnit}`, kimiDurationLabel(duration, timeUnit), record.detail);
      if (window) windows.push(window);
    }
  }
  const user = json.user as { membership?: { level?: unknown } | null } | null;
  const level = typeof user?.membership?.level === 'string' ? user.membership.level : null;
  const planType = level ? level.replace(/^LEVEL_/, '').toLowerCase() : null;
  return { windows, planType };
}

async function readKimiCreds(): Promise<{
  accessToken: string;
  expiresAtMs: number | null;
} | null> {
  try {
    const raw = await readFile(join(resolveKimiHome(), 'credentials', 'kimi-code.json'), 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
      return null;
    }
    return {
      accessToken: json.access_token,
      expiresAtMs: typeof json.expires_at === 'number' ? json.expires_at * 1000 : null,
    };
  } catch {
    return null;
  }
}

async function kimiLimits(): Promise<ProviderUsageLimits> {
  const creds = await readKimiCreds();
  if (!creds) {
    return {
      provider: 'kimi',
      status: 'unavailable',
      reason: 'Credenciais do Kimi ilegiveis — rode `kimi login` no terminal.',
      windows: [],
    };
  }
  if (creds.expiresAtMs !== null && creds.expiresAtMs < Date.now()) {
    return {
      provider: 'kimi',
      status: 'unavailable',
      reason: 'Token do Kimi expirado — rode um turno com o Kimi (ou use o CLI) para renova-lo.',
      windows: [],
    };
  }
  try {
    const response = await fetchWithTimeout('https://api.kimi.com/coding/v1/usages', {
      Authorization: `Bearer ${creds.accessToken}`,
    });
    if (!response.ok) {
      return {
        provider: 'kimi',
        status: 'unavailable',
        reason: `Consulta de uso do Kimi falhou (HTTP ${response.status}).`,
        windows: [],
      };
    }
    const json = (await response.json()) as Record<string, unknown>;
    const { windows, planType } = parseKimiUsages(json);
    if (windows.length === 0) {
      return {
        provider: 'kimi',
        status: 'unavailable',
        reason: 'Resposta de uso do Kimi sem janelas reconheciveis.',
        planType,
        windows: [],
      };
    }
    return { provider: 'kimi', status: 'ok', planType, windows };
  } catch {
    return {
      provider: 'kimi',
      status: 'unavailable',
      reason: 'Consulta de uso do Kimi nao respondeu (rede/timeout).',
      windows: [],
    };
  }
}

const LIMITS_CACHE_TTL_MS = 4 * 60_000;
const LIMITS_STALE_MAX_MS = 30 * 60_000;

let cachedResponse: { body: UsageLimitsResponse; at: number } | null = null;
const lastOkByProvider = new Map<ProviderUsageLimits['provider'], { data: ProviderUsageLimits; at: number }>();

export function withStaleFallback(result: ProviderUsageLimits, now: number): ProviderUsageLimits {
  if (result.status === 'ok') {
    lastOkByProvider.set(result.provider, { data: result, at: now });
    return result;
  }
  const lastOk = lastOkByProvider.get(result.provider);
  if (lastOk && now - lastOk.at <= LIMITS_STALE_MAX_MS) {
    return lastOk.data;
  }
  return result;
}

export function resetUsageLimitsCache(): void {
  cachedResponse = null;
  lastOkByProvider.clear();
}

async function codexConfigured(): Promise<boolean> {
  const root = join(homedir(), '.codex');
  return (await pathExists(join(root, 'auth.json'))) || (await pathExists(join(root, 'sessions')));
}

async function vaultKeyFromRef(settingKey: string): Promise<string> {
  try {
    const ref = getSetting(settingKey);
    if (!ref) return '';
    const key = await getSecret(ref);
    return key?.trim() ?? '';
  } catch {
    return '';
  }
}

function unexpectedFailure(provider: ProviderUsageLimits['provider'], name: string): () => ProviderUsageLimits {
  return () => ({
    provider,
    status: 'unavailable',
    reason: `Falha inesperada ao ler o uso do ${name}.`,
    windows: [],
  });
}

export async function getProviderUsageLimits(): Promise<UsageLimitsResponse> {
  const now = Date.now();
  if (cachedResponse && now - cachedResponse.at < LIMITS_CACHE_TTL_MS) {
    return cachedResponse.body;
  }
  const [claudeCreds, hasCodex, glmKey, minimaxKey, kimiCreds] = await Promise.all([
    readClaudeCreds().catch(() => null),
    codexConfigured(),
    vaultKeyFromRef('orchestrator_zai_api_key_ref'),
    vaultKeyFromRef('orchestrator_minimax_api_key_ref'),
    readKimiCreds().catch(() => null),
  ]);
  const tasks: Promise<ProviderUsageLimits>[] = [];
  if (claudeCreds?.accessToken) {
    tasks.push(claudeLimits(claudeCreds).catch(unexpectedFailure('claude', 'Claude')));
  }
  if (hasCodex) {
    tasks.push(codexLimits().catch(unexpectedFailure('codex', 'Codex')));
  }
  if (glmKey.length > 0) {
    tasks.push(glmLimits(glmKey).catch(unexpectedFailure('glm', 'GLM')));
  }
  if (minimaxKey.length > 0) {
    tasks.push(minimaxLimits(minimaxKey).catch(unexpectedFailure('minimax', 'MiniMax')));
  }
  if (kimiCreds) {
    tasks.push(kimiLimits().catch(unexpectedFailure('kimi', 'Kimi')));
  }
  const results = await Promise.all(tasks);
  const providers = results.map((result) => withStaleFallback(result, now));
  logger.debug(
    { providers: providers.map((p) => `${p.provider}:${p.status}`).join(' ') },
    'Limites de uso consultados',
  );
  const body: UsageLimitsResponse = { providers };
  cachedResponse = { body, at: now };
  return body;
}

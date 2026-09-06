
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createLogger } from '../logger';
import { resolveCodexBinary } from './binary';
import {
  CODEX_EFFORT_ORDER,
  staticEffortsFor,
  clampCodexEffortToSupported,
} from '../../../src/constants/codex-models';
import type { CodexChatReasoningEffort } from '../../../src/types';

const logger = createLogger('codex-model-capabilities');

export interface CodexModelCapability {
  id: string;
  displayName: string;
  description: string;
  supportedEfforts: readonly CodexChatReasoningEffort[];
  defaultEffort: CodexChatReasoningEffort;
  hidden: boolean;
}

export type CodexCapabilitiesState = 'uninitialized' | 'ready' | 'probe-failed';

const PROBE_TIMEOUT_MS = 5_000;
const NEGATIVE_CACHE_BASE_MS = 30_000;
const NEGATIVE_CACHE_MAX_MS = 10 * 60_000;

interface CapabilitiesStore {
  state: CodexCapabilitiesState;
  cache: CodexModelCapability[] | null;
  cliUserAgent: string | null;
  binaryKey: string | null;
  generation: number;
  inflight: Promise<CodexModelCapability[] | null> | null;
  nextRetryAtMs: number;
  backoffMs: number;
}

let testPinned = false;

const store: CapabilitiesStore = {
  state: 'uninitialized',
  cache: null,
  cliUserAgent: null,
  binaryKey: null,
  generation: 0,
  inflight: null,
  nextRetryAtMs: 0,
  backoffMs: NEGATIVE_CACHE_BASE_MS,
};

function computeBinaryKey(binaryPath: string): string {
  try {
    const st = statSync(binaryPath);
    return `${binaryPath}|${st.mtimeMs}|${st.size}`;
  } catch {
    return `${binaryPath}|stat-failed`;
  }
}

export function invalidateCodexModelCapabilities(reason: string): void {
  store.generation += 1;
  store.state = 'uninitialized';
  store.cache = null;
  store.binaryKey = null;
  store.nextRetryAtMs = 0;
  store.backoffMs = NEGATIVE_CACHE_BASE_MS;
  store.inflight = null;
  logger.info({ reason, generation: store.generation }, 'codex model capabilities invalidated');
}

export function getCodexModelCapabilitiesState(): CodexCapabilitiesState {
  return store.state;
}

export function peekCodexModelCapabilities(): CodexModelCapability[] | null {
  return store.state === 'ready' ? store.cache : null;
}

export function notifyObservedCodexCliUserAgent(userAgent: string | null): void {
  if (!userAgent) return;
  if (store.state === 'ready' && store.cliUserAgent && store.cliUserAgent !== userAgent) {
    invalidateCodexModelCapabilities(
      `cli userAgent changed: ${store.cliUserAgent} -> ${userAgent}`,
    );
    store.cliUserAgent = userAgent;
  } else if (!store.cliUserAgent) {
    store.cliUserAgent = userAgent;
  }
}

export function getObservedCodexCliUserAgent(): string | null {
  return store.cliUserAgent;
}

export function normalizeCapability(rawModel: Record<string, unknown>): CodexModelCapability | null {
  const id = typeof rawModel['id'] === 'string' ? rawModel['id'] : null;
  if (!id) return null;
  const rawEfforts = Array.isArray(rawModel['supportedReasoningEfforts'])
    ? (rawModel['supportedReasoningEfforts'] as Array<Record<string, unknown>>)
    : [];
  const announced = rawEfforts
    .map((e) => (typeof e['reasoningEffort'] === 'string' ? e['reasoningEffort'] : null))
    .filter((e): e is string => e !== null);
  const known = CODEX_EFFORT_ORDER.filter((e) => announced.includes(e));
  const unknown = announced.filter(
    (e) => !(CODEX_EFFORT_ORDER as readonly string[]).includes(e),
  );
  if (unknown.length > 0) {
    logger.warn({ model: id, unknown }, 'model/list anunciou efforts fora do union conhecido; filtrados');
  }
  const rawDefault =
    typeof rawModel['defaultReasoningEffort'] === 'string'
      ? rawModel['defaultReasoningEffort']
      : '';
  const supported = known.length > 0 ? known : staticEffortsFor(id);
  const defaultEffort = (CODEX_EFFORT_ORDER as readonly string[]).includes(rawDefault)
    ? clampCodexEffortToSupported(rawDefault as CodexChatReasoningEffort, supported)
    : clampCodexEffortToSupported('medium', supported);
  return {
    id,
    displayName: typeof rawModel['displayName'] === 'string' ? rawModel['displayName'] : id,
    description: typeof rawModel['description'] === 'string' ? rawModel['description'] : '',
    supportedEfforts: supported,
    defaultEffort,
    hidden: rawModel['hidden'] === true,
  };
}

async function runProbe(binaryPath: string): Promise<{
  capabilities: CodexModelCapability[];
  userAgent: string | null;
} | null> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    const settle = (value: { capabilities: CodexModelCapability[]; userAgent: string | null } | null): void => {
      if (settled) return;
      settled = true;
      const c = child;
      if (!c || c.exitCode !== null) {
        resolve(value);
        return;
      }
      let waited = false;
      const done = (): void => {
        if (waited) return;
        waited = true;
        resolve(value);
      };
      c.once('close', done);
      try {
        c.kill('SIGKILL');
      } catch {
      }
      setTimeout(done, 500);
    };
    const timer = setTimeout(() => {
      logger.warn({ timeoutMs: PROBE_TIMEOUT_MS }, 'codex model/list probe timeout; killing');
      settle(null);
    }, PROBE_TIMEOUT_MS);

    try {
      const useShell = process.platform === 'win32' && binaryPath.toLowerCase().endsWith('.cmd');
      child = spawn(binaryPath, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: useShell,
      });
    } catch (err) {
      clearTimeout(timer);
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'codex probe spawn failed');
      settle(null);
      return;
    }

    const models: CodexModelCapability[] = [];
    let userAgent: string | null = null;
    let nextId = 1;
    const INIT_ID = nextId++;
    let buffer = '';

    const send = (method: string, params: Record<string, unknown>, id?: number): void => {
      const msg: Record<string, unknown> = { jsonrpc: '2.0', method, params };
      if (id !== undefined) msg['id'] = id;
      try {
        child?.stdin?.write(JSON.stringify(msg) + '\n');
      } catch {
        settle(null);
      }
    };

    const listPage = (cursor?: string): void => {
      const id = nextId++;
      pendingListIds.add(id);
      send('model/list', { includeHidden: true, ...(cursor ? { cursor } : {}) }, id);
    };
    const pendingListIds = new Set<number>();

    child.on('error', (err) => {
      clearTimeout(timer);
      logger.warn({ err: err.message }, 'codex probe process error');
      settle(null);
    });
    child.on('close', () => {
      if (!settled) {
        clearTimeout(timer);
        settle(null);
      }
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const msgId = msg['id'];
        if (msgId === INIT_ID) {
          const result = msg['result'] as Record<string, unknown> | undefined;
          userAgent = typeof result?.['userAgent'] === 'string' ? result['userAgent'] : null;
          send('initialized', {});
          listPage();
          continue;
        }
        if (typeof msgId === 'number' && pendingListIds.has(msgId)) {
          pendingListIds.delete(msgId);
          const result = msg['result'] as Record<string, unknown> | undefined;
          if (!result || msg['error']) {
            clearTimeout(timer);
            settle(null);
            return;
          }
          const data = Array.isArray(result['data'])
            ? (result['data'] as Array<Record<string, unknown>>)
            : [];
          for (const raw of data) {
            const cap = normalizeCapability(raw);
            if (cap) models.push(cap);
          }
          const nextCursor = result['nextCursor'];
          if (typeof nextCursor === 'string' && nextCursor.length > 0) {
            listPage(nextCursor);
          } else {
            clearTimeout(timer);
            settle({ capabilities: models, userAgent });
          }
        }
      }
    });

    send(
      'initialize',
      { clientInfo: { name: 'LionClaw', title: 'LionClaw', version: 'model-capabilities-probe' } },
      INIT_ID,
    );
  });
}

export async function getCodexModelCapabilities(): Promise<CodexModelCapability[] | null> {
  if (testPinned) return store.state === 'ready' ? store.cache : null;

  let binaryPath: string | null = null;
  try {
    binaryPath = await resolveCodexBinary();
  } catch {
    binaryPath = null;
  }
  if (!binaryPath) {
    if (store.state === 'ready' && store.cache) return store.cache;
    if (store.state !== 'probe-failed') {
      store.state = 'probe-failed';
      store.nextRetryAtMs = Date.now() + store.backoffMs;
    }
    return null;
  }
  const key = computeBinaryKey(binaryPath);

  if (store.state === 'ready' && store.cache && store.binaryKey === key) {
    return store.cache;
  }
  if (store.state === 'ready' && store.binaryKey !== key) {
    invalidateCodexModelCapabilities('codex binary changed (path/mtime/size)');
  }
  if (store.state === 'probe-failed' && Date.now() < store.nextRetryAtMs) {
    return null;
  }
  if (store.inflight) return store.inflight;

  const generationAtStart = store.generation;
  let inflightPromise!: Promise<CodexModelCapability[] | null>;
  inflightPromise = (async () => {
    try {
      const probed = await runProbe(binaryPath);
      if (store.generation !== generationAtStart) {
        logger.info('codex probe result discarded (generation bumped mid-flight)');
        return store.state === 'ready' ? store.cache : null;
      }
      if (probed === null) {
        store.state = 'probe-failed';
        store.nextRetryAtMs = Date.now() + store.backoffMs;
        store.backoffMs = Math.min(store.backoffMs * 2, NEGATIVE_CACHE_MAX_MS);
        logger.warn(
          { retryInMs: store.nextRetryAtMs - Date.now() },
          'codex model/list probe failed; static fallback active (negative cache)',
        );
        return null;
      }
      store.state = 'ready';
      store.cache = probed.capabilities;
      store.cliUserAgent = probed.userAgent;
      store.binaryKey = key;
      store.backoffMs = NEGATIVE_CACHE_BASE_MS;
      logger.info(
        { models: probed.capabilities.length, userAgent: probed.userAgent },
        'codex model capabilities discovered (model/list)',
      );
      return probed.capabilities;
    } finally {
      if (store.inflight === inflightPromise) store.inflight = null;
    }
  })();
  store.inflight = inflightPromise;
  return inflightPromise;
}

export function findDiscoveredCodexModel(model: string): CodexModelCapability | undefined {
  const slug = (model || '').trim().toLowerCase();
  return peekCodexModelCapabilities()?.find((c) => c.id.toLowerCase() === slug);
}

export function resolveSupportedCodexEfforts(
  model: string,
): readonly CodexChatReasoningEffort[] {
  return findDiscoveredCodexModel(model)?.supportedEfforts ?? staticEffortsFor(model);
}

export function clampCodexEffortForModelDiscovered(
  effort: CodexChatReasoningEffort,
  model: string,
): CodexChatReasoningEffort {
  return clampCodexEffortToSupported(effort, resolveSupportedCodexEfforts(model));
}

export function __resetCodexModelCapabilitiesForTests(): void {
  testPinned = false;
  store.state = 'uninitialized';
  store.cache = null;
  store.cliUserAgent = null;
  store.binaryKey = null;
  store.generation = 0;
  store.inflight = null;
  store.nextRetryAtMs = 0;
  store.backoffMs = NEGATIVE_CACHE_BASE_MS;
}

export function __setCodexModelCapabilitiesForTests(
  capabilities: CodexModelCapability[] | null,
  state: CodexCapabilitiesState = capabilities ? 'ready' : 'probe-failed',
): void {
  testPinned = true;
  store.cache = capabilities;
  store.state = state;
  store.binaryKey = null;
  if (state === 'probe-failed') store.nextRetryAtMs = Date.now() + 60_000;
}

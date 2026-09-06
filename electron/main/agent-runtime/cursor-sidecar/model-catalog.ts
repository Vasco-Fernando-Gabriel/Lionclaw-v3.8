
import { spawn } from 'child_process';
import os from 'os';
import { createLogger } from '../../logger';
import { CURSOR_MODELS } from '../../../../src/constants/cursor-models';
import {
  createSidecarLineDecoder,
  encodeSidecarLine,
  type CursorSidecarModelEntry,
} from './protocol';
import { resolveCursorSidecarEntry, resolveCursorSidecarNode } from './node-resolver';

const logger = createLogger('cursor-model-catalog');

const CATALOG_TTL_MS = 10 * 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export interface CursorModelCatalog {
  models: CursorSidecarModelEntry[];
  source: 'live' | 'static-fallback';
  fetchedAt: number;
}

let cachedCatalog: CursorModelCatalog | null = null;
let inflight: Promise<CursorModelCatalog> | null = null;

function staticFallbackCatalog(): CursorModelCatalog {
  return {
    models: CURSOR_MODELS.map((model) => ({ id: model.slug, displayName: model.label })),
    source: 'static-fallback',
    fetchedAt: Date.now(),
  };
}

export interface ListCursorModelsOptions {
  apiKey: string;
  forceRefresh?: boolean;
  nodePathOverride?: string;
  entryPathOverride?: string;
  timeoutMs?: number;
  extraEnv?: Record<string, string>;
}

async function fetchLiveCatalog(opts: ListCursorModelsOptions): Promise<CursorSidecarModelEntry[]> {
  const nodePath = opts.nodePathOverride ?? (await resolveCursorSidecarNode()).nodePath;
  const entryPath = opts.entryPathOverride ?? resolveCursorSidecarEntry();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const requestId = `models-${Date.now()}`;

  return new Promise<CursorSidecarModelEntry[]>((resolve, reject) => {
    const child = spawn(nodePath, [entryPath], {
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.extraEnv ?? {}) },
      windowsHide: true,
    });
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.write(encodeSidecarLine({ type: 'shutdown' }));
      } catch {
      }
      try {
        child.kill();
      } catch {
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`list-models nao respondeu em ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();

    child.stdin?.on('error', () => {
    });

    const decoder = createSidecarLineDecoder((raw) => {
      const type = typeof raw['type'] === 'string' ? (raw['type'] as string) : '';
      if (type === 'ready') {
        child.stdin?.write(
          encodeSidecarLine({ type: 'list-models', id: requestId, apiKey: opts.apiKey }),
        );
        return;
      }
      if (type === 'models-result' && raw['id'] === requestId) {
        const error = typeof raw['error'] === 'string' ? (raw['error'] as string) : undefined;
        if (error !== undefined) {
          finish(() => reject(new Error(`Cursor.models.list falhou no sidecar: ${error}`)));
          return;
        }
        const models = Array.isArray(raw['models'])
          ? (raw['models'] as unknown[]).flatMap((entry): CursorSidecarModelEntry[] => {
              if (!entry || typeof entry !== 'object') return [];
              const rec = entry as Record<string, unknown>;
              if (typeof rec['id'] !== 'string') return [];
              return [{
                id: rec['id'],
                displayName:
                  typeof rec['displayName'] === 'string' ? rec['displayName'] : rec['id'],
              }];
            })
          : [];
        finish(() => resolve(models));
      }
    });
    child.stdout?.on('data', decoder);

    child.on('error', (err) => {
      finish(() => reject(new Error(`Falha ao spawnar sidecar de catalogo: ${err.message}`)));
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Sidecar de catalogo morreu antes do resultado (code=${code}, signal=${signal})`));
    });
  });
}

export async function listCursorModels(opts: ListCursorModelsOptions): Promise<CursorModelCatalog> {
  if (
    !opts.forceRefresh
    && cachedCatalog
    && Date.now() - cachedCatalog.fetchedAt < CATALOG_TTL_MS
  ) {
    return cachedCatalog;
  }
  if (inflight) return inflight;

  inflight = (async (): Promise<CursorModelCatalog> => {
    try {
      const models = await fetchLiveCatalog(opts);
      if (models.length === 0) {
        throw new Error('Cursor.models.list retornou catalogo vazio');
      }
      cachedCatalog = { models, source: 'live', fetchedAt: Date.now() };
      return cachedCatalog;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Catalogo vivo do Cursor indisponivel — usando snapshot estatico G6',
      );
      cachedCatalog = staticFallbackCatalog();
      return cachedCatalog;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getCachedCursorModelCatalog(): CursorModelCatalog | null {
  return cachedCatalog;
}

export function isCursorCatalogModel(model: string): boolean {
  if (CURSOR_MODELS.some((entry) => entry.slug === model)) return true;
  return cachedCatalog?.models.some((entry) => entry.id === model) ?? false;
}

export function _resetCursorModelCatalogForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error('_resetCursorModelCatalogForTesting can only be called in test environment');
  }
  cachedCatalog = null;
  inflight = null;
}

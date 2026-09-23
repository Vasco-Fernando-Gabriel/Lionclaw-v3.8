import { useCallback, useSyncExternalStore } from 'react';
import type { OrchestratorRuntime } from '@/types';
import { favoriteKey } from './model-picker.logic';

export const FAVORITE_MODELS_STORAGE_KEY = 'lionclaw:favorite-models';

function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

let listeners: Array<() => void> = [];
let cachedRaw: string | null = null;
let cachedList: readonly string[] = [];

function emitChange(): void {
  for (const listener of listeners) listener();
}

function readRaw(): string | null {
  if (!hasStorage()) return null;
  try {
    return localStorage.getItem(FAVORITE_MODELS_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function parseFavoriteKeys(raw: string | null): readonly string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    return [];
  }
  return [];
}

export function readFavoriteKeys(): readonly string[] {
  const raw = readRaw();
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  cachedList = parseFavoriteKeys(raw);
  return cachedList;
}

const EMPTY: readonly string[] = [];
function getServerSnapshot(): readonly string[] {
  return EMPTY;
}

function subscribe(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  listeners.push(listener);
  const handleStorage = (event: StorageEvent): void => {
    if (event.key === FAVORITE_MODELS_STORAGE_KEY) emitChange();
  };
  window.addEventListener('storage', handleStorage);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
    window.removeEventListener('storage', handleStorage);
  };
}

function persist(keys: readonly string[]): void {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(FAVORITE_MODELS_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    return;
  }
  cachedRaw = readRaw();
  cachedList = parseFavoriteKeys(cachedRaw);
  emitChange();
}

export function toggleFavoriteKey(runtime: OrchestratorRuntime, modelId: string): readonly string[] {
  const key = favoriteKey(runtime, modelId);
  const current = readFavoriteKeys();
  const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
  persist(next);
  return next;
}

export interface UseFavoriteModels {
  favorites: ReadonlySet<string>;
  isFavorite: (runtime: OrchestratorRuntime, modelId: string) => boolean;
  toggleFavorite: (runtime: OrchestratorRuntime, modelId: string) => void;
}

export function useFavoriteModels(): UseFavoriteModels {
  const list = useSyncExternalStore(subscribe, readFavoriteKeys, getServerSnapshot);
  const favorites = new Set(list);

  const isFavorite = useCallback(
    (runtime: OrchestratorRuntime, modelId: string): boolean =>
      readFavoriteKeys().includes(favoriteKey(runtime, modelId)),
    [],
  );

  const toggleFavorite = useCallback((runtime: OrchestratorRuntime, modelId: string): void => {
    toggleFavoriteKey(runtime, modelId);
  }, []);

  return { favorites, isFavorite, toggleFavorite };
}

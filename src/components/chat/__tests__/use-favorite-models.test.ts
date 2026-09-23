// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FAVORITE_MODELS_STORAGE_KEY,
  parseFavoriteKeys,
  readFavoriteKeys,
  toggleFavoriteKey,
} from '../composer/use-favorite-models';

beforeEach(() => {
  localStorage.clear();
});

describe('use-favorite-models: favoritos em localStorage lionclaw:favorite-models', () => {
  it('toggle grava a chave runtime:modelId e remove no segundo toggle', () => {
    expect(readFavoriteKeys()).toEqual([]);
    toggleFavoriteKey('claude-sdk', 'claude-opus-5');
    expect(JSON.parse(localStorage.getItem(FAVORITE_MODELS_STORAGE_KEY) ?? '[]')).toEqual(['claude-sdk:claude-opus-5']);
    toggleFavoriteKey('codex-sdk', 'gpt-6-astra');
    expect(readFavoriteKeys()).toEqual(['claude-sdk:claude-opus-5', 'codex-sdk:gpt-6-astra']);
    toggleFavoriteKey('claude-sdk', 'claude-opus-5');
    expect(readFavoriteKeys()).toEqual(['codex-sdk:gpt-6-astra']);
  });

  it('snapshot estavel entre leituras sem mudanca e tolerante a JSON invalido', () => {
    toggleFavoriteKey('kimi-sdk', 'kimi-code/k3');
    const first = readFavoriteKeys();
    expect(readFavoriteKeys()).toBe(first);
    expect(parseFavoriteKeys('nao-e-json')).toEqual([]);
    expect(parseFavoriteKeys(JSON.stringify(['a', 1, null, 'b']))).toEqual(['a', 'b']);
    localStorage.setItem(FAVORITE_MODELS_STORAGE_KEY, '{oops');
    expect(readFavoriteKeys()).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_FORCED_FULL_BELOW,
  effectiveArtifactMode,
  htmlArtifactUrl,
  parseArtifactMessage,
  sanitizeArtifactStorageKey,
} from '../artifact-panel-messages';

describe('parseArtifactMessage (RM2 / 8.5)', () => {
  it('aceita as tres mensagens da lista fechada', () => {
    expect(parseArtifactMessage({ type: 'lionclaw:ready', storageKey: 'Proj-Doc-v1' })).toEqual({
      type: 'ready',
      storageKey: 'proj-doc-v1',
    });
    expect(parseArtifactMessage({ type: 'lionclaw:decisions', text: 'RM1: ok' })).toEqual({
      type: 'decisions',
      text: 'RM1: ok',
    });
    expect(parseArtifactMessage({ type: 'lionclaw:state:set', storageKey: 'k', state: { RM1: { s: 'ok' } } })).toEqual({
      type: 'state:set',
      storageKey: 'k',
      state: { RM1: { s: 'ok' } },
    });
  });

  it('ignora tipo fora da lista, inclusive lionclaw:mode', () => {
    expect(parseArtifactMessage({ type: 'lionclaw:mode', mode: 'full' })).toBeNull();
    expect(parseArtifactMessage({ type: 'lionclaw:state', state: {} })).toBeNull();
    expect(parseArtifactMessage('lionclaw:ready')).toBeNull();
    expect(parseArtifactMessage(null)).toBeNull();
  });

  it('ignora payload fora do shape ou acima dos tetos', () => {
    expect(parseArtifactMessage({ type: 'lionclaw:ready', storageKey: '///' })).toBeNull();
    expect(parseArtifactMessage({ type: 'lionclaw:decisions', text: '' })).toBeNull();
    expect(parseArtifactMessage({ type: 'lionclaw:decisions', text: 'x'.repeat(64 * 1024 + 1) })).toBeNull();
    expect(parseArtifactMessage({ type: 'lionclaw:state:set', storageKey: 'k', state: ['a'] })).toBeNull();
    expect(
      parseArtifactMessage({ type: 'lionclaw:state:set', storageKey: 'k', state: { big: 'x'.repeat(256 * 1024) } }),
    ).toBeNull();
  });

  it('sanitiza storageKey para [a-z0-9-]', () => {
    expect(sanitizeArtifactStorageKey('LionClaw Spec_v1')).toBe('lionclawspecv1');
    expect(sanitizeArtifactStorageKey('')).toBeNull();
  });
});

describe('layout do painel (7.3 / 7.6)', () => {
  it('URL do protocolo codifica o caminho', () => {
    expect(htmlArtifactUrl('C:\\a b.html')).toBe('lionclaw-asset://host/html-artifact/C%3A%5Ca%20b.html');
  });

  it('side vira full quando a pagina do chat nao comporta as duas metades', () => {
    expect(effectiveArtifactMode('side', ARTIFACT_FORCED_FULL_BELOW)).toBe('side');
    expect(effectiveArtifactMode('side', ARTIFACT_FORCED_FULL_BELOW - 1)).toBe('full');
    expect(effectiveArtifactMode('side', null)).toBe('side');
    expect(effectiveArtifactMode('minimized', 100)).toBe('minimized');
    expect(effectiveArtifactMode('full', 2000)).toBe('full');
  });
});

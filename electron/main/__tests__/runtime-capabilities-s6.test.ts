
import { describe, it, expect } from 'vitest';
import {
  RUNTIME_CAPABILITIES,
  runtimeSupportsImageInput,
  runtimeSupportsEffort,
  imageUnsupportedNotice,
  runtimeLabel,
} from '../agent-runtime/runtime-capabilities';
import type { OrchestratorRuntime } from '../../../src/types';

const ALL_RUNTIMES: OrchestratorRuntime[] = [
  'claude-sdk',
  'claude-compat-sdk',
  'codex-sdk',
  'kimi-sdk',
  'grok-sdk',
  'lion-sdk',
];

describe('RUNTIME_CAPABILITIES (SPEC 3.7)', () => {
  it('cobre todos os 6 runtimes', () => {
    for (const r of ALL_RUNTIMES) {
      expect(RUNTIME_CAPABILITIES[r]).toBeDefined();
    }
  });

  it('valores iniciais da SPEC 3.7', () => {
    expect(RUNTIME_CAPABILITIES['claude-sdk']).toEqual({
      supportsImageInput: true,
      supportsDocumentInput: true,
      supportsEffort: true,
    });
    expect(RUNTIME_CAPABILITIES['claude-compat-sdk']).toEqual({
      supportsImageInput: true,
      supportsDocumentInput: false,
      supportsEffort: false,
    });
    expect(RUNTIME_CAPABILITIES['codex-sdk']).toEqual({
      supportsImageInput: false,
      supportsDocumentInput: false,
      supportsEffort: true,
    });
    expect(RUNTIME_CAPABILITIES['kimi-sdk']).toEqual({
      supportsImageInput: false,
      supportsDocumentInput: false,
      supportsEffort: true,
    });
    expect(RUNTIME_CAPABILITIES['grok-sdk']).toEqual({
      supportsImageInput: false,
      supportsDocumentInput: false,
      supportsEffort: true,
    });
    expect(RUNTIME_CAPABILITIES['lion-sdk']).toEqual({
      supportsImageInput: false,
      supportsDocumentInput: false,
      supportsEffort: false,
    });
  });

  it('runtimeSupportsImageInput: so claude-sdk e claude-compat-sdk', () => {
    expect(runtimeSupportsImageInput('claude-sdk')).toBe(true);
    expect(runtimeSupportsImageInput('claude-compat-sdk')).toBe(true);
    expect(runtimeSupportsImageInput('codex-sdk')).toBe(false);
    expect(runtimeSupportsImageInput('kimi-sdk')).toBe(false);
    expect(runtimeSupportsImageInput('grok-sdk')).toBe(false);
    expect(runtimeSupportsImageInput('lion-sdk')).toBe(false);
  });

  it('runtimeSupportsEffort: Claude, Codex, Kimi e Grok', () => {
    for (const r of ['claude-sdk', 'codex-sdk', 'kimi-sdk', 'grok-sdk'] as const) {
      expect(runtimeSupportsEffort(r)).toBe(true);
    }
    expect(runtimeSupportsEffort('claude-compat-sdk')).toBe(false);
    expect(runtimeSupportsEffort('lion-sdk')).toBe(false);
  });

  it('imageUnsupportedNotice: mensagem P4 com o rotulo do runtime, sem trocar provider', () => {
    const notice = imageUnsupportedNotice('kimi-sdk');
    expect(notice).toContain('Kimi');
    expect(notice).toContain('nao processa imagens');
    expect(notice).toContain('texto foi considerado');
  });

  it('runtimeLabel: rotulos amigaveis', () => {
    expect(runtimeLabel('claude-sdk')).toBe('Claude SDK');
    expect(runtimeLabel('codex-sdk')).toBe('Codex');
    expect(runtimeLabel('grok-sdk')).toBe('Grok Build');
    expect(runtimeLabel('lion-sdk')).toBe('Lion');
  });
});

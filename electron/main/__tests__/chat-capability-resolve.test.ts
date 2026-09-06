
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  resolveChatCapabilitiesForTurn,
  sanitizeChatFeatureToggles,
  sanitizeChatFeatureTogglesPatch,
} from '../chat-capability-resolve';
import { getChatFeatureToggles } from '../db';
import { CHAT_CAPABILITIES_DEFAULT_OFF } from '../../../src/types';
import type { ChatFeatureToggles } from '../../../src/types';

vi.mock('../db', () => ({
  getChatFeatureToggles: vi.fn(),
}));

const getChatFeatureTogglesMock = vi.mocked(getChatFeatureToggles);

beforeEach(() => {
  getChatFeatureTogglesMock.mockReset();
});

describe('resolveChatCapabilitiesForTurn - precedencia (A.4)', () => {
  it('1: options.featureToggles vence e o DB NAO e consultado', () => {
    const snapshot: ChatFeatureToggles = {
      pipelineControl: true,
      dynamicWorkflows: false,
    };
    const result = resolveChatCapabilitiesForTurn({
      sessionId: 'sess-1',
      options: { featureToggles: snapshot },
    });

    expect(result).toEqual(snapshot);
    expect(getChatFeatureTogglesMock).not.toHaveBeenCalled();
  });

  it('2: sem snapshot, cai no persistido da sessao (fallback legado, decisao A.1-5)', () => {
    getChatFeatureTogglesMock.mockReturnValue({
      pipelineControl: true,
      dynamicWorkflows: true,
    });

    const result = resolveChatCapabilitiesForTurn({
      sessionId: 'sess-legada',
      options: {},
    });

    expect(getChatFeatureTogglesMock).toHaveBeenCalledWith('sess-legada');
    expect(result).toEqual({ pipelineControl: true, dynamicWorkflows: true });
  });

  it('3: sem snapshot e sem linha persistida -> default OFF', () => {
    getChatFeatureTogglesMock.mockReturnValue(null);

    const result = resolveChatCapabilitiesForTurn({
      sessionId: 'sess-sem-linha',
      options: {},
    });

    expect(result).toEqual(CHAT_CAPABILITIES_DEFAULT_OFF);
  });

  it('3: sessionId null (sessao ainda vai nascer) -> default OFF, sem tocar DB', () => {
    const result = resolveChatCapabilitiesForTurn({
      sessionId: null,
      options: {},
    });

    expect(result).toEqual(CHAT_CAPABILITIES_DEFAULT_OFF);
    expect(getChatFeatureTogglesMock).not.toHaveBeenCalled();
  });

  it('snapshot MALFORMADO (IPC nao confiavel) e tratado como ausente -> precedencia 2', () => {
    getChatFeatureTogglesMock.mockReturnValue({
      pipelineControl: false,
      dynamicWorkflows: true,
    });

    const result = resolveChatCapabilitiesForTurn({
      sessionId: 'sess-1',
      options: {
        featureToggles: { pipelineControl: 'true' } as unknown as ChatFeatureToggles,
      },
    });

    expect(getChatFeatureTogglesMock).toHaveBeenCalledWith('sess-1');
    expect(result).toEqual({ pipelineControl: false, dynamicWorkflows: true });
  });

  it('retorna SEMPRE objeto novo (sem aliasing com o input nem com a constante)', () => {
    const snapshot: ChatFeatureToggles = {
      pipelineControl: true,
      dynamicWorkflows: true,
    };
    const fromOptions = resolveChatCapabilitiesForTurn({
      sessionId: 'sess-1',
      options: { featureToggles: snapshot },
    });
    expect(fromOptions).not.toBe(snapshot);

    const fromDefault = resolveChatCapabilitiesForTurn({
      sessionId: null,
      options: {},
    });
    expect(fromDefault).not.toBe(CHAT_CAPABILITIES_DEFAULT_OFF);
  });
});

describe('sanitizeChatFeatureToggles', () => {
  it('aceita o shape exato com os dois booleans', () => {
    expect(
      sanitizeChatFeatureToggles({ pipelineControl: true, dynamicWorkflows: false }),
    ).toEqual({ pipelineControl: true, dynamicWorkflows: false });
  });

  it.each([
    ['null', null],
    ['string', 'on'],
    ['array', []],
    ['faltando chave', { pipelineControl: true }],
    ['valor nao-boolean', { pipelineControl: 1, dynamicWorkflows: true }],
  ])('rejeita %s -> null', (_label, input) => {
    expect(sanitizeChatFeatureToggles(input)).toBeNull();
  });
});

describe('sanitizeChatFeatureTogglesPatch', () => {
  it('aceita patch parcial, completo e vazio', () => {
    expect(sanitizeChatFeatureTogglesPatch({ pipelineControl: true })).toEqual({
      ok: true,
      patch: { pipelineControl: true },
    });
    expect(
      sanitizeChatFeatureTogglesPatch({ pipelineControl: false, dynamicWorkflows: true }),
    ).toEqual({ ok: true, patch: { pipelineControl: false, dynamicWorkflows: true } });
    expect(sanitizeChatFeatureTogglesPatch({})).toEqual({ ok: true, patch: {} });
  });

  it('ignora chaves desconhecidas (patch e parcial por contrato)', () => {
    expect(
      sanitizeChatFeatureTogglesPatch({ dynamicWorkflows: true, extra: 'x' }),
    ).toEqual({ ok: true, patch: { dynamicWorkflows: true } });
  });

  it.each([
    ['null', null],
    ['string', 'on'],
    ['valor nao-boolean', { pipelineControl: 'true' }],
  ])('rejeita %s -> { ok:false }', (_label, input) => {
    expect(sanitizeChatFeatureTogglesPatch(input)).toEqual({ ok: false });
  });
});

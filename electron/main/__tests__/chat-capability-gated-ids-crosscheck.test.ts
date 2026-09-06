
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  getSetting: () => undefined,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import {
  CHAT_GATED_HELPER_IDS,
  GATED_METHOD_PREFIXES,
  gatedServerIdForMethod,
} from '../helper-identity';
import { getChatCapabilityForServer } from '../chat-capability-gate';
import { normalizeChatCapabilityServerId } from '../chat-capability-context';

const GATED_IDS = [...CHAT_GATED_HELPER_IDS];

describe('cross-check das 3 fontes de gated ids (S4-ii, direcao FAIL-OPEN)', () => {
  it('ha pelo menos um id gated (o teste nao vira no-op vazio)', () => {
    expect(GATED_IDS.length).toBeGreaterThan(0);
  });

  for (const id of GATED_IDS) {
    describe(`id gated "${id}"`, () => {
      it('fonte 2: getChatCapabilityForServer(id) mapeia para uma capability', () => {
        expect(getChatCapabilityForServer(id)).not.toBeUndefined();
      });

      it('fonte 3: existe >=1 prefixo em GATED_METHOD_PREFIXES para o id', () => {
        const prefixes = GATED_METHOD_PREFIXES.filter((p) => p.serverId === id);
        expect(prefixes.length).toBeGreaterThan(0);
      });

      it('fonte 3: gatedServerIdForMethod resolve o prefixo de volta ao id', () => {
        for (const { prefix } of GATED_METHOD_PREFIXES.filter((p) => p.serverId === id)) {
          expect(gatedServerIdForMethod(`${prefix}alguma_tool`)).toBe(id);
        }
      });
    });
  }

  it('sem orfaos: todo serverId de GATED_METHOD_PREFIXES esta em CHAT_GATED_HELPER_IDS', () => {
    for (const { serverId } of GATED_METHOD_PREFIXES) {
      expect(CHAT_GATED_HELPER_IDS.has(serverId)).toBe(true);
    }
  });

  it('sem orfaos: todo serverId de GATED_METHOD_PREFIXES tem capability no gate', () => {
    for (const { serverId } of GATED_METHOD_PREFIXES) {
      expect(getChatCapabilityForServer(serverId)).not.toBeUndefined();
    }
  });

  it('o alias 0.4 (pipeline-control) normaliza para o id canonico gated', () => {
    const canonical = normalizeChatCapabilityServerId('pipeline-control');
    expect(CHAT_GATED_HELPER_IDS.has(canonical)).toBe(true);
    expect(getChatCapabilityForServer('pipeline-control')).toBe(
      getChatCapabilityForServer(canonical),
    );
  });

  it('metodo nao-gated nao resolve para nenhum helper (sobre-gate seria falso positivo)', () => {
    expect(gatedServerIdForMethod('list_agents')).toBeNull();
    expect(gatedServerIdForMethod('mcp_invoke')).toBeNull();
  });
});

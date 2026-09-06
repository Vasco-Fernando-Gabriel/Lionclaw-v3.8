
import { describe, it, expect } from 'vitest';
import {
  createChatTurnStreamFlags,
  trackChatTurnChunk,
  markChatTurnDelegated,
  shouldEmitChatTurnFallbackError,
  chatTurnFallbackError,
} from '../chat-turn-safety-net';

const DESKTOP = { isDesktopLane: true, silent: false };

describe('SB-10 AC-B26 — rede de seguranca do turno de chat:send', () => {
  it('AC-B26: turno que morre sem chunk de erro, sem conteudo e sem done -> emite fallback', () => {
    const flags = createChatTurnStreamFlags();
    trackChatTurnChunk(flags, 'usage');
    trackChatTurnChunk(flags, 'context_usage');

    expect(shouldEmitChatTurnFallbackError(flags, DESKTOP)).toBe(true);

    const fallback = chatTurnFallbackError('lane=desktop');
    expect(fallback.code).toBe('LLM-EMPTY');
    expect(fallback.userMessage).toBe('O agente terminou sem resposta.');
  });

  it('AC-B26: chunk de erro ja emitido (AC-B4b ou catch) -> a rede fica muda (nao emite 2x)', () => {
    const flags = createChatTurnStreamFlags();
    trackChatTurnChunk(flags, 'error');
    expect(shouldEmitChatTurnFallbackError(flags, DESKTOP)).toBe(false);
  });

  it('AC-B26: done emitido (sucesso ou abort do usuario) -> sem alarme falso (empty-ok)', () => {
    const flags = createChatTurnStreamFlags();
    trackChatTurnChunk(flags, 'done');
    expect(shouldEmitChatTurnFallbackError(flags, DESKTOP)).toBe(false);
  });

  it('AC-B26: conteudo do assistente (text/tool_call/artifact) -> sem alarme falso', () => {
    for (const type of ['text', 'tool_call', 'tool_result', 'artifact', 'replace_content', 'assistant_pushed']) {
      const flags = createChatTurnStreamFlags();
      trackChatTurnChunk(flags, type);
      expect(shouldEmitChatTurnFallbackError(flags, DESKTOP)).toBe(false);
    }
  });

  it('AC-B26: SO na lane DESKTOP — telegram/cron (contrato proprio) nunca emitem', () => {
    const flags = createChatTurnStreamFlags();
    expect(
      shouldEmitChatTurnFallbackError(flags, { isDesktopLane: false, silent: false }),
    ).toBe(false);
  });

  it('AC-B26: turno silent (nada streama) -> suprimido', () => {
    const flags = createChatTurnStreamFlags();
    expect(
      shouldEmitChatTurnFallbackError(flags, { isDesktopLane: true, silent: true }),
    ).toBe(false);
  });

  it('AC-B26: turno delegado ao retry interno (resume falhou) -> a rede externa fica muda', () => {
    const flags = createChatTurnStreamFlags();
    markChatTurnDelegated(flags);
    expect(shouldEmitChatTurnFallbackError(flags, DESKTOP)).toBe(false);
  });
});

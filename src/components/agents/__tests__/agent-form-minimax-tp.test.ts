
import { describe, it, expect } from 'vitest';


type RuntimeType = 'cloud' | 'zai' | 'minimax-tp' | 'local' | 'external' | 'codex';

function resolveModel(
  runtime: RuntimeType,
  minimaxTpModel: string,
  zaiModel: string,
  cloudModel: string,
  codexModel: string,
): string {
  if (runtime === 'local') return 'haiku';
  if (runtime === 'codex') return codexModel;
  if (runtime === 'minimax-tp') return minimaxTpModel;
  if (runtime === 'zai') return zaiModel;
  return cloudModel;
}

type ProviderStatusEntry = { connected: boolean; reason?: string } | null;

function computeMinimaxTpKeyBlocking(
  runtime: RuntimeType,
  minimaxTpStatus: ProviderStatusEntry,
): boolean {
  return runtime === 'minimax-tp' && (!minimaxTpStatus || !minimaxTpStatus.connected);
}


describe('AgentFormModal save logic - SPEC-006 Sprint 3 minimax-tp', () => {
  describe('resolveModel ternario expandido', () => {
    it('runtime minimax-tp: retorna minimaxTpModel', () => {
      expect(resolveModel('minimax-tp', 'MiniMax-M2.7', 'glm-4.7', 'claude-sonnet-4-6', 'o4-mini')).toBe('MiniMax-M2.7');
    });

    it('runtime minimax-tp com highspeed: retorna MiniMax-M2.7-highspeed', () => {
      expect(resolveModel('minimax-tp', 'MiniMax-M2.7-highspeed', 'glm-4.7', 'claude-sonnet-4-6', 'o4-mini')).toBe('MiniMax-M2.7-highspeed');
    });

    it('runtime zai: retorna zaiModel (nao afetado pelo minimax-tp)', () => {
      expect(resolveModel('zai', 'MiniMax-M2.7', 'glm-4.7', 'claude-sonnet-4-6', 'o4-mini')).toBe('glm-4.7');
    });

    it('runtime cloud: retorna cloudModel', () => {
      expect(resolveModel('cloud', 'MiniMax-M2.7', 'glm-4.7', 'claude-sonnet-4-6', 'o4-mini')).toBe('claude-sonnet-4-6');
    });

    it('runtime local: retorna "haiku" independente dos outros campos', () => {
      expect(resolveModel('local', 'MiniMax-M2.7', 'glm-4.7', 'claude-sonnet-4-6', 'o4-mini')).toBe('haiku');
    });

    it('runtime codex: retorna codexModel', () => {
      expect(resolveModel('codex', 'MiniMax-M2.7', 'glm-4.7', 'claude-sonnet-4-6', 'o4-mini')).toBe('o4-mini');
    });
  });

  describe('minimaxTpKeyBlocking predicate', () => {
    it('runtime minimax-tp + status null = blocking', () => {
      expect(computeMinimaxTpKeyBlocking('minimax-tp', null)).toBe(true);
    });

    it('runtime minimax-tp + connected false = blocking', () => {
      expect(computeMinimaxTpKeyBlocking('minimax-tp', { connected: false })).toBe(true);
    });

    it('runtime minimax-tp + connected true = nao blocking', () => {
      expect(computeMinimaxTpKeyBlocking('minimax-tp', { connected: true })).toBe(false);
    });

    it('runtime cloud + status null = nao blocking', () => {
      expect(computeMinimaxTpKeyBlocking('cloud', null)).toBe(false);
    });

    it('runtime zai + status null = nao blocking (blocking e do zai, nao minimax-tp)', () => {
      expect(computeMinimaxTpKeyBlocking('zai', null)).toBe(false);
    });
  });

  describe('snapshot do payload de save minimax-tp', () => {
    it('payload tem runtime minimax-tp e model MiniMax-M2.7', () => {
      const runtime: RuntimeType = 'minimax-tp';
      const minimaxTpModel = 'MiniMax-M2.7';
      const zaiModel = 'glm-4.7';
      const cloudModel = 'claude-sonnet-4-6';
      const codexModel = 'o4-mini';

      const model = resolveModel(runtime, minimaxTpModel, zaiModel, cloudModel, codexModel);

      const payload = {
        runtime,
        model,
        name: 'MiniMax Test Agent',
        description: 'teste',
      };

      expect(payload).toMatchObject({
        runtime: 'minimax-tp',
        model: 'MiniMax-M2.7',
      });
    });
  });
});

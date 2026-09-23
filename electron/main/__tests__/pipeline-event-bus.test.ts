import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

import { pipelineEventBus } from '../pipeline-event-bus';
import { emitIPC } from '../pipeline-shared/ipc-emitter';

describe('pipeline-event-bus (SPEC 4.0 / B1)', () => {
  beforeEach(() => {
    pipelineEventBus._resetForTesting();
  });

  describe('emit chama os listeners', () => {
    it('chama o unico listener do canal com o payload', () => {
      const seen: unknown[] = [];
      pipelineEventBus.on('pipeline:agent-completed', (p) => seen.push(p));

      pipelineEventBus.emit('pipeline:agent-completed', { projectId: 'proj_a' });

      expect(seen).toEqual([{ projectId: 'proj_a' }]);
    });

    it('chama TODOS os listeners do mesmo canal', () => {
      const a = vi.fn();
      const b = vi.fn();
      const c = vi.fn();
      pipelineEventBus.on('pipeline:stream', a);
      pipelineEventBus.on('pipeline:stream', b);
      pipelineEventBus.on('pipeline:stream', c);

      const payload = { projectId: 'proj_a', phase: 1, type: 'done' as const };
      pipelineEventBus.emit('pipeline:stream', payload);

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(c).toHaveBeenCalledTimes(1);
      expect(a).toHaveBeenCalledWith(payload);
    });

    it('NAO chama listeners de outro canal', () => {
      const onStream = vi.fn();
      const onError = vi.fn();
      pipelineEventBus.on('pipeline:stream', onStream);
      pipelineEventBus.on('pipeline:error', onError);

      pipelineEventBus.emit('pipeline:error', { projectId: 'proj_a', error: 'boom' });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onStream).not.toHaveBeenCalled();
    });

    it('emit sem listeners e no-op (nao lanca)', () => {
      expect(() => pipelineEventBus.emit('pipeline:agent-completed', { projectId: 'x' })).not.toThrow();
    });
  });

  describe('off remove a assinatura', () => {
    it('off para de notificar o listener removido', () => {
      const listener = vi.fn();
      pipelineEventBus.on('pipeline:agent-completed', listener);

      pipelineEventBus.emit('pipeline:agent-completed', { projectId: 'a' });
      expect(listener).toHaveBeenCalledTimes(1);

      pipelineEventBus.off('pipeline:agent-completed', listener);
      pipelineEventBus.emit('pipeline:agent-completed', { projectId: 'a' });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('o cleanup retornado por on() tambem remove', () => {
      const listener = vi.fn();
      const cleanup = pipelineEventBus.on('pipeline:agent-completed', listener);

      cleanup();
      pipelineEventBus.emit('pipeline:agent-completed', { projectId: 'a' });
      expect(listener).not.toHaveBeenCalled();
    });

    it('off de um listener NAO afeta os demais do canal', () => {
      const a = vi.fn();
      const b = vi.fn();
      pipelineEventBus.on('pipeline:stream', a);
      pipelineEventBus.on('pipeline:stream', b);

      pipelineEventBus.off('pipeline:stream', a);
      pipelineEventBus.emit('pipeline:stream', { projectId: 'a', phase: 1, type: 'done' });

      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('off de listener inexistente e no-op (nao lanca)', () => {
      expect(() => pipelineEventBus.off('pipeline:stream', () => {})).not.toThrow();
    });
  });

  describe('isolamento de erro (SPEC 4.0)', () => {
    it('um listener que joga NAO impede os demais nem derruba o emit', () => {
      const before = vi.fn();
      const throwing = vi.fn(() => {
        throw new Error('listener com defeito');
      });
      const after = vi.fn();

      pipelineEventBus.on('pipeline:stream', before);
      pipelineEventBus.on('pipeline:stream', throwing);
      pipelineEventBus.on('pipeline:stream', after);

      expect(() => pipelineEventBus.emit('pipeline:stream', { projectId: 'a', phase: 1, type: 'done' })).not.toThrow();

      expect(before).toHaveBeenCalledTimes(1);
      expect(throwing).toHaveBeenCalledTimes(1);
      expect(after).toHaveBeenCalledTimes(1);
    });

    it('on/off durante o dispatch nao corrompe a iteracao (snapshot)', () => {
      const calls: string[] = [];
      const self = vi.fn(() => {
        calls.push('self');
        pipelineEventBus.off('pipeline:stream', self);
      });
      const other = vi.fn(() => calls.push('other'));
      pipelineEventBus.on('pipeline:stream', self);
      pipelineEventBus.on('pipeline:stream', other);

      pipelineEventBus.emit('pipeline:stream', { projectId: 'a', phase: 1, type: 'done' });
      expect(calls).toEqual(['self', 'other']);

      pipelineEventBus.emit('pipeline:stream', { projectId: 'a', phase: 1, type: 'done' });
      expect(self).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(2);
    });
  });

  describe('emitIPC publica pipeline:* no bus e NAO publica nao-pipeline', () => {
    it('emitIPC("pipeline:...") chega no bus', () => {
      const listener = vi.fn();
      pipelineEventBus.on('pipeline:phase-changed', listener);

      const payload = { projectId: 'proj_a', phase: 2, status: 'started' };
      emitIPC('pipeline:phase-changed', payload);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(payload);
    });

    it('emitIPC de canal NAO-pipeline NAO chega no bus', () => {
      const driveListener = vi.fn();
      const chatListener = vi.fn();
      pipelineEventBus.on('drive:state-changed', driveListener);
      pipelineEventBus.on('chat:stream', chatListener);

      emitIPC('drive:state-changed', { projectId: 'proj_a', drive: null });
      emitIPC('chat:stream', { type: 'text', content: 'oi' });

      expect(driveListener).not.toHaveBeenCalled();
      expect(chatListener).not.toHaveBeenCalled();
    });

    it('emitIPC nao quebra quando um listener do bus joga', () => {
      pipelineEventBus.on('pipeline:error', () => {
        throw new Error('boom no bus');
      });
      expect(() => emitIPC('pipeline:error', { projectId: 'a', error: 'x' })).not.toThrow();
    });
  });
});

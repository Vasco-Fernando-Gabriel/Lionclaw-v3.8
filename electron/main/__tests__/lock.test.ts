
import { describe, it, expect, beforeEach } from 'vitest';

import {
  acquireProjectLock,
  ensureProjectLock,
  releaseProjectLock,
  isProjectLocked,
  _resetLocksForTesting,
} from '../pipeline-shared/lock';

describe('pipeline-shared/lock', () => {
  beforeEach(() => {
    _resetLocksForTesting();
  });


  describe('acquireProjectLock', () => {
    it('adquire lock pra projeto novo', () => {
      const result = acquireProjectLock('proj_a');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lock.projectId).toBe('proj_a');
        expect(result.lock.pipelineKind).toBe('pipeline-engine');
        expect(result.lock.acquiredAt).toBeInstanceOf(Date);
      }
    });

    it('falha quando ja existe lock pra mesmo projeto', () => {
      const first = acquireProjectLock('proj_a');
      expect(first.ok).toBe(true);

      const second = acquireProjectLock('proj_a');
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.runningPipeline.projectId).toBe('proj_a');
      }
    });

    it('permite locks em projetos diferentes simultaneamente', () => {
      const a = acquireProjectLock('proj_a');
      const b = acquireProjectLock('proj_b');
      const c = acquireProjectLock('proj_c');
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(c.ok).toBe(true);
      expect(isProjectLocked('proj_a')).toBe(true);
      expect(isProjectLocked('proj_b')).toBe(true);
      expect(isProjectLocked('proj_c')).toBe(true);
    });

    it('default kind e pipeline-engine', () => {
      const result = acquireProjectLock('proj_x');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lock.pipelineKind).toBe('pipeline-engine');
      }
    });
  });


  describe('ensureProjectLock', () => {
    it('adquire lock pra projeto novo', () => {
      const result = ensureProjectLock('proj_a');
      expect(result.ok).toBe(true);
      expect(result.lock.projectId).toBe('proj_a');
      expect(isProjectLocked('proj_a')).toBe(true);
    });

    it('e idempotente: chamadas sucessivas retornam o mesmo lock', () => {
      const first = ensureProjectLock('proj_a');
      const second = ensureProjectLock('proj_a');
      const third = ensureProjectLock('proj_a');
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(third.ok).toBe(true);
      expect(first.lock).toBe(second.lock);
      expect(second.lock).toBe(third.lock);
    });

    it('NAO falha se lock ja foi adquirido por acquireProjectLock', () => {
      const acquired = acquireProjectLock('proj_a');
      expect(acquired.ok).toBe(true);

      const ensured = ensureProjectLock('proj_a');
      expect(ensured.ok).toBe(true);
      if (acquired.ok) {
        expect(ensured.lock).toBe(acquired.lock);
      }
    });
  });


  describe('releaseProjectLock', () => {
    it('remove o lock', () => {
      acquireProjectLock('proj_a');
      expect(isProjectLocked('proj_a')).toBe(true);

      releaseProjectLock('proj_a');
      expect(isProjectLocked('proj_a')).toBe(false);
    });

    it('e seguro chamar com projectId sem lock (no-op)', () => {
      expect(() => releaseProjectLock('proj_inexistente')).not.toThrow();
      expect(isProjectLocked('proj_inexistente')).toBe(false);
    });

    it('apos release, novo acquire e permitido', () => {
      const first = acquireProjectLock('proj_a');
      expect(first.ok).toBe(true);

      releaseProjectLock('proj_a');

      const second = acquireProjectLock('proj_a');
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(first.lock).not.toBe(second.lock);
      }
    });

    it('release de um projeto NAO afeta outros', () => {
      acquireProjectLock('proj_a');
      acquireProjectLock('proj_b');
      acquireProjectLock('proj_c');

      releaseProjectLock('proj_b');

      expect(isProjectLocked('proj_a')).toBe(true);
      expect(isProjectLocked('proj_b')).toBe(false);
      expect(isProjectLocked('proj_c')).toBe(true);
    });
  });


  describe('cenarios integrados', () => {
    it('R7: 2 pipelines em projetos DIFERENTES rodam paralelo', () => {
      const a = acquireProjectLock('proj_a');
      const b = acquireProjectLock('proj_b');
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
    });

    it('R7: 2o pipeline:start no MESMO projeto e bloqueado', () => {
      const first = acquireProjectLock('proj_a');
      expect(first.ok).toBe(true);

      const second = acquireProjectLock('proj_a');
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.runningPipeline.projectId).toBe('proj_a');
      }
    });

    it('Resume/Advance/Retry pos-restart usa ensureProjectLock', () => {
      expect(isProjectLocked('proj_a')).toBe(false);

      const ensured = ensureProjectLock('proj_a');
      expect(ensured.ok).toBe(true);
      expect(isProjectLocked('proj_a')).toBe(true);
    });

    it('ciclo terminal: acquire -> release -> acquire de novo', () => {
      const start = acquireProjectLock('proj_a');
      expect(start.ok).toBe(true);


      releaseProjectLock('proj_a');
      expect(isProjectLocked('proj_a')).toBe(false);

      const restart = acquireProjectLock('proj_a');
      expect(restart.ok).toBe(true);
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  DriveTurnSemaphore,
  DriveTurnAdmissionAbortedError,
  readDriveParallelTurns,
  DEFAULT_DRIVE_PARALLEL_TURNS,
} from '../drive-turn-semaphore';
import { DRIVE_PARALLEL_TURNS_MAX } from '../lanes';

describe('readDriveParallelTurns (8.3)', () => {
  it('default 1 quando ausente, invalido ou menor que 1', () => {
    expect(readDriveParallelTurns(() => undefined)).toBe(DEFAULT_DRIVE_PARALLEL_TURNS);
    expect(readDriveParallelTurns(() => 'abc')).toBe(1);
    expect(readDriveParallelTurns(() => '0')).toBe(1);
    expect(readDriveParallelTurns(() => '-3')).toBe(1);
  });

  it('respeita o valor e o teto DRIVE_PARALLEL_TURNS_MAX', () => {
    expect(readDriveParallelTurns(() => '2')).toBe(2);
    expect(readDriveParallelTurns(() => '99')).toBe(DRIVE_PARALLEL_TURNS_MAX);
  });

  it('leitura que lanca cai no default (fail-safe)', () => {
    expect(
      readDriveParallelTurns(() => {
        throw new Error('db fechado');
      }),
    ).toBe(1);
  });
});

describe('DriveTurnSemaphore', () => {
  it('FIFO: com limite 1 o segundo espera e entra na ordem quando o primeiro libera', async () => {
    const sem = new DriveTurnSemaphore(() => 1);
    const order: string[] = [];
    const release1 = await sem.acquire();
    order.push('1');
    const p2 = sem.acquire().then((r) => {
      order.push('2');
      return r;
    });
    const p3 = sem.acquire().then((r) => {
      order.push('3');
      return r;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['1']);
    expect(sem.waitingCount).toBe(2);
    release1();
    const release2 = await p2;
    expect(order).toEqual(['1', '2']);
    expect(sem.activeCount).toBe(1);
    release2();
    const release3 = await p3;
    expect(order).toEqual(['1', '2', '3']);
    release3();
    expect(sem.activeCount).toBe(0);
  });

  it('abort enquanto aguarda rejeita tipado e sai da fila sem consumir vaga', async () => {
    const sem = new DriveTurnSemaphore(() => 1);
    const release1 = await sem.acquire();
    const ac = new AbortController();
    const waiting = sem.acquire(ac.signal);
    ac.abort();
    await expect(waiting).rejects.toBeInstanceOf(DriveTurnAdmissionAbortedError);
    expect(sem.waitingCount).toBe(0);
    release1();
    expect(sem.activeCount).toBe(0);
  });

  it('limite lido a cada admissao: subir o setting admite dois waiters no proximo release (FIFO preservada)', async () => {
    let limit = 1;
    const sem = new DriveTurnSemaphore(() => limit);
    const r1 = await sem.acquire();
    const p2 = sem.acquire();
    const p3 = sem.acquire();
    limit = 2;
    await new Promise((r) => setTimeout(r, 5));
    expect(sem.waitingCount).toBe(2);
    r1();
    const [r2, r3] = await Promise.all([p2, p3]);
    expect(sem.activeCount).toBe(2);
    expect(sem.waitingCount).toBe(0);
    r2();
    r3();
    expect(sem.activeCount).toBe(0);
  });

  it('release e idempotente', async () => {
    const sem = new DriveTurnSemaphore(() => 1);
    const r = await sem.acquire();
    r();
    r();
    expect(sem.activeCount).toBe(0);
  });
});

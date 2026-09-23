import { afterEach, describe, expect, it } from 'vitest';
import {
  _grokPoolStateForTests,
  _resetGrokPoolForTests,
  acquireGrokSlot,
  GrokConcurrencyError,
} from '../grok-concurrency';

describe('Grok concurrency pool', () => {
  afterEach(() => _resetGrokPoolForTests());

  it('com cap=1 admite filho cross-runtime e recusa somente ancestry Grok ativa', async () => {
    _resetGrokPoolForTests(1);
    const crossRuntimeChild = await acquireGrokSlot({
      role: 'child',
      rootExecutionId: 'claude-root',
      executionDepth: 1,
    });
    crossRuntimeChild();
    const parent = await acquireGrokSlot({
      role: 'parent',
      toolBearing: true,
      rootExecutionId: 'grok-root',
      executionDepth: 0,
    });
    await expect(
      acquireGrokSlot({
        role: 'child',
        rootExecutionId: 'grok-root',
        executionDepth: 1,
      }),
    ).rejects.toBeInstanceOf(GrokConcurrencyError);
    parent();
    expect(_grokPoolStateForTests()).toMatchObject({ active: 0, queued: 0 });
  });

  it('reserva um slot para filho e nao deadlocka atras de pai FIFO', async () => {
    _resetGrokPoolForTests(3);
    const releaseParent1 = await acquireGrokSlot({ role: 'parent', toolBearing: true });
    const releaseParent2 = await acquireGrokSlot({ role: 'parent', toolBearing: true });
    let thirdParentGranted = false;
    const thirdParent = acquireGrokSlot({ role: 'parent', toolBearing: true }).then((release) => {
      thirdParentGranted = true;
      return release;
    });
    const releaseChild = await acquireGrokSlot({ role: 'child', parentExecutionId: 'p1' });
    expect(thirdParentGranted).toBe(false);
    releaseChild();
    releaseParent1();
    const releaseParent3 = await thirdParent;
    releaseParent3();
    releaseParent2();
    expect(_grokPoolStateForTests()).toMatchObject({ active: 0, queued: 0 });
  });

  it('remove waiter abortado e release e idempotente', async () => {
    _resetGrokPoolForTests(1);
    const release = await acquireGrokSlot();
    const abort = new AbortController();
    const queued = acquireGrokSlot({ signal: abort.signal });
    abort.abort();
    await expect(queued).rejects.toBeInstanceOf(GrokConcurrencyError);
    release();
    release();
    expect(_grokPoolStateForTests()).toMatchObject({ active: 0, queued: 0 });
  });

  it('rejeita neto antes da fila quando ancestrais tool-bearing saturam o pool', async () => {
    _resetGrokPoolForTests(2);
    const releaseParent = await acquireGrokSlot({
      role: 'parent',
      toolBearing: true,
      rootExecutionId: 'root-1',
      executionDepth: 0,
    });
    const releaseChild = await acquireGrokSlot({
      role: 'child',
      toolBearing: true,
      rootExecutionId: 'root-1',
      executionDepth: 1,
    });

    await expect(
      acquireGrokSlot({
        role: 'child',
        rootExecutionId: 'root-1',
        executionDepth: 2,
      }),
    ).rejects.toThrow(/own tool-bearing ancestry saturates/);
    expect(_grokPoolStateForTests()).toMatchObject({ active: 2, queued: 0 });

    releaseChild();
    releaseParent();
  });
});

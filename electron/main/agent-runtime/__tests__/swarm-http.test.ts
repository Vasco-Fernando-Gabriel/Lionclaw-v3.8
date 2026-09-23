import { it, expect, vi, afterEach } from 'vitest';
vi.mock('../../local-tool-executor', () => ({
  executeLocalTool: vi.fn(() => {
    throw new Error('unsafe dispatcher called');
  }),
  executeToolDispatch: vi.fn(),
}));
import { ollamaChatWithTools } from '../../ollama-client';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it.each([false, true])('aborts the underlying HTTP request (stream=%s)', async (streaming) => {
  const abort = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetchMock = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(new Error('transport-aborted')), { once: true });
        started();
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const request = ollamaChatWithTools('http://fixture.invalid', 'fixture-model', '', '', [], {
    signal: abort.signal,
    provider: 'openai-compatible',
    streaming,
  });
  await ready;
  abort.abort();
  await expect(request).rejects.toThrow('transport-aborted');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('provider hallucinated shell call goes only to guarded dispatch, and abort prevents next round', async () => {
  const abort = new AbortController();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: 'fixture',
            message: {
              content: '',
              tool_calls: [{ function: { name: 'Bash', arguments: { command: 'touch victim' } } }],
            },
          }),
          { status: 200 },
        ),
    ),
  );
  const dispatch = vi.fn(async () => {
    abort.abort();
    return { result: 'denied', isError: true };
  });
  await expect(
    ollamaChatWithTools('http://fixture.invalid', 'fixture', '', '', [], {
      signal: abort.signal,
      toolDispatch: dispatch,
    }),
  ).rejects.toThrow();
  expect(dispatch).toHaveBeenCalledExactlyOnceWith('Bash', { command: 'touch victim' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('Swarm HTTP has no hidden 5-minute timer; only caller abort cancels it', async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(new Error('transport-aborted')), { once: true });
        }),
    ),
  );
  const pending = ollamaChatWithTools('http://fixture.invalid', 'm', '', '', [], {
    signal: abort.signal,
    externallyManagedTimeout: true,
  });
  await vi.advanceTimersByTimeAsync(360000);
  expect(abort.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  abort.abort();
  await expect(pending).rejects.toThrow('transport-aborted');
});

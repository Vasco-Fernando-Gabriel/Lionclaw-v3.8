import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const resolveKimiBinaryMock = vi.fn<() => Promise<string | null>>();
const isKimiAvailableMock = vi.fn();

vi.mock('../../agent-runtime/kimi-availability', async () => {
  const actual = await vi.importActual<typeof import('../../agent-runtime/kimi-availability')>(
    '../../agent-runtime/kimi-availability',
  );
  return {
    ...actual,
    resolveKimiBinary: () => resolveKimiBinaryMock(),
    isKimiAvailable: () => isKimiAvailableMock(),
  };
});

import { KimiAcpDriver } from '../acp-driver';
import { KimiUnavailableError } from '../../agent-runtime/kimi-availability';
import { FakeAcpTransport, fakeAcpTransportFactory } from './fake-acp-transport';
import type { CliStreamCallbacks } from '../../agent-runtime/cli-agentic/contract';
import type { KimiAcpRunOptions } from '../types';

const SESSION_ID = 'session_pipeline_001';

function sessionNewResult(): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    configOptions: [
      {
        id: 'model',
        currentValue: 'kimi-code/kimi-for-coding',
        options: [{ value: 'kimi-code/kimi-for-coding' }, { value: 'kimi-code/k3' }],
      },
      { id: 'thinking', currentValue: 'on', options: [{ value: 'on' }] },
      {
        id: 'mode',
        currentValue: 'default',
        options: [{ value: 'default' }, { value: 'auto' }, { value: 'yolo' }],
      },
    ],
  };
}

function pipelineOpts(over: Partial<KimiAcpRunOptions> = {}): KimiAcpRunOptions {
  return {
    workDir: '/repo',
    model: 'kimi-code/kimi-for-coding',
    thinking: true,
    systemPrompt: 'sys',
    surface: 'pipeline',
    ownerKind: 'pipeline',
    runId: 'run-pipe-1',
    profile: 'pipeline',
    ...over,
  };
}

beforeEach(() => {
  resolveKimiBinaryMock.mockReset();
  resolveKimiBinaryMock.mockResolvedValue('/home/u/.kimi-code/bin/kimi');
  isKimiAvailableMock.mockReset();
  isKimiAvailableMock.mockResolvedValue({
    installed: true,
    version: '0.15.0',
    authenticated: true,
    authMode: 'subscription',
  });
});

describe('Kimi ACP pipeline acceptance (HAPPY long agentic turn, AC-S7.3)', () => {
  it('streams N tool/text events INCREMENTALLY, terminates cleanly, and reaps on close()', async () => {
    const TOOL_COUNT = 4;
    const fake = new FakeAcpTransport();

    const callbackLog: string[] = [];
    let logAtPromptResolve: string[] | null = null;

    const cb: CliStreamCallbacks = {
      onText: (t) => callbackLog.push(`text:${t}`),
      onThinking: (t) => callbackLog.push(`think:${t}`),
      onToolUse: (t) => callbackLog.push(`tool:${t}`),
      onToolUseComplete: (t) => callbackLog.push(`toolDone:${t}`),
    };

    fake.responder = (method: string): unknown => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return sessionNewResult();
      if (method === 'session/set_config_option') {
        return { currentValue: 'kimi-code/kimi-for-coding' };
      }
      if (method === 'session/set_mode') return {};
      if (method === 'session/prompt') {
        for (let i = 0; i < TOOL_COUNT; i++) {
          fake.pushNotification('session/update', {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `step ${i} ` },
            },
          });
          fake.pushNotification('session/update', {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: `tc${i}`,
              title: `Tool${i}`,
              kind: 'execute',
              status: 'pending',
            },
          });
          fake.pushNotification('session/update', {
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: `tc${i}`,
              status: 'in_progress',
              rawInput: { idx: i },
            },
          });
          fake.pushNotification('session/update', {
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: `tc${i}`,
              status: 'completed',
              rawOutput: `out${i}`,
            },
          });
        }
        fake.pushNotification('session/update', {
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
        });
        return new Promise((resolve) =>
          setTimeout(() => {
            logAtPromptResolve = [...callbackLog];
            resolve({ stopReason: 'end_turn' });
          }, 10),
        );
      }
      return {};
    };

    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(pipelineOpts());
    const res = await handle.send('run the pipeline phase', cb);

    expect(logAtPromptResolve).not.toBeNull();
    expect(logAtPromptResolve).toEqual(callbackLog);
    expect(logAtPromptResolve!).toContain('tool:Tool0');
    expect(logAtPromptResolve!).toContain('tool:Tool3');
    expect(logAtPromptResolve!).toContain('text:step 0 ');

    expect(res.status).toBe('finished');
    expect(res.toolUses).toBe(TOOL_COUNT);
    expect(res.content).toBe('step 0 step 1 step 2 step 3 done');
    expect(res.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    await handle.close();
    expect(fake.killSpy).toHaveBeenCalled();
    expect(fake.waitClosedSpy).toHaveBeenCalled();
    expect(fake.killed.length).toBeGreaterThan(0);
  });
});

describe('Kimi ACP pipeline wedge/error retriability (KI-3, AC-S7.3)', () => {
  it('a WEDGED turn (silence after one update, tiny idleTimeoutMs) REJECTS send() (not resolve-cancelled)', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = (method: string): unknown => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return sessionNewResult();
      if (method === 'session/set_config_option') {
        return { currentValue: 'kimi-code/kimi-for-coding' };
      }
      if (method === 'session/set_mode') return {};
      if (method === 'session/prompt') {
        fake.pushNotification('session/update', {
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } },
        });
        return new Promise((resolve) => setTimeout(() => resolve({ stopReason: 'end_turn' }), 5000));
      }
      return {};
    };

    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(pipelineOpts({ idleTimeoutMs: 30 }));

    await expect(handle.send('go')).rejects.toBeInstanceOf(KimiUnavailableError);

    const cancel = fake.notifications.find((n) => n.method === 'session/cancel');
    expect(cancel).toEqual({ method: 'session/cancel', params: { sessionId: SESSION_ID } });
    expect(fake.requests.some((r) => r.method === 'session/cancel')).toBe(false);

    await handle.close();
  });

  it('an error-notification turn (willRetry:false) REJECTS send()', async () => {
    const fake = new FakeAcpTransport();
    fake.responder = (method: string): unknown => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return sessionNewResult();
      if (method === 'session/set_config_option') {
        return { currentValue: 'kimi-code/kimi-for-coding' };
      }
      if (method === 'session/set_mode') return {};
      if (method === 'session/prompt') {
        fake.pushNotification('error', { error: { code: 'forced_failure' }, willRetry: false });
        return new Promise((resolve) => setTimeout(() => resolve({ stopReason: 'end_turn' }), 5000));
      }
      return {};
    };

    const driver = new KimiAcpDriver(fakeAcpTransportFactory(fake));
    const handle = await driver.createRun(pipelineOpts({ idleTimeoutMs: 5000 }));

    await expect(handle.send('go')).rejects.toBeInstanceOf(KimiUnavailableError);

    await handle.close();
  });
});

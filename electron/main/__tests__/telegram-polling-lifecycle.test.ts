import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class FakeTelegramBot {
    static instances: FakeTelegramBot[] = [];
    static deleteWebhookFactory: () => Promise<boolean> = async () => true;
    static nextStartError: Error | null = null;
    static stopError: Error | null = null;
    static stopKeepsPolling = false;
    static sendChatActionFactory: () => Promise<boolean> = async () => true;
    static sendMessageFactory: () => Promise<boolean> = async () => true;

    readonly options: {
      polling?: false | { autoStart?: boolean; params?: { timeout?: number } };
      request?: { timeout?: number };
    };
    private readonly listenersByEvent = new Map<string, Set<Listener>>();
    private polling = false;

    readonly deleteWebHook = vi.fn(() => FakeTelegramBot.deleteWebhookFactory());
    readonly setMyCommands = vi.fn(async () => true);
    readonly sendChatAction = vi.fn(() => FakeTelegramBot.sendChatActionFactory());
    readonly sendMessage = vi.fn(() => FakeTelegramBot.sendMessageFactory());
    readonly getFileLink = vi.fn(async () => 'https://fake.telegram/file');
    readonly startPolling = vi.fn(async () => {
      this.polling = true;
      const error = FakeTelegramBot.nextStartError;
      FakeTelegramBot.nextStartError = null;
      if (error) this.emit('polling_error', error);
    });
    readonly stopPolling = vi.fn(async () => {
      if (!FakeTelegramBot.stopKeepsPolling) this.polling = false;
      if (FakeTelegramBot.stopError) throw FakeTelegramBot.stopError;
    });

    constructor(
      _token: string,
      options: {
        polling?: false | { autoStart?: boolean; params?: { timeout?: number } };
        request?: { timeout?: number };
      },
    ) {
      this.options = options;
      FakeTelegramBot.instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listenersByEvent.get(event) ?? new Set<Listener>();
      listeners.add(listener);
      this.listenersByEvent.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      const listeners = [...(this.listenersByEvent.get(event) ?? [])];
      for (const listener of listeners) listener(...args);
      return listeners.length > 0;
    }

    removeAllListeners(): this {
      this.listenersByEvent.clear();
      return this;
    }

    isPolling(): boolean {
      return this.polling;
    }
  }

  return {
    FakeTelegramBot,
    updateChannelStatus: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    },
    executeTelegramLaneQuery: vi.fn(async () => undefined),
    enqueueTelegramLaneTask: vi.fn((operation: () => Promise<unknown>) => operation()),
  };
});

vi.mock('node-telegram-bot-api', () => ({ default: h.FakeTelegramBot }));
vi.mock('electron', () => ({ BrowserWindow: class {} }));

vi.mock('../db', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      get: () => ({
        config: JSON.stringify({
          allowedUserId: 42,
          allowedUserName: 'Breno',
          sessionMode: 'continuous',
          notifyOnSchedulerTasks: false,
          notifyOnDriveHandoff: false,
        }),
      }),
      all: () => [],
      run: () => undefined,
    })),
  })),
  createSession: vi.fn(),
  getSession: vi.fn(() => undefined),
  updateSessionStatus: vi.fn(),
  getSetting: vi.fn(() => undefined),
  listActiveTelegramSessions: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  setSessionCompactionState: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
}));

vi.mock('../orchestrator', () => ({
  executeTelegramLaneQuery: h.executeTelegramLaneQuery,
  enqueueTelegramLaneTask: h.enqueueTelegramLaneTask,
  resetTelegramSessionState: vi.fn(),
}));
vi.mock('../memory-pipeline', () => ({ runCompaction: vi.fn() }));
vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => 'telegram-token-for-test'),
  getSecretNonInteractiveOrThrow: vi.fn(async () => 'telegram-token-for-test'),
}));
vi.mock('../channels-db', () => ({
  updateChannelStatus: h.updateChannelStatus,
}));
vi.mock('../logger', () => ({ createLogger: () => h.logger }));
vi.mock('../scheduler', () => ({
  getAllScheduledTasks: vi.fn(() => []),
  getPendingReviewCount: vi.fn(() => 0),
}));
vi.mock('../voice-engine', () => ({ transcribeAudio: vi.fn() }));
vi.mock('../knowledge-engine', () => ({ parseFile: vi.fn() }));
vi.mock('../vision-engine', () => ({
  describeImage: vi.fn(),
  buildTranscriptionBlock: vi.fn(),
  visionUnavailableNotice: vi.fn(() => 'vision indisponivel'),
}));
vi.mock('../agent-runtime/runtime-capabilities', () => ({
  runtimeSupportsImageInput: vi.fn(() => false),
}));
vi.mock('../smoke-audit', () => ({ smokeAudit: vi.fn() }));

import {
  __telegramInternal,
  isTelegramRunning,
  startTelegramBot,
  stopTelegramBot,
} from '../telegram-bridge';

const getWindow = () => null;

function pollingInstances(): InstanceType<typeof h.FakeTelegramBot>[] {
  return h.FakeTelegramBot.instances.filter((instance) => instance.options.polling !== false);
}

async function settleLifecycle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  await stopTelegramBot();
  h.FakeTelegramBot.instances.length = 0;
  h.FakeTelegramBot.deleteWebhookFactory = async () => true;
  h.FakeTelegramBot.nextStartError = null;
  h.FakeTelegramBot.stopError = null;
  h.FakeTelegramBot.stopKeepsPolling = false;
  h.FakeTelegramBot.sendChatActionFactory = async () => true;
  h.FakeTelegramBot.sendMessageFactory = async () => true;
  vi.clearAllMocks();
});

afterEach(async () => {
  h.FakeTelegramBot.stopError = null;
  h.FakeTelegramBot.stopKeepsPolling = false;
  await stopTelegramBot();
});

describe('Telegram polling lifecycle', () => {
  it('usa autoStart false, timeout curto e confirma o primeiro ciclo antes de conectar', async () => {
    await expect(startTelegramBot(getWindow)).resolves.toBe(true);

    const [instance] = pollingInstances();
    expect(instance).toBeDefined();
    expect(instance?.options.polling).toEqual({
      autoStart: false,
      params: { timeout: 2 },
    });
    expect(instance?.options.request).toEqual({ timeout: 5_000 });
    expect(h.FakeTelegramBot.instances[0]?.options.request).toEqual({ timeout: 5_000 });
    expect(instance?.startPolling).toHaveBeenCalledTimes(1);
    expect(h.updateChannelStatus).toHaveBeenCalledWith('telegram', 'connected');
  });

  it('serializa dois starts concorrentes e publica somente uma instancia', async () => {
    const first = startTelegramBot(getWindow);
    const second = startTelegramBot(getWindow);

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(pollingInstances()).toHaveLength(1);
  });

  it('start-stop-start usa parada cooperativa sem cancel e deixa somente o bot novo ativo', async () => {
    await startTelegramBot(getWindow);
    const first = pollingInstances()[0]!;

    await startTelegramBot(getWindow);
    const instances = pollingInstances();
    const second = instances[1]!;

    expect(first.stopPolling).toHaveBeenCalledTimes(1);
    expect(first.stopPolling.mock.calls[0]).toHaveLength(0);
    expect(first.isPolling()).toBe(false);
    expect(second.isPolling()).toBe(true);
    expect(isTelegramRunning()).toBe(true);
  });

  it('nao publica bot novo quando a parada do atual nao e confirmada', async () => {
    await startTelegramBot(getWindow);
    const first = pollingInstances()[0]!;
    h.FakeTelegramBot.stopError = new Error('stop falhou');
    h.FakeTelegramBot.stopKeepsPolling = true;

    await expect(startTelegramBot(getWindow)).resolves.toBe(false);

    expect(pollingInstances()).toHaveLength(1);
    expect(first.isPolling()).toBe(true);
    expect(isTelegramRunning()).toBe(false);
    expect(h.updateChannelStatus).toHaveBeenCalledWith(
      'telegram',
      'error',
      'Nao foi possivel parar o Telegram',
    );
  });

  it('409 e terminal, deduplicado e nao cria reconnect', async () => {
    await startTelegramBot(getWindow);
    const instance = pollingInstances()[0]!;

    for (let index = 0; index < 100; index++) {
      instance.emit('polling_error', new Error('ETELEGRAM: 409 Conflict: terminated by other getUpdates request'));
    }
    await settleLifecycle();

    expect(instance.stopPolling).toHaveBeenCalledTimes(1);
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    expect(h.updateChannelStatus).toHaveBeenCalledWith('telegram', 'error', 'Conflict: polling ativo em outra instancia');
    expect(pollingInstances()).toHaveLength(1);
    expect(isTelegramRunning()).toBe(false);
  });

  it('409 tardio de geracao antiga nao derruba o bot atual', async () => {
    await startTelegramBot(getWindow);
    const first = pollingInstances()[0]!;
    await startTelegramBot(getWindow);
    const second = pollingInstances()[1]!;
    h.updateChannelStatus.mockClear();

    first.emit('polling_error', new Error('ETELEGRAM: 409 Conflict: terminated by other getUpdates request'));
    await settleLifecycle();

    expect(second.stopPolling).not.toHaveBeenCalled();
    expect(second.isPolling()).toBe(true);
    expect(isTelegramRunning()).toBe(true);
    expect(h.updateChannelStatus).not.toHaveBeenCalledWith('telegram', 'error', expect.any(String));
  });

  it('stop durante deleteWebhook invalida o start antes de criar polling', async () => {
    let releaseDeleteWebhook: (value: boolean) => void = () => {
      throw new Error('deleteWebhook ainda nao iniciou');
    };
    h.FakeTelegramBot.deleteWebhookFactory = () =>
      new Promise<boolean>((resolve) => {
        releaseDeleteWebhook = resolve;
      });

    const starting = startTelegramBot(getWindow);
    await settleLifecycle();
    const stopping = stopTelegramBot();
    releaseDeleteWebhook(true);

    await expect(starting).resolves.toBe(false);
    await stopping;
    expect(pollingInstances()).toHaveLength(0);
    expect(isTelegramRunning()).toBe(false);
  });

  it('nao inicia polling quando deleteWebhook falha', async () => {
    h.FakeTelegramBot.deleteWebhookFactory = async () => false;

    await expect(startTelegramBot(getWindow)).resolves.toBe(false);
    expect(pollingInstances()).toHaveLength(0);
    expect(h.updateChannelStatus).toHaveBeenCalledWith('telegram', 'error', 'Nao foi possivel preparar o polling');
  });

  it('primeiro ciclo com 409 nunca publica connected', async () => {
    h.FakeTelegramBot.nextStartError = new Error('ETELEGRAM: 409 Conflict: terminated by other getUpdates request');

    await expect(startTelegramBot(getWindow)).resolves.toBe(false);
    await settleLifecycle();
    expect(h.updateChannelStatus).not.toHaveBeenCalledWith('telegram', 'connected');
    expect(isTelegramRunning()).toBe(false);
  });

  it('limita logs de uma rajada de erros transitorios', async () => {
    await startTelegramBot(getWindow);
    const instance = pollingInstances()[0]!;
    h.logger.warn.mockClear();

    for (let index = 0; index < 1_000; index++) {
      instance.emit('polling_error', new Error('EFATAL: read ECONNRESET'));
    }

    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(pollingInstances()).toHaveLength(1);
    expect(isTelegramRunning()).toBe(true);
  });

  it('stop idempotente publica disconnected mesmo sem bot', async () => {
    h.updateChannelStatus.mockClear();

    await stopTelegramBot();

    expect(h.updateChannelStatus).toHaveBeenCalledWith('telegram', 'disconnected');
  });

  it('logout durante mensagem em voo nao inicia query depois do stop', async () => {
    let releaseChatAction: () => void = () => {
      throw new Error('sendChatAction ainda nao iniciou');
    };
    h.FakeTelegramBot.sendChatActionFactory = () =>
      new Promise<boolean>((resolve) => {
        releaseChatAction = () => resolve(true);
      });
    await startTelegramBot(getWindow);
    const instance = pollingInstances()[0]!;
    h.executeTelegramLaneQuery.mockClear();

    instance.emit('message', {
      chat: { id: 42 },
      message_id: 77,
      from: { id: 42, first_name: 'Breno' },
      text: 'teste durante logout',
    });
    await settleLifecycle();

    const stopping = stopTelegramBot();
    releaseChatAction();
    await stopping;
    await settleLifecycle();

    expect(h.executeTelegramLaneQuery).not.toHaveBeenCalled();
    expect(instance.sendMessage).not.toHaveBeenCalled();
  });

  it('logout durante comando pausado nao inicia compactacao nem mutacao', async () => {
    let releaseChatAction: () => void = () => {
      throw new Error('sendChatAction ainda nao iniciou');
    };
    h.FakeTelegramBot.sendChatActionFactory = () =>
      new Promise<boolean>((resolve) => {
        releaseChatAction = () => resolve(true);
      });
    await startTelegramBot(getWindow);
    const instance = pollingInstances()[0]!;
    h.enqueueTelegramLaneTask.mockClear();

    instance.emit('message', {
      chat: { id: 42 },
      message_id: 78,
      from: { id: 42, first_name: 'Breno' },
      text: '/clear',
    });
    await settleLifecycle();

    const stopping = stopTelegramBot();
    releaseChatAction();
    await stopping;
    await settleLifecycle();

    expect(h.enqueueTelegramLaneTask).not.toHaveBeenCalled();
    expect(instance.sendMessage).not.toHaveBeenCalled();
  });

  it('logout durante sendChatAction de voz nao inicia download nem transcricao', async () => {
    let releaseChatAction: () => void = () => {
      throw new Error('sendChatAction ainda nao iniciou');
    };
    h.FakeTelegramBot.sendChatActionFactory = () =>
      new Promise<boolean>((resolve) => {
        releaseChatAction = () => resolve(true);
      });
    await startTelegramBot(getWindow);
    const instance = pollingInstances()[0]!;

    instance.emit('message', {
      chat: { id: 42 },
      message_id: 79,
      from: { id: 42, first_name: 'Breno' },
      voice: { file_id: 'voice-1', duration: 2 },
    });
    await settleLifecycle();

    const stopping = stopTelegramBot();
    releaseChatAction();
    await stopping;
    await settleLifecycle();

    expect(instance.getFileLink).not.toHaveBeenCalled();
    expect(instance.sendMessage).not.toHaveBeenCalled();
  });

  it('stop interrompe resposta segmentada sem enviar chunks restantes', async () => {
    let releaseFirstChunk: () => void = () => {
      throw new Error('primeiro chunk ainda nao iniciou');
    };
    let calls = 0;
    h.FakeTelegramBot.sendMessageFactory = () => {
      calls++;
      if (calls > 1) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        releaseFirstChunk = () => resolve(true);
      });
    };
    await startTelegramBot(getWindow);
    const instance = pollingInstances()[0]!;

    const response = __telegramInternal.sendTelegramResponse(
      42,
      'a'.repeat(9_000),
      instance as never,
      () => isTelegramRunning(),
    );
    await settleLifecycle();

    const stopping = stopTelegramBot();
    releaseFirstChunk();
    await response;
    await stopping;

    expect(instance.sendMessage).toHaveBeenCalledTimes(1);
  });
});

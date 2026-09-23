import TelegramBot from 'node-telegram-bot-api';
import { BrowserWindow } from 'electron';
import crypto from 'crypto';
import {
  getDb,
  createSession,
  getSession,
  updateSessionStatus,
  getSetting,
  listActiveTelegramSessions,
  getSessionMessages,
  setSessionCompactionState,
  setSessionActiveContextTokens,
} from './db';
import { executeTelegramLaneQuery, enqueueTelegramLaneTask, resetTelegramSessionState } from './orchestrator';
import { InvalidOrchestratorSelectionError } from './orchestrator-selection';
import { smokeAudit } from './smoke-audit';
import { buildExecutionError, translateProviderError } from './agent-runtime/llm-error';
import { runtimeSupportsImageInput } from './agent-runtime/runtime-capabilities';
import { describeImage, buildTranscriptionBlock, visionUnavailableNotice } from './vision-engine';
import type { OrchestratorRuntime } from '../../src/types';
import { runCompaction, isCompactionStepError } from './memory-pipeline';
import { tryAcquireDreamingMutex } from './dreaming-mutex';
import { estimateTokens } from './token-estimator';
import { getModelContextWindow } from './pricing';
import type { ChatMessage, ChatSession } from '../../src/types';
import { getSecret, getSecretNonInteractiveOrThrow } from './secrets-vault';
import { updateChannelStatus } from './channels-db';
import { createLogger } from './logger';
import { getAllScheduledTasks, getPendingReviewCount } from './scheduler';
import { transcribeAudio } from './voice-engine';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as XLSX from 'xlsx';

const logger = createLogger('telegram');

function telegramErrorReply(error: unknown): string {
  const typed = translateProviderError(error);
  return `${typed.userMessage} ${typed.suggestedAction}`;
}

export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export const TELEGRAM_DOC_TEXT_MAX_CHARS = 200_000;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 bytes';
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  const rendered =
    mb >= 100 ? String(Math.round(mb)) : (Math.round(mb * 10) / 10).toFixed(1).replace(/\.0$/, '').replace('.', ',');
  return `${rendered} MB`;
}

let bot: TelegramBot | null = null;
let getWindowFn: (() => BrowserWindow | null) | null = null;
let activeSessionId: string | null = null;
let botGeneration = 0;
let lifecycleEpoch = 0;
let lifecycleTransition: Promise<void> = Promise.resolve();
const stoppingBotGenerations = new Set<number>();
const processedMessageIds = new Set<string>();
const MAX_PROCESSED_IDS = 500;
const TELEGRAM_LONG_POLL_TIMEOUT_SECONDS = 2;
const TELEGRAM_HTTP_TIMEOUT_MS = 5_000;
const TELEGRAM_STOP_TIMEOUT_MS = TELEGRAM_HTTP_TIMEOUT_MS + 2_000;
const TELEGRAM_TRANSIENT_LOG_INTERVAL_MS = 60_000;
const TELEGRAM_REQUEST_OPTIONS = {
  timeout: TELEGRAM_HTTP_TIMEOUT_MS,
} as TelegramBot.ConstructorOptions['request'];

type TelegramConflictKind = 'another-poller' | 'webhook-active' | 'unknown';

function serializeTelegramLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const next = lifecycleTransition.then(operation, operation);
  lifecycleTransition = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function sanitizeTelegramErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

async function withTelegramTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function classifyTelegramConflict(message: string): TelegramConflictKind {
  const normalized = message.toLowerCase();
  if (normalized.includes('webhook')) return 'webhook-active';
  if (
    normalized.includes('getupdates') ||
    normalized.includes('another instance') ||
    normalized.includes('terminated by other')
  ) {
    return 'another-poller';
  }
  return 'unknown';
}

function isCurrentBot(instance: TelegramBot, generation: number): boolean {
  return bot === instance && botGeneration === generation && !stoppingBotGenerations.has(generation);
}

function getActiveBotInstance(): TelegramBot | null {
  const instance = bot;
  return instance && isCurrentBot(instance, botGeneration) ? instance : null;
}

async function stopBotInstance(instance: TelegramBot, generation: number): Promise<boolean> {
  stoppingBotGenerations.add(generation);
  let stopError: unknown = null;
  try {
    await withTelegramTimeout(instance.stopPolling(), TELEGRAM_STOP_TIMEOUT_MS, 'Telegram polling stop timed out');
  } catch (error) {
    stopError = error;
  }

  if (instance.isPolling()) {
    const safeError = sanitizeTelegramErrorMessage(stopError ?? new Error('Polling permaneceu ativo apos stop'));
    logger.error({ error: safeError }, 'Telegram: polling stop not confirmed');
    updateChannelStatus('telegram', 'error', 'Nao foi possivel parar o Telegram');
    return false;
  }

  if (stopError !== null) {
    logger.warn({ error: sanitizeTelegramErrorMessage(stopError) }, 'Telegram: polling stopped after stop error');
  }
  if (bot === instance && botGeneration === generation) {
    bot = null;
    botGeneration++;
  }
  stoppingBotGenerations.delete(generation);
  instance.removeAllListeners();
  return true;
}

interface TelegramConfig {
  allowedUserId: number;
  allowedUserName: string;
  botUsername?: string;
  sessionMode: 'continuous' | 'per-message';
  notifyOnSchedulerTasks: boolean;
  notifyOnDriveHandoff: boolean;
}

export async function startTelegramBot(
  getWindow: () => BrowserWindow | null,
  options: { nonInteractive?: boolean } = {},
): Promise<boolean> {
  const requestedEpoch = ++lifecycleEpoch;
  return serializeTelegramLifecycle(async () => {
    if (requestedEpoch !== lifecycleEpoch) return false;
    getWindowFn = getWindow;

    if (bot) {
      logger.info('Telegram: stopping existing bot before restart');
      const oldBot = bot;
      const oldGeneration = botGeneration;
      if (!(await stopBotInstance(oldBot, oldGeneration))) return false;
      if (requestedEpoch !== lifecycleEpoch) return false;
    }

    try {
      const token = options.nonInteractive
        ? await getSecretNonInteractiveOrThrow('TELEGRAM_BOT_TOKEN')
        : await getSecret('TELEGRAM_BOT_TOKEN');
      if (requestedEpoch !== lifecycleEpoch) return false;
      if (!token) {
        logger.warn('Telegram bot token not configured, skipping');
        return false;
      }

      const config = getTelegramConfig();
      if (!config || !config.allowedUserId) {
        logger.warn('Telegram allowedUserId not configured, skipping');
        return false;
      }

      const allowedUserId = config.allowedUserId;

      const cleanupBot = new TelegramBot(token, {
        polling: false,
        request: TELEGRAM_REQUEST_OPTIONS,
      });
      const deleteWebhook = cleanupBot.deleteWebHook.bind(cleanupBot) as () => Promise<boolean>;
      let webhookDeleted = false;
      try {
        webhookDeleted = await withTelegramTimeout(
          deleteWebhook(),
          TELEGRAM_HTTP_TIMEOUT_MS,
          'Telegram deleteWebhook timed out',
        );
      } finally {
        cleanupBot.removeAllListeners();
      }
      if (requestedEpoch !== lifecycleEpoch) return false;
      if (!webhookDeleted) {
        updateChannelStatus('telegram', 'error', 'Nao foi possivel preparar o polling');
        logger.warn('Telegram: deleteWebhook failed or timed out; polling not started');
        return false;
      }

      const currentBot = new TelegramBot(token, {
        polling: {
          autoStart: false,
          params: { timeout: TELEGRAM_LONG_POLL_TIMEOUT_SECONDS },
        },
        request: TELEGRAM_REQUEST_OPTIONS,
      });
      const generation = ++botGeneration;
      bot = currentBot;
      let conflictHandled = false;
      let lastTransientErrorMessage = '';
      let lastTransientErrorLogAt = 0;
      let suppressedTransientErrors = 0;

      void currentBot
        .setMyCommands([
          { command: 'compact', description: 'Compacta a conversa (mesmo contexto, mais enxuto)' },
          { command: 'clear', description: 'Arquiva a conversa e comeca uma nova' },
          { command: 'reset', description: 'Igual ao /clear' },
          { command: 'status', description: 'Sessao atual, contexto e tokens' },
          { command: 'tasks', description: 'Tarefas agendadas' },
          { command: 'help', description: 'Lista de comandos' },
        ])
        .then(() => logger.info('Telegram: menu de comandos registrado (setMyCommands)'))
        .catch((error) =>
          logger.warn(
            { error: sanitizeTelegramErrorMessage(error) },
            'Telegram: setMyCommands falhou (menu de autocomplete; nao-fatal)',
          ),
        );

      currentBot.on('message', async (msg) => {
        if (!isCurrentBot(currentBot, generation)) return;
        const dedupKey = `${msg.chat.id}:${msg.message_id}`;
        if (processedMessageIds.has(dedupKey)) {
          logger.debug({ messageId: msg.message_id, chatId: msg.chat.id }, 'Telegram: duplicate message, skipping');
          return;
        }
        processedMessageIds.add(dedupKey);
        if (processedMessageIds.size > MAX_PROCESSED_IDS) {
          const oldest = processedMessageIds.values().next().value;
          if (oldest !== undefined) processedMessageIds.delete(oldest);
        }

        if (!msg.from?.id || msg.from.id !== allowedUserId) {
          logger.warn({ fromId: msg.from?.id }, 'Telegram: unauthorized user, ignoring');
          return;
        }

        const userName = config.allowedUserName || msg.from?.first_name || 'Usuario';

        if (msg.voice) {
          logger.info({ duration: msg.voice.duration, user: userName }, 'Telegram: voice message received');

          try {
            await currentBot.sendChatAction(msg.chat.id, 'typing');
            if (!isCurrentBot(currentBot, generation)) return;

            const fileLink = await currentBot.getFileLink(msg.voice.file_id);
            if (!isCurrentBot(currentBot, generation)) return;
            const audioResponse = await fetch(fileLink);
            if (!isCurrentBot(currentBot, generation)) return;
            const audioBytes = await audioResponse.arrayBuffer();
            if (!isCurrentBot(currentBot, generation)) return;
            const audioBuffer = Buffer.from(audioBytes);
            const audioBase64 = audioBuffer.toString('base64');

            const transcribedText = await transcribeAudio(audioBase64, 'ogg');
            if (!isCurrentBot(currentBot, generation)) return;

            if (!transcribedText.trim()) {
              if (!isCurrentBot(currentBot, generation)) return;
              await currentBot.sendMessage(msg.chat.id, 'Nao consegui entender o audio. Tente novamente.');
              return;
            }

            logger.info({ text: transcribedText.substring(0, 50) }, 'Telegram: voice transcribed');

            if (!isCurrentBot(currentBot, generation)) return;
            const sessionId = getOrCreateTelegramSession();
            const response = await executeTelegramQuery(
              transcribedText,
              sessionId,
              msg.chat.id,
              userName,
              undefined,
              currentBot,
              () => isCurrentBot(currentBot, generation),
            );
            if (!isCurrentBot(currentBot, generation)) return;
            await sendTelegramResponse(msg.chat.id, response, currentBot, () => isCurrentBot(currentBot, generation));
          } catch (error) {
            if (!isCurrentBot(currentBot, generation)) return;
            logger.error({ error }, 'Telegram: voice processing failed');
            await currentBot.sendMessage(msg.chat.id, telegramErrorReply(error));
          }
          return;
        }

        if (msg.photo && msg.photo.length > 0) {
          logger.info({ sizes: msg.photo.length, user: userName }, 'Telegram: photo received');
          try {
            await currentBot.sendChatAction(msg.chat.id, 'typing');
            if (!isCurrentBot(currentBot, generation)) return;

            const largest = msg.photo[msg.photo.length - 1];
            const fileLink = await currentBot.getFileLink(largest.file_id);
            if (!isCurrentBot(currentBot, generation)) return;
            const imgResponse = await fetch(fileLink);
            if (!isCurrentBot(currentBot, generation)) return;
            const imageBytes = await imgResponse.arrayBuffer();
            if (!isCurrentBot(currentBot, generation)) return;
            const imgBuffer = Buffer.from(imageBytes);
            const base64 = imgBuffer.toString('base64');

            const attachment = {
              id: `tg-${msg.chat.id}-${msg.message_id}`,
              type: 'image',
              filename: `telegram-${msg.message_id}.jpg`,
              mimeType: 'image/jpeg',
              data: base64,
              size: imgBuffer.length,
            };

            const captionText = msg.caption?.trim() || 'O usuario enviou esta imagem. Analise e responda.';
            const sessionId = getOrCreateTelegramSession();
            const resolved = await transcribeAndResolveImageTurn(msg.chat.id, captionText, attachment, currentBot, () =>
              isCurrentBot(currentBot, generation),
            );
            if (!isCurrentBot(currentBot, generation)) return;
            const response = await executeTelegramQuery(
              resolved.text,
              sessionId,
              msg.chat.id,
              userName,
              resolved.attachment ? [resolved.attachment] : undefined,
              currentBot,
              () => isCurrentBot(currentBot, generation),
            );
            if (!isCurrentBot(currentBot, generation)) return;
            await sendTelegramResponse(msg.chat.id, response, currentBot, () => isCurrentBot(currentBot, generation));
          } catch (error) {
            if (!isCurrentBot(currentBot, generation)) return;
            logger.error({ error }, 'Telegram: photo processing failed');
            await currentBot.sendMessage(msg.chat.id, 'Erro ao processar imagem.');
          }
          return;
        }

        if (msg.document && msg.document.mime_type?.startsWith('image/')) {
          logger.info({ mime: msg.document.mime_type, user: userName }, 'Telegram: image document received');
          try {
            await currentBot.sendChatAction(msg.chat.id, 'typing');
            if (!isCurrentBot(currentBot, generation)) return;

            const fileLink = await currentBot.getFileLink(msg.document.file_id);
            if (!isCurrentBot(currentBot, generation)) return;
            const imgResponse = await fetch(fileLink);
            if (!isCurrentBot(currentBot, generation)) return;
            const imageBytes = await imgResponse.arrayBuffer();
            if (!isCurrentBot(currentBot, generation)) return;
            const imgBuffer = Buffer.from(imageBytes);
            const base64 = imgBuffer.toString('base64');
            const mimeType = msg.document.mime_type;
            const ext = mimeType.split('/')[1] || 'jpg';

            const attachment = {
              id: `tg-${msg.chat.id}-${msg.message_id}`,
              type: 'image',
              filename: msg.document.file_name || `telegram-${msg.message_id}.${ext}`,
              mimeType,
              data: base64,
              size: imgBuffer.length,
            };

            const captionText = msg.caption?.trim() || 'O usuario enviou esta imagem. Analise e responda.';
            const sessionId = getOrCreateTelegramSession();
            const resolved = await transcribeAndResolveImageTurn(msg.chat.id, captionText, attachment, currentBot, () =>
              isCurrentBot(currentBot, generation),
            );
            if (!isCurrentBot(currentBot, generation)) return;
            const response = await executeTelegramQuery(
              resolved.text,
              sessionId,
              msg.chat.id,
              userName,
              resolved.attachment ? [resolved.attachment] : undefined,
              currentBot,
              () => isCurrentBot(currentBot, generation),
            );
            if (!isCurrentBot(currentBot, generation)) return;
            await sendTelegramResponse(msg.chat.id, response, currentBot, () => isCurrentBot(currentBot, generation));
          } catch (error) {
            if (!isCurrentBot(currentBot, generation)) return;
            logger.error({ error }, 'Telegram: image document processing failed');
            await currentBot.sendMessage(msg.chat.id, 'Erro ao processar imagem.');
          }
          return;
        }

        if (msg.animation) {
          await replyUnprocessableAttachment(msg.chat.id, 'animation', currentBot, () =>
            isCurrentBot(currentBot, generation),
          );
          return;
        }

        if (msg.document) {
          try {
            await handleIncomingDocument(msg, msg.chat.id, userName, currentBot, () =>
              isCurrentBot(currentBot, generation),
            );
          } catch (error) {
            if (!isCurrentBot(currentBot, generation)) return;
            logger.error({ error }, 'Telegram: document processing failed');
            await currentBot.sendMessage(msg.chat.id, 'Erro ao processar o documento. Tente novamente.');
          }
          return;
        }

        if (msg.audio) {
          await replyUnprocessableAttachment(msg.chat.id, 'audio', currentBot, () =>
            isCurrentBot(currentBot, generation),
          );
          return;
        }
        if (msg.video) {
          await replyUnprocessableAttachment(msg.chat.id, 'video', currentBot, () =>
            isCurrentBot(currentBot, generation),
          );
          return;
        }
        if (msg.video_note) {
          await replyUnprocessableAttachment(msg.chat.id, 'video_note', currentBot, () =>
            isCurrentBot(currentBot, generation),
          );
          return;
        }
        if (msg.sticker) {
          await replyUnprocessableAttachment(msg.chat.id, 'sticker', currentBot, () =>
            isCurrentBot(currentBot, generation),
          );
          return;
        }
        if (msg.contact || msg.location || msg.venue || msg.poll || msg.dice) {
          await replyUnprocessableAttachment(msg.chat.id, 'outro', currentBot, () =>
            isCurrentBot(currentBot, generation),
          );
          return;
        }

        const text = msg.text;
        if (!text) {
          logger.info({ user: userName }, 'Telegram: unsupported message type, ignoring');
          return;
        }

        if (text.startsWith('/')) {
          await handleBotCommand(text, msg.chat.id, config, currentBot, () => isCurrentBot(currentBot, generation));
          return;
        }

        logger.info({ text: text.substring(0, 50), user: userName }, 'Telegram: message received');

        try {
          await currentBot.sendChatAction(msg.chat.id, 'typing');

          if (!isCurrentBot(currentBot, generation)) return;
          const sessionId = getOrCreateTelegramSession();
          const response = await executeTelegramQuery(
            text,
            sessionId,
            msg.chat.id,
            userName,
            undefined,
            currentBot,
            () => isCurrentBot(currentBot, generation),
          );
          if (!isCurrentBot(currentBot, generation)) return;
          await sendTelegramResponse(msg.chat.id, response, currentBot, () => isCurrentBot(currentBot, generation));
        } catch (error) {
          if (!isCurrentBot(currentBot, generation)) return;
          logger.error({ error }, 'Telegram: query failed');
          await currentBot.sendMessage(msg.chat.id, telegramErrorReply(error));
        }
      });

      currentBot.on('callback_query', (query) => {
        if (!isCurrentBot(currentBot, generation)) return;
        if (query.from.id !== allowedUserId) return;
        currentBot.answerCallbackQuery(query.id).catch(() => {});
      });

      currentBot.on('inline_query', (query) => {
        if (!isCurrentBot(currentBot, generation)) return;
        if (query.from.id !== allowedUserId) return;
      });

      currentBot.on('polling_error', (error) => {
        if (!isCurrentBot(currentBot, generation)) return;

        const safeMessage = sanitizeTelegramErrorMessage(error);
        const normalizedMessage = safeMessage.toLowerCase();
        const is409 = safeMessage.includes('409') || normalizedMessage.includes('conflict');

        if (!is409) {
          const now = Date.now();
          if (
            safeMessage !== lastTransientErrorMessage ||
            now - lastTransientErrorLogAt >= TELEGRAM_TRANSIENT_LOG_INTERVAL_MS
          ) {
            logger.warn(
              { error: safeMessage, suppressed: suppressedTransientErrors },
              'Telegram: transient polling error (library will retry)',
            );
            lastTransientErrorMessage = safeMessage;
            lastTransientErrorLogAt = now;
            suppressedTransientErrors = 0;
          } else {
            suppressedTransientErrors++;
          }
          return;
        }

        if (conflictHandled) return;
        conflictHandled = true;
        const conflictKind = classifyTelegramConflict(safeMessage);
        ++lifecycleEpoch;
        logger.error(
          { conflictKind, error: safeMessage },
          'Telegram: polling conflict detected; stopping this activation',
        );
        updateChannelStatus(
          'telegram',
          'error',
          conflictKind === 'webhook-active' ? 'Conflict: webhook ativo' : 'Conflict: polling ativo em outra instancia',
        );

        void serializeTelegramLifecycle(async () => {
          await stopBotInstance(currentBot, generation);
        });
      });

      await currentBot.startPolling();
      if (requestedEpoch !== lifecycleEpoch || conflictHandled || !isCurrentBot(currentBot, generation)) {
        return false;
      }

      updateChannelStatus('telegram', 'connected');
      logger.info('Telegram bot started and completed first polling cycle');
      return true;
    } catch (error) {
      const safeMessage = sanitizeTelegramErrorMessage(error);
      if (bot) {
        const failedBot = bot;
        const failedGeneration = botGeneration;
        await stopBotInstance(failedBot, failedGeneration);
      }
      if (requestedEpoch === lifecycleEpoch) {
        updateChannelStatus('telegram', 'error', safeMessage);
        logger.error({ error: safeMessage }, 'Telegram bot failed to start');
      }
      return false;
    }
  });
}

export function stopTelegramBot(): Promise<void> {
  const requestedEpoch = ++lifecycleEpoch;
  if (bot) stoppingBotGenerations.add(botGeneration);
  return serializeTelegramLifecycle(async () => {
    if (!bot) {
      if (requestedEpoch === lifecycleEpoch) {
        updateChannelStatus('telegram', 'disconnected');
      }
      return;
    }
    const oldBot = bot;
    const oldGeneration = botGeneration;
    const stopped = await stopBotInstance(oldBot, oldGeneration);
    if (!stopped || requestedEpoch !== lifecycleEpoch) return;
    updateChannelStatus('telegram', 'disconnected');
    logger.info('Telegram bot stopped');
  });
}

export function isTelegramRunning(): boolean {
  return bot !== null && isCurrentBot(bot, botGeneration) && bot.isPolling();
}

interface TelegramImageAttachment {
  id: string;
  type: string;
  filename: string;
  mimeType: string;
  data: string;
  size: number;
}

interface ResolvedImageTurn {
  text: string;
  attachment?: TelegramImageAttachment;
}

async function transcribeAndResolveImageTurn(
  chatId: number,
  captionText: string,
  attachment: TelegramImageAttachment,
  currentBot: TelegramBot | null = getActiveBotInstance(),
  isActive: () => boolean = () => currentBot !== null && currentBot === getActiveBotInstance(),
): Promise<ResolvedImageTurn> {
  const runtime = ((getSetting('orchestrator_runtime') || '').trim() || 'claude-sdk') as OrchestratorRuntime;
  const supportsNative = runtimeSupportsImageInput(runtime);
  const nativeAttachment = supportsNative ? attachment : undefined;
  const inactiveResult = { text: captionText, attachment: nativeAttachment };
  if (!isActive()) return inactiveResult;

  let text = captionText;
  let visionUsed = false;

  try {
    const transcription = await describeImage({
      data: attachment.data,
      mimeType: attachment.mimeType,
      hint: captionText,
    });
    if (!isActive()) return inactiveResult;
    if (transcription.trim()) {
      text = buildTranscriptionBlock(captionText, transcription);
      visionUsed = true;
    }
  } catch (err) {
    if (!isActive()) return inactiveResult;
    logger.warn({ err, runtime }, 'Telegram: vision indisponivel; turno segue so com texto');
    try {
      if (currentBot && isActive()) {
        await currentBot.sendMessage(chatId, visionUnavailableNotice(err));
      }
    } catch (sendErr) {
      logger.warn({ err: sendErr }, 'Telegram: falha ao enviar aviso de vision indisponivel');
    }
  }

  if (!isActive()) return inactiveResult;

  smokeAudit('attachment_capability', {
    lane: 'telegram',
    runtime,
    supported: supportsNative,
    noticeSent: !visionUsed,
    visionUsed,
  });

  return { text, attachment: nativeAttachment };
}

export async function sendTelegramNotification(text: string): Promise<void> {
  const currentBot = bot;
  const generation = botGeneration;
  if (!currentBot || !isCurrentBot(currentBot, generation)) {
    throw new Error('Telegram bot offline');
  }

  const config = getTelegramConfig();
  if (!config?.allowedUserId) throw new Error('Telegram sem destinatario configurado');

  try {
    await sendTelegramResponse(config.allowedUserId, text, currentBot, () => isCurrentBot(currentBot, generation));
  } catch (error) {
    logger.error({ error }, 'Failed to send Telegram notification');
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function notifyDriveHandoff(text: string): Promise<void> {
  if (!isTelegramRunning()) return;
  const config = getTelegramConfig();
  if (!config?.notifyOnDriveHandoff) return;
  try {
    await sendTelegramNotification(text);
  } catch (error) {
    logger.warn({ error }, 'Telegram drive handoff notification failed');
  }
}

export async function sendTelegramPhoto(
  chatId: number,
  base64: string,
  mimeType: string,
  caption?: string,
  currentBot: TelegramBot | null = getActiveBotInstance(),
  isActive: () => boolean = () => currentBot !== null && currentBot === getActiveBotInstance(),
): Promise<void> {
  if (!currentBot || !isActive()) return;

  try {
    const buffer = Buffer.from(base64, 'base64');

    if (buffer.length > TELEGRAM_MAX_PHOTO_BYTES) {
      logger.info({ sizeBytes: buffer.length }, 'Telegram: foto acima do limite de envio');
      if (!isActive()) return;
      await currentBot.sendMessage(
        chatId,
        `Gerei a imagem, mas ela tem ${formatBytes(buffer.length)} e passou do limite de ${formatBytes(TELEGRAM_MAX_PHOTO_BYTES)} para fotos no Telegram.`,
      );
      return;
    }

    const ext = mimeType.includes('png') ? 'png' : 'jpg';

    if (!isActive()) return;
    await currentBot.sendPhoto(
      chatId,
      buffer,
      {
        caption: caption?.substring(0, 1024),
      },
      {
        filename: `image.${ext}`,
        contentType: mimeType,
      },
    );

    logger.info('Telegram: photo sent');
  } catch (error) {
    logger.error({ error }, 'Failed to send Telegram photo');
  }
}

export async function sendTelegramDocument(
  chatId: number,
  file: Buffer | string,
  fileName: string,
  mimeType?: string,
  caption?: string,
  currentBot: TelegramBot | null = getActiveBotInstance(),
  isActive: () => boolean = () => currentBot !== null && currentBot === getActiveBotInstance(),
): Promise<void> {
  if (!currentBot || !isActive()) return;

  try {
    const buffer = typeof file === 'string' ? fs.readFileSync(file) : file;

    if (!isActive()) return;
    await currentBot.sendDocument(
      chatId,
      buffer,
      {
        caption: caption?.substring(0, 1024),
      },
      {
        filename: fileName,
        contentType: mimeType || 'application/octet-stream',
      },
    );

    logger.info({ fileName, sizeBytes: buffer.length }, 'Telegram: document sent');
  } catch (error) {
    logger.error({ error, fileName }, 'Failed to send Telegram document');
  }
}

export function isTelegramConfigured(): boolean {
  const config = getTelegramConfig();
  return config !== null && config.notifyOnSchedulerTasks;
}

async function handleBotCommand(
  text: string,
  chatId: number,
  _config: TelegramConfig,
  currentBot: TelegramBot | null = getActiveBotInstance(),
  isActive: () => boolean = () => currentBot !== null && currentBot === getActiveBotInstance(),
): Promise<void> {
  if (!currentBot || !isActive()) return;

  const command = text.split(' ')[0].toLowerCase();

  switch (command) {
    case '/compact': {
      const sessionId = getOrCreateTelegramSession();
      await currentBot.sendChatAction(chatId, 'typing').catch(() => {});
      if (!isActive()) return;
      const outcome = await enqueueTelegramLaneTask(() =>
        compactTelegramSessionInPlace(sessionId, {
          force: true,
          currentBot,
          isActive,
        }),
      );
      if (!isActive()) return;
      if (outcome.ok && outcome.noop && outcome.reason === 'dreaming_busy') {
        await currentBot.sendMessage(chatId, TELEGRAM_DREAMING_BUSY_MESSAGE);
      } else if (outcome.ok && outcome.noop) {
        await currentBot.sendMessage(
          chatId,
          'Nada novo para compactar desde a ultima compactacao. Seguimos na mesma conversa.',
        );
      }
      break;
    }
    case '/clear':
    case '/reset': {
      const sessionId = getOrCreateTelegramSession();
      await currentBot.sendChatAction(chatId, 'typing').catch(() => {});
      if (!isActive()) return;
      const outcome = await enqueueTelegramLaneTask(() =>
        compactTelegramSessionInPlace(sessionId, {
          force: true,
          notify: false,
          currentBot,
          isActive,
        }),
      );
      if (!isActive()) return;
      if (!outcome.ok) {
        await currentBot.sendMessage(
          chatId,
          'Nao consegui salvar a conversa na memoria agora, entao nao encerrei nada. A conversa continua; tente de novo em breve.',
        );
        break;
      }
      updateSessionStatus(sessionId, 'archived');
      activeSessionId = null;
      resetTelegramSessionState();
      await currentBot.sendMessage(chatId, 'Conversa salva na memoria e encerrada. Proxima mensagem comeca do zero.');
      break;
    }
    case '/status': {
      const db = getDb();
      const sessionCount = (
        db.prepare("SELECT COUNT(*) as c FROM sessions WHERE type = 'telegram' AND status = 'active'").get() as {
          c: number;
        }
      ).c;
      const pendingReviews = getPendingReviewCount();
      const tasks = getAllScheduledTasks().filter((t) => t.status === 'active');

      const sessionId = getOrCreateTelegramSession();
      const session = getSession(sessionId);
      const tokensAtivos = session ? getActiveContextTokens(session) : 0;
      const threshold = getTelegramCompactionThreshold();
      const target = readPositiveNumberSetting(
        'telegram_compaction_target_tokens',
        DEFAULT_TELEGRAM_COMPACTION_TARGET_TOKENS,
      );
      const pct = threshold > 0 ? Math.round((tokensAtivos / threshold) * 100) : 0;

      let statusMsg = '== Status do LionClaw ==\n\n';
      statusMsg += `Sessao Telegram ativa: ${activeSessionId ? 'Sim' : 'Nao'}\n`;
      statusMsg += `Sessoes Telegram total: ${sessionCount}\n`;
      statusMsg += `Contexto: ${tokensAtivos} / ${threshold} (${pct}%) | alvo pos-compactacao: ${target}\n`;
      statusMsg += `Tasks agendadas ativas: ${tasks.length}\n`;
      statusMsg += `Reviews pendentes: ${pendingReviews}\n`;

      if (!isActive()) return;
      await currentBot.sendMessage(chatId, statusMsg);
      break;
    }
    case '/tasks': {
      const tasks = getAllScheduledTasks();
      if (tasks.length === 0) {
        if (!isActive()) return;
        await currentBot.sendMessage(chatId, 'Nenhuma task agendada.');
        break;
      }

      let msg = '== Tasks Agendadas ==\n\n';
      for (const task of tasks) {
        const statusEmoji = task.status === 'active' ? 'ON' : task.status === 'paused' ? 'PAUSA' : 'OK';
        msg += `[${statusEmoji}] ${task.name}\n`;
        if (task.nextRun) msg += `  Proxima: ${new Date(task.nextRun).toLocaleString('pt-BR')}\n`;
        msg += `  Execucoes: ${task.runCount}\n\n`;
      }

      const pendingCount = getPendingReviewCount();
      if (pendingCount > 0) {
        msg += `\n${pendingCount} review(s) pendente(s) no app.`;
      }

      if (!isActive()) return;
      await currentBot.sendMessage(chatId, msg);
      break;
    }
    default: {
      if (!isActive()) return;
      await currentBot.sendMessage(
        chatId,
        'Comandos disponiveis:\n' +
          '/compact - Compacta a conversa (mesma conversa, contexto condensado)\n' +
          '/clear - Salva na memoria e encerra; proxima mensagem comeca do zero\n' +
          '/reset - Alias de /clear\n' +
          '/status - Status do sistema e contexto da conversa\n' +
          '/tasks - Tasks agendadas',
      );
    }
  }
}

const TELEGRAM_CONTEXT = `[SISTEMA — CANAL TELEGRAM]
Esta conversa acontece pelo Telegram. O usuario esta no celular/desktop do Telegram, NAO no app LionClaw.

## COMO ENVIAR VOZ NO TELEGRAM
Voce tem a tool "text_to_speech" do MCP ElevenLabs. Quando voce a usa, o sistema detecta o audio gerado e envia automaticamente como voice message no Telegram. O usuario recebe e ouve direto no chat.

QUANDO USAR text_to_speech:
- O usuario pede "fala isso", "manda audio", "me responde em voz", "quero ouvir"
- O usuario manda voice message (audio) para voce — responda com text_to_speech tambem
- Qualquer situacao onde audio faz mais sentido que texto

COMO USAR:
- Chame a tool "text_to_speech" com o texto que quer falar. Omita voice_id para usar a voz padrao configurada.
- So informe voice_id se o usuario pedir explicitamente outra voz.
- O audio chega automaticamente ao usuario como voice message — voce NAO precisa fazer mais nada
- Para multiplos audios (ex: previews de vozes), chame a tool UMA VEZ POR AUDIO
- NUNCA mencione nomes de arquivo, paths ou ARQUIVO_AUDIO na resposta — o usuario so ve o audio

Para previews/samples de vozes, use "preview_voice" com o voice_id. Mesmo mecanismo.

## IMAGENS
Use as tools normalmente (nano-banana, etc). O sistema envia como foto no Telegram automaticamente.

## ENVIO DE ARQUIVOS GERADOS
Para enviar um arquivo que voce gerou (PDF, CSV, planilha, ZIP, codigo, imagem como documento, qualquer tipo), inclua na sua resposta uma linha propria exatamente assim:
ENVIAR_ARQUIVO: <caminho absoluto>
O sistema envia o arquivo automaticamente pelo Telegram e o usuario nunca ve o caminho. Limite: 50 MB por arquivo. Uma linha ENVIAR_ARQUIVO por arquivo.

## REGRAS GERAIS
- NUNCA mencione caminhos de arquivo (C:\\, /tmp/, etc) — o usuario nao tem acesso
- Formatacao: Markdown basico (*negrito*, _italico_). Evite tabelas e blocos de codigo longos.
- Seja conciso — mensagens longas ficam ruins no Telegram
[/SISTEMA]

`;

async function executeTelegramQuery(
  text: string,
  sessionId: string,
  chatId: number,
  userName?: string,
  attachments?: Array<{
    id: string;
    type: string;
    filename: string;
    mimeType: string;
    data: string;
    size: number;
  }>,
  currentBot: TelegramBot | null = getActiveBotInstance(),
  isActive: () => boolean = () => true,
): Promise<string> {
  const userPrefix = userName ? `[Mensagem de: ${userName}]\n` : '';
  const contextualMessage = TELEGRAM_CONTEXT + userPrefix + text;

  const db = getDb();
  const lastBefore = db
    .prepare("SELECT id FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
    .get(sessionId) as { id: number } | undefined;
  const lastIdBefore = lastBefore?.id ?? 0;

  try {
    await executeTelegramLaneQuery(
      contextualMessage,
      {
        sessionId,
        silent: true,
        displayMessage: text,
        attachments,
        skipVisionTranscription: true,
      },
      getWindowFn || (() => null),
    );
  } catch (err) {
    if (err instanceof InvalidOrchestratorSelectionError) {
      smokeAudit('orchestrator_error', {
        lane: 'telegram',
        code: err.code,
        missingField: err.missingField ?? null,
      });
      logger.error(
        { sessionId, code: err.code, missingField: err.missingField },
        'Telegram: selection do orquestrador falhou (erro tipado)',
      );
      if (err.code === 'orchestrator_unconfigured') {
        return 'Orquestrador nao configurado: abra Configuracoes no app.';
      }
      return err.message;
    }
    throw err;
  }

  if (!isActive()) return '';

  const row = db
    .prepare(
      "SELECT id, content, metadata FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
    )
    .get(sessionId) as { id: number; content: string; metadata?: string } | undefined;

  if (!row || row.id <= lastIdBefore) {
    logger.warn(
      { sessionId, lastIdBefore },
      'Telegram: no new assistant message after executeQuery — possible silent failure',
    );
    const empty = buildExecutionError('LLM-EMPTY');
    return `${empty.userMessage} ${empty.suggestedAction}`;
  }

  const tgWin = getWindowFn?.();
  if (tgWin && !tgWin.isDestroyed() && isActive()) tgWin.webContents.send('chat:sessions-updated');
  if (isActive()) void maybeCompactTelegramSession(sessionId, currentBot, isActive);

  const sentDocumentPaths = new Set<string>();

  if (row?.metadata) {
    try {
      const meta = JSON.parse(row.metadata);
      if (meta.artifacts && currentBot && isActive()) {
        for (const artifact of meta.artifacts) {
          if (!isActive()) break;
          if (artifact.type === 'image' && artifact.data?.imageBase64) {
            await sendTelegramPhoto(
              chatId,
              artifact.data.imageBase64,
              artifact.data.mimeType || 'image/png',
              artifact.data.prompt || 'Imagem gerada',
              currentBot,
              isActive,
            );
          }
          if (artifact.type === 'audio' && (artifact.data?.audioBase64 || artifact.data?.filePath)) {
            try {
              let audioBuffer: Buffer | null = null;
              let ext = '.mp3';
              if (typeof artifact.data.audioBase64 === 'string' && artifact.data.audioBase64) {
                audioBuffer = Buffer.from(artifact.data.audioBase64, 'base64');
                ext =
                  typeof artifact.data.mimeType === 'string' && artifact.data.mimeType.includes('ogg')
                    ? '.ogg'
                    : '.mp3';
              } else if (typeof artifact.data.filePath === 'string' && fs.existsSync(artifact.data.filePath)) {
                audioBuffer = fs.readFileSync(artifact.data.filePath);
                ext = path.extname(artifact.data.filePath).toLowerCase();
              }
              if (audioBuffer && isActive()) {
                const contentType = ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg';
                const filename = ext === '.ogg' ? 'audio.ogg' : 'audio.mp3';
                await currentBot.sendVoice(chatId, audioBuffer, {}, { filename, contentType });
                logger.info({ fromMemory: !!artifact.data.audioBase64 }, 'Telegram: audio artifact sent as voice');
              }
            } catch (err) {
              logger.warn({ err, filePath: artifact.data.filePath }, 'Failed to send audio artifact via Telegram');
            }
          }
          if (artifact.type === 'document' && typeof artifact.data?.filePath === 'string') {
            await sendDocumentPathViaTelegram(
              chatId,
              artifact.data.filePath,
              typeof artifact.data.fileName === 'string' ? artifact.data.fileName : undefined,
              typeof artifact.data.mimeType === 'string' ? artifact.data.mimeType : undefined,
              typeof artifact.data.caption === 'string' ? artifact.data.caption : undefined,
              currentBot,
              isActive,
            );
            sentDocumentPaths.add(artifact.data.filePath);
          }
        }
      }
    } catch {
      /* metadata parse error, ignore */
    }
  }

  const content = row?.content || 'Sem resposta.';
  const imageMatch = content.match(/ARQUIVO_IMAGEM:\s*((?:\/|[A-Za-z]:\\).+?)(?:\n|$)/);
  if (imageMatch && isActive()) {
    const imagePath = imageMatch[1].trim();
    try {
      if (fs.existsSync(imagePath)) {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        await sendTelegramPhoto(chatId, base64, mimeType, 'Imagem gerada', currentBot, isActive);
      }
    } catch (err) {
      logger.warn({ err, imagePath }, 'Failed to send generated image via Telegram');
    }
  }

  const audioMatches = content.matchAll(/ARQUIVO_AUDIO:\s*((?:\/|[A-Za-z]:\\).+?)(?:\n|$)/g);
  for (const audioMatch of audioMatches) {
    if (!isActive()) break;
    const audioPath = audioMatch[1].trim();
    try {
      if (currentBot && fs.existsSync(audioPath)) {
        const audioBuffer = fs.readFileSync(audioPath);
        const ext = path.extname(audioPath).toLowerCase();
        const contentType = ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg';
        const filename = ext === '.ogg' ? 'audio.ogg' : 'audio.mp3';

        if (!isActive()) break;
        await currentBot.sendVoice(chatId, audioBuffer, {}, { filename, contentType });
        logger.info({ audioPath }, 'Telegram: audio file sent via content fallback');
      }
    } catch (err) {
      logger.warn({ err, audioPath }, 'Failed to send audio file via Telegram');
    }
  }

  const documentMatches = content.matchAll(/ENVIAR_ARQUIVO:\s*((?:\/|[A-Za-z]:\\).+?)(?:\n|$)/g);
  for (const documentMatch of documentMatches) {
    if (!isActive()) break;
    const docPath = documentMatch[1].trim();
    if (sentDocumentPaths.has(docPath)) continue;
    await sendDocumentPathViaTelegram(chatId, docPath, undefined, undefined, undefined, currentBot, isActive);
    sentDocumentPaths.add(docPath);
  }

  const sanitized = content
    .replace(/^\s*ENVIAR_ARQUIVO:\s*(?:\/|[A-Za-z]:\\).*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (sanitized.length === 0 && sentDocumentPaths.size > 0) return 'Arquivo enviado.';
  return sanitized.length > 0 ? sanitized : content;
}

async function sendDocumentPathViaTelegram(
  chatId: number,
  filePath: string,
  fileName?: string,
  mimeType?: string,
  caption?: string,
  currentBot: TelegramBot | null = getActiveBotInstance(),
  isActive: () => boolean = () => currentBot !== null && currentBot === getActiveBotInstance(),
): Promise<void> {
  if (!currentBot || !isActive()) return;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return;
    const name = fileName || path.basename(filePath);
    if (stat.size > TELEGRAM_MAX_UPLOAD_BYTES) {
      logger.info({ fileName: name, sizeBytes: stat.size }, 'Telegram: arquivo gerado acima do limite de upload');
      if (!isActive()) return;
      await currentBot.sendMessage(
        chatId,
        `Gerei o arquivo ${name} (${formatBytes(stat.size)}), mas passou do limite de ${formatBytes(TELEGRAM_MAX_UPLOAD_BYTES)} do Telegram.`,
      );
      return;
    }
    await sendTelegramDocument(chatId, filePath, name, mimeType, caption || name, currentBot, isActive);
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to send document file via Telegram');
  }
}

async function sendTelegramResponse(
  chatId: number,
  text: string,
  currentBot: TelegramBot | null = getActiveBotInstance(),
  isActive: () => boolean = () => currentBot !== null && currentBot === getActiveBotInstance(),
): Promise<void> {
  if (!currentBot || !isActive()) return;

  const MAX_LENGTH = 4096;

  if (text.length <= MAX_LENGTH) {
    try {
      await currentBot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch {
      if (!isActive()) return;
      await currentBot.sendMessage(chatId, text);
    }
    return;
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf('\n', MAX_LENGTH);
    if (cutAt < MAX_LENGTH / 2) cutAt = MAX_LENGTH;
    chunks.push(remaining.substring(0, cutAt));
    remaining = remaining.substring(cutAt).trimStart();
  }

  for (const chunk of chunks) {
    if (!isActive()) return;
    try {
      await currentBot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    } catch {
      if (!isActive()) return;
      await currentBot.sendMessage(chatId, chunk);
    }
  }
}

export type TelegramDocumentType = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'txt' | 'md';

const TELEGRAM_SUPPORTED_TYPES_NOTE =
  'Posso trabalhar com PDF, DOCX, planilha (XLSX), CSV, TXT, MD, imagens e audio de voz.';

const UNPROCESSABLE_ATTACHMENT_REPLIES: Record<string, string> = {
  animation: `Recebi um GIF/animacao, mas ainda nao processo animacao. ${TELEGRAM_SUPPORTED_TYPES_NOTE}`,
  audio: `Recebi um arquivo de audio (musica), mas ainda nao processo musica. ${TELEGRAM_SUPPORTED_TYPES_NOTE}`,
  video: `Recebi um video, mas ainda nao processo video. ${TELEGRAM_SUPPORTED_TYPES_NOTE}`,
  video_note: `Recebi uma videomensagem, mas ainda nao processo video. ${TELEGRAM_SUPPORTED_TYPES_NOTE}`,
  sticker: `Recebi um sticker, mas ainda nao processo sticker. ${TELEGRAM_SUPPORTED_TYPES_NOTE}`,
};

async function replyUnprocessableAttachment(
  chatId: number,
  kind: string,
  currentBot: TelegramBot | null = getActiveBotInstance(),
  isActive: () => boolean = () => currentBot !== null && currentBot === getActiveBotInstance(),
): Promise<void> {
  if (!currentBot || !isActive()) return;
  const reply =
    UNPROCESSABLE_ATTACHMENT_REPLIES[kind] ??
    `Recebi um anexo que ainda nao processo. ${TELEGRAM_SUPPORTED_TYPES_NOTE}`;
  logger.info({ kind }, 'Telegram: anexo nao processavel, respondendo por tipo (SPEC 8.1)');
  await currentBot.sendMessage(chatId, reply).catch(() => {});
}

export function detectTelegramDocumentType(fileName: string, mimeType?: string): TelegramDocumentType | null {
  const ext = path.extname(fileName || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();
  if (ext === '.pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === '.docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    return 'docx';
  if (
    ext === '.xlsx' ||
    ext === '.xls' ||
    ext === '.xlsm' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel'
  )
    return 'xlsx';
  if (ext === '.csv' || mime === 'text/csv') return 'csv';
  if (ext === '.md' || ext === '.markdown' || mime === 'text/markdown') return 'md';
  if (ext === '.txt' || mime === 'text/plain') return 'txt';
  return null;
}

export async function extractTelegramDocumentText(
  buffer: Buffer,
  docType: TelegramDocumentType,
  fileName: string,
): Promise<string> {
  if (docType === 'xlsx') {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const parts: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
      parts.push(`=== Aba: ${sheetName} ===\n${csv.trim()}`);
    }
    return parts.join('\n\n');
  }

  const ext = path.extname(fileName || '').toLowerCase() || `.${docType}`;
  const tempPath = path.join(os.tmpdir(), `lionclaw-tgdoc-${crypto.randomUUID()}${ext}`);
  try {
    fs.writeFileSync(tempPath, buffer);
    const { parseFile } = await import('./knowledge-engine');
    const raw = await parseFile(tempPath, docType);
    return raw.text;
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
}

export function buildTelegramDocumentPrompt(
  fileName: string,
  docType: TelegramDocumentType,
  sizeBytes: number,
  caption: string | undefined,
  text: string,
): string {
  let body = text;
  if (body.length > TELEGRAM_DOC_TEXT_MAX_CHARS) {
    body = `${body.slice(0, TELEGRAM_DOC_TEXT_MAX_CHARS)}\n[documento truncado para caber no contexto]`;
  }
  const instruction = caption?.trim() || 'O usuario enviou este documento; analise e responda.';
  return (
    `[Documento recebido: ${fileName} (${docType.toUpperCase()}, ${formatBytes(sizeBytes)})]\n` +
    `${instruction}\n\n=== CONTEUDO ===\n${body}`
  );
}

function telegramDownloadLimitMessage(sizeBytes?: number): string {
  const limit = formatBytes(TELEGRAM_MAX_DOWNLOAD_BYTES);
  const actual = sizeBytes !== undefined ? formatBytes(sizeBytes) : 'tamanho desconhecido';
  return `Arquivo grande demais para eu baixar pelo Telegram. O maximo e ${limit}; este tem ${actual}.`;
}

async function handleIncomingDocument(
  msg: TelegramBot.Message,
  chatId: number,
  userName: string,
  currentBot: TelegramBot | null = getActiveBotInstance(),
  isActive: () => boolean = () => currentBot !== null && currentBot === getActiveBotInstance(),
): Promise<void> {
  if (!currentBot || !isActive() || !msg.document) return;
  const doc = msg.document;
  const fileName = doc.file_name || `documento-${msg.message_id}`;

  if (typeof doc.file_size === 'number' && doc.file_size > TELEGRAM_MAX_DOWNLOAD_BYTES) {
    logger.info({ fileName, fileSize: doc.file_size }, 'Telegram: documento acima do limite de download (nao baixado)');
    await currentBot.sendMessage(chatId, telegramDownloadLimitMessage(doc.file_size));
    return;
  }

  const docType = detectTelegramDocumentType(fileName, doc.mime_type);
  if (!docType) {
    logger.info({ fileName, mime: doc.mime_type }, 'Telegram: tipo de documento nao suportado');
    await currentBot.sendMessage(
      chatId,
      `Recebi o arquivo ${fileName}, mas ainda nao processo esse tipo. ${TELEGRAM_SUPPORTED_TYPES_NOTE}`,
    );
    return;
  }

  logger.info({ fileName, docType, fileSize: doc.file_size, user: userName }, 'Telegram: documento recebido');
  await currentBot.sendChatAction(chatId, 'typing').catch(() => {});
  if (!isActive()) return;

  let buffer: Buffer;
  try {
    const fileLink = await currentBot.getFileLink(doc.file_id);
    if (!isActive()) return;
    const response = await fetch(fileLink);
    if (!isActive()) return;
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
    if (!isActive()) return;
  } catch (error) {
    if (!isActive()) return;
    logger.warn({ error, fileName }, 'Telegram: falha ao baixar documento');
    if (doc.file_size === undefined) {
      await currentBot.sendMessage(chatId, telegramDownloadLimitMessage(undefined));
    } else {
      await currentBot.sendMessage(chatId, 'Erro ao baixar o documento. Tente novamente.');
    }
    return;
  }

  if (buffer.length > TELEGRAM_MAX_DOWNLOAD_BYTES) {
    logger.info({ fileName, size: buffer.length }, 'Telegram: documento acima do limite (pos-download)');
    await currentBot.sendMessage(chatId, telegramDownloadLimitMessage(buffer.length));
    return;
  }

  let text: string;
  try {
    text = await extractTelegramDocumentText(buffer, docType, fileName);
  } catch (error) {
    if (!isActive()) return;
    logger.warn({ error, fileName, docType }, 'Telegram: falha ao extrair texto do documento');
    await currentBot.sendMessage(
      chatId,
      `Nao consegui ler o conteudo de ${fileName}. O arquivo pode estar corrompido ou protegido.`,
    );
    return;
  }

  if (!isActive()) return;
  const prompt = buildTelegramDocumentPrompt(fileName, docType, buffer.length, msg.caption, text);
  const sessionId = getOrCreateTelegramSession();
  const response = await executeTelegramQuery(prompt, sessionId, chatId, userName, undefined, currentBot, isActive);
  if (!isActive()) return;
  await sendTelegramResponse(chatId, response, currentBot, isActive);
}

export function setActiveTelegramSession(newSessionId: string): void {
  for (const session of listActiveTelegramSessions()) {
    if (session.id === newSessionId) continue;
    updateSessionStatus(session.id, 'archived');
    logger.info(
      { archivedSessionId: session.id, newSessionId },
      'Telegram: sessao ativa anterior arquivada (unicidade de sessao active, SPEC 3.1)',
    );
  }
  activeSessionId = newSessionId;
}

function getOrCreateTelegramSession(): string {
  if (activeSessionId) return activeSessionId;

  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM sessions WHERE type = 'telegram' AND status = 'active' ORDER BY updated_at DESC LIMIT 1")
    .get() as { id: string } | undefined;

  if (existing) {
    setActiveTelegramSession(existing.id);
    return existing.id;
  }

  const id = crypto.randomUUID();
  createSession(id, '[Telegram] Conversa', undefined, { type: 'telegram' });
  setActiveTelegramSession(id);
  return id;
}

function getTelegramConfig(): TelegramConfig | null {
  const db = getDb();
  const row = db.prepare("SELECT config FROM channels WHERE type = 'telegram' AND is_active = 1").get() as
    { config: string } | undefined;

  if (!row) return null;
  try {
    const raw = JSON.parse(row.config) as Record<string, unknown>;

    let userId = raw.allowedUserId as number | undefined;
    let userName = (raw.allowedUserName as string) || 'Usuario';

    if (!userId) {
      const users = raw.allowedUsers as Array<{ userId: number; name: string }> | undefined;
      if (users?.length) {
        userId = users[0].userId;
        userName = users[0].name || 'Usuario';
      }
      const ids = raw.allowedUserIds as number[] | undefined;
      if (!userId && ids?.length) {
        userId = ids[0];
      }
    }

    if (!userId) return null;

    if (!raw.allowedUserId || raw.allowedUsers || raw.allowedUserIds) {
      const clean: TelegramConfig = {
        allowedUserId: userId,
        allowedUserName: userName,
        botUsername: raw.botUsername as string | undefined,
        sessionMode: (raw.sessionMode as 'continuous' | 'per-message') || 'continuous',
        notifyOnSchedulerTasks: (raw.notifyOnSchedulerTasks as boolean) ?? false,
        notifyOnDriveHandoff: (raw.notifyOnDriveHandoff as boolean) ?? false,
      };
      try {
        db.prepare(
          "UPDATE channels SET config = ?, updated_at = datetime('now') WHERE type = 'telegram' AND is_active = 1",
        ).run(JSON.stringify(clean));
        logger.info('Telegram: migrated config to single-user format');
      } catch (e) {
        logger.warn({ error: e }, 'Telegram: failed to persist config migration');
      }
      return clean;
    }

    return {
      allowedUserId: userId,
      allowedUserName: userName,
      botUsername: raw.botUsername as string | undefined,
      sessionMode: (raw.sessionMode as 'continuous' | 'per-message') || 'continuous',
      notifyOnSchedulerTasks: (raw.notifyOnSchedulerTasks as boolean) ?? false,
      notifyOnDriveHandoff: (raw.notifyOnDriveHandoff as boolean) ?? false,
    };
  } catch {
    return null;
  }
}

const DEFAULT_TELEGRAM_COMPACTION_TOKEN_THRESHOLD = 600_000;
const DEFAULT_TELEGRAM_COMPACTION_WINDOW_FRACTION = 0.75;
const DEFAULT_TELEGRAM_COMPACTION_TARGET_TOKENS = 50_000;

const compactingTelegramSessions = new Set<string>();

export const TELEGRAM_COMPACTION_MEMORY_BACKOFF_MS = 15 * 60_000;

const telegramCompactionBackoffUntil = new Map<string, number>();

export const TELEGRAM_DREAMING_BUSY_MESSAGE = 'Clear do desktop em andamento; tente em alguns minutos.';

function readPositiveNumberSetting(key: string, fallback: number): number {
  const raw = getSetting(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getActiveContextTokens(session: ChatSession): number {
  return session.activeContextTokensEst ?? (session.inputTokens || 0) + (session.outputTokens || 0);
}

function getTelegramCompactionThreshold(): number {
  const thresholdAbs = readPositiveNumberSetting(
    'telegram_compaction_token_threshold',
    DEFAULT_TELEGRAM_COMPACTION_TOKEN_THRESHOLD,
  );
  const fraction = readPositiveNumberSetting(
    'telegram_compaction_window_fraction',
    DEFAULT_TELEGRAM_COMPACTION_WINDOW_FRACTION,
  );
  const model = getSetting('orchestrator_model') || '';
  const contextWindow = model ? getModelContextWindow(model) : undefined;
  const thresholdPct = contextWindow !== undefined ? Math.floor(contextWindow * fraction) : undefined;
  return Math.min(thresholdAbs, thresholdPct ?? Infinity);
}

export function buildTelegramCompactionSeed(
  rollingSummary: string,
  messages: ChatMessage[],
  targetTokens: number,
): string {
  const header = `[Resumo da conversa ate aqui]: ${rollingSummary}`;
  const SEPARATOR = '\n\n';
  let remaining = targetTokens - estimateTokens(header);

  const convo = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const turns: string[] = [];
  let current: string[] = [];
  for (const m of convo) {
    if (m.role === 'user' && current.length > 0) {
      turns.push(current.join('\n'));
      current = [];
    }
    current.push(`[${m.role}] ${m.content}`);
  }
  if (current.length > 0) turns.push(current.join('\n'));

  const included: string[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turnText = turns[i];
    const cost = estimateTokens(SEPARATOR + turnText);
    if (cost <= remaining) {
      included.unshift(turnText);
      remaining -= cost;
      continue;
    }
    if (included.length === 0 && turns.length > 0) {
      const marker = '[turno truncado] ';
      const budgetChars = Math.max(0, (remaining - estimateTokens(SEPARATOR + marker)) * 4);
      const tail = turnText.slice(Math.max(0, turnText.length - budgetChars));
      included.unshift(marker + tail);
    }
    break;
  }

  return included.length > 0 ? header + SEPARATOR + included.join(SEPARATOR) : header;
}

async function sendCompactionNotice(
  success: boolean,
  currentBot: TelegramBot | null = getActiveBotInstance(),
  isActive: () => boolean = () => currentBot !== null && currentBot === getActiveBotInstance(),
  cause?: string,
): Promise<void> {
  if (!currentBot || !isActive()) return;
  const config = getTelegramConfig();
  if (!config?.allowedUserId) return;
  try {
    await sendTelegramResponse(
      config.allowedUserId,
      success
        ? 'Compactei nossa conversa para nao perder o fio: mantive um resumo e as mensagens recentes. Seguimos.'
        : cause
          ? `Nao consegui compactar agora: ${cause}. Nada foi perdido; volto a tentar mais tarde.`
          : 'Nao consegui compactar agora. Nada foi perdido; tento de novo em breve.',
      currentBot,
      isActive,
    );
  } catch {}
}

export interface TelegramCompactionOutcome {
  ok: boolean;
  noop?: boolean;
  reason?: 'dreaming_busy';
  error?: string;
}

export async function compactTelegramSessionInPlace(
  sessionId: string,
  opts: {
    force?: boolean;
    notify?: boolean;
    currentBot?: TelegramBot | null;
    isActive?: () => boolean;
  } = {},
): Promise<TelegramCompactionOutcome> {
  const { force = false, notify = true, currentBot = getActiveBotInstance(), isActive = () => true } = opts;

  if (!isActive()) return { ok: false, noop: true, error: 'bot inativo' };

  if (compactingTelegramSessions.has(sessionId)) {
    return { ok: false, noop: true, error: 'compactacao ja em andamento' };
  }
  const session = getSession(sessionId);
  if (!session || session.type !== 'telegram' || session.status !== 'active') {
    return { ok: false, error: 'sessao telegram ativa nao encontrada' };
  }
  if (!force) {
    const tokensAtivos = getActiveContextTokens(session);
    const threshold = getTelegramCompactionThreshold();
    if (tokensAtivos < threshold) return { ok: true, noop: true };
  }

  compactingTelegramSessions.add(sessionId);
  try {
    const boundary = session.compactedUpToMessageId;
    const allMessages = getSessionMessages(sessionId);
    const deltaMessages = boundary !== undefined ? allMessages.filter((m) => m.id > boundary) : allMessages;
    if (deltaMessages.length === 0) {
      logger.info({ sessionId, boundary }, 'Telegram: nada novo para compactar (delta vazio)');
      return { ok: true, noop: true };
    }

    const periodStart = new Date(deltaMessages[0].createdAt ?? session.createdAt);
    const releaseDreaming = tryAcquireDreamingMutex();
    if (!releaseDreaming) {
      logger.info({ sessionId }, 'Telegram: dreaming ocupado pelo Clear do desktop (noop dreaming_busy)');
      return { ok: true, noop: true, reason: 'dreaming_busy' };
    }
    let compactionResult: Awaited<ReturnType<typeof runCompaction>>;
    try {
      compactionResult = await runCompaction(periodStart, new Date(), sessionId, {
        sinceMessageId: boundary,
        priorSummary: session.rollingSummary,
        skipDailySummary: true,
        dreamingMutex: 'held',
      });
      if (!isActive()) return { ok: false, noop: true, error: 'bot inativo' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isCompactionStepError(err) && err.code === 'COMPACT-MEMORY-FAILED') {
        telegramCompactionBackoffUntil.set(sessionId, Date.now() + TELEGRAM_COMPACTION_MEMORY_BACKOFF_MS);
        logger.error({ err, sessionId }, 'Telegram: gate de memoria falhou; boundary intacto, backoff armado');
        if (notify && isActive()) await sendCompactionNotice(false, currentBot, isActive, msg);
        return { ok: false, error: msg };
      }
      logger.error({ err, sessionId }, 'Telegram: compactacao abortada (summarizer falhou); contexto intacto');
      if (notify && isActive()) await sendCompactionNotice(false, currentBot, isActive);
      return { ok: false, error: msg };
    } finally {
      releaseDreaming();
    }
    if (!compactionResult) {
      logger.info({ sessionId }, 'Telegram: runCompaction sem mensagens no delta (noop)');
      return { ok: true, noop: true };
    }

    const newRollingSummary = compactionResult.executiveSummary;

    const targetTokens = readPositiveNumberSetting(
      'telegram_compaction_target_tokens',
      DEFAULT_TELEGRAM_COMPACTION_TARGET_TOKENS,
    );
    const seed = buildTelegramCompactionSeed(newRollingSummary, allMessages, targetTokens);

    const newBoundary = deltaMessages[deltaMessages.length - 1].id;

    if (!isActive()) return { ok: false, noop: true, error: 'bot inativo' };

    const newSdkThreadId = crypto.randomUUID();
    setSessionCompactionState(sessionId, {
      compactedUpToMessageId: newBoundary,
      rollingSummary: newRollingSummary,
      pendingSeed: seed,
      sdkSessionId: newSdkThreadId,
    });

    setSessionActiveContextTokens(sessionId, estimateTokens(seed));

    resetTelegramSessionState();

    logger.info(
      { sessionId, newBoundary, seedTokens: estimateTokens(seed), sdkThreadId: newSdkThreadId },
      'Telegram: compactacao in-place concluida (mesma sessao, thread SDK nova)',
    );

    if (notify && isActive()) await sendCompactionNotice(true, currentBot, isActive);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId }, 'Telegram: falha inesperada na compactacao in-place (nao-fatal)');
    if (notify && isActive()) await sendCompactionNotice(false, currentBot, isActive);
    return { ok: false, error: msg };
  } finally {
    compactingTelegramSessions.delete(sessionId);
  }
}

async function maybeCompactTelegramSession(
  sessionId: string,
  currentBot: TelegramBot | null = getActiveBotInstance(),
  isActive: () => boolean = () => true,
): Promise<void> {
  try {
    if (!isActive()) return;
    const session = getSession(sessionId);
    if (!session || session.type !== 'telegram' || session.status !== 'active') return;
    if (compactingTelegramSessions.has(sessionId)) return;

    const backoffUntil = telegramCompactionBackoffUntil.get(sessionId);
    if (backoffUntil !== undefined) {
      if (Date.now() < backoffUntil) return;
      telegramCompactionBackoffUntil.delete(sessionId);
    }

    const tokensAtivos = getActiveContextTokens(session);
    const threshold = getTelegramCompactionThreshold();
    if (tokensAtivos < threshold) return;

    logger.info(
      { sessionId, tokensAtivos, threshold },
      'Telegram: gatilho de compactacao in-place atingido (SPEC 5.2)',
    );
    await enqueueTelegramLaneTask(() =>
      compactTelegramSessionInPlace(sessionId, {
        force: false,
        currentBot,
        isActive,
      }),
    );
  } catch (err) {
    logger.error({ err, sessionId }, 'Telegram: falha no gatilho de compactacao (nao-fatal)');
  }
}

export const __telegramInternal = {
  handleBotCommand,
  handleIncomingDocument,
  sendTelegramResponse,
  replyUnprocessableAttachment,
  sendDocumentPathViaTelegram,
  executeTelegramQueryForTests: executeTelegramQuery,
  transcribeAndResolveImageTurn,
  maybeCompactTelegramSession,
  getTelegramCompactionThreshold,
  getActiveContextTokens,
  setBotForTests(fake: unknown): void {
    botGeneration++;
    stoppingBotGenerations.clear();
    bot = fake as TelegramBot | null;
  },
  setActiveSessionIdForTests(id: string | null): void {
    activeSessionId = id;
  },
  resetCompactionBackoffForTests(): void {
    telegramCompactionBackoffUntil.clear();
  },
  getCompactionBackoffUntilForTests(sessionId: string): number | undefined {
    return telegramCompactionBackoffUntil.get(sessionId);
  },
  getActiveSessionIdForTests(): string | null {
    return activeSessionId;
  },
};

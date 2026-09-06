import type { BrowserWindow } from 'electron';
import { getSession, getSessionMessages, updateSessionTitle } from '../db';
import { createLogger } from '../logger';
import type { LionAdapter, LionChatMessage } from './adapters/types';

const logger = createLogger('lion-sdk-title');
const TITLE_TIMEOUT_MS = 15_000;

type GetWindow = () => BrowserWindow | null;

function titleExtraFor(adapter: LionAdapter, model: string): Record<string, unknown> {
  if (adapter.name === 'ollama') {
    return { num_predict: 60, temperature: 0.2 };
  }
  if (adapter.name === 'openai-compatible' && /kimi|moonshot/i.test(model)) {
    return { max_tokens: 60, temperature: 1 };
  }
  return { max_tokens: 60, temperature: 0.2 };
}

function sanitizeTitle(raw: string): string | null {
  const title = raw
    .split('\n')[0]
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^titulo:\s*/i, '')
    .replace(/[.!?]+$/g, '')
    .substring(0, 60)
    .trim();

  return title.length >= 3 ? title : null;
}

function notifySessionsUpdated(getWindow: GetWindow): void {
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('chat:sessions-updated');
    }
  } catch {
  }
}

function errorLogFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      err: error,
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
    };
  }
  return {
    errorValue: String(error),
  };
}

function buildTitleMessages(sessionId: string): LionChatMessage[] | null {
  const messages = getSessionMessages(sessionId);
  if (messages.length < 2) return null;

  const contextMessages = messages.slice(0, 6);
  const conversationSnippet = contextMessages
    .map((m) => {
      const role = m.role === 'user'
        ? 'Usuario'
        : m.role === 'assistant'
          ? 'Assistente'
          : m.role;
      return `${role}: ${m.content.substring(0, 300)}`;
    })
    .join('\n\n');

  return [
    {
      role: 'system',
      content: 'Voce gera titulos curtos para conversas. Responda apenas com o titulo, em portugues brasileiro.',
    },
    {
      role: 'user',
      content: `Analise esta conversa e gere um titulo CURTO (3-6 palavras, maximo 50 caracteres) que resuma o tema principal. Retorne APENAS o titulo, sem aspas, sem pontuacao final, sem explicacao.\n\nConversa:\n${conversationSnippet}\n\nTitulo:`,
    },
  ];
}

async function generateTitleWithChatModel(
  adapter: LionAdapter,
  model: string,
  messages: LionChatMessage[],
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Title generation timed out after ${TITLE_TIMEOUT_MS}ms`));
  }, TITLE_TIMEOUT_MS);
  let output = '';

  try {
    for await (const ev of adapter.streamCompletion({
      model,
      messages,
      tools: [],
      abortSignal: controller.signal,
      extra: titleExtraFor(adapter, model),
    })) {
      if (ev.type === 'text') {
        output += ev.delta;
      } else if (ev.type === 'error') {
        throw new Error(ev.error);
      } else if (ev.type === 'done') {
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return sanitizeTitle(output);
}

export async function maybeGenerateLionSessionTitle(opts: {
  sessionId: string;
  adapter: LionAdapter;
  model: string;
  getWindow: GetWindow;
}): Promise<void> {
  try {
    const session = getSession(opts.sessionId);
    if (!session || session.type === 'scheduled' || session.type === 'telegram') {
      return;
    }

    const persistedMessages = getSessionMessages(session.id);
    const assistantCount = persistedMessages.filter((msg) => msg.role === 'assistant').length;
    const shouldGenerateTitle = !session.title || assistantCount === 1;
    if (!shouldGenerateTitle || persistedMessages.length < 2) {
      return;
    }

    const titleMessages = buildTitleMessages(session.id);
    if (!titleMessages) return;

    const title = await generateTitleWithChatModel(opts.adapter, opts.model, titleMessages);
    if (!title) {
      logger.warn({ sessionId: opts.sessionId }, 'Lion-SDK title generation returned empty/short result');
      return;
    }

    updateSessionTitle(opts.sessionId, title);
    logger.info({ sessionId: opts.sessionId, model: opts.model, title }, 'Lion-SDK session title generated');
    notifySessionsUpdated(opts.getWindow);
  } catch (error) {
    logger.warn(
      { ...errorLogFields(error), sessionId: opts.sessionId },
      'Lion-SDK title generation failed',
    );
  }
}

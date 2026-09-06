import { BrowserWindow } from 'electron';
import crypto from 'crypto';
import { createLogger } from './logger';
import type { AskQuestionRequest, AskQuestionResponse } from '../../src/types';

const logger = createLogger('ask-question');

interface PendingAskQuestion {
  resolve: (response: AskQuestionResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const pendingAskQuestions = new Map<string, PendingAskQuestion>();

export function sendAskQuestion(
  getWindow: () => BrowserWindow | null,
  questions: AskQuestionRequest['questions'],
  signal?: AbortSignal,
  timeoutMs = 300_000,
): Promise<AskQuestionResponse> {
  const window = getWindow();
  if (!window) {
    return Promise.reject(new Error('Janela nao disponivel para pergunta'));
  }

  const id = crypto.randomUUID();
  const request: AskQuestionRequest = { id, questions };

  if (signal?.aborted) return Promise.reject(new Error('AskUserQuestion cancelada'));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingAskQuestions.get(id);
      if (pending?.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
      pendingAskQuestions.delete(id);
      logger.warn({ id, timeoutMs }, 'AskUserQuestion timeout');
      reject(new Error(`AskUserQuestion timeout (${Math.round(timeoutMs / 60_000)} min sem resposta do usuario)`));
    }, timeoutMs);

    const pending: PendingAskQuestion = { resolve, reject, timeout, ...(signal ? { signal } : {}) };
    if (signal) {
      pending.onAbort = () => {
        if (!pendingAskQuestions.delete(id)) return;
        clearTimeout(timeout);
        reject(new Error('AskUserQuestion cancelada'));
      };
      signal.addEventListener('abort', pending.onAbort, { once: true });
    }
    pendingAskQuestions.set(id, pending);

    window.webContents.send('chat:ask-question', request);

    window.webContents.send('chat:stream', {
      type: 'ask_question',
      askRequest: request,
    });
  });
}

export function resolveAskQuestion(response: AskQuestionResponse): void {
  const pending = pendingAskQuestions.get(response.id);
  if (!pending) {
    logger.warn({ id: response.id }, 'AskQuestion response not found');
    return;
  }

  clearTimeout(pending.timeout);
  pendingAskQuestions.delete(response.id);
  if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
  pending.resolve(response);
  logger.info({ id: response.id }, 'AskQuestion resolved');
}

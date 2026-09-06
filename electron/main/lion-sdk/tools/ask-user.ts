
import type { BrowserWindow } from 'electron';
import { sendAskQuestion } from '../../ask-question';
import type { AskQuestion, AskQuestionResponse } from '../../../../src/types';

export interface AskUserInput {
  questions: AskQuestion[];
}

export interface AskUserToolResult {
  ok: boolean;
  answers?: AskQuestionResponse['answers'];
  annotations?: AskQuestionResponse['annotations'];
  error?: string;
}

export interface AskUserDeps {
  getWindow: () => BrowserWindow | null;
  sender?: typeof sendAskQuestion;
}

export async function lionAskUserQuestion(
  input: AskUserInput,
  deps: AskUserDeps,
): Promise<AskUserToolResult> {
  if (!input || !Array.isArray(input.questions) || input.questions.length === 0) {
    return { ok: false, error: 'AskUserQuestion: questions vazio.' };
  }
  const send = deps.sender ?? sendAskQuestion;
  try {
    const response = await send(deps.getWindow, input.questions);
    return {
      ok: true,
      answers: response.answers,
      annotations: response.annotations,
    };
  } catch (e) {
    return {
      ok: false,
      error: `AskUserQuestion falhou: ${(e as Error).message}`,
    };
  }
}

import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('electron', () => ({ BrowserWindow: class {} }));

import { sendAskQuestion, resolveAskQuestion, AskQuestionSessionRequiredError } from '../ask-question';

type Sent = { channel: string; payload: Record<string, unknown> };

function fakeWindow(sent: Sent[]) {
  return {
    webContents: {
      send: (channel: string, payload: Record<string, unknown>) => {
        sent.push({ channel, payload });
      },
    },
  } as unknown as import('electron').BrowserWindow;
}

const questions = [{ question: 'Qual?', header: 'H', options: [{ label: 'a', description: '' }] }];

describe('P2-2 (RM7): AskUserQuestion exige sessionId do turno', () => {
  it('sem contexto ou sem sessionId: recusa tipada session_required e nada e enviado ao renderer', async () => {
    const sent: Sent[] = [];
    await expect(sendAskQuestion(() => fakeWindow(sent), questions)).rejects.toBeInstanceOf(
      AskQuestionSessionRequiredError,
    );
    await expect(sendAskQuestion(() => fakeWindow(sent), questions, undefined, undefined, {})).rejects.toThrow(
      /session_required/,
    );
    expect(sent).toHaveLength(0);
  });

  it('com sessionId: o request e o chunk ask_question carregam o sessionId sem condicional', async () => {
    const sent: Sent[] = [];
    const pending = sendAskQuestion(() => fakeWindow(sent), questions, undefined, undefined, {
      sessionId: 'lane-b',
      title: 'Bug do login',
      laneBadge: 2,
    });
    expect(sent.map((s) => s.channel)).toEqual(['chat:ask-question', 'chat:stream']);
    const request = sent[0].payload as { id: string; sessionId: string; laneBadge: number; title: string };
    expect(request.sessionId).toBe('lane-b');
    expect(request.laneBadge).toBe(2);
    expect(request.title).toBe('Bug do login');
    expect(sent[1].payload['sessionId']).toBe('lane-b');
    expect(sent[1].payload['type']).toBe('ask_question');

    resolveAskQuestion({ id: request.id, answers: { 'Qual?': 'a' } });
    await expect(pending).resolves.toMatchObject({ answers: { 'Qual?': 'a' } });
  });
});

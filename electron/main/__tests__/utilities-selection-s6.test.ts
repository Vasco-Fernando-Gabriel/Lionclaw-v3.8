
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../memory-pipeline', () => ({
  runStructuredMemoryLlm: vi.fn(),
  CompactionProviderUnavailableError: class extends Error {},
}));

vi.mock('../db', () => ({
  getSessionMessages: vi.fn(),
  updateSessionTitle: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      throw new Error('title-generator NAO deve instanciar o client Anthropic direto (SPEC 4.3)');
    }
  },
}));

import { runStructuredMemoryLlm } from '../memory-pipeline';
import { getSessionMessages, updateSessionTitle } from '../db';
import { generateSessionTitle } from '../title-generator';

const runLlmMock = runStructuredMemoryLlm as unknown as Mock;
const getMessagesMock = getSessionMessages as unknown as Mock;
const updateTitleMock = updateSessionTitle as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  getMessagesMock.mockReturnValue([
    { role: 'user', content: 'como faco X?' },
    { role: 'assistant', content: 'assim ó' },
  ]);
});

describe('generateSessionTitle pela selecao de compactacao (SPEC 4.3)', () => {
  it('sucesso -> usa runStructuredMemoryLlm e grava o titulo (sem literal de modelo)', async () => {
    runLlmMock.mockResolvedValue('Titulo Gerado');

    await generateSessionTitle('sess_1');

    expect(runLlmMock).toHaveBeenCalledTimes(1);
    const [, opts] = runLlmMock.mock.calls[0];
    expect(opts).toMatchObject({ maxTokens: 60 });
    expect(opts).not.toHaveProperty('model');
    expect(updateTitleMock).toHaveBeenCalledWith('sess_1', 'Titulo Gerado');
  });

  it('falha de resolucao do provider -> sem titulo, warn, NAO derruba o turno', async () => {
    runLlmMock.mockRejectedValue(new Error('compaction_provider_unavailable'));

    await expect(generateSessionTitle('sess_2')).resolves.toBeUndefined();
    expect(updateTitleMock).not.toHaveBeenCalled();
  });

  it('resposta vazia -> sem titulo, sem crash', async () => {
    runLlmMock.mockResolvedValue('');

    await expect(generateSessionTitle('sess_3')).resolves.toBeUndefined();
    expect(updateTitleMock).not.toHaveBeenCalled();
  });
});

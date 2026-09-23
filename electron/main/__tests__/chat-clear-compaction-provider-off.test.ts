import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

const h = vi.hoisted(() => ({
  settings: {} as Record<string, string | undefined>,
  sessions: new Map<string, Record<string, unknown>>(),
  statuses: [] as Array<Record<string, unknown>>,
  replaceLaneSessionMock: vi.fn(),
  setDreamingStartedAtMock: vi.fn(),
}));

vi.mock('../db', () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => [
        {
          id: 1,
          session_id: 'lane-a',
          role: 'user',
          content: 'oi',
          created_at: '2026-09-08 10:00:00',
          session_title: 'A',
        },
        {
          id: 2,
          session_id: 'lane-a',
          role: 'assistant',
          content: 'ola',
          created_at: '2026-09-08 10:00:01',
          session_title: 'A',
        },
      ],
    }),
  }),
  getSessionMessages: vi.fn(() => []),
  getSession: (id: string) => h.sessions.get(id),
  getSetting: (key: string) => h.settings[key],
  insertChunkWithEmbedding: vi.fn(),
  searchBM25: vi.fn(),
  searchVector: vi.fn(),
  setLastGateRunAt: vi.fn(),
  countSessionMessages: () => 2,
  isOpenDesktopConversation: (s: { status: string; type: string; id: string }) =>
    s.status === 'active' && (s.type === 'chat' || s.type === 'manual') && !s.id.startsWith('dw-drive-'),
  setDreamingStartedAt: (...args: unknown[]) => h.setDreamingStartedAtMock(...args),
  replaceLaneSession: (...args: unknown[]) => h.replaceLaneSessionMock(...args),
  getSessionsWithDreamingStarted: () => [],
}));
vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => null),
  getApiKey: vi.fn(async () => null),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../paths', () => ({
  getLionClawHome: () => '/tmp/lionclaw-test',
  getBackgroundCwd: () => '/tmp/lionclaw-test/background',
}));
vi.mock('../embedding-provider', () => ({ generateEmbedding: vi.fn() }));
vi.mock('../provider-availability', () => ({
  listProviderStatuses: async () => h.statuses,
}));
vi.mock('../mgraph-engine', () => ({
  executeVaultOperation: vi.fn(),
  regenerateVaultIndex: vi.fn(),
  updateVaultHot: vi.fn(),
  appendVaultLog: vi.fn(),
  getExistingVaultFilesList: vi.fn(() => ''),
}));
vi.mock('../memory-pipeline/oneshot-subscription', () => ({
  runSubscriptionPromptWithFallback: vi.fn(),
  humanizeModelLabel: (s: unknown) => String(s),
}));
vi.mock('../lion-sdk/adapters/lmstudio', () => ({ createLmStudioAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/ollama', () => ({ createOllamaAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/openai-compatible', () => ({ createOpenAiCompatibleAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/google-genai', () => ({ createGoogleGenAiAdapter: vi.fn() }));
vi.mock('../orchestrator', () => ({
  getDesktopSessionExecutionState: () => 'idle',
  stopDesktopSessionQuery: vi.fn(),
}));
vi.mock('../chat-compaction-inplace', () => ({ isChatSessionCompacting: () => false }));
vi.mock('../session-drive', () => ({ listActiveDriveProjectIdsForSession: () => [] }));
vi.mock('../pipeline-drive-coordinator', () => ({ getPipelineDriveCoordinator: () => null }));
vi.mock('../codex-sdk', () => ({ closeCachedChatCodexSession: vi.fn() }));

import { clearLaneSession } from '../chat-clear';
import { clearingSessions, isSessionClearing } from '../clearing-sessions';
import { resetDreamingMutexForTests } from '../dreaming-mutex';
import { COMPACTION_PROVIDER_OFF_HINT } from '../memory-pipeline';

beforeEach(() => {
  clearingSessions.clear();
  resetDreamingMutexForTests();
  h.replaceLaneSessionMock.mockReset();
  h.setDreamingStartedAtMock.mockReset();
  h.sessions.clear();
  h.sessions.set('lane-a', {
    id: 'lane-a',
    title: 'Conversa A',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    status: 'active',
    type: 'chat',
    laneBadge: 1,
    createdAt: '2026-09-08 10:00:00',
    updatedAt: '2026-09-08 10:00:00',
  });
  h.settings = {
    orchestrator_runtime: 'claude-sdk',
    orchestrator_provider: 'anthropic',
    orchestrator_model: 'claude-opus-4-7',
    orchestrator_compaction_provider: '',
    orchestrator_compaction_model: '',
  };
});

describe('7.8 via Clear: compactacao Auto com o provider da lane off', () => {
  it('chat:clear devolve COMPACT-SUMMARY-FAILED com a dica de Settings; conversa intacta, nada arquivado', async () => {
    h.statuses = [
      {
        runtime: 'claude-sdk',
        provider: 'anthropic',
        connected: false,
        available: false,
        reason: 'Engine Claude Code nao encontrado.',
      },
    ];

    const result = await clearLaneSession('lane-a');

    expect(result).toMatchObject({ ok: false, code: 'COMPACT-SUMMARY-FAILED' });
    if (result.ok) throw new Error('esperava falha');
    expect(result.error).toContain(COMPACTION_PROVIDER_OFF_HINT);
    expect(result.error).toContain('configure o Modelo de compactacao em Settings');
    expect(h.replaceLaneSessionMock).not.toHaveBeenCalled();
    expect(h.setDreamingStartedAtMock).toHaveBeenLastCalledWith('lane-a', null);
    expect(isSessionClearing('lane-a')).toBe(false);
    expect(h.sessions.get('lane-a')?.['status']).toBe('active');
  });
});

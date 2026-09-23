import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

interface StoredRow {
  id: number;
  projectId: string;
  phaseNumber: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const store: StoredRow[] = [];
let nextRowId = 1;

vi.mock('../db', () => ({
  getHarnessProject: vi.fn(),
  listHarnessProjects: vi.fn(() => []),
  getActiveChatSession: vi.fn(),
  getDriveState: vi.fn(() => null),
  savePipelineMessage: (data: {
    projectId: string;
    phaseNumber: number;
    role: 'user' | 'assistant' | 'system';
    content: string;
  }) => {
    store.push({
      id: nextRowId++,
      projectId: data.projectId,
      phaseNumber: data.phaseNumber,
      role: data.role,
      content: data.content,
    });
  },
  getPipelinePhaseMessagesAsChatHistory: (projectId: string, phaseNumber: number) =>
    store
      .filter((r) => r.projectId === projectId && r.phaseNumber === phaseNumber)
      .sort((a, b) => a.id - b.id)
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .map((r) => ({ role: r.role, content: r.content })),
  insertEnrichMessage: vi.fn(),
  insertHarnessRound: vi.fn(),
  updateHarnessRound: vi.fn(),
}));

vi.mock('../pipeline-create', () => ({ createPipelineProject: vi.fn() }));
vi.mock('../pipeline-drive-coordinator', () => ({ getPipelineDriveCoordinator: vi.fn(() => null) }));
vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));

import type { Mock } from 'vitest';
import { getHarnessProject } from '../db';
import { pipelineEventBus } from '../pipeline-event-bus';
import { registerPipelineEngineRef, _resetPipelineEngineRefForTesting } from '../pipeline-engine-ref';
import { pipelineReplyCore, resolvePendingQuestion } from '../pipeline-control-core';
import { persistMessage } from '../pipeline-shared/persist';
import { textProbe } from '../pipeline-shared/text-probe';

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'f8-pending-question-multibyte.txt'), 'utf8');

const PROJECT = {
  id: 'proj_rt',
  name: 'RoundTrip',
  pipelineType: 'development',
  status: 'running',
  pipelineCurrentPhase: 1,
  pipelineStartPhase: 1,
  projectPath: '/tmp/demo',
  specPath: null,
};

function installEngine(): void {
  registerPipelineEngineRef(((/* */) => ({
    getCurrentPhase: vi.fn(() => ({ phase: 1, status: 'running' })),
    sendMessage: vi.fn(() => {
      queueMicrotask(() => {
        pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_rt', phase: 1, type: 'done' });
      });
      return undefined;
    }),
  })) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.length = 0;
  nextRowId = 1;
  pipelineEventBus._resetForTesting();
  _resetPipelineEngineRefForTesting();
  (getHarnessProject as Mock).mockReturnValue({ ...PROJECT });
  installEngine();
});

describe('F8-b2 — round-trip multibyte byte a byte (F8-AC2)', () => {
  it('fixture e de fato multibyte pesada (sanidade: bytes > chars, >200 chars de path)', () => {
    const probe = textProbe(FIXTURE);
    expect(probe.bytes).toBeGreaterThan(FIXTURE.length);
    const pathLine = FIXTURE.split('\n').find((l) => l.startsWith('- /Users/'));
    expect(pathLine && pathLine.length).toBeGreaterThan(200);
  });

  it('persistMessage -> store -> resolvePendingQuestion devolve a fixture INTACTA (hash igual)', () => {
    persistMessage(
      { kind: 'pipeline', projectId: 'proj_rt', phaseNumber: 1 },
      'user',
      'contexto da fase com acentuação própria',
    );
    persistMessage({ kind: 'pipeline', projectId: 'proj_rt', phaseNumber: 1 }, 'assistant', FIXTURE);

    const pending = resolvePendingQuestion('proj_rt', 'development', 1);
    expect(pending).not.toBeNull();
    expect(textProbe(pending as string)).toEqual(textProbe(FIXTURE));
    expect(pending).toBe(FIXTURE);
  });

  it('payload do pipelineReplyCore carrega a pendingQuestion byte-identica (fim do caminho b2)', async () => {
    persistMessage({ kind: 'pipeline', projectId: 'proj_rt', phaseNumber: 1 }, 'assistant', FIXTURE);

    const res = await pipelineReplyCore('proj_rt', 'resposta do motorista com ação e emoji 🚀');

    expect(res.ok).toBe(true);
    if (res.ok) {
      const value = res.value as { status: string; pendingQuestion: string | null };
      expect(value.status).toBe('completed');
      expect(value.pendingQuestion).not.toBeNull();
      const got = value.pendingQuestion as string;
      expect(Buffer.from(got, 'utf8').equals(Buffer.from(FIXTURE, 'utf8'))).toBe(true);
      expect(textProbe(got)).toEqual(textProbe(FIXTURE));
    }
  });

  it('a reply do motorista tambem persiste intacta (caminho de escrita do sendMessage simulado)', () => {
    const reply = 'ajuste: usar codificação UTF-8 ponta a ponta — ação, coração, 🧭✅';
    persistMessage({ kind: 'pipeline', projectId: 'proj_rt', phaseNumber: 1 }, 'user', reply);
    const row = store.find((r) => r.role === 'user');
    expect(row).toBeDefined();
    expect(textProbe(row!.content)).toEqual(textProbe(reply));
  });
});

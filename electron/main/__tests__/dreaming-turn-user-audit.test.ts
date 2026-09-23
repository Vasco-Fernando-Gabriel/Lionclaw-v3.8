import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// eslint-disable-next-line no-var
var TEST_TMP_DIR: string = path.join(os.tmpdir(), `turn-user-audit-test-${process.pid}`);

const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../paths', () => ({
  getLionClawHome: () => TEST_TMP_DIR,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockGetSetting = vi.fn<(key: string) => string | null>(() => null);
const mockGetDreamingState = vi.fn(() => ({ lastGateRunAt: 0, lastTurnRunAt: 0 }));
const mockAllFn = vi.fn(() => [
  { role: 'user', content: 'nao uso mais JavaScript, migrei para TypeScript' },
  { role: 'assistant', content: 'anotado' },
]);

vi.mock('../db', () => ({
  getSetting: (key: string) => mockGetSetting(key),
  getSession: vi.fn(() => ({ type: 'chat' })),
  getDreamingState: () => mockGetDreamingState(),
  getDreamingTurnInterval: vi.fn(() => 20),
  incrementTurnCount: vi.fn(() => 20),
  resetTurnCount: vi.fn(),
  setLastTurnRunAt: vi.fn(),
  incrementTotalTurnRuns: vi.fn(),
  incrementTotalTurnFailsafes: vi.fn(),
  getDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: mockAllFn })) })),
}));

// eslint-disable-next-line no-var
var inLock = false;
const mockApplyMemoryUpdates = vi.fn<(updates: unknown) => Promise<void>>(async () => {});
const mockApplyUserProfileUpdates = vi.fn<(updates: unknown) => Promise<void>>(async () => {
  if (!inLock) throw new Error('applyUserProfileUpdates chamado FORA do lock');
});
const mockRunStructuredMemoryLlm = vi.fn<(prompt: string, options?: unknown) => Promise<string>>();

vi.mock('../memory-pipeline', () => ({
  runStructuredMemoryLlm: (prompt: string, options?: unknown) => mockRunStructuredMemoryLlm(prompt, options),
  tryWithMemoryGateLock: async (fn: () => Promise<unknown>) => {
    inLock = true;
    try {
      return await fn();
    } finally {
      inLock = false;
    }
  },
  applyMemoryUpdates: (updates: unknown) => mockApplyMemoryUpdates(updates),
  applyUserProfileUpdates: (updates: unknown) => mockApplyUserProfileUpdates(updates),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

import { runTurnDreaming, maybeRunTurnDreaming } from '../dreaming-turn-engine';

const skillDir = path.join(TEST_TMP_DIR, 'skills', 'dreaming');

const VALID_SKILL = '# Dreaming\n## Regras de REMOVE Automatico\n- REMOVE 1\n## Regras de Seguranca\n- ok\n';

const BASE_INPUT = {
  recentTurns: [{ role: 'user' as const, content: 'migrei para TypeScript' }],
  currentMemoryMd: '## Decisoes ativas\n- [2026-01-01] a\n',
  currentUserMd: '# Sobre o Usuario\n\n## Stack e ferramentas\n- Usa JavaScript [2026-01-01]\n',
};

beforeEach(() => {
  vi.clearAllMocks();
  inLock = false;
  mockGetSetting.mockImplementation(() => null);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), VALID_SKILL, 'utf-8');
});

afterEach(() => {
  fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
});

describe('runTurnDreaming — schema do USER.md (12.3)', () => {
  it('userRemove/userUpdate validos entram no resultado', async () => {
    const invoker = vi.fn(async (_prompt: string) =>
      JSON.stringify({
        apply: {
          remove: [],
          update: [],
          userRemove: ['- linha velha [2026-01-01]'],
          userUpdate: [
            {
              oldText: '- Usa JavaScript [2026-01-01]',
              newText: '- Usa TypeScript [2026-07-01]',
              section: 'stack_ferramentas',
            },
          ],
        },
        quarantine: [],
        discarded: [],
      }),
    );

    const result = await runTurnDreaming(BASE_INPUT, { invoker });

    expect(result.failSafeTriggered).toBe(false);
    expect(result.apply.userRemove).toEqual(['- linha velha [2026-01-01]']);
    expect(result.apply.userUpdate).toEqual([
      {
        oldText: '- Usa JavaScript [2026-01-01]',
        newText: '- Usa TypeScript [2026-07-01]',
        section: 'stack_ferramentas',
      },
    ]);
    const prompt = invoker.mock.calls[0][0] as unknown as string;
    expect(prompt).toContain('[USER_MD_AUDIT]');
    expect(prompt).toContain('NUNCA proponha userAdd');
  });

  it('userAdd emitido pelo modelo e descartado com warn; REMOVE/UPDATE preservados', async () => {
    const invoker = vi.fn(async (_prompt: string) =>
      JSON.stringify({
        apply: {
          remove: ['- linha do memory'],
          update: [],
          userAdd: [{ section: 'fatos_duraveis', text: 'fato novo proibido' }],
          userRemove: ['- Usa JavaScript [2026-01-01]'],
          userUpdate: [],
        },
        quarantine: [],
        discarded: [],
      }),
    );

    const result = await runTurnDreaming(BASE_INPUT, { invoker });

    expect(result.failSafeTriggered).toBe(false);
    expect(result.apply.remove).toEqual(['- linha do memory']);
    expect(result.apply.userRemove).toEqual(['- Usa JavaScript [2026-01-01]']);
    expect('userAdd' in result.apply).toBe(false);
    const warned = warnSpy.mock.calls.some((c) => String(c[1] ?? c[0]).includes('apply.userAdd descartado'));
    expect(warned).toBe(true);
  });

  it('AC-53: section invalida em userUpdate cai no fail-safe sem tocar o arquivo', async () => {
    const invoker = vi.fn(async (_prompt: string) =>
      JSON.stringify({
        apply: {
          remove: [],
          update: [],
          userRemove: [],
          userUpdate: [{ oldText: '- x', newText: '- y', section: 'secao_que_nao_existe' }],
        },
        quarantine: [],
        discarded: [],
      }),
    );

    const result = await runTurnDreaming(BASE_INPUT, { invoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('json_parse_error');
    expect(result.apply.userRemove).toBeUndefined();
    expect(result.apply.userUpdate).toBeUndefined();
  });
});

describe('maybeRunTurnDreaming — aplicacao dentro do lock (AC-53)', () => {
  function writeMemoryAndUser(): void {
    const memLines = ['## Decisoes ativas'];
    for (let i = 0; i < 12; i++) memLines.push(`- [2026-01-01] decisao ${i}`);
    fs.writeFileSync(path.join(TEST_TMP_DIR, 'MEMORY.md'), memLines.join('\n'), 'utf-8');
    fs.writeFileSync(
      path.join(TEST_TMP_DIR, 'USER.md'),
      '# Sobre o Usuario\n\n## Stack e ferramentas\n- Usa JavaScript [2026-01-01]\n',
      'utf-8',
    );
  }

  it('aplica userRemove + userUpdate line-matched via applyUserProfileUpdates; update sem match e ignorado', async () => {
    writeMemoryAndUser();
    mockGetSetting.mockImplementation((key: string) => (key === 'dreaming_turn_based_enabled' ? 'true' : null));

    mockRunStructuredMemoryLlm.mockResolvedValue(
      JSON.stringify({
        apply: {
          remove: [],
          update: [],
          userRemove: [],
          userUpdate: [
            {
              oldText: '- Usa JavaScript [2026-01-01]',
              newText: 'Usa TypeScript [2026-07-01]',
              section: 'stack_ferramentas',
            },
            {
              oldText: '- linha fantasma [2026-01-01]',
              newText: 'nao deveria entrar',
              section: 'fatos_duraveis',
            },
          ],
        },
        quarantine: [],
        discarded: [],
      }),
    );

    await maybeRunTurnDreaming('session-1', () => null);

    await vi.waitFor(() => {
      expect(mockApplyUserProfileUpdates).toHaveBeenCalledTimes(1);
    });

    const input = mockApplyUserProfileUpdates.mock.calls[0][0] as unknown as {
      add: Array<{ section: string; text: string }>;
      remove: string[];
    };
    expect(input.add).toEqual([{ section: 'stack_ferramentas', text: 'Usa TypeScript [2026-07-01]' }]);
    expect(input.remove).toEqual(['- Usa JavaScript [2026-01-01]']);
    const warned = warnSpy.mock.calls.some((c) => String(c[1] ?? c[0]).includes('userUpdate sem line-match exato'));
    expect(warned).toBe(true);
  });

  it('sem propostas de USER.md, applyUserProfileUpdates nao e chamado', async () => {
    writeMemoryAndUser();
    mockGetSetting.mockImplementation((key: string) => (key === 'dreaming_turn_based_enabled' ? 'true' : null));

    mockRunStructuredMemoryLlm.mockResolvedValue(
      JSON.stringify({
        apply: { remove: ['- [2026-01-01] decisao 0'], update: [] },
        quarantine: [],
        discarded: [],
      }),
    );

    await maybeRunTurnDreaming('session-1', () => null);

    await vi.waitFor(() => {
      expect(mockApplyMemoryUpdates).toHaveBeenCalledTimes(1);
    });
    expect(mockApplyUserProfileUpdates).not.toHaveBeenCalled();
  });
});

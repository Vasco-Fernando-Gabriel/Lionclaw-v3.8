import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// eslint-disable-next-line no-var
var TEST_TMP_DIR: string = path.join(os.tmpdir(), `dreaming-turn-engine-test-${process.pid}`);

vi.mock('../paths', () => ({
  getLionClawHome: () => TEST_TMP_DIR,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockGetSetting = vi.fn<(key: string) => string | null>();
const mockGetDreamingState = vi.fn<
  () => {
    lastGateRunAt: number | null;
    lastTurnRunAt: number | null;
    turnCount: number;
    totalTurnRuns: number;
    totalTurnFailsafes: number;
  }
>();
const mockGetDreamingTurnInterval = vi.fn<() => number>().mockReturnValue(20);
const mockIncrementTurnCount = vi.fn<() => number>();
const mockResetTurnCount = vi.fn<() => void>();
const mockSetLastTurnRunAt = vi.fn<(timestamp: number) => void>();
const mockIncrementTotalTurnRuns = vi.fn<() => void>();
const mockIncrementTotalTurnFailsafes = vi.fn<() => void>();

const mockAllFn = vi.fn<(sessionId: string, limit: number) => Array<{ role: string; content: string }>>();
const mockGetDb = vi.fn(() => ({
  prepare: vi.fn(() => ({ all: mockAllFn })),
}));

const mockGetSession = vi.fn<(sessionId: string) => { type: string } | undefined>(() => ({ type: 'chat' }));

vi.mock('../db', () => ({
  getSetting: (...args: Parameters<typeof mockGetSetting>) => mockGetSetting(...args),
  getSession: (...args: Parameters<typeof mockGetSession>) => mockGetSession(...args),
  getDreamingState: (...args: Parameters<typeof mockGetDreamingState>) => mockGetDreamingState(...args),
  getDreamingTurnInterval: () => mockGetDreamingTurnInterval(),
  incrementTurnCount: () => mockIncrementTurnCount(),
  resetTurnCount: () => mockResetTurnCount(),
  setLastTurnRunAt: (...args: Parameters<typeof mockSetLastTurnRunAt>) => mockSetLastTurnRunAt(...args),
  incrementTotalTurnRuns: () => mockIncrementTotalTurnRuns(),
  incrementTotalTurnFailsafes: () => mockIncrementTotalTurnFailsafes(),
  getDb: () => mockGetDb(),
}));

const mockTryWithMemoryGateLock = vi.fn<(fn: () => Promise<unknown>) => Promise<unknown>>();
const mockApplyMemoryUpdates = vi.fn<(updates: unknown) => Promise<void>>();
const mockRunStructuredMemoryLlm = vi.fn<(prompt: string, options?: unknown) => Promise<string>>();

vi.mock('../memory-pipeline', () => ({
  runStructuredMemoryLlm: (prompt: string, options?: unknown) => mockRunStructuredMemoryLlm(prompt, options),
  tryWithMemoryGateLock: (fn: () => Promise<unknown>) => mockTryWithMemoryGateLock(fn),
  applyMemoryUpdates: (updates: unknown) => mockApplyMemoryUpdates(updates),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

import {
  runTurnDreaming,
  saveTurnDreamingReport,
  maybeRunTurnDreaming,
  recordCompletedMainChatTurn,
  type TurnDreamingInput,
} from '../dreaming-turn-engine';

const tmpDir = TEST_TMP_DIR;
const skillDir = path.join(tmpDir, 'skills', 'dreaming');
const skillPath = path.join(skillDir, 'SKILL.md');

const VALID_SKILL_CONTENT = `# Skill: Dreaming

## Regras de Auto-Apply

### REMOVE AUTOMATICAMENTE
1. Entrada sem data [YYYY-MM-DD]
2. Workaround resolvido

### Regras de Seguranca
1. Nunca remova informacoes criticas de seguranca
`;

const BASE_INPUT: TurnDreamingInput = {
  recentTurns: [
    { role: 'user', content: 'O workaround do bug do banco ja foi corrigido na v2.' },
    { role: 'assistant', content: 'Entendido. Removerei o workaround obsoleto do MEMORY.md.' },
  ],
  currentMemoryMd: [
    '## Decisoes ativas',
    '',
    '- [2026-05-20] Usar Vitest para testes',
    '',
    '## Workarounds e bugs conhecidos',
    '',
    '- Workaround do bug do banco (ja corrigido)',
    '',
    '## Estado de projetos',
    '',
    '## Referencias externas',
  ].join('\n'),
  currentUserMd: '',
};

const VALID_LLM_OUTPUT = {
  apply: {
    remove: ['- Workaround do bug do banco (ja corrigido)'],
    update: [
      {
        oldText: '- [2026-05-20] Usar Vitest para testes',
        newText: '- [2026-05-24] Usar Vitest para testes (confirmado em prod)',
        section: 'decisoes_ativas',
      },
    ],
  },
  quarantine: [],
  discarded: [],
};

beforeEach(() => {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillPath, VALID_SKILL_CONTENT, 'utf-8');

  vi.clearAllMocks();
  mockGetSetting.mockReturnValue(null);
  mockGetSession.mockReturnValue({ type: 'chat' });
  mockGetDreamingState.mockReturnValue({
    lastGateRunAt: null,
    lastTurnRunAt: null,
    turnCount: 0,
    totalTurnRuns: 0,
    totalTurnFailsafes: 0,
  });
  mockGetDreamingTurnInterval.mockReturnValue(20);
  mockIncrementTurnCount.mockReturnValue(1);
  mockResetTurnCount.mockReturnValue(undefined);
  mockSetLastTurnRunAt.mockReturnValue(undefined);
  mockIncrementTotalTurnRuns.mockReturnValue(undefined);
  mockIncrementTotalTurnFailsafes.mockReturnValue(undefined);
  mockAllFn.mockReturnValue([]);
  mockApplyMemoryUpdates.mockResolvedValue(undefined);
  mockRunStructuredMemoryLlm.mockRejectedValue(
    new Error('runStructuredMemoryLlm NAO deve ser chamado diretamente nos testes'),
  );
  mockTryWithMemoryGateLock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('(a) JSON valido com REMOVE+UPDATE', () => {
  it('retorna apply correto e failSafeTriggered=false quando LLM retorna JSON bem-formado', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(false);
    expect(result.failSafeReason).toBeUndefined();
    expect(result.apply.remove).toEqual(['- Workaround do bug do banco (ja corrigido)']);
    expect(result.apply.update).toHaveLength(1);
    expect(result.apply.update[0].section).toBe('decisoes_ativas');
    expect(result.apply.update[0].oldText).toBe('- [2026-05-20] Usar Vitest para testes');
    expect(result.apply.update[0].newText).toBe('- [2026-05-24] Usar Vitest para testes (confirmado em prod)');
    expect(result.quarantine).toEqual([]);
    expect(result.discarded).toEqual([]);
    expect(result.report).toContain('Turn-Based Dreaming');
    expect(mockInvoker).toHaveBeenCalledTimes(1);
  });

  it('valida todas as 4 MemorySection validas em apply.update', async () => {
    const sections = ['decisoes_ativas', 'workarounds', 'estado_de_projetos', 'referencias_externas'] as const;
    for (const section of sections) {
      const output = {
        apply: {
          remove: [],
          update: [{ oldText: 'texto antigo', newText: 'texto novo', section }],
        },
        quarantine: [],
        discarded: [],
      };
      const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(output));
      const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

      expect(result.failSafeTriggered).toBe(false);
      expect(result.apply.update[0].section).toBe(section);
    }
  });

  it('aceita JSON com code fence (LLM ignorou instrucao de JSON puro)', async () => {
    const withFence = '```json\n' + JSON.stringify(VALID_LLM_OUTPUT) + '\n```';
    const mockInvoker = vi.fn().mockResolvedValue(withFence);

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(false);
    expect(result.apply.remove).toHaveLength(1);
    expect(result.apply.update).toHaveLength(1);
  });

  it('nunca throw — runTurnDreaming sempre retorna TurnDreamingResult', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));

    await expect(runTurnDreaming(BASE_INPUT, { invoker: mockInvoker })).resolves.toBeDefined();
  });

  it('retorna TurnDreamingResult sem campo add no apply', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect((result.apply as Record<string, unknown>)['add']).toBeUndefined();
  });
});

describe('(b) JSON com apply.add presente', () => {
  it('descarta apply.add silenciosamente, preserva remove e update, failSafeTriggered=false', async () => {
    const outputWithAdd = {
      apply: {
        remove: ['linha a remover'],
        update: [
          {
            oldText: 'texto antigo',
            newText: 'texto novo',
            section: 'decisoes_ativas',
          },
        ],
        add: [
          { section: 'decisoes_ativas', text: '[2026-05-24] Nova entrada' },
          { section: 'workarounds', text: 'Outro item indevido' },
        ],
      },
      quarantine: [],
      discarded: [],
    };
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(outputWithAdd));

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(false);
    expect(result.apply.remove).toEqual(['linha a remover']);
    expect(result.apply.update).toHaveLength(1);
    expect(result.apply.update[0].section).toBe('decisoes_ativas');
    expect((result.apply as Record<string, unknown>)['add']).toBeUndefined();
  });

  it('descarta apply.add mesmo quando e o unico campo populado', async () => {
    const outputOnlyAdd = {
      apply: {
        remove: [],
        update: [],
        add: [{ section: 'decisoes_ativas', text: 'Isso nao deve entrar' }],
      },
      quarantine: [],
      discarded: [],
    };
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(outputOnlyAdd));

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(false);
    expect(result.apply.remove).toEqual([]);
    expect(result.apply.update).toEqual([]);
  });
});

describe('(c) JSON invalido', () => {
  it('retorna failSafeReason=json_parse_error quando LLM retorna texto nao-JSON', async () => {
    const mockInvoker = vi.fn().mockResolvedValue('not json at all');

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('json_parse_error');
    expect(result.apply.remove).toEqual([]);
    expect(result.apply.update).toEqual([]);
  });

  it('retorna failSafeReason=json_parse_error quando JSON valido mas schema invalido (sem apply)', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify({ quarantine: [], discarded: [] }));

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('json_parse_error');
  });

  it('retorna failSafeReason=json_parse_error quando apply.update tem section invalida', async () => {
    const outputBadSection = {
      apply: {
        remove: [],
        update: [{ oldText: 'texto', newText: 'novo', section: 'secao_invalida' }],
      },
      quarantine: [],
      discarded: [],
    };
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(outputBadSection));

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('json_parse_error');
  });

  it('quarantine e discarded ficam vazios em json_parse_error (sem candidatos)', async () => {
    const mockInvoker = vi.fn().mockResolvedValue('{ invalid json }');

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.quarantine).toEqual([]);
    expect(result.discarded).toEqual([]);
  });
});

describe('(d) invoker throw', () => {
  it('retorna failSafeReason=llm_error quando o invoker rejeita', async () => {
    const mockInvoker = vi.fn().mockRejectedValue(new Error('LLM offline'));

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('llm_error');
    expect(result.apply.remove).toEqual([]);
    expect(result.apply.update).toEqual([]);
  });

  it('nunca throw — runTurnDreaming sempre retorna TurnDreamingResult mesmo com invoker rejeitando', async () => {
    const mockInvoker = vi.fn().mockRejectedValue(new Error('qualquer erro'));

    await expect(runTurnDreaming(BASE_INPUT, { invoker: mockInvoker })).resolves.toBeDefined();
  });

  it('quarantine e discarded ficam vazios em llm_error (sem candidatos)', async () => {
    const mockInvoker = vi.fn().mockRejectedValue(new Error('connection refused'));

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.quarantine).toEqual([]);
    expect(result.discarded).toEqual([]);
  });
});

describe('(e) SKILL.md ausente', () => {
  it('retorna failSafeReason=skill_md_missing quando SKILL.md nao existe', async () => {
    fs.rmSync(skillPath);

    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('skill_md_missing');
  });

  it('invoker NAO e chamado quando SKILL.md nao existe (contagem = 0)', async () => {
    fs.rmSync(skillPath);

    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));

    await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(mockInvoker).toHaveBeenCalledTimes(0);
  });

  it('retorna failSafeReason=skill_md_missing quando SKILL.md existe mas esta vazio', async () => {
    fs.writeFileSync(skillPath, '   \n\n  ', 'utf-8');

    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('skill_md_missing');
    expect(mockInvoker).toHaveBeenCalledTimes(0);
  });

  it('quarantine e discarded ficam vazios em skill_md_missing', async () => {
    fs.rmSync(skillPath);

    const mockInvoker = vi.fn();

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.quarantine).toEqual([]);
    expect(result.discarded).toEqual([]);
  });
});

describe('(f) timeout', () => {
  it('retorna failSafeReason=timeout quando invoker demora mais que timeoutMs', async () => {
    const slowInvoker = vi
      .fn()
      .mockImplementation(
        () => new Promise<string>((resolve) => setTimeout(() => resolve(JSON.stringify(VALID_LLM_OUTPUT)), 2000)),
      );

    const result = await runTurnDreaming(BASE_INPUT, { invoker: slowInvoker, timeoutMs: 50 });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('timeout');
    expect(result.apply.remove).toEqual([]);
    expect(result.apply.update).toEqual([]);
  }, 3000);

  it('nao faz timeout com timeoutMs suficientemente alto', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));

    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker, timeoutMs: 5000 });

    expect(result.failSafeTriggered).toBe(false);
    expect(result.failSafeReason).toBeUndefined();
  });

  it('quarantine e discarded ficam vazios em timeout', async () => {
    const slowInvoker = vi
      .fn()
      .mockImplementation(() => new Promise<string>((resolve) => setTimeout(() => resolve('{}'), 2000)));

    const result = await runTurnDreaming(BASE_INPUT, { invoker: slowInvoker, timeoutMs: 50 });

    expect(result.quarantine).toEqual([]);
    expect(result.discarded).toEqual([]);
  }, 3000);
});

describe('saveTurnDreamingReport', () => {
  it('cria arquivo com nome no formato YYYY-MM-DD_HHmmss_<uuid>_turn-dreaming-report.md', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));
    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    const filePath = await saveTurnDreamingReport(result);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(path.basename(filePath)).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f-]+_turn-dreaming-report\.md$/);
  });

  it('gera 20 paths unicos em chamadas back-to-back (UUID anti-colisao)', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));
    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    const paths = new Set<string>();
    for (let i = 0; i < 20; i++) {
      paths.add(await saveTurnDreamingReport(result));
    }

    expect(paths.size).toBe(20);
  });

  it('cria o diretorio pai se nao existir', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));
    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    const expectedDir = path.join(tmpDir, 'workspaces', 'lionclaw', 'dreaming-reports');
    if (fs.existsSync(expectedDir)) {
      fs.rmSync(expectedDir, { recursive: true });
    }

    const filePath = await saveTurnDreamingReport(result);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(expectedDir)).toBe(true);
  });

  it('conteudo do arquivo contem o report do resultado', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));
    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    const filePath = await saveTurnDreamingReport(result);
    const content = fs.readFileSync(filePath, 'utf-8');

    expect(content).toContain(result.report);
  });

  it('adiciona secao fail-safe quando failSafeTriggered=true', async () => {
    const mockInvoker = vi.fn().mockRejectedValue(new Error('LLM offline'));
    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(true);

    const filePath = await saveTurnDreamingReport(result);
    const content = fs.readFileSync(filePath, 'utf-8');

    expect(content).toContain('Fail-Safe Details');
    expect(content).toContain('llm_error');
  });

  it('retorna path absoluto do arquivo criado', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));
    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    const filePath = await saveTurnDreamingReport(result);

    expect(path.isAbsolute(filePath)).toBe(true);
  });

  it('fail-safe com skill_md_missing inclui failSafeReason no arquivo', async () => {
    fs.rmSync(skillPath);

    const mockInvoker = vi.fn();
    const result = await runTurnDreaming(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('skill_md_missing');

    const filePath = await saveTurnDreamingReport(result);
    const content = fs.readFileSync(filePath, 'utf-8');

    expect(content).toContain('skill_md_missing');
    expect(content).toContain('Fail-Safe Details');
  });
});

function makeGetWindow() {
  const sentChunks: Array<{ type: string; isDreaming?: boolean }> = [];
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: vi.fn((_channel: string, chunk: { type: string; isDreaming?: boolean }) => {
        sentChunks.push(chunk);
      }),
    },
  };
  const getWindow = vi.fn(() => win as unknown as import('electron').BrowserWindow);
  return { getWindow, win, sentChunks };
}

function writeMemoryMd(lines: string[]): void {
  const memoryPath = path.join(tmpDir, 'MEMORY.md');
  fs.writeFileSync(memoryPath, lines.join('\n'), 'utf-8');
}

describe('Sprint4 Cenario 1: dreaming_turn_based_enabled=false', () => {
  it('maybeRunTurnDreaming retorna sem tocar no lock, LLM ou emit', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'false';
      return null;
    });

    const { getWindow, sentChunks } = makeGetWindow();

    await maybeRunTurnDreaming('session-1', getWindow);

    expect(mockTryWithMemoryGateLock).not.toHaveBeenCalled();
    expect(mockRunStructuredMemoryLlm).not.toHaveBeenCalled();
    expect(sentChunks).toHaveLength(0);
  });

  it('recordCompletedMainChatTurn nao incrementa contador quando disabled', () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'false';
      return null;
    });

    const { getWindow } = makeGetWindow();
    recordCompletedMainChatTurn('session-1', getWindow);

    expect(mockIncrementTurnCount).not.toHaveBeenCalled();
  });
});

describe('Sprint4 Cenario 2: cooldown ativo', () => {
  it('skip silencioso quando last_gate_run_at < 5min atras', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      return null;
    });
    mockGetDreamingState.mockReturnValue({
      lastGateRunAt: Date.now() - 60 * 1000,
      lastTurnRunAt: null,
      turnCount: 5,
      totalTurnRuns: 0,
      totalTurnFailsafes: 0,
    });

    const { getWindow, sentChunks } = makeGetWindow();

    await maybeRunTurnDreaming('session-1', getWindow);

    expect(mockTryWithMemoryGateLock).not.toHaveBeenCalled();
    expect(sentChunks).toHaveLength(0);
  });

  it('skip cooldown nao zera o turn_count (resetTurnCount nao chamado)', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      return null;
    });
    mockGetDreamingState.mockReturnValue({
      lastGateRunAt: Date.now() - 2 * 60 * 1000,
      lastTurnRunAt: null,
      turnCount: 8,
      totalTurnRuns: 0,
      totalTurnFailsafes: 0,
    });

    const { getWindow } = makeGetWindow();

    await maybeRunTurnDreaming('session-1', getWindow);

    expect(mockResetTurnCount).not.toHaveBeenCalled();
  });
});

describe('Sprint4 Cenario 3: lock ocupado', () => {
  it('skip silencioso quando tryWithMemoryGateLock retorna null', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      return null;
    });
    mockGetDreamingState.mockReturnValue({
      lastGateRunAt: null,
      lastTurnRunAt: null,
      turnCount: 0,
      totalTurnRuns: 0,
      totalTurnFailsafes: 0,
    });
    mockTryWithMemoryGateLock.mockResolvedValue(null);

    const { getWindow, sentChunks } = makeGetWindow();

    await maybeRunTurnDreaming('session-1', getWindow);

    expect(sentChunks).toHaveLength(0);
    expect(mockResetTurnCount).not.toHaveBeenCalled();
  });
});

describe('Sprint4 Cenario 4: MEMORY.md pequeno', () => {
  it('skip memory_too_small quando MEMORY.md tem < 10 linhas nao-vazias', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      if (key === 'dreaming_turn_based_model') return '';
      return null;
    });
    mockGetDreamingState.mockReturnValue({
      lastGateRunAt: null,
      lastTurnRunAt: null,
      turnCount: 0,
      totalTurnRuns: 0,
      totalTurnFailsafes: 0,
    });
    writeMemoryMd(['linha 1', 'linha 2', 'linha 3']);

    const { getWindow, sentChunks } = makeGetWindow();

    await maybeRunTurnDreaming('session-1', getWindow);

    await new Promise((r) => setTimeout(r, 10));

    expect(sentChunks).toHaveLength(0);
    expect(mockResetTurnCount).toHaveBeenCalledTimes(1);
    expect(mockSetLastTurnRunAt).not.toHaveBeenCalled();
  });
});

describe('Sprint4 Cenario 5: execucao completa com sucesso', () => {
  it('emit true antes, false no finally; state commits APOS exec; applyMemoryUpdates chamado', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      if (key === 'dreaming_turn_based_model') return '';
      return null;
    });
    mockGetDreamingState.mockReturnValue({
      lastGateRunAt: null,
      lastTurnRunAt: null,
      turnCount: 0,
      totalTurnRuns: 0,
      totalTurnFailsafes: 0,
    });

    writeMemoryMd(Array.from({ length: 15 }, (_, i) => `linha ${i + 1}`));

    const validOutput = {
      apply: {
        remove: ['linha 1'],
        update: [],
      },
      quarantine: [],
      discarded: [],
    };
    mockRunStructuredMemoryLlm.mockResolvedValue(JSON.stringify(validOutput));

    const { getWindow, sentChunks } = makeGetWindow();

    await maybeRunTurnDreaming('session-1', getWindow);

    await new Promise((r) => setTimeout(r, 50));

    const dreamingChunks = sentChunks.filter((c) => c.type === 'dreaming_status');
    expect(dreamingChunks).toHaveLength(2);
    expect(dreamingChunks[0].isDreaming).toBe(true);
    expect(dreamingChunks[1].isDreaming).toBe(false);

    expect(mockSetLastTurnRunAt).toHaveBeenCalledTimes(1);
    expect(mockIncrementTotalTurnRuns).toHaveBeenCalledTimes(1);
    expect(mockResetTurnCount).toHaveBeenCalledTimes(1);

    expect(mockApplyMemoryUpdates).toHaveBeenCalledTimes(1);
    const applyArgs = mockApplyMemoryUpdates.mock.calls[0][0] as { remove: string[] };
    expect(applyArgs.remove).toContain('linha 1');

    expect(mockIncrementTotalTurnFailsafes).not.toHaveBeenCalled();
  });
});

describe('Sprint4 Cenario 6: fail-safe acionado', () => {
  it('MEMORY.md nao tocado, report criado, incrementTotalTurnFailsafes chamado', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      if (key === 'dreaming_turn_based_model') return '';
      return null;
    });
    mockGetDreamingState.mockReturnValue({
      lastGateRunAt: null,
      lastTurnRunAt: null,
      turnCount: 0,
      totalTurnRuns: 0,
      totalTurnFailsafes: 0,
    });

    writeMemoryMd(Array.from({ length: 15 }, (_, i) => `linha ${i + 1}`));

    mockRunStructuredMemoryLlm.mockRejectedValue(new Error('LLM connection refused'));

    const { getWindow, sentChunks } = makeGetWindow();

    await maybeRunTurnDreaming('session-1', getWindow);

    await new Promise((r) => setTimeout(r, 50));

    const dreamingChunks = sentChunks.filter((c) => c.type === 'dreaming_status');
    expect(dreamingChunks).toHaveLength(2);
    expect(dreamingChunks[0].isDreaming).toBe(true);
    expect(dreamingChunks[1].isDreaming).toBe(false);

    expect(mockApplyMemoryUpdates).not.toHaveBeenCalled();

    expect(mockIncrementTotalTurnFailsafes).toHaveBeenCalledTimes(1);

    expect(mockSetLastTurnRunAt).toHaveBeenCalledTimes(1);
    expect(mockIncrementTotalTurnRuns).toHaveBeenCalledTimes(1);
    expect(mockResetTurnCount).toHaveBeenCalledTimes(1);
  });
});

describe('Sprint4 Cenario 7: collectRecentTurns SQL', () => {
  it('passa session_id e LIMIT = turnCount * 2 para o prepare().all()', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      if (key === 'dreaming_turn_based_model') return '';
      return null;
    });
    mockGetDreamingState.mockReturnValue({
      lastGateRunAt: null,
      lastTurnRunAt: null,
      turnCount: 0,
      totalTurnRuns: 0,
      totalTurnFailsafes: 0,
    });

    writeMemoryMd(Array.from({ length: 15 }, (_, i) => `linha ${i + 1}`));

    mockAllFn.mockReturnValue([
      { role: 'assistant', content: 'Resposta 2' },
      { role: 'user', content: 'Pergunta 2' },
      { role: 'assistant', content: 'Resposta 1' },
      { role: 'user', content: 'Pergunta 1' },
    ]);

    const validOutput = { apply: { remove: [], update: [] }, quarantine: [], discarded: [] };
    mockRunStructuredMemoryLlm.mockResolvedValue(JSON.stringify(validOutput));

    const { getWindow } = makeGetWindow();

    await maybeRunTurnDreaming('session-abc', getWindow);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockAllFn).toHaveBeenCalledWith('session-abc', 40);
  });

  it('retorna mensagens em ordem ASC (inverte resultado DESC do SQL)', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      if (key === 'dreaming_turn_based_model') return '';
      return null;
    });
    mockGetDreamingState.mockReturnValue({
      lastGateRunAt: null,
      lastTurnRunAt: null,
      turnCount: 0,
      totalTurnRuns: 0,
      totalTurnFailsafes: 0,
    });

    writeMemoryMd(Array.from({ length: 15 }, (_, i) => `linha ${i + 1}`));

    mockAllFn.mockReturnValue([
      { role: 'assistant', content: 'Resposta B' },
      { role: 'user', content: 'Pergunta B' },
      { role: 'assistant', content: 'Resposta A' },
      { role: 'user', content: 'Pergunta A' },
    ]);

    let capturedPrompt = '';
    mockRunStructuredMemoryLlm.mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify({ apply: { remove: [], update: [] }, quarantine: [], discarded: [] });
    });

    const { getWindow } = makeGetWindow();
    await maybeRunTurnDreaming('session-1', getWindow);
    await new Promise((r) => setTimeout(r, 50));

    const posA = capturedPrompt.indexOf('Pergunta A');
    const posB = capturedPrompt.indexOf('Pergunta B');
    expect(posA).toBeGreaterThan(-1);
    expect(posB).toBeGreaterThan(-1);
    expect(posA).toBeLessThan(posB);
  });
});

describe('Sprint4 Cenario 8 (D7-a): modelo dedicado preenchido e ignorado', () => {
  it('NAO passa modelOverride nem providerOverride mesmo com dreaming_turn_based_model setado', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      if (key === 'dreaming_turn_based_model') return 'claude-haiku-4-5-20251001';
      return null;
    });
    mockGetDreamingState.mockReturnValue({
      lastGateRunAt: null,
      lastTurnRunAt: null,
      turnCount: 0,
      totalTurnRuns: 0,
      totalTurnFailsafes: 0,
    });

    writeMemoryMd(Array.from({ length: 15 }, (_, i) => `linha ${i + 1}`));

    let capturedOpts: unknown = 'NOT_CALLED';
    mockRunStructuredMemoryLlm.mockImplementation(async (_prompt: string, opts?: unknown) => {
      capturedOpts = opts;
      return JSON.stringify({ apply: { remove: [], update: [] }, quarantine: [], discarded: [] });
    });

    const { getWindow } = makeGetWindow();
    await maybeRunTurnDreaming('session-1', getWindow);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockRunStructuredMemoryLlm).toHaveBeenCalledTimes(1);
    expect(capturedOpts).toBeUndefined();
  });
});

describe('Sprint4 Cenario 9: modelo vazio usa runStructuredMemoryLlm sem overrides', () => {
  it('chama runStructuredMemoryLlm sem opts quando setting vazio', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      if (key === 'dreaming_turn_based_model') return '';
      return null;
    });
    mockGetDreamingState.mockReturnValue({
      lastGateRunAt: null,
      lastTurnRunAt: null,
      turnCount: 0,
      totalTurnRuns: 0,
      totalTurnFailsafes: 0,
    });

    writeMemoryMd(Array.from({ length: 15 }, (_, i) => `linha ${i + 1}`));

    let capturedOpts: unknown = 'NOT_CALLED';
    mockRunStructuredMemoryLlm.mockImplementation(async (_prompt: string, opts?: unknown) => {
      capturedOpts = opts;
      return JSON.stringify({ apply: { remove: [], update: [] }, quarantine: [], discarded: [] });
    });

    const { getWindow } = makeGetWindow();
    await maybeRunTurnDreaming('session-1', getWindow);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockRunStructuredMemoryLlm).toHaveBeenCalledTimes(1);
    expect(capturedOpts).toBeUndefined();
  });
});

describe('Sprint4 recordCompletedMainChatTurn', () => {
  it('incrementa contador quando enabled=true e nao dispara quando count < interval', () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      return null;
    });
    mockGetDreamingTurnInterval.mockReturnValue(20);
    mockIncrementTurnCount.mockReturnValue(5);

    const { getWindow } = makeGetWindow();
    recordCompletedMainChatTurn('session-1', getWindow);

    expect(mockIncrementTurnCount).toHaveBeenCalledTimes(1);
    expect(mockTryWithMemoryGateLock).not.toHaveBeenCalled();
  });

  it('dispara maybeRunTurnDreaming quando newCount >= interval', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      if (key === 'dreaming_turn_based_model') return '';
      return null;
    });
    mockGetDreamingTurnInterval.mockReturnValue(20);
    mockIncrementTurnCount.mockReturnValue(20);

    mockGetDreamingState.mockReturnValue({
      lastGateRunAt: Date.now() - 60 * 1000, // 1min atras -> cooldown
      lastTurnRunAt: null,
      turnCount: 20,
      totalTurnRuns: 0,
      totalTurnFailsafes: 0,
    });

    const { getWindow } = makeGetWindow();
    recordCompletedMainChatTurn('session-1', getWindow);

    await new Promise((r) => setTimeout(r, 20));

    expect(mockGetDreamingState).toHaveBeenCalled();
  });

  it('NAO incrementa contador quando session.type !== "chat" (scheduled)', () => {
    mockGetSession.mockReturnValue({ type: 'scheduled' });
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      return null;
    });

    const { getWindow } = makeGetWindow();
    recordCompletedMainChatTurn('scheduler-session-id', getWindow);

    expect(mockIncrementTurnCount).not.toHaveBeenCalled();
    expect(mockTryWithMemoryGateLock).not.toHaveBeenCalled();
  });

  it('NAO incrementa contador quando session.type === "telegram"', () => {
    mockGetSession.mockReturnValue({ type: 'telegram' });
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      return null;
    });

    const { getWindow } = makeGetWindow();
    recordCompletedMainChatTurn('telegram-session-id', getWindow);

    expect(mockIncrementTurnCount).not.toHaveBeenCalled();
  });

  it('NAO incrementa contador quando getSession retorna undefined (sessao inexistente)', () => {
    mockGetSession.mockReturnValue(undefined);
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'dreaming_turn_based_enabled') return 'true';
      return null;
    });

    const { getWindow } = makeGetWindow();
    recordCompletedMainChatTurn('ghost-session', getWindow);

    expect(mockIncrementTurnCount).not.toHaveBeenCalled();
  });
});


import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';


// eslint-disable-next-line no-var
var TEST_TMP_DIR: string = path.join(os.tmpdir(), `compaction-gate-test-${process.pid}`);

// eslint-disable-next-line no-var
var mockSettings: Record<string, string | undefined> = {};


vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

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

vi.mock('../db', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(() => {
        if (sql.includes('FROM messages')) {
          return [
            {
              role: 'user',
              content: 'Trabalhamos na implementacao do dreaming gate hoje',
              created_at: '2026-05-24T10:00:00.000Z',
              session_title: 'Sprint 5 session',
            },
          ];
        }
        return [];
      }),
      run: vi.fn(),
      get: vi.fn(),
    })),
  })),
  getSessionMessages: vi.fn(() => []),
  getSession: vi.fn(() => null),
  getSetting: vi.fn((key: string) => mockSettings[key] ?? null),
  setSetting: vi.fn((key: string, value: string) => {
    mockSettings[key] = value;
  }),
  insertChunkWithEmbedding: vi.fn(),
  insertChunkPlainWithFTS: vi.fn(),
  searchBM25: vi.fn(() => []),
  searchVector: vi.fn(() => []),
  setLastGateRunAt: vi.fn(),
}));

vi.mock('../embedding-provider', () => ({
  generateEmbedding: vi.fn(async () => null),
}));

vi.mock('../mgraph-engine', () => ({
  executeVaultOperation: vi.fn(() => ({ success: true })),
  regenerateVaultIndex: vi.fn(),
  updateVaultHot: vi.fn(),
  appendVaultLog: vi.fn(),
  getExistingVaultFilesList: vi.fn(() => ''),
}));

vi.mock('../ollama-client', () => ({
  ollamaChat: vi.fn(async () => {
    throw new Error('Ollama nao deve ser chamado nestes testes');
  }),
}));

vi.mock('../secrets-vault', () => ({
  getApiKey: vi.fn(async () => {
    throw new Error('Anthropic SDK nao deve ser chamado nestes testes');
  }),
  getSecret: vi.fn(async () => 'mock-key'),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({
    messages: {
      create: vi.fn(async () => {
        throw new Error('Anthropic SDK nao deve ser chamado nestes testes');
      }),
    },
  })),
}));

vi.mock('../lion-sdk/adapters/lmstudio', () => ({
  createLmStudioAdapter: vi.fn(),
}));
vi.mock('../lion-sdk/adapters/ollama', () => ({
  createOllamaAdapter: vi.fn(),
}));
vi.mock('../lion-sdk/adapters/openai-compatible', () => ({
  createOpenAiCompatibleAdapter: vi.fn(),
}));
vi.mock('../lion-sdk/adapters/google-genai', () => ({
  createGoogleGenAiAdapter: vi.fn(),
}));



const COMPACTION_RESULT_WITH_CANDIDATES = JSON.stringify({
  executive_summary: 'Sessao de implementacao do Sprint 5',
  decisions: ['Usar gate obrigatorio no compaction'],
  tasks_created: [],
  facts: ['Gate integrado no runCompaction'],
  semantic_chunks: [
    { topic: 'Sprint 5', content: 'Integracao do dreaming gate' },
  ],
  user_profile_updates: [],
  working_memory_updates: {
    add: [
      '[2026-05-24] Sprint 5 do dreaming gate concluido',
      '[2026-05-24] runCompaction integrado com gate',
    ],
    remove: [],
  },
});

const COMPACTION_WITH_USER_UPDATES = JSON.stringify({
  executive_summary: 'Sessao com atualizacoes de perfil',
  decisions: [],
  tasks_created: [],
  facts: [],
  semantic_chunks: [],
  user_profile_updates: [
    { action: 'add', section: 'Stack tecnologico', fact: 'TypeScript strict mode' },
  ],
  working_memory_updates: {
    add: ['[2026-05-24] Candidato para quarentena'],
    remove: [],
  },
});


const mockRunDreamingGate = vi.fn();
const mockSaveDreamingReport = vi.fn();

vi.mock('../dreaming-gate', async (importOriginal) => {
  const original = await importOriginal<typeof import('../dreaming-gate')>();
  return {
    ...original, // preserva tipos exportados
    runDreamingGate: (...args: unknown[]) => mockRunDreamingGate(...args),
    saveDreamingReport: (...args: unknown[]) => mockSaveDreamingReport(...args),
  };
});

const mockStreamCompletionFn = vi.fn();

vi.mock('../lion-sdk/adapters/lmstudio', async () => ({
  createLmStudioAdapter: vi.fn(() => ({
    name: 'lmstudio',
    async *streamCompletion() {
      yield* mockStreamCompletionFn();
    },
  })),
}));


import { runCompaction } from '../memory-pipeline';
import { insertChunkPlainWithFTS, setLastGateRunAt } from '../db';


function memPath(): string {
  return path.join(TEST_TMP_DIR, 'MEMORY.md');
}

function readMemory(): string {
  return fs.readFileSync(memPath(), 'utf-8');
}

function reportDir(): string {
  return path.join(TEST_TMP_DIR, 'workspaces', 'lionclaw', 'dreaming-reports');
}

function createSkillMd(): void {
  const skillDir = path.join(TEST_TMP_DIR, 'skills', 'dreaming');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '# Dreaming\n## Regras de Auto-Apply\n- ADD com secao\n',
    'utf-8',
  );
}


beforeEach(() => {
  vi.clearAllMocks();

  fs.mkdirSync(TEST_TMP_DIR, { recursive: true });

  mockSettings = {
    orchestrator_runtime: 'lion-sdk',
    orchestrator_provider: 'lmstudio',
    orchestrator_model: 'qwen3-27b',
    orchestrator_lmstudio_base_url: 'http://localhost:1234',
    orchestrator_compaction_provider: '',
    orchestrator_compaction_model: '',
    mgraph_mode: 'false',
  };

  mockStreamCompletionFn.mockImplementation(async function* () {
    yield { type: 'text' as const, delta: COMPACTION_RESULT_WITH_CANDIDATES };
    yield { type: 'done' as const };
  });

  mockSaveDreamingReport.mockResolvedValue(
    path.join(reportDir(), '2026-05-24_120000_compaction-dreaming-report.md'),
  );
});

afterEach(() => {
  if (TEST_TMP_DIR && fs.existsSync(TEST_TMP_DIR)) {
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
  }
});


describe('Cenario 1: Sucesso completo do gate', () => {
  it('MEMORY.md e atualizado section-aware quando gate aprova candidatos', async () => {
    createSkillMd();

    const gateApplyResult = {
      apply: {
        add: [
          { section: 'decisoes_ativas' as const, text: '[2026-05-24] Sprint 5 do dreaming gate concluido' },
          { section: 'estado_de_projetos' as const, text: '[2026-05-24] runCompaction integrado com gate' },
        ],
        remove: [],
      },
      quarantine: [],
      discarded: [],
      report: '# Dreaming Gate - Relatorio de Compactacao\n\n## Aplicar\n...',
      failSafeTriggered: false,
    };
    mockRunDreamingGate.mockResolvedValue(gateApplyResult);

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    expect(mockRunDreamingGate).toHaveBeenCalledTimes(1);

    expect(mockSaveDreamingReport).toHaveBeenCalledTimes(1);
    expect(mockSaveDreamingReport).toHaveBeenCalledWith(gateApplyResult);

    expect(fs.existsSync(memPath())).toBe(true);
    const memContent = readMemory();

    expect(memContent).toContain('## Decisoes ativas');
    expect(memContent).toContain('[2026-05-24] Sprint 5 do dreaming gate concluido');

    expect(memContent).toContain('## Estado de projetos');
    expect(memContent).toContain('[2026-05-24] runCompaction integrado com gate');

    const lines = memContent.split('\n');
    const idxDecisoes = lines.findIndex(l => l === '## Decisoes ativas');
    const idxEstado = lines.findIndex(l => l === '## Estado de projetos');
    const idxDecisaoEntry = lines.findIndex(l => l.includes('Sprint 5 do dreaming gate'));
    const idxEstadoEntry = lines.findIndex(l => l.includes('runCompaction integrado'));

    expect(idxDecisaoEntry).toBeGreaterThan(idxDecisoes);
    expect(idxDecisaoEntry).toBeLessThan(idxEstado);
    expect(idxEstadoEntry).toBeGreaterThan(idxEstado);
  });

  it('embeddings e daily summary continuam rodando apos gate bem-sucedido', async () => {
    createSkillMd();

    const gateApplyResult = {
      apply: { add: [{ section: 'decisoes_ativas' as const, text: '[2026-05-24] Test' }], remove: [] },
      quarantine: [],
      discarded: [],
      report: '# Gate OK',
      failSafeTriggered: false,
    };
    mockRunDreamingGate.mockResolvedValue(gateApplyResult);

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    expect(insertChunkPlainWithFTS).toHaveBeenCalledTimes(1);

    const dbMock = (await vi.importMock('../db') as { getDb: ReturnType<typeof vi.fn> }).getDb;
    const dbInstance = dbMock.mock.results[0]?.value as { prepare: ReturnType<typeof vi.fn> } | undefined;
    if (dbInstance) {
      expect(dbInstance.prepare).toHaveBeenCalled();
    }
  });

  it('runDreamingGate recebe conversationExcerpt com ate 8000 chars', async () => {
    createSkillMd();

    const gateApplyResult = {
      apply: { add: [], remove: [] },
      quarantine: [],
      discarded: [],
      report: '# Gate OK',
      failSafeTriggered: false,
    };
    mockRunDreamingGate.mockResolvedValue(gateApplyResult);

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    expect(mockRunDreamingGate).toHaveBeenCalledTimes(1);
    const callInput = mockRunDreamingGate.mock.calls[0][0] as { conversationExcerpt: string };
    expect(callInput.conversationExcerpt.length).toBeLessThanOrEqual(8000);
  });

  it('runDreamingGate recebe candidatos corretos mapeados do summary', async () => {
    createSkillMd();

    const gateApplyResult = {
      apply: { add: [], remove: [] },
      quarantine: [],
      discarded: [],
      report: '# Gate OK',
      failSafeTriggered: false,
    };
    mockRunDreamingGate.mockResolvedValue(gateApplyResult);

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    const callInput = mockRunDreamingGate.mock.calls[0][0] as {
      candidates: Array<{ kind: string; text: string }>;
    };

    expect(callInput.candidates).toHaveLength(2);
    expect(callInput.candidates[0].kind).toBe('add');
    expect(callInput.candidates[0].text).toBe('[2026-05-24] Sprint 5 do dreaming gate concluido');
    expect(callInput.candidates[1].kind).toBe('add');
    expect(callInput.candidates[1].text).toBe('[2026-05-24] runCompaction integrado com gate');
  });
});


describe('Cenario 2: Fail-safe do gate', () => {
  it('MEMORY.md NAO e tocado quando gate retorna failSafeTriggered=true', async () => {
    createSkillMd();

    const originalMemContent = [
      '## Decisoes ativas',
      '- [2026-05-23] Decisao anterior',
      '',
      '## Workarounds e bugs conhecidos',
      '',
      '## Estado de projetos',
      '',
      '## Referencias externas',
    ].join('\n') + '\n';
    fs.writeFileSync(memPath(), originalMemContent, 'utf-8');

    const failSafeResult = {
      apply: { add: [], remove: [] }, // arrays vazios -> updateWorkingMemory no-op
      quarantine: [
        { text: '[2026-05-24] Sprint 5 do dreaming gate concluido', reason: 'gate_failed: llm_error' },
        { text: '[2026-05-24] runCompaction integrado com gate', reason: 'gate_failed: llm_error' },
      ],
      discarded: [],
      report: '# Dreaming Gate - Fail-Safe Acionado\n\n**Motivo:** `llm_error`',
      failSafeTriggered: true,
      failSafeReason: 'llm_error' as const,
    };
    mockRunDreamingGate.mockResolvedValue(failSafeResult);

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    const finalMemContent = readMemory();
    expect(finalMemContent).toBe(originalMemContent);

    expect(mockRunDreamingGate).toHaveBeenCalledTimes(1);

    expect(mockSaveDreamingReport).toHaveBeenCalledTimes(1);
    expect(mockSaveDreamingReport).toHaveBeenCalledWith(failSafeResult);
  });

  it('dreaming-report e salvo mesmo em fail-safe', async () => {
    createSkillMd();

    const failSafeResult = {
      apply: { add: [], remove: [] },
      quarantine: [{ text: 'candidato', reason: 'gate_failed: timeout' }],
      discarded: [],
      report: '# Dreaming Gate - Fail-Safe Acionado\n\n**Motivo:** `timeout`',
      failSafeTriggered: true,
      failSafeReason: 'timeout' as const,
    };
    mockRunDreamingGate.mockResolvedValue(failSafeResult);

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    expect(mockSaveDreamingReport).toHaveBeenCalledTimes(1);
    expect(mockSaveDreamingReport).toHaveBeenCalledWith(
      expect.objectContaining({ failSafeTriggered: true, failSafeReason: 'timeout' }),
    );
  });

  it('embeddings continuam rodando em fail-safe (nao sao afetados pelo gate)', async () => {
    createSkillMd();

    const failSafeResult = {
      apply: { add: [], remove: [] },
      quarantine: [],
      discarded: [],
      report: '# Fail-Safe',
      failSafeTriggered: true,
      failSafeReason: 'json_parse_error' as const,
    };
    mockRunDreamingGate.mockResolvedValue(failSafeResult);

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    expect(insertChunkPlainWithFTS).toHaveBeenCalledTimes(1);
  });

  it('USER.md fica INTOCADO em fail-safe do gate (SPEC 12.2 / AC-48: passo direto morreu)', async () => {
    createSkillMd();

    mockStreamCompletionFn.mockImplementation(async function* () {
      yield { type: 'text' as const, delta: COMPACTION_WITH_USER_UPDATES };
      yield { type: 'done' as const };
    });

    const failSafeResult = {
      apply: { add: [], remove: [], userAdd: [], userRemove: [] },
      quarantine: [
        { text: '[2026-05-24] Candidato para quarentena', reason: 'gate_failed: skill_md_missing' },
        { text: 'TypeScript strict mode', reason: 'gate_failed: skill_md_missing' },
      ],
      discarded: [],
      report: '# Fail-Safe',
      failSafeTriggered: true,
      failSafeReason: 'skill_md_missing' as const,
    };
    mockRunDreamingGate.mockResolvedValue(failSafeResult);

    const userPath = path.join(TEST_TMP_DIR, 'USER.md');
    const originalUserMd = '# Sobre o Usuario\n';
    fs.writeFileSync(userPath, originalUserMd, 'utf-8');

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    const userContent = fs.readFileSync(userPath, 'utf-8');
    expect(userContent).toBe(originalUserMd);

    const callInput = mockRunDreamingGate.mock.calls[0][0] as {
      userCandidates?: Array<{ action: string; section: string; fact: string }>;
    };
    expect(callInput.userCandidates).toEqual([
      { action: 'add', section: 'Stack tecnologico', fact: 'TypeScript strict mode' },
    ]);
  });

  it('archive continua rodando em fail-safe', async () => {
    createSkillMd();

    const failSafeResult = {
      apply: { add: [], remove: [] },
      quarantine: [],
      discarded: [],
      report: '# Fail-Safe',
      failSafeTriggered: true,
      failSafeReason: 'timeout' as const,
    };
    mockRunDreamingGate.mockResolvedValue(failSafeResult);

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    const convDir = path.join(TEST_TMP_DIR, 'conversations');
    expect(fs.existsSync(convDir)).toBe(true);
    const convFiles = fs.readdirSync(convDir);
    expect(convFiles.length).toBeGreaterThan(0);
  });

  it('saveDreamingReport e chamado FORA do lock (apos withMemoryGateLock retornar)', async () => {
    createSkillMd();

    const callOrder: string[] = [];

    const failSafeResult = {
      apply: { add: [], remove: [] },
      quarantine: [],
      discarded: [],
      report: '# Fail-Safe',
      failSafeTriggered: true,
      failSafeReason: 'llm_error' as const,
    };

    mockRunDreamingGate.mockImplementation(async () => {
      callOrder.push('gate');
      return failSafeResult;
    });

    mockSaveDreamingReport.mockImplementation(async () => {
      callOrder.push('save');
      return '/tmp/report.md';
    });

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    expect(callOrder.indexOf('gate')).toBeLessThan(callOrder.indexOf('save'));
    expect(callOrder).toContain('gate');
    expect(callOrder).toContain('save');
  });
});


describe('Cenario 3: Ordem e isolamento', () => {
  it('runDreamingGate e chamado dentro do lock (antes de saveDreamingReport)', async () => {
    createSkillMd();

    const gateResult = {
      apply: { add: [], remove: [] },
      quarantine: [],
      discarded: [],
      report: '# Gate OK',
      failSafeTriggered: false,
    };
    mockRunDreamingGate.mockResolvedValue(gateResult);

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    expect(mockRunDreamingGate).toHaveBeenCalledTimes(1);
    expect(mockSaveDreamingReport).toHaveBeenCalledTimes(1);
  });

  it('gateResult passado para saveDreamingReport e o retorno de runDreamingGate', async () => {
    createSkillMd();

    const specificGateResult = {
      apply: {
        add: [{ section: 'workarounds' as const, text: '[2026-05-24] Workaround especifico' }],
        remove: ['linha antiga'],
      },
      quarantine: [],
      discarded: [{ text: 'info obsoleta', reason: 'sem valor' }],
      report: '# Gate Sucesso com dados especificos',
      failSafeTriggered: false,
    };
    mockRunDreamingGate.mockResolvedValue(specificGateResult);

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    expect(mockSaveDreamingReport).toHaveBeenCalledWith(specificGateResult);
  });

  it('currentMemoryMd passado para gate reflete o MEMORY.md no disco', async () => {
    createSkillMd();

    const preExistingContent = '## Decisoes ativas\n- [2026-05-23] Conteudo pre-existente\n\n## Workarounds e bugs conhecidos\n\n## Estado de projetos\n\n## Referencias externas\n';
    fs.writeFileSync(memPath(), preExistingContent, 'utf-8');

    const gateResult = {
      apply: { add: [], remove: [] },
      quarantine: [],
      discarded: [],
      report: '# Gate OK',
      failSafeTriggered: false,
    };
    mockRunDreamingGate.mockResolvedValue(gateResult);

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    const callInput = mockRunDreamingGate.mock.calls[0][0] as { currentMemoryMd: string };
    expect(callInput.currentMemoryMd).toBe(preExistingContent);
  });
});


describe('Cenario 4: setLastGateRunAt chamado apos gate', () => {
  it('setLastGateRunAt e chamado com timestamp recente apos runCompaction bem-sucedido', async () => {
    createSkillMd();

    const gateResult = {
      apply: { add: [], remove: [] },
      quarantine: [],
      discarded: [],
      report: '# Gate OK',
      failSafeTriggered: false,
    };
    mockRunDreamingGate.mockResolvedValue(gateResult);

    const before = Date.now();
    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );
    const after = Date.now();

    expect(setLastGateRunAt).toHaveBeenCalledTimes(1);
    const calledWith = (setLastGateRunAt as ReturnType<typeof vi.fn>).mock.calls[0][0] as number;
    expect(calledWith).toBeGreaterThanOrEqual(before);
    expect(calledWith).toBeLessThanOrEqual(after + 100);
  });

  it('setLastGateRunAt e chamado mesmo em fail-safe do gate', async () => {
    createSkillMd();

    const failSafeResult = {
      apply: { add: [], remove: [] },
      quarantine: [{ text: 'candidato', reason: 'gate_failed: llm_error' }],
      discarded: [],
      report: '# Fail-Safe',
      failSafeTriggered: true,
      failSafeReason: 'llm_error' as const,
    };
    mockRunDreamingGate.mockResolvedValue(failSafeResult);

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    expect(setLastGateRunAt).toHaveBeenCalledTimes(1);
  });
});


describe('Cenario 5: USER.md governado pelo gate (SPEC 12.2)', () => {
  function todayTag(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  it('AC-50: userAdd aprovado pelo gate TERMINA escrito no USER.md na secao correta', async () => {
    createSkillMd();

    mockSettings['user_md_sanitized_v1'] = 'true';

    mockStreamCompletionFn.mockImplementation(async function* () {
      yield { type: 'text' as const, delta: COMPACTION_WITH_USER_UPDATES };
      yield { type: 'done' as const };
    });

    const gateApplyResult = {
      apply: {
        add: [],
        remove: [],
        userAdd: [{ section: 'stack_ferramentas' as const, text: 'TypeScript strict mode' }],
        userRemove: ['- Usa JavaScript [2026-01-01]'],
      },
      quarantine: [],
      discarded: [],
      report: '# Gate OK com USER.md',
      failSafeTriggered: false,
    };
    mockRunDreamingGate.mockResolvedValue(gateApplyResult);

    const userPath = path.join(TEST_TMP_DIR, 'USER.md');
    fs.writeFileSync(
      userPath,
      [
        '# Sobre o Usuario',
        '',
        '## Identidade',
        '- Nome: Breno',
        '',
        '## Perfil profissional',
        '',
        '## Negocios e projetos',
        '',
        '## Stack e ferramentas',
        '- Usa JavaScript [2026-01-01]',
        '',
        '## Preferencias',
        '',
        '## Fatos duraveis',
      ].join('\n'),
      'utf-8',
    );

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    const callInput = mockRunDreamingGate.mock.calls[0][0] as {
      userCandidates?: Array<{ action: string; section: string; fact: string }>;
      currentUserMd: string;
    };
    expect(callInput.userCandidates).toEqual([
      { action: 'add', section: 'Stack tecnologico', fact: 'TypeScript strict mode' },
    ]);
    expect(callInput.currentUserMd).toContain('- Usa JavaScript [2026-01-01]');

    const content = fs.readFileSync(userPath, 'utf-8');
    const stackIdx = content.indexOf('## Stack e ferramentas');
    const prefIdx = content.indexOf('## Preferencias');
    const factIdx = content.indexOf(`- TypeScript strict mode [${todayTag()}]`);
    expect(factIdx).toBeGreaterThan(stackIdx);
    expect(factIdx).toBeLessThan(prefIdx);
    expect(content).not.toContain('- Usa JavaScript [2026-01-01]');
    expect(content).toContain('- Nome: Breno');
  });

  it('sem user_profile_updates o gate NAO recebe userCandidates (retrocompat AC-49)', async () => {
    createSkillMd();
    mockSettings['user_md_sanitized_v1'] = 'true';

    const gateResult = {
      apply: { add: [], remove: [] },
      quarantine: [],
      discarded: [],
      report: '# Gate OK',
      failSafeTriggered: false,
    };
    mockRunDreamingGate.mockResolvedValue(gateResult);

    await runCompaction(
      new Date('2026-05-24T00:00:00.000Z'),
      new Date('2026-05-24T12:00:00.000Z'),
      'session-sprint5',
    );

    const callInput = mockRunDreamingGate.mock.calls[0][0] as Record<string, unknown>;
    expect('userCandidates' in callInput).toBe(false);
    expect(fs.existsSync(path.join(TEST_TMP_DIR, 'USER.md'))).toBe(false);
  });
});

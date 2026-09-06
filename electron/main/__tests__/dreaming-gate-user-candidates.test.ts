
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// eslint-disable-next-line no-var
var TEST_TMP_DIR: string = path.join(
  os.tmpdir(),
  `dreaming-gate-user-test-${process.pid}`,
);

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

vi.mock('../memory-pipeline', () => ({
  runStructuredMemoryLlm: vi.fn().mockRejectedValue(
    new Error('runStructuredMemoryLlm NAO deve ser chamado diretamente nos testes'),
  ),
}));

vi.mock('../db', () => ({
  getSetting: vi.fn(() => null),
  setSetting: vi.fn(),
}));

import {
  runDreamingGate,
  type DreamingGateInput,
  type UserCandidateItem,
} from '../dreaming-gate';

const skillDir = path.join(TEST_TMP_DIR, 'skills', 'dreaming');
const skillPath = path.join(skillDir, 'SKILL.md');

const VALID_SKILL_CONTENT = `# Skill: Dreaming

## Regras de Auto-Apply
- ADD com secao

## Regras de Seguranca
- NUNCA adicionar entrada nova ao USER.md sem quarentena
`;

const MEMORY_CANDIDATES = [
  { kind: 'add' as const, text: '[2026-07-01] Decisao de usar Vitest' },
];

const USER_CANDIDATES: UserCandidateItem[] = [
  { action: 'add', section: 'Stack tecnologico', fact: 'Usa TypeScript strict mode' },
  { action: 'add', section: 'Perfil', fact: 'Trabalha com Electron' },
];

function baseInput(withUser: boolean): DreamingGateInput {
  return {
    candidates: MEMORY_CANDIDATES,
    ...(withUser ? { userCandidates: USER_CANDIDATES } : {}),
    currentMemoryMd: '## Decisoes ativas\n',
    currentUserMd: '# Sobre o Usuario\n\n## Stack e ferramentas\n- Usa JavaScript [2026-01-01]\n',
    conversationExcerpt: 'conversa de exemplo',
  };
}

const LEGACY_LLM_OUTPUT = {
  apply: {
    add: [{ section: 'decisoes_ativas', text: '[2026-07-01] Decisao de usar Vitest' }],
    remove: [],
  },
  quarantine: [],
  discarded: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillPath, VALID_SKILL_CONTENT, 'utf-8');
});

afterEach(() => {
  fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
});

describe('AC-49 — nao-regressao sem userCandidates', () => {
  it('prompt nao contem blocos de USER e resultado nao tem chaves userAdd/userRemove', async () => {
    let capturedPrompt = '';
    const invoker = vi.fn(async (p: string) => {
      capturedPrompt = p;
      return JSON.stringify(LEGACY_LLM_OUTPUT);
    });

    const result = await runDreamingGate(baseInput(false), { invoker });

    expect(capturedPrompt).not.toContain('[USER_RULES]');
    expect(capturedPrompt).not.toContain('[USER_CANDIDATES]');
    expect(capturedPrompt).not.toContain('[USER_JSON_SCHEMA_EXTENSION]');
    expect(result.failSafeTriggered).toBe(false);
    expect('userAdd' in result.apply).toBe(false);
    expect('userRemove' in result.apply).toBe(false);
  });

  it('campos userAdd/userRemove alucinados pelo modelo sao descartados sem userCandidates', async () => {
    const invoker = vi.fn(async () =>
      JSON.stringify({
        ...LEGACY_LLM_OUTPUT,
        apply: {
          ...LEGACY_LLM_OUTPUT.apply,
          userAdd: [{ section: 'fatos_duraveis', text: 'alucinado' }],
          userRemove: ['- linha alucinada'],
        },
      }),
    );

    const result = await runDreamingGate(baseInput(false), { invoker });

    expect(result.failSafeTriggered).toBe(false);
    expect('userAdd' in result.apply).toBe(false);
    expect('userRemove' in result.apply).toBe(false);
  });

  it('prompt com userCandidates=[] e byte-identico ao prompt sem o campo', async () => {
    const prompts: string[] = [];
    const invoker = vi.fn(async (p: string) => {
      prompts.push(p);
      return JSON.stringify(LEGACY_LLM_OUTPUT);
    });

    await runDreamingGate(baseInput(false), { invoker });
    await runDreamingGate({ ...baseInput(false), userCandidates: [] }, { invoker });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(prompts[0]);
  });
});

describe('AC-50 — prompt e caminho positivo do ADD', () => {
  it('prompt contem [USER_RULES], [USER_CANDIDATES] e o OVERRIDE explicito da skill', async () => {
    let capturedPrompt = '';
    const invoker = vi.fn(async (p: string) => {
      capturedPrompt = p;
      return JSON.stringify(LEGACY_LLM_OUTPUT);
    });

    await runDreamingGate(baseInput(true), { invoker });

    expect(capturedPrompt).toContain('[USER_RULES]');
    expect(capturedPrompt).toContain('[USER_CANDIDATES]');
    expect(capturedPrompt).toContain('[USER_JSON_SCHEMA_EXTENSION]');
    expect(capturedPrompt).toContain('OVERRIDE EXPLICITO DA SKILL');
    expect(capturedPrompt).toContain('vale APENAS para o fluxo standalone');
    expect(capturedPrompt).toContain('(secao sugerida: Stack tecnologico) Usa TypeScript strict mode');
  });

  it('AC-52: formato pinado do userRemove esta no prompt (linha exata + prefixo + tag)', async () => {
    let capturedPrompt = '';
    const invoker = vi.fn(async (p: string) => {
      capturedPrompt = p;
      return JSON.stringify(LEGACY_LLM_OUTPUT);
    });

    await runDreamingGate(baseInput(true), { invoker });

    expect(capturedPrompt).toContain('FORMATO do apply.userRemove: a linha EXATA como esta no USER.md');
    expect(capturedPrompt).toContain('com o prefixo "- " e a tag [YYYY-MM-DD] quando presente');
  });

  it('caminho POSITIVO do ADD: userAdd aprovado pelo gate chega no resultado', async () => {
    const invoker = vi.fn(async () =>
      JSON.stringify({
        apply: {
          add: [],
          remove: [],
          userAdd: [
            { section: 'stack_ferramentas', text: 'Usa TypeScript strict mode' },
          ],
          userRemove: ['- Usa JavaScript [2026-01-01]'],
        },
        quarantine: [],
        discarded: [{ text: 'Trabalha com Electron', reason: 'derivavel do contexto' }],
      }),
    );

    const result = await runDreamingGate(baseInput(true), { invoker });

    expect(result.failSafeTriggered).toBe(false);
    expect(result.apply.userAdd).toEqual([
      { section: 'stack_ferramentas', text: 'Usa TypeScript strict mode' },
    ]);
    expect(result.apply.userRemove).toEqual(['- Usa JavaScript [2026-01-01]']);
    expect(result.quarantine.filter(q => q.reason === 'unaccounted_by_gate')).toEqual([]);
  });
});

describe('AC-51 — contabilidade por candidato no codigo', () => {
  it('modelo que OMITE os campos novos manda todos os userCandidates para quarentena unaccounted_by_gate', async () => {
    const invoker = vi.fn(async () => JSON.stringify(LEGACY_LLM_OUTPUT));

    const result = await runDreamingGate(baseInput(true), { invoker });

    expect(result.failSafeTriggered).toBe(false);
    expect(result.apply.userAdd).toEqual([]);
    expect(result.apply.userRemove).toEqual([]);
    const unaccounted = result.quarantine.filter(q => q.reason === 'unaccounted_by_gate');
    expect(unaccounted.map(q => q.text).sort()).toEqual(
      [...USER_CANDIDATES.map(c => c.fact)].sort(),
    );
  });

  it('candidato contabilizado (mesmo reformatado com tag/prefixo) nao vai para quarentena; o esquecido vai', async () => {
    const invoker = vi.fn(async () =>
      JSON.stringify({
        apply: {
          add: [],
          remove: [],
          userAdd: [
            { section: 'stack_ferramentas', text: 'Usa TypeScript strict mode [2026-07-01]' },
          ],
          userRemove: [],
        },
        quarantine: [],
        discarded: [],
      }),
    );

    const result = await runDreamingGate(baseInput(true), { invoker });

    const unaccounted = result.quarantine.filter(q => q.reason === 'unaccounted_by_gate');
    expect(unaccounted.map(q => q.text)).toEqual(['Trabalha com Electron']);
  });

  it('prompt lista candidatos com ids c1/c2 e pede apply.userAccounting no schema', async () => {
    let capturedPrompt = '';
    const invoker = vi.fn(async (p: string) => {
      capturedPrompt = p;
      return JSON.stringify(LEGACY_LLM_OUTPUT);
    });

    await runDreamingGate(baseInput(true), { invoker });

    expect(capturedPrompt).toContain('c1. [ADD] (secao sugerida: Stack tecnologico) Usa TypeScript strict mode');
    expect(capturedPrompt).toContain('c2. [ADD] (secao sugerida: Perfil) Trabalha com Electron');
    expect(capturedPrompt).toContain('"userAccounting"');
    expect(capturedPrompt).toContain('RASTRO POR ID');
  });

  it('rastro por id: fato REESCRITO pelo gate com userAccounting valido nao e re-quarentenado', async () => {
    const invoker = vi.fn(async () =>
      JSON.stringify({
        apply: {
          add: [],
          remove: [],
          userAdd: [
            { section: 'stack_ferramentas', text: 'Programa com tipagem estrita habilitada no compilador' },
          ],
          userRemove: [],
          userAccounting: [
            { candidateId: 'c1', destination: 'userAdd' },
            { candidateId: 'c2', destination: 'discarded' },
          ],
        },
        quarantine: [],
        discarded: [{ text: 'Trabalha com Electron', reason: 'derivavel' }],
      }),
    );

    const result = await runDreamingGate(baseInput(true), { invoker });

    expect(result.failSafeTriggered).toBe(false);
    expect(result.quarantine.filter(q => q.reason === 'unaccounted_by_gate')).toEqual([]);
    expect('userAccounting' in result.apply).toBe(false);
  });

  it('fallback Jaccard: sem userAccounting, reescrita parcial (>=50% dos tokens) conta como contabilizado', async () => {
    const invoker = vi.fn(async () =>
      JSON.stringify({
        apply: {
          add: [],
          remove: [],
          userAdd: [
            { section: 'stack_ferramentas', text: 'Usa TypeScript em strict mode sempre' },
          ],
          userRemove: [],
        },
        quarantine: [],
        discarded: [{ text: 'Trabalha com Electron', reason: 'derivavel' }],
      }),
    );

    const result = await runDreamingGate(baseInput(true), { invoker });

    expect(result.quarantine.filter(q => q.reason === 'unaccounted_by_gate')).toEqual([]);
  });

  it('userAccounting malformado e ignorado (parse leniente): cai no fallback textual sem fail-safe', async () => {
    const invoker = vi.fn(async () =>
      JSON.stringify({
        apply: {
          add: [],
          remove: [],
          userAdd: [],
          userRemove: [],
          userAccounting: [
            { candidateId: 42, destination: 'userAdd' }, // id nao-string
            { candidateId: 'c2', destination: 'destino_inexistente' }, // destino invalido
            'string solta', // entrada lixo
          ],
        },
        quarantine: [],
        discarded: [],
      }),
    );

    const result = await runDreamingGate(baseInput(true), { invoker });

    expect(result.failSafeTriggered).toBe(false);
    const unaccounted = result.quarantine.filter(q => q.reason === 'unaccounted_by_gate');
    expect(unaccounted.map(q => q.text).sort()).toEqual(
      [...USER_CANDIDATES.map(c => c.fact)].sort(),
    );
  });

  it('userAccounting alucinado SEM userCandidates e descartado junto com os demais campos user', async () => {
    const invoker = vi.fn(async () =>
      JSON.stringify({
        ...LEGACY_LLM_OUTPUT,
        apply: {
          ...LEGACY_LLM_OUTPUT.apply,
          userAccounting: [{ candidateId: 'c1', destination: 'userAdd' }],
        },
      }),
    );

    const result = await runDreamingGate(baseInput(false), { invoker });

    expect(result.failSafeTriggered).toBe(false);
    expect('userAccounting' in result.apply).toBe(false);
  });
});

describe('AC-48 — fail-safe com userCandidates', () => {
  it('invoker throw: userAdd/userRemove vazios + todos os userCandidates na quarentena; gate nao lanca', async () => {
    const invoker = vi.fn(async () => {
      throw new Error('LLM caiu');
    });

    const result = await runDreamingGate(baseInput(true), { invoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('llm_error');
    expect(result.apply.userAdd).toEqual([]);
    expect(result.apply.userRemove).toEqual([]);
    const texts = result.quarantine.map(q => q.text);
    for (const c of USER_CANDIDATES) {
      expect(texts).toContain(c.fact);
    }
    expect(texts).toContain(MEMORY_CANDIDATES[0].text);
  });

  it('fail-safe SEM userCandidates mantem o shape legado (sem chaves user)', async () => {
    const invoker = vi.fn(async () => {
      throw new Error('LLM caiu');
    });

    const result = await runDreamingGate(baseInput(false), { invoker });

    expect(result.failSafeTriggered).toBe(true);
    expect('userAdd' in result.apply).toBe(false);
    expect('userRemove' in result.apply).toBe(false);
  });

  it('section invalida em userAdd -> fail-safe json_parse_error (USER.md protegido)', async () => {
    const invoker = vi.fn(async () =>
      JSON.stringify({
        apply: {
          add: [],
          remove: [],
          userAdd: [{ section: 'secao_inexistente', text: 'x' }],
          userRemove: [],
        },
        quarantine: [],
        discarded: [],
      }),
    );

    const result = await runDreamingGate(baseInput(true), { invoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('json_parse_error');
    expect(result.apply.userAdd).toEqual([]);
    expect(result.apply.userRemove).toEqual([]);
  });
});


import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';


// eslint-disable-next-line no-var
var TEST_TMP_DIR: string = path.join(os.tmpdir(), `dreaming-gate-test-${process.pid}`);

vi.mock('../paths', () => ({
  getLionClawHome: () => TEST_TMP_DIR,
}));

vi.mock('../db', () => ({
  getSetting: vi.fn(() => undefined),
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

import {
  runDreamingGate,
  saveDreamingReport,
  type DreamingGateInput,
  type GateInputItem,
} from '../dreaming-gate';

const tmpDir = TEST_TMP_DIR;
const skillDir = path.join(tmpDir, 'skills', 'dreaming');
const skillPath = path.join(skillDir, 'SKILL.md');


const VALID_SKILL_CONTENT = `# Skill: Dreaming

## Regras de Auto-Apply

### REMOVE AUTOMATICAMENTE
1. Entrada sem data [YYYY-MM-DD]

### ADD COM SECAO
1. Decisoes ativas -> decisoes_ativas
2. Workarounds -> workarounds
`;

const SAMPLE_CANDIDATES: GateInputItem[] = [
  { kind: 'add', text: '[2026-05-24] Decisao de usar Vitest' },
  { kind: 'remove', text: 'Linha antiga sem data' },
];

const BASE_INPUT: DreamingGateInput = {
  candidates: SAMPLE_CANDIDATES,
  currentMemoryMd: '## Decisoes ativas\n\n## Workarounds e bugs conhecidos\n',
  currentUserMd: '',
  conversationExcerpt: 'conversa de exemplo',
};

const VALID_LLM_OUTPUT = {
  apply: {
    add: [{ section: 'decisoes_ativas', text: '[2026-05-24] Decisao de usar Vitest' }],
    remove: ['Linha antiga sem data'],
  },
  quarantine: [],
  discarded: [],
};


beforeEach(() => {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillPath, VALID_SKILL_CONTENT, 'utf-8');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});


describe('(a) JSON valido', () => {
  it('retorna apply correto e failSafeTriggered=false quando LLM retorna JSON bem-formado', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));

    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(false);
    expect(result.failSafeReason).toBeUndefined();
    expect(result.apply.add).toHaveLength(1);
    expect(result.apply.add[0].section).toBe('decisoes_ativas');
    expect(result.apply.add[0].text).toBe('[2026-05-24] Decisao de usar Vitest');
    expect(result.apply.remove).toEqual(['Linha antiga sem data']);
    expect(result.quarantine).toEqual([]);
    expect(result.discarded).toEqual([]);
    expect(result.report).toContain('decisoes_ativas');
    expect(mockInvoker).toHaveBeenCalledTimes(1);
  });

  it('aceita JSON com code fence (LLM ignorou instrucao de retornar JSON puro)', async () => {
    const withFence = '```json\n' + JSON.stringify(VALID_LLM_OUTPUT) + '\n```';
    const mockInvoker = vi.fn().mockResolvedValue(withFence);

    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(false);
    expect(result.apply.add).toHaveLength(1);
  });

  it('quarantine e discarded populados corretamente quando LLM os retorna', async () => {
    const withQuarantine = {
      apply: { add: [], remove: [] },
      quarantine: [{ text: 'texto suspeito', reason: 'sem data', proposed_section: 'workarounds' }],
      discarded: [{ text: 'texto inutil', reason: 'sem valor de memoria' }],
    };
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(withQuarantine));

    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(false);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine[0].reason).toBe('sem data');
    expect(result.discarded).toHaveLength(1);
    expect(result.discarded[0].reason).toBe('sem valor de memoria');
  });
});


describe('(b) JSON invalido', () => {
  it('retorna failSafeReason=json_parse_error quando LLM retorna texto nao-JSON', async () => {
    const mockInvoker = vi.fn().mockResolvedValue('not json at all');

    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('json_parse_error');
    expect(result.apply.add).toEqual([]);
    expect(result.apply.remove).toEqual([]);
  });

  it('todos os candidatos vao para quarentena em json_parse_error', async () => {
    const mockInvoker = vi.fn().mockResolvedValue('{ invalid json }');

    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    expect(result.quarantine).toHaveLength(SAMPLE_CANDIDATES.length);
    result.quarantine.forEach((q) => {
      expect(q.reason).toContain('gate_failed: json_parse_error');
    });
  });

  it('retorna failSafeReason=json_parse_error quando JSON valido mas schema invalido', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify({ apply: { add: null, remove: [] }, quarantine: [], discarded: [] }));

    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('json_parse_error');
  });
});


describe('(c) invoker throw', () => {
  it('retorna failSafeReason=llm_error quando o invoker rejeita', async () => {
    const mockInvoker = vi.fn().mockRejectedValue(new Error('LLM offline'));

    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('llm_error');
    expect(result.apply.add).toEqual([]);
    expect(result.apply.remove).toEqual([]);
  });

  it('todos os candidatos vao para quarentena em llm_error', async () => {
    const mockInvoker = vi.fn().mockRejectedValue(new Error('connection refused'));

    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    expect(result.quarantine).toHaveLength(SAMPLE_CANDIDATES.length);
    result.quarantine.forEach((q) => {
      expect(q.reason).toContain('gate_failed: llm_error');
    });
  });

  it('nunca throw — runDreamingGate sempre retorna DreamingGateResult', async () => {
    const mockInvoker = vi.fn().mockRejectedValue(new Error('qualquer erro'));

    await expect(runDreamingGate(BASE_INPUT, { invoker: mockInvoker })).resolves.toBeDefined();
  });
});


describe('(d) SKILL.md ausente', () => {
  it('retorna failSafeReason=skill_md_missing quando SKILL.md nao existe', async () => {
    fs.rmSync(skillPath);

    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));

    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('skill_md_missing');
  });

  it('invoker NAO e chamado quando SKILL.md nao existe', async () => {
    fs.rmSync(skillPath);

    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));

    await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    expect(mockInvoker).toHaveBeenCalledTimes(0);
  });

  it('retorna failSafeReason=skill_md_missing quando SKILL.md existe mas esta vazio', async () => {
    fs.writeFileSync(skillPath, '   \n\n  ', 'utf-8');

    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));

    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('skill_md_missing');
    expect(mockInvoker).toHaveBeenCalledTimes(0);
  });

  it('todos os candidatos vao para quarentena em skill_md_missing', async () => {
    fs.rmSync(skillPath);

    const mockInvoker = vi.fn();

    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    expect(result.quarantine).toHaveLength(SAMPLE_CANDIDATES.length);
    result.quarantine.forEach((q) => {
      expect(q.reason).toContain('gate_failed: skill_md_missing');
    });
  });
});


describe('(e) timeout', () => {
  it('retorna failSafeReason=timeout quando invoker demora mais que timeoutMs', async () => {
    const slowInvoker = vi.fn().mockImplementation(
      () => new Promise<string>((resolve) => setTimeout(() => resolve(JSON.stringify(VALID_LLM_OUTPUT)), 2000)),
    );

    const result = await runDreamingGate(BASE_INPUT, { invoker: slowInvoker, timeoutMs: 50 });

    expect(result.failSafeTriggered).toBe(true);
    expect(result.failSafeReason).toBe('timeout');
    expect(result.apply.add).toEqual([]);
    expect(result.apply.remove).toEqual([]);
  }, 3000);

  it('todos os candidatos vao para quarentena em timeout', async () => {
    const slowInvoker = vi.fn().mockImplementation(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('{}'), 2000)),
    );

    const result = await runDreamingGate(BASE_INPUT, { invoker: slowInvoker, timeoutMs: 50 });

    expect(result.quarantine).toHaveLength(SAMPLE_CANDIDATES.length);
    result.quarantine.forEach((q) => {
      expect(q.reason).toContain('gate_failed: timeout');
    });
  }, 3000);

  it('nao faz timeout com timeoutMs suficientemente alto', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));

    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker, timeoutMs: 5000 });

    expect(result.failSafeTriggered).toBe(false);
    expect(result.failSafeReason).toBeUndefined();
  });
});


describe('saveDreamingReport', () => {
  it('cria arquivo com nome no formato YYYY-MM-DD_HHmmss_<uuid>_compaction-dreaming-report.md', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));
    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    const filePath = await saveDreamingReport(result);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(path.basename(filePath)).toMatch(
      /^\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f-]+_compaction-dreaming-report\.md$/,
    );
  });

  it('gera nomes unicos em chamadas no mesmo segundo (anti-colisao)', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));
    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    const paths = new Set<string>();
    for (let i = 0; i < 20; i++) {
      paths.add(await saveDreamingReport(result));
    }
    expect(paths.size).toBe(20);
  });

  it('cria o diretorio pai se nao existir', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));
    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    const expectedDir = path.join(tmpDir, 'workspaces', 'lionclaw', 'dreaming-reports');
    if (fs.existsSync(expectedDir)) {
      fs.rmSync(expectedDir, { recursive: true });
    }

    const filePath = await saveDreamingReport(result);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(expectedDir)).toBe(true);
  });

  it('conteudo do arquivo contem o report do resultado', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));
    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    const filePath = await saveDreamingReport(result);
    const content = fs.readFileSync(filePath, 'utf-8');

    expect(content).toContain(result.report);
  });

  it('adiciona secao fail-safe quando failSafeTriggered=true', async () => {
    const mockInvoker = vi.fn().mockRejectedValue(new Error('LLM offline'));
    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    expect(result.failSafeTriggered).toBe(true);

    const filePath = await saveDreamingReport(result);
    const content = fs.readFileSync(filePath, 'utf-8');

    expect(content).toContain('Fail-Safe Details');
    expect(content).toContain('llm_error');
  });

  it('retorna path absoluto do arquivo criado', async () => {
    const mockInvoker = vi.fn().mockResolvedValue(JSON.stringify(VALID_LLM_OUTPUT));
    const result = await runDreamingGate(BASE_INPUT, { invoker: mockInvoker });

    const filePath = await saveDreamingReport(result);

    expect(path.isAbsolute(filePath)).toBe(true);
  });
});

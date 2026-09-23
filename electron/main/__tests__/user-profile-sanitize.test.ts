import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// eslint-disable-next-line no-var
var TEST_TMP_DIR: string = path.join(os.tmpdir(), `user-sanitize-test-${process.pid}`);

// eslint-disable-next-line no-var
var mockSettings: Record<string, string | undefined> = {};

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
  getSetting: vi.fn((key: string) => mockSettings[key] ?? null),
  setSetting: vi.fn((key: string, value: string) => {
    mockSettings[key] = value;
  }),
}));

import { maybeSanitizeUserProfile } from '../memory-pipeline/user-profile';
import type { PlainPromptInvoker } from '../memory-pipeline/budgeted-input';

const userPath = () => path.join(TEST_TMP_DIR, 'USER.md');
const backupsDir = () => path.join(TEST_TMP_DIR, 'backups');
const reportsDir = () => path.join(TEST_TMP_DIR, 'workspaces', 'lionclaw', 'dreaming-reports');

const MESSY_USER_MD = [
  '# Sobre o Usuario',
  '',
  '## Dados basicos',
  '- Nome: Breno',
  '- Timezone: America/Sao_Paulo',
  '',
  '## Stack tecnologico',
  '- usa Excalidraw',
  '- Usa Excalidraw para diagramas',
  '- usa excalidraw',
  '',
  '## Notas soltas',
  '- Gosta de respostas diretas',
].join('\n');

const CANONICAL_RESPONSE = JSON.stringify({
  sections: {
    identidade: ['Nome: Breno', 'Timezone: America/Sao_Paulo'],
    perfil_profissional: [],
    negocios_projetos: [],
    stack_ferramentas: ['Usa Excalidraw para diagramas'],
    preferencias: ['Gosta de respostas diretas'],
    fatos_duraveis: [],
  },
});

function makeInvoker(response: string | (() => Promise<string>)): PlainPromptInvoker & ReturnType<typeof vi.fn> {
  if (typeof response === 'string') {
    return vi.fn(async () => response) as PlainPromptInvoker & ReturnType<typeof vi.fn>;
  }
  return vi.fn(response) as PlainPromptInvoker & ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings = {};
  fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
});

describe('AC-55 — skips idempotentes sem LLM', () => {
  it('flag true: retorna sem ler nada e sem LLM', async () => {
    mockSettings['user_md_sanitized_v1'] = 'true';
    const invoker = makeInvoker(CANONICAL_RESPONSE);
    await maybeSanitizeUserProfile({ kind: 'claude', invoker });
    expect(invoker).not.toHaveBeenCalled();
  });

  it('flag skipped (teto atingido): retorna sem LLM (reversivel por setting)', async () => {
    mockSettings['user_md_sanitized_v1'] = 'skipped';
    const invoker = makeInvoker(CANONICAL_RESPONSE);
    await maybeSanitizeUserProfile({ kind: 'claude', invoker });
    expect(invoker).not.toHaveBeenCalled();
  });

  it('USER.md ausente: seta flag sem LLM (fresh install = no-op)', async () => {
    const invoker = makeInvoker(CANONICAL_RESPONSE);
    await maybeSanitizeUserProfile({ kind: 'claude', invoker });
    expect(invoker).not.toHaveBeenCalled();
    expect(mockSettings['user_md_sanitized_v1']).toBe('true');
  });

  it('placeholder do onboarding: seta flag sem LLM', async () => {
    fs.writeFileSync(
      userPath(),
      '# Sobre o Usuario\n\nNenhuma informacao coletada ainda. Execute o onboarding para conhecer o usuario.\n',
      'utf-8',
    );
    const invoker = makeInvoker(CANONICAL_RESPONSE);
    await maybeSanitizeUserProfile({ kind: 'claude', invoker });
    expect(invoker).not.toHaveBeenCalled();
    expect(mockSettings['user_md_sanitized_v1']).toBe('true');
  });

  it('arquivo ja canonico dentro do cap: seta flag sem LLM', async () => {
    fs.writeFileSync(
      userPath(),
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
        '',
        '## Preferencias',
        '',
        '## Fatos duraveis',
      ].join('\n'),
      'utf-8',
    );
    const invoker = makeInvoker(CANONICAL_RESPONSE);
    await maybeSanitizeUserProfile({ kind: 'claude', invoker });
    expect(invoker).not.toHaveBeenCalled();
    expect(mockSettings['user_md_sanitized_v1']).toBe('true');
  });
});

describe('AC-54 — sucesso, backup e report', () => {
  it('sanitiza arquivo legado: backup ANTES, render canonico por codigo, flag apenas no fim, report salvo', async () => {
    fs.writeFileSync(userPath(), MESSY_USER_MD, 'utf-8');
    const invoker = makeInvoker(CANONICAL_RESPONSE);

    await maybeSanitizeUserProfile({ kind: 'claude', invoker });

    expect(invoker).toHaveBeenCalledTimes(1);

    const backups = fs.readdirSync(backupsDir()).filter((f) => f.startsWith('USER-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupsDir(), backups[0]), 'utf-8')).toBe(MESSY_USER_MD);

    const content = fs.readFileSync(userPath(), 'utf-8');
    expect(content).toContain('## Identidade');
    expect(content).toContain('- Nome: Breno');
    expect(content).toContain('## Stack e ferramentas');
    expect(content).toContain('- Usa Excalidraw para diagramas');
    expect(content).not.toContain('## Dados basicos');
    expect(content).not.toContain('## Notas soltas');
    expect(content).not.toContain('- usa excalidraw');

    expect(mockSettings['user_md_sanitized_v1']).toBe('true');
    expect(mockSettings['user_md_sanitize_attempts']).toBe('1');

    const reports = fs.readdirSync(reportsDir()).filter((f) => f.includes('user-sanitization-report'));
    expect(reports).toHaveLength(1);
    const report = fs.readFileSync(path.join(reportsDir(), reports[0]), 'utf-8');
    expect(report).toContain('## Antes');
    expect(report).toContain('## Depois');
    expect(report).toContain('Backup:');
  });

  it('usa a MESMA selection do ciclo: kind determina o orcamento; lotes por secao quando excede', async () => {
    mockSettings['compaction_input_budget_tokens'] = '1';
    const bigSection = (name: string, marker: string) =>
      `## ${name}\n` + Array.from({ length: 38 }, (_, i) => `- ${marker} fato ${i} ${'x'.repeat(80)}`).join('\n');
    const bigFile = [
      '# Sobre o Usuario',
      bigSection('Bloco A', 'aa'),
      bigSection('Bloco B', 'bb'),
      bigSection('Bloco C', 'cc'),
    ].join('\n');
    fs.writeFileSync(userPath(), bigFile, 'utf-8');

    const responses = [
      JSON.stringify({
        sections: {
          identidade: ['Nome: Breno'],
          perfil_profissional: [],
          negocios_projetos: [],
          stack_ferramentas: ['fato do lote A'],
          preferencias: [],
          fatos_duraveis: [],
        },
      }),
      JSON.stringify({
        sections: {
          identidade: [],
          perfil_profissional: [],
          negocios_projetos: ['fato do lote B'],
          stack_ferramentas: [],
          preferencias: [],
          fatos_duraveis: [],
        },
      }),
      JSON.stringify({
        sections: {
          identidade: [],
          perfil_profissional: [],
          negocios_projetos: [],
          stack_ferramentas: [],
          preferencias: [],
          fatos_duraveis: ['fato do lote C'],
        },
      }),
    ];
    let call = 0;
    const invoker = makeInvoker(async () => responses[call++]);

    await maybeSanitizeUserProfile({ kind: 'claude', invoker });

    expect(invoker.mock.calls.length).toBeGreaterThan(1);
    const content = fs.readFileSync(userPath(), 'utf-8');
    expect(content).toContain('- fato do lote A');
    expect(content).toContain('- fato do lote B');
    expect(content).toContain('- fato do lote C');
    expect(mockSettings['user_md_sanitized_v1']).toBe('true');
  });
});

describe('AC-54/55 — fail-safe, teto de tentativas e backup obrigatorio', () => {
  it('invoker falha: original intocado, flag ausente, tentativa contada, nao lanca', async () => {
    fs.writeFileSync(userPath(), MESSY_USER_MD, 'utf-8');
    const invoker = makeInvoker(async () => {
      throw new Error('LLM caiu');
    });

    await expect(maybeSanitizeUserProfile({ kind: 'claude', invoker })).resolves.toBeUndefined();

    expect(fs.readFileSync(userPath(), 'utf-8')).toBe(MESSY_USER_MD);
    expect(mockSettings['user_md_sanitized_v1']).toBeUndefined();
    expect(mockSettings['user_md_sanitize_attempts']).toBe('1');
  });

  it('resposta invalida (JSON sem as 6 chaves): fail-safe, original intocado', async () => {
    fs.writeFileSync(userPath(), MESSY_USER_MD, 'utf-8');
    const invoker = makeInvoker(JSON.stringify({ sections: { identidade: ['Nome: Breno'] } }));

    await maybeSanitizeUserProfile({ kind: 'claude', invoker });

    expect(fs.readFileSync(userPath(), 'utf-8')).toBe(MESSY_USER_MD);
    expect(mockSettings['user_md_sanitized_v1']).toBeUndefined();
  });

  it('identidade vazia com nome no original: fail-safe (validacao 12.4 item 7)', async () => {
    fs.writeFileSync(userPath(), MESSY_USER_MD, 'utf-8');
    const invoker = makeInvoker(
      JSON.stringify({
        sections: {
          identidade: [],
          perfil_profissional: [],
          negocios_projetos: [],
          stack_ferramentas: ['Usa Excalidraw'],
          preferencias: [],
          fatos_duraveis: [],
        },
      }),
    );

    await maybeSanitizeUserProfile({ kind: 'claude', invoker });

    expect(fs.readFileSync(userPath(), 'utf-8')).toBe(MESSY_USER_MD);
    expect(mockSettings['user_md_sanitized_v1']).toBeUndefined();
  });

  it('teto de 5 tentativas: grava estado skipped e para de gastar LLM', async () => {
    fs.writeFileSync(userPath(), MESSY_USER_MD, 'utf-8');
    mockSettings['user_md_sanitize_attempts'] = '5';
    const invoker = makeInvoker(CANONICAL_RESPONSE);

    await maybeSanitizeUserProfile({ kind: 'claude', invoker });

    expect(invoker).not.toHaveBeenCalled();
    expect(mockSettings['user_md_sanitized_v1']).toBe('skipped');
    expect(fs.readFileSync(userPath(), 'utf-8')).toBe(MESSY_USER_MD);
  });

  it('falha no backup aborta a sanitizacao inteira ANTES do LLM', async () => {
    fs.writeFileSync(userPath(), MESSY_USER_MD, 'utf-8');
    fs.writeFileSync(backupsDir(), 'nao sou um diretorio', 'utf-8');
    const invoker = makeInvoker(CANONICAL_RESPONSE);

    await maybeSanitizeUserProfile({ kind: 'claude', invoker });

    expect(invoker).not.toHaveBeenCalled();
    expect(fs.readFileSync(userPath(), 'utf-8')).toBe(MESSY_USER_MD);
    expect(mockSettings['user_md_sanitized_v1']).toBeUndefined();
  });
});

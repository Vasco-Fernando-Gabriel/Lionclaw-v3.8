
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// eslint-disable-next-line no-var
var TEST_TMP_DIR: string = path.join(os.tmpdir(), `user-profile-test-${process.pid}`);

const warnSpy = vi.hoisted(() => vi.fn());
// eslint-disable-next-line no-var
var mockSettings: Record<string, string | undefined> = {};

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

vi.mock('../db', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] ?? null),
  setSetting: vi.fn((key: string, value: string) => {
    mockSettings[key] = value;
  }),
}));

import {
  updateUserProfileSectionAware,
  applyUserProfileUpdates,
  USER_SECTION_HEADERS,
  USER_SECTION_ORDER,
} from '../memory-pipeline/user-profile';

const userPath = () => path.join(TEST_TMP_DIR, 'USER.md');
const archivePath = () => path.join(TEST_TMP_DIR, 'USER-archive.md');

function readUser(): string {
  return fs.readFileSync(userPath(), 'utf-8');
}

function todayTag(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function countNonEmpty(content: string): number {
  return content.split('\n').filter(l => l.trim().length > 0).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings = {};
  fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
});

describe('12.1 — estrutura canonica e formato de linha', () => {
  it('cria arquivo canonico com as 6 secoes na ordem e linha pinada `- fato [YYYY-MM-DD]`', async () => {
    await updateUserProfileSectionAware({
      add: [
        { section: 'identidade', text: 'Nome: Breno' },
        { section: 'perfil_profissional', text: 'Desenvolvedor' },
        { section: 'negocios_projetos', text: 'Projeto LionClaw' },
        { section: 'stack_ferramentas', text: 'TypeScript' },
        { section: 'preferencias', text: 'Comunicacao direta' },
        { section: 'fatos_duraveis', text: 'Usa Mac' },
      ],
      remove: [],
    });

    const content = readUser();
    let lastIdx = -1;
    for (const s of USER_SECTION_ORDER) {
      const idx = content.indexOf(USER_SECTION_HEADERS[s]);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
    for (const line of content.split('\n')) {
      if (line.startsWith('## ')) {
        expect(Object.values(USER_SECTION_HEADERS)).toContain(line);
      }
    }
    const tag = todayTag();
    expect(content).toContain(`- Desenvolvedor [${tag}]`);
    expect(content).toContain(`- Projeto LionClaw [${tag}]`);
    expect(content).toContain('- Nome: Breno');
    expect(content).not.toContain(`- Nome: Breno [${tag}]`);
  });

  it('texto que ja tem tag [YYYY-MM-DD] nao recebe tag dupla', async () => {
    await updateUserProfileSectionAware({
      add: [{ section: 'fatos_duraveis', text: 'Fato antigo [2026-01-15]' }],
      remove: [],
    });
    const content = readUser();
    expect(content).toContain('- Fato antigo [2026-01-15]');
    expect(content).not.toContain(`[2026-01-15] [${todayTag()}]`);
  });

  it('AC-44: header desconhecido e conteudo orfao sao DOBRADOS em Fatos duraveis, nunca descartados', async () => {
    fs.writeFileSync(
      userPath(),
      [
        '# Sobre o Usuario',
        'linha orfa antes de qualquer header',
        '',
        '## Secao Estranha',
        '- fato precioso do usuario',
        '',
        '## Identidade',
        '- Nome: Breno',
      ].join('\n'),
      'utf-8',
    );

    await updateUserProfileSectionAware({
      add: [{ section: 'preferencias', text: 'PT-BR' }],
      remove: [],
    });

    const content = readUser();
    const fatosIdx = content.indexOf('## Fatos duraveis');
    expect(fatosIdx).toBeGreaterThan(-1);
    expect(content.indexOf('- fato precioso do usuario')).toBeGreaterThan(fatosIdx);
    expect(content.indexOf('linha orfa antes de qualquer header')).toBeGreaterThan(fatosIdx);
    expect(content).not.toContain('## Secao Estranha');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('AC-52: remove por linha EXATA funciona; remove que nao casa = no-op logado', async () => {
    fs.writeFileSync(
      userPath(),
      [
        '# Sobre o Usuario',
        '',
        '## Identidade',
        '- Nome: Breno',
        '',
        '## Perfil profissional',
        '- Desenvolvedor [2026-01-01]',
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

    await updateUserProfileSectionAware({
      add: [],
      remove: ['- Desenvolvedor [2026-01-01]', '- Linha que nao existe [2026-01-01]'],
    });

    const content = readUser();
    expect(content).not.toContain('- Desenvolvedor [2026-01-01]');
    expect(content).toContain('- Nome: Breno');
    const warned = warnSpy.mock.calls.some(c =>
      String(c[1] ?? c[0]).includes('userRemove sem line-match exato'),
    );
    expect(warned).toBe(true);
  });

  it('guard de input vazio: nenhuma escrita', async () => {
    await updateUserProfileSectionAware({ add: [], remove: [] });
    expect(fs.existsSync(userPath())).toBe(false);
  });

  it('dedup literal (guard secundario): linha identica nao duplica', async () => {
    await updateUserProfileSectionAware({
      add: [{ section: 'fatos_duraveis', text: 'Fato unico [2026-01-01]' }],
      remove: [],
    });
    await updateUserProfileSectionAware({
      add: [{ section: 'fatos_duraveis', text: 'Fato unico [2026-01-01]' }],
      remove: [],
    });
    const content = readUser();
    const occurrences = content.split('- Fato unico [2026-01-01]').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('12.1 — poda deterministica com archive (AC-45)', () => {
  function bigUserMd(): string {
    const lines: string[] = ['# Sobre o Usuario', '', '## Identidade', '- Nome: Breno'];
    lines.push('', '## Perfil profissional');
    for (let i = 0; i < 10; i++) lines.push(`- perfil ${i} [2026-01-01]`);
    lines.push('', '## Negocios e projetos');
    for (let i = 0; i < 20; i++) lines.push(`- negocio ${i} [2026-01-01]`);
    lines.push('', '## Stack e ferramentas');
    for (let i = 0; i < 10; i++) lines.push(`- stack ${i} [2026-01-01]`);
    lines.push('', '## Preferencias');
    for (let i = 0; i < 10; i++) lines.push(`- pref ${i} [2026-01-01]`);
    lines.push('', '## Fatos duraveis');
    for (let i = 0; i < 15; i++) lines.push(`- fato ${i} [2026-01-01]`);
    return lines.join('\n');
  }

  it('poda ate o cap (default 60) comecando por Negocios e projetos, do inicio; archive recebe as linhas', async () => {
    fs.writeFileSync(userPath(), bigUserMd(), 'utf-8');

    await updateUserProfileSectionAware({
      add: [{ section: 'fatos_duraveis', text: 'novo fato' }],
      remove: [],
    });

    const content = readUser();
    expect(countNonEmpty(content)).toBeLessThanOrEqual(60);

    expect(content).not.toContain('- negocio 0 [2026-01-01]');
    expect(content).toContain('- Nome: Breno');
    expect(content).toContain('- perfil 0 [2026-01-01]');

    expect(fs.existsSync(archivePath())).toBe(true);
    const archive = fs.readFileSync(archivePath(), 'utf-8');
    expect(archive).toContain('- negocio 0 [2026-01-01]');
    expect(archive).toContain('[## Negocios e projetos]');
    expect(archive).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('cap custom via setting user_md_max_lines', async () => {
    mockSettings['user_md_max_lines'] = '20';
    fs.writeFileSync(userPath(), bigUserMd(), 'utf-8');

    await updateUserProfileSectionAware({
      add: [{ section: 'fatos_duraveis', text: 'novo fato' }],
      remove: [],
    });

    expect(countNonEmpty(readUser())).toBeLessThanOrEqual(20);
    expect(readUser()).toContain('- Nome: Breno');
  });

  it('Identidade slot-like: dedup por prefixo de chave + teto ~10 com fold em Fatos duraveis', async () => {
    const identLines: Array<{ section: 'identidade'; text: string }> = [];
    for (let i = 0; i < 12; i++) {
      identLines.push({ section: 'identidade', text: `Chave${i}: valor${i}` });
    }
    await updateUserProfileSectionAware({ add: identLines, remove: [] });

    let content = readUser();
    const identSection = content
      .slice(content.indexOf('## Identidade'), content.indexOf('## Perfil profissional'))
      .split('\n')
      .filter(l => l.trim().startsWith('- '));
    expect(identSection.length).toBeLessThanOrEqual(10);
    const fatosIdx = content.indexOf('## Fatos duraveis');
    expect(content.indexOf('- Chave11: valor11')).toBeGreaterThan(fatosIdx);

    await updateUserProfileSectionAware({
      add: [{ section: 'identidade', text: 'Chave0: NOVO' }],
      remove: [],
    });
    content = readUser();
    expect(content).toContain('- Chave0: NOVO');
    expect(content).not.toContain('- Chave0: valor0');
  });
});

describe('AC-46 — grep estatico: passo direto morreu', () => {
  it('memory-pipeline.ts nao contem mais a funcao updateUserProfile nem a aplicacao direta', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'memory-pipeline.ts'),
      'utf-8',
    );
    expect(source).not.toMatch(/async function updateUserProfile\(/);
    expect(source).not.toMatch(/await updateUserProfile\(summary\.user_profile_updates\)/);
    expect(source).toContain('await updateUserProfileSectionAware({');
  });
});

describe('applyUserProfileUpdates (wrapper publico)', () => {
  it('delega para updateUserProfileSectionAware', async () => {
    await applyUserProfileUpdates({
      add: [{ section: 'preferencias', text: 'Respostas curtas' }],
      remove: [],
    });
    expect(readUser()).toContain(`- Respostas curtas [${todayTag()}]`);
  });
});

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter } from '../skills';

const SKILL_DIR = path.join(__dirname, '..', '..', '..', '.lionclaw', 'skills', 'revisao-de-decisoes');

describe('skill padrao revisao-de-decisoes (SPEC artefatos HTML 4.5)', () => {
  it('a pasta rastreada tem os tres arquivos', () => {
    for (const name of ['SKILL.md', 'template.html', 'formato-decisoes.md']) {
      expect(fs.existsSync(path.join(SKILL_DIR, name)), name).toBe(true);
    }
  });

  it('frontmatter tem name, description, category e version', () => {
    const fm = parseSkillFrontmatter(fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(fm.name).toBe('revisao-de-decisoes');
    expect(typeof fm.description).toBe('string');
    expect(fm.category).toBe('produto');
    expect(String(fm.version)).toBe('1');
  });

  it('SKILL.md ensina a saida por ARQUIVO_HTML e nao cita o harness do Claude Code', () => {
    const md = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8');
    expect(md).toContain('ARQUIVO_HTML:');
    expect(md).toContain('~/.lionclaw/artifacts/');
    expect(md).not.toContain('artifact-design');
    expect(md).not.toMatch(/tool `Artifact`/);
    expect(md).not.toContain('favicon');
  });

  it('template.html tem o adaptador do LionClaw e nenhum script externo', () => {
    const html = fs.readFileSync(path.join(SKILL_DIR, 'template.html'), 'utf-8');
    expect(html).toContain('window.__lionclawStore');
    expect(html).toContain("'lionclaw:ready'");
    expect(html).toContain("'lionclaw:decisions'");
    expect(html).toContain("'lionclaw:state:set'");
    expect(html).toContain('store.onState');
    expect(html).not.toMatch(/<script\s+src=/i);
    const externalRefs = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
    for (const ref of externalRefs) {
      expect(ref.startsWith('https://fonts.googleapis.com'), ref).toBe(true);
    }
  });
});

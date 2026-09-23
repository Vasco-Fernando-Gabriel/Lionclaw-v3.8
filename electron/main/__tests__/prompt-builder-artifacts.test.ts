import { describe, expect, it } from 'vitest';
import { buildArtifactsSection } from '../prompt-builder';

describe('secao de artefatos HTML do prompt (SPEC artefatos HTML 5.1)', () => {
  const section = buildArtifactsSection();

  it('respeita o teto de 600 caracteres', () => {
    expect(section.length).toBeLessThanOrEqual(600);
  });

  it('ensina o marcador, a pasta e a skill de revisao', () => {
    expect(section).toContain('ARQUIVO_HTML:');
    expect(section).toContain('~/.lionclaw/artifacts/');
    expect(section).toContain('revisao-de-decisoes');
    expect(section).toContain('formato-decisoes.md');
    expect(section).toMatch(/Nunca peca ao usuario para abrir o arquivo no navegador/);
  });
});

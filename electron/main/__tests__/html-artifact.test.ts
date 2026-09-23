import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HTML_ARTIFACT_CSP,
  HTML_ARTIFACT_MAX_BYTES,
  artifactsDirHtmlWritePath,
  detectHtmlArtifact,
  htmlArtifactUrl,
  readArtifactState,
  resolveHtmlArtifactPath,
  sanitizeArtifactStateKey,
  writeArtifactState,
} from '../html-artifact';

const createdDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveHtmlArtifactPath (RM3 / 6.2)', () => {
  it('aceita .html dentro da pasta do usuario e devolve o caminho real e o tamanho', () => {
    const home = tempDir('lionclaw-home-');
    const file = path.join(home, 'artifacts', 'pagina.html');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '<title>Oi</title>');
    const res = resolveHtmlArtifactPath(file, home);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.filePath).toBe(fs.realpathSync(file));
      expect(res.size).toBe(Buffer.byteLength('<title>Oi</title>'));
    }
  });

  it('aceita file:// e %20 no caminho', () => {
    const home = tempDir('lionclaw-home-');
    const file = path.join(home, 'com espaco.html');
    fs.writeFileSync(file, 'x');
    expect(resolveHtmlArtifactPath(encodeURI(file), home).ok).toBe(true);
    expect(resolveHtmlArtifactPath(`file:///${file.replace(/\\/g, '/')}`, home).ok).toBe(true);
  });

  it('rejeita arquivo fora da pasta do usuario', () => {
    const home = tempDir('lionclaw-home-');
    const outside = tempDir('lionclaw-outside-');
    const file = path.join(outside, 'fora.html');
    fs.writeFileSync(file, 'x');
    const res = resolveHtmlArtifactPath(file, home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('Arquivo fora da pasta do usuario');
  });

  it('rejeita extensao diferente de .html/.htm, arquivo inexistente e caminho relativo', () => {
    const home = tempDir('lionclaw-home-');
    const txt = path.join(home, 'nota.txt');
    fs.writeFileSync(txt, 'x');
    expect(resolveHtmlArtifactPath(txt, home)).toMatchObject({
      ok: false,
      error: 'Extensao nao permitida (so .html ou .htm)',
    });
    expect(resolveHtmlArtifactPath(path.join(home, 'nada.html'), home)).toMatchObject({
      ok: false,
      error: 'Arquivo nao encontrado',
    });
    expect(resolveHtmlArtifactPath('relativo.html', home)).toMatchObject({
      ok: false,
      error: 'O caminho precisa ser absoluto',
    });
  });

  it('rejeita arquivo acima do teto de 2 MiB', () => {
    const home = tempDir('lionclaw-home-');
    const file = path.join(home, 'grande.html');
    fs.writeFileSync(file, Buffer.alloc(HTML_ARTIFACT_MAX_BYTES + 1, 0x20));
    const res = resolveHtmlArtifactPath(file, home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('2 MiB');
  });
});

describe('detectHtmlArtifact (marcador ARQUIVO_HTML:)', () => {
  it('produz ArtifactData html com titulo do <title>, tamanho e sha256, sem conteudo', () => {
    const home = tempDir('lionclaw-home-');
    const file = path.join(home, 'revisao.html');
    fs.writeFileSync(file, '<title>Artefatos HTML</title><p>oi</p>');
    const det = detectHtmlArtifact(`Pronto.\n\nARQUIVO_HTML: ${file}\n`, home);
    expect(det?.kind).toBe('artifact');
    if (det?.kind === 'artifact') {
      expect(det.artifact.type).toBe('html');
      expect(det.artifact.title).toBe('Artefatos HTML');
      expect(det.artifact.toolName).toBe('file-output');
      expect(det.artifact.data.fileName).toBe('revisao.html');
      expect(det.artifact.data.size).toBe(fs.statSync(file).size);
      expect(typeof det.artifact.data.sha256).toBe('string');
      expect((det.artifact.data.sha256 as string).length).toBe(64);
      expect(det.artifact.data.html).toBeUndefined();
    }
  });

  it('cai no nome do arquivo quando nao ha <title>', () => {
    const home = tempDir('lionclaw-home-');
    const file = path.join(home, 'sem-titulo.html');
    fs.writeFileSync(file, '<p>oi</p>');
    const det = detectHtmlArtifact(`ARQUIVO_HTML: ${file}`, home);
    expect(det?.kind === 'artifact' && det.artifact.title).toBe('sem-titulo.html');
  });

  it('devolve erro com motivo para marcador invalido e null sem marcador', () => {
    const home = tempDir('lionclaw-home-');
    const outside = tempDir('lionclaw-outside-');
    const file = path.join(outside, 'fora.html');
    fs.writeFileSync(file, 'x');
    expect(detectHtmlArtifact(`ARQUIVO_HTML: ${file}`, home)).toMatchObject({
      kind: 'error',
      error: 'Arquivo fora da pasta do usuario',
    });
    expect(detectHtmlArtifact('texto sem marcador', home)).toBeNull();
  });
});

describe('artifactsDirHtmlWritePath (deteccao sem marcador, 6.2b)', () => {
  const home = path.join(os.tmpdir(), 'lionclaw-home-x');
  const inside = path.join(home, 'artifacts', 'revisao-20260909-0900.html');

  it('reconhece Write/Edit/MultiEdit de .html dentro de ~/.lionclaw/artifacts', () => {
    expect(artifactsDirHtmlWritePath('Write', { file_path: inside }, home)).toBe(path.resolve(inside));
    expect(artifactsDirHtmlWritePath('Edit', { file_path: inside }, home)).toBe(path.resolve(inside));
    expect(artifactsDirHtmlWritePath('MultiEdit', { file_path: inside }, home)).toBe(path.resolve(inside));
    expect(
      artifactsDirHtmlWritePath('Write', { file_path: path.join(home, 'artifacts', 'sub', 'a.htm') }, home),
    ).not.toBeNull();
  });

  it('ignora outras tools, outras extensoes, fora da pasta e caminho relativo', () => {
    expect(artifactsDirHtmlWritePath('Read', { file_path: inside }, home)).toBeNull();
    expect(artifactsDirHtmlWritePath('Bash', { command: `echo > ${inside}` }, home)).toBeNull();
    expect(
      artifactsDirHtmlWritePath('Write', { file_path: path.join(home, 'artifacts', 'notas.md') }, home),
    ).toBeNull();
    expect(artifactsDirHtmlWritePath('Write', { file_path: path.join(home, 'skills', 'x.html') }, home)).toBeNull();
    expect(
      artifactsDirHtmlWritePath('Write', { file_path: path.join(home, 'artifacts-old', 'x.html') }, home),
    ).toBeNull();
    expect(artifactsDirHtmlWritePath('Write', { file_path: 'artifacts/x.html' }, home)).toBeNull();
    expect(artifactsDirHtmlWritePath('Write', {}, home)).toBeNull();
  });
});

describe('protocolo e CSP (RM1 / RM8)', () => {
  it('monta a URL do protocolo com o caminho codificado', () => {
    expect(htmlArtifactUrl('C:\\Users\\x\\a b.html')).toBe(
      'lionclaw-asset://host/html-artifact/C%3A%5CUsers%5Cx%5Ca%20b.html',
    );
  });

  it('CSP minima: sem script externo, fontes so do Google, sem connect-src', () => {
    expect(HTML_ARTIFACT_CSP).toContain("default-src 'none'");
    expect(HTML_ARTIFACT_CSP).toContain("script-src 'unsafe-inline'");
    expect(HTML_ARTIFACT_CSP).toContain('https://fonts.googleapis.com');
    expect(HTML_ARTIFACT_CSP).toContain('https://fonts.gstatic.com');
    expect(HTML_ARTIFACT_CSP).toContain("connect-src 'none'");
    expect(HTML_ARTIFACT_CSP).not.toMatch(/script-src[^;]*https?:/);
  });
});

describe('estado das marcacoes (6.5)', () => {
  let home: string;
  beforeEach(() => {
    home = tempDir('lionclaw-state-home-');
    process.env['NODE_ENV'] = 'test';
    process.env['LIONCLAW_TEST_HOME'] = home;
  });
  afterEach(() => {
    delete process.env['LIONCLAW_TEST_HOME'];
  });

  it('sanitiza a chave para [a-z0-9-]', () => {
    expect(sanitizeArtifactStateKey('Lion Claw_Spec/v1')).toBe('lionclawspecv1');
    expect(sanitizeArtifactStateKey('../../etc')).toBe('etc');
    expect(sanitizeArtifactStateKey('///')).toBeNull();
    expect(sanitizeArtifactStateKey(42)).toBeNull();
  });

  it('grava e le por chave; chave ausente devolve state null', () => {
    expect(readArtifactState('projeto-doc-v1')).toEqual({ state: null });
    expect(writeArtifactState('projeto-doc-v1', { RM1: { s: 'ok' } })).toEqual({ ok: true });
    expect(readArtifactState('projeto-doc-v1')).toEqual({ state: { RM1: { s: 'ok' } } });
    expect(fs.existsSync(path.join(home, 'artifacts', 'state', 'projeto-doc-v1.json'))).toBe(true);
  });

  it('recusa estado que nao e objeto e acima de 256 KiB', () => {
    expect(writeArtifactState('k', 'texto')).toEqual({ error: 'Estado precisa ser um objeto' });
    expect(writeArtifactState('k', ['a'])).toEqual({ error: 'Estado precisa ser um objeto' });
    expect(writeArtifactState('k', { big: 'x'.repeat(256 * 1024) })).toEqual({ error: 'Estado acima de 256 KiB' });
  });
});

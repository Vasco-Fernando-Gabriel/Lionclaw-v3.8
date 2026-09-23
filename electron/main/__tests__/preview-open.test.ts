import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const openPathMock = vi.fn<(target: string) => Promise<string>>(async () => '');
const openExternalMock = vi.fn<(url: string) => Promise<void>>(async () => undefined);
vi.mock('electron', () => ({
  shell: {
    openPath: (target: string) => openPathMock(target),
    openExternal: (url: string) => openExternalMock(url),
  },
}));

const listHarnessProjectsMock = vi.fn<() => Array<{ projectPath: string }>>(() => []);
vi.mock('../db', () => ({
  listHarnessProjects: () => listHarnessProjectsMock(),
}));

const getLionClawHomeMock = vi.fn<() => string>(() => '/nonexistent/.lionclaw-test');
vi.mock('../paths', () => ({
  getLionClawHome: () => getLionClawHomeMock(),
}));

import { isPreviewRequestAllowed, previewOpenCore } from '../preview-open';
import { pathToFileURL } from 'node:url';

let projectRoot = '';
let outsideDir = '';
let lionHome = '';

beforeAll(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-open-root-'));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-open-out-'));
  lionHome = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-open-home-'));

  fs.writeFileSync(path.join(projectRoot, 'index.html'), '<html></html>');
  fs.mkdirSync(path.join(projectRoot, 'sub'));
  fs.writeFileSync(path.join(projectRoot, 'sub', 'page.htm'), '<html></html>');
  fs.writeFileSync(path.join(projectRoot, 'notes.txt'), 'texto');
  fs.writeFileSync(path.join(outsideDir, 'outside.html'), '<html></html>');
  fs.writeFileSync(path.join(lionHome, 'artifact.html'), '<html></html>');
  fs.symlinkSync(path.join(outsideDir, 'outside.html'), path.join(projectRoot, 'escape.html'));
});

afterAll(() => {
  for (const dir of [projectRoot, outsideDir, lionHome]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  openPathMock.mockResolvedValue('');
  openExternalMock.mockResolvedValue(undefined);
  listHarnessProjectsMock.mockReturnValue([{ projectPath: projectRoot }]);
  getLionClawHomeMock.mockReturnValue(lionHome);
});

describe('previewOpenCore — arquivos (W5)', () => {
  it('abre .html dentro do project_path (openPath com o caminho canonicalizado)', async () => {
    const target = path.join(projectRoot, 'index.html');
    const res = await previewOpenCore(target);
    expect(res).toEqual({
      ok: true,
      value: { opened: true, kind: 'file', target: fs.realpathSync(target) },
    });
    expect(openPathMock).toHaveBeenCalledTimes(1);
    expect(openPathMock).toHaveBeenCalledWith(fs.realpathSync(target));
  });

  it('abre .htm em subpasta da raiz', async () => {
    const target = path.join(projectRoot, 'sub', 'page.htm');
    const res = await previewOpenCore(target);
    expect(res.ok).toBe(true);
    expect(openPathMock).toHaveBeenCalledWith(fs.realpathSync(target));
  });

  it('abre .html dentro de getLionClawHome()', async () => {
    const target = path.join(lionHome, 'artifact.html');
    const res = await previewOpenCore(target);
    expect(res.ok).toBe(true);
    expect(openPathMock).toHaveBeenCalledWith(fs.realpathSync(target));
  });

  it('recusa arquivo FORA das raizes permitidas', async () => {
    const res = await previewOpenCore(path.join(outsideDir, 'outside.html'));
    expect(res).toEqual({ ok: false, error: expect.stringContaining('fora das raizes permitidas') });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it('recusa `../` que escapa da raiz (realpath antes do check de prefixo)', async () => {
    const traversal = `${projectRoot}${path.sep}sub${path.sep}..${path.sep}..${path.sep}${path.basename(outsideDir)}${path.sep}outside.html`;
    const res = await previewOpenCore(traversal);
    expect(res).toEqual({ ok: false, error: expect.stringContaining('fora das raizes permitidas') });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it('recusa symlink dentro da raiz que aponta pra fora', async () => {
    const res = await previewOpenCore(path.join(projectRoot, 'escape.html'));
    expect(res).toEqual({ ok: false, error: expect.stringContaining('fora das raizes permitidas') });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it('recusa extensao diferente de .html/.htm', async () => {
    const res = await previewOpenCore(path.join(projectRoot, 'notes.txt'));
    expect(res).toEqual({ ok: false, error: expect.stringContaining('.html/.htm') });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it('recusa arquivo inexistente', async () => {
    const res = await previewOpenCore(path.join(projectRoot, 'nao-existe.html'));
    expect(res).toEqual({ ok: false, error: expect.stringContaining('nao encontrado') });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it('recusa caminho relativo', async () => {
    const res = await previewOpenCore('relativo/index.html');
    expect(res).toEqual({ ok: false, error: expect.stringContaining('absoluto') });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it('recusa target vazio', async () => {
    const res = await previewOpenCore('   ');
    expect(res).toEqual({ ok: false, error: expect.stringContaining('target obrigatorio') });
    expect(openPathMock).not.toHaveBeenCalled();
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('propaga falha do shell.openPath como { error } (sem throw)', async () => {
    openPathMock.mockResolvedValue('No application found');
    const res = await previewOpenCore(path.join(projectRoot, 'index.html'));
    expect(res).toEqual({ ok: false, error: expect.stringContaining('No application found') });
  });
});

describe('previewOpenCore — urls locais (W5)', () => {
  it('abre http://localhost com porta', async () => {
    const res = await previewOpenCore('http://localhost:5173/');
    expect(res).toEqual({
      ok: true,
      value: { opened: true, kind: 'url', target: 'http://localhost:5173/' },
    });
    expect(openExternalMock).toHaveBeenCalledWith('http://localhost:5173/');
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it('abre http://127.0.0.1 com path', async () => {
    const res = await previewOpenCore('http://127.0.0.1:3000/preview/index.html');
    expect(res.ok).toBe(true);
    expect(openExternalMock).toHaveBeenCalledTimes(1);
  });

  it('abre https://localhost (sem porta)', async () => {
    const res = await previewOpenCore('https://localhost/');
    expect(res.ok).toBe(true);
    expect(openExternalMock).toHaveBeenCalledTimes(1);
  });

  it('recusa host externo', async () => {
    const res = await previewOpenCore('https://evil.com/page.html');
    expect(res).toEqual({ ok: false, error: expect.stringContaining('host nao permitido') });
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('recusa subdominio que so PARECE local (localhost.evil.com)', async () => {
    const res = await previewOpenCore('http://localhost.evil.com/');
    expect(res).toEqual({ ok: false, error: expect.stringContaining('host nao permitido') });
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('recusa truque de userinfo (http://localhost@evil.com)', async () => {
    const res = await previewOpenCore('http://localhost@evil.com/');
    expect(res).toEqual({ ok: false, error: expect.stringContaining('host nao permitido') });
    expect(openExternalMock).not.toHaveBeenCalled();
  });
});

describe('previewCaptureCore — política default-deny de subrecursos', () => {
  it('permite somente target, assets locais na mesma pasta e data/blob', () => {
    const target = fs.realpathSync(path.join(projectRoot, 'index.html'));
    const asset = path.join(projectRoot, 'asset.css');
    fs.writeFileSync(asset, 'body{}');
    expect(isPreviewRequestAllowed(pathToFileURL(target).href, target)).toBe(true);
    expect(isPreviewRequestAllowed(pathToFileURL(asset).href, target)).toBe(true);
    expect(isPreviewRequestAllowed('data:image/png;base64,AA==', target)).toBe(true);
    expect(isPreviewRequestAllowed('blob:null/fixture', target)).toBe(true);
  });

  it('bloqueia rede, websocket, arquivo fora da pasta e symlink de escape', () => {
    const target = fs.realpathSync(path.join(projectRoot, 'index.html'));
    const outside = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outside, 'secret');
    const escape = path.join(projectRoot, 'asset-escape.txt');
    fs.symlinkSync(outside, escape);
    for (const raw of [
      'https://example.com/a.js',
      'http://127.0.0.1:9999/a.js',
      'ws://example.com/socket',
      'wss://example.com/socket',
      pathToFileURL(outside).href,
      pathToFileURL(escape).href,
    ]) {
      expect(isPreviewRequestAllowed(raw, target), raw).toBe(false);
    }
  });

  it('bloqueia arquivo sensível irmão mesmo estando na pasta do HTML', () => {
    const target = fs.realpathSync(path.join(projectRoot, 'index.html'));
    const env = path.join(projectRoot, '.env');
    const text = path.join(projectRoot, 'credentials.txt');
    fs.writeFileSync(env, 'TOKEN=secret');
    fs.writeFileSync(text, 'secret');
    expect(isPreviewRequestAllowed(pathToFileURL(env).href, target)).toBe(false);
    expect(isPreviewRequestAllowed(pathToFileURL(text).href, target)).toBe(false);
  });
});

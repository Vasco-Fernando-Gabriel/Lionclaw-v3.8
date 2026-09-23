import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLionClawHome } from './paths';
import type { ArtifactData } from '../../src/types';

export const HTML_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export const HTML_ARTIFACT_STATE_MAX_BYTES = 256 * 1024;
export const HTML_ARTIFACT_PROTOCOL_PREFIX = '/html-artifact/';
export const HTML_ARTIFACT_MARKER = 'ARQUIVO_HTML:';
export const HTML_ARTIFACT_MARKER_REGEX = /ARQUIVO_HTML:\s*((?:\/|[A-Za-z]:\\|file:\/\/).+?)(?:\n|\\n|$)/;

export const HTML_ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com data:',
  'img-src data: blob:',
  "connect-src 'none'",
].join('; ');

export type HtmlArtifactResolution =
  { ok: true; filePath: string; size: number } | { ok: false; error: string; candidate: string };

export function resolveHtmlArtifactPath(rawTarget: string, homeDir: string = os.homedir()): HtmlArtifactResolution {
  let candidate = rawTarget.trim();
  if (/^file:/i.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return { ok: false, error: 'URL file:// invalida', candidate };
    }
  } else {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      return { ok: false, error: 'Caminho com codificacao invalida', candidate };
    }
  }
  if (!path.isAbsolute(candidate)) {
    return { ok: false, error: 'O caminho precisa ser absoluto', candidate };
  }
  const ext = path.extname(candidate).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') {
    return { ok: false, error: 'Extensao nao permitida (so .html ou .htm)', candidate };
  }
  let realTarget: string;
  let realHome: string;
  try {
    realTarget = fs.realpathSync(candidate);
    realHome = fs.realpathSync(homeDir);
  } catch {
    return { ok: false, error: 'Arquivo nao encontrado', candidate };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(realTarget);
  } catch {
    return { ok: false, error: 'Arquivo nao encontrado', candidate };
  }
  if (!stat.isFile()) {
    return { ok: false, error: 'O caminho nao e um arquivo', candidate };
  }
  if (realTarget !== realHome && !realTarget.startsWith(realHome + path.sep)) {
    return { ok: false, error: 'Arquivo fora da pasta do usuario', candidate };
  }
  if (stat.size > HTML_ARTIFACT_MAX_BYTES) {
    return { ok: false, error: `Arquivo acima de ${Math.round(HTML_ARTIFACT_MAX_BYTES / 1024 / 1024)} MiB`, candidate };
  }
  return { ok: true, filePath: realTarget, size: stat.size };
}

export function extractHtmlTitle(html: string): string | null {
  const match = /<title>([^<]{1,200})<\/title>/i.exec(html.slice(0, 16 * 1024));
  if (!match) return null;
  const title = match[1].replace(/\s+/g, ' ').trim();
  return title.length > 0 ? title : null;
}

export type HtmlArtifactDetection =
  { kind: 'artifact'; artifact: ArtifactData } | { kind: 'error'; error: string; candidate: string } | null;

const HTML_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

export function artifactsDirHtmlWritePath(
  toolName: string,
  input: Record<string, unknown>,
  lionclawHome: string = getLionClawHome(),
): string | null {
  if (!HTML_WRITE_TOOLS.has(toolName)) return null;
  const raw = input.file_path ?? input.filePath ?? input.path;
  if (typeof raw !== 'string' || !path.isAbsolute(raw)) return null;
  const ext = path.extname(raw).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') return null;
  const artifactsDir = path.resolve(lionclawHome, 'artifacts');
  const resolved = path.resolve(raw);
  const inside = resolved.toLowerCase().startsWith((artifactsDir + path.sep).toLowerCase());
  return inside ? resolved : null;
}

export function detectHtmlArtifact(content: string, homeDir?: string): HtmlArtifactDetection {
  const match = content.match(HTML_ARTIFACT_MARKER_REGEX);
  if (!match) return null;
  return htmlArtifactFromPath(match[1], homeDir);
}

export function htmlArtifactFromPath(rawPath: string, homeDir?: string): HtmlArtifactDetection {
  const resolution = resolveHtmlArtifactPath(rawPath, homeDir);
  if (!resolution.ok) {
    return { kind: 'error', error: resolution.error, candidate: resolution.candidate };
  }
  let html: string;
  try {
    html = fs.readFileSync(resolution.filePath, 'utf-8');
  } catch {
    return { kind: 'error', error: 'Arquivo nao pode ser lido', candidate: resolution.filePath };
  }
  const fileName = path.basename(resolution.filePath);
  return {
    kind: 'artifact',
    artifact: {
      id: crypto.randomUUID(),
      type: 'html',
      title: extractHtmlTitle(html) ?? fileName,
      toolName: 'file-output',
      data: {
        filePath: resolution.filePath,
        fileName,
        size: resolution.size,
        sha256: crypto.createHash('sha256').update(html).digest('hex'),
      },
    },
  };
}

export function htmlArtifactUrl(filePath: string): string {
  return `lionclaw-asset://host${HTML_ARTIFACT_PROTOCOL_PREFIX}${encodeURIComponent(filePath)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function htmlArtifactErrorPage(message: string, candidate: string): string {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${escapeHtml(message)}</title>
<style>html,body{margin:0;height:100%;background:#070707;color:#f6f1ea;font-family:'Segoe UI',system-ui,sans-serif}
.box{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;padding:24px;text-align:center}
h1{font-size:15px;font-weight:600;margin:0;color:#ff9640}code{font-family:Consolas,'Cascadia Mono',monospace;font-size:12px;color:#9a8f84;word-break:break-all}</style></head>
<body><div class="box"><h1>${escapeHtml(message)}</h1><code>${escapeHtml(candidate)}</code></div></body></html>`;
}

export function serveHtmlArtifact(pathname: string): Response {
  const encoded = pathname.slice(HTML_ARTIFACT_PROTOCOL_PREFIX.length);
  const resolution = resolveHtmlArtifactPath(encoded);
  const htmlHeaders = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': HTML_ARTIFACT_CSP,
  };
  if (!resolution.ok) {
    const status = resolution.error === 'Arquivo nao encontrado' ? 404 : 403;
    return new Response(htmlArtifactErrorPage(resolution.error, resolution.candidate), {
      status,
      headers: htmlHeaders,
    });
  }
  try {
    const html = fs.readFileSync(resolution.filePath, 'utf-8');
    return new Response(html, { headers: htmlHeaders });
  } catch (err) {
    return new Response(htmlArtifactErrorPage('Arquivo nao pode ser lido', resolution.filePath), {
      status: 500,
      headers: htmlHeaders,
    });
  }
}

export function sanitizeArtifactStateKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return key.length > 0 && key.length <= 120 ? key : null;
}

function artifactStateDir(): string {
  return path.join(getLionClawHome(), 'artifacts', 'state');
}

export function readArtifactState(rawKey: unknown): { state: unknown } | { error: string } {
  const key = sanitizeArtifactStateKey(rawKey);
  if (!key) return { error: 'storageKey invalida' };
  const file = path.join(artifactStateDir(), `${key}.json`);
  if (!fs.existsSync(file)) return { state: null };
  try {
    return { state: JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown };
  } catch {
    return { error: 'Estado salvo ilegivel' };
  }
}

export function writeArtifactState(rawKey: unknown, state: unknown): { ok: true } | { error: string } {
  const key = sanitizeArtifactStateKey(rawKey);
  if (!key) return { error: 'storageKey invalida' };
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return { error: 'Estado precisa ser um objeto' };
  }
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json, 'utf-8') > HTML_ARTIFACT_STATE_MAX_BYTES) {
    return { error: 'Estado acima de 256 KiB' };
  }
  const dir = artifactStateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.json`), json, 'utf-8');
  return { ok: true };
}

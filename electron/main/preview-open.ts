
import fs from 'fs';
import path from 'path';
import { BrowserWindow, session, shell } from 'electron';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { listHarnessProjects } from './db';
import { getLionClawHome } from './paths';
import { createLogger } from './logger';

const logger = createLogger('preview-open');

export type PreviewOpenResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

const ALLOWED_EXTENSIONS = new Set(['.html', '.htm']);
const ALLOWED_URL_HOSTS = new Set(['localhost', '127.0.0.1']);
const ALLOWED_CAPTURE_ASSET_EXTENSIONS = new Set([
  '.css', '.js', '.mjs', '.wasm',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
]);

function fail(error: string): PreviewOpenResult {
  return { ok: false, error };
}

function isHttpUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

export function resolveAllowedRealRoots(): string[] {
  const candidates: string[] = [getLionClawHome()];
  try {
    for (const project of listHarnessProjects()) {
      if (project.projectPath) candidates.push(project.projectPath);
    }
  } catch (err) {
    logger.warn(
      { error: (err as Error).message },
      'preview_open: falha ao listar project_paths; seguindo so com o home do LionClaw',
    );
  }
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      roots.push(fs.realpathSync(candidate));
    } catch {
    }
  }
  return roots;
}

function isUnderRoot(realTarget: string, realRoot: string): boolean {
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

export function isPreviewRequestAllowed(rawUrl: string, canonicalTarget: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
  if (url.protocol === 'about:') return url.href === 'about:blank';
  if (url.protocol !== 'file:') return false;
  try {
    const requested = fs.realpathSync(fileURLToPath(url));
    const assetRoot = fs.realpathSync(path.dirname(canonicalTarget));
    if (requested === canonicalTarget) return true;
    return isUnderRoot(requested, assetRoot) &&
      ALLOWED_CAPTURE_ASSET_EXTENSIONS.has(path.extname(requested).toLowerCase());
  } catch {
    return false;
  }
}

function isPreviewMainNavigationAllowed(rawUrl: string, canonicalTarget: string): boolean {
  try {
    return new URL(rawUrl).protocol === 'file:' &&
      fs.realpathSync(fileURLToPath(rawUrl)) === canonicalTarget;
  } catch {
    return false;
  }
}

async function openLocalUrl(raw: string): Promise<PreviewOpenResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`preview_open: url invalida "${raw}".`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail(`preview_open: protocolo nao permitido "${url.protocol}". Apenas http(s).`);
  }
  if (!ALLOWED_URL_HOSTS.has(url.hostname)) {
    return fail(
      `preview_open: host nao permitido "${url.hostname}". Apenas http(s)://localhost ou http(s)://127.0.0.1 (com porta opcional).`,
    );
  }
  try {
    await shell.openExternal(url.toString());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ url: url.toString(), error: msg }, 'preview_open: openExternal falhou');
    return fail(`preview_open: falha ao abrir a url "${url.toString()}": ${msg}`);
  }
  logger.info({ url: url.toString() }, 'preview_open: url local aberta no browser');
  return { ok: true, value: { opened: true, kind: 'url', target: url.toString() } };
}

async function openLocalHtmlFile(raw: string): Promise<PreviewOpenResult> {
  const validated = validateLocalHtmlFile(raw);
  if (!validated.ok) return validated.result;
  const realTarget = validated.target;

  let openError = '';
  try {
    openError = await shell.openPath(realTarget);
  } catch (err) {
    openError = err instanceof Error ? err.message : String(err);
  }
  if (openError) {
    logger.error({ target: realTarget, error: openError }, 'preview_open: openPath falhou');
    return fail(`preview_open: falha ao abrir "${realTarget}": ${openError}`);
  }
  logger.info({ target: realTarget }, 'preview_open: arquivo HTML aberto no browser');
  return { ok: true, value: { opened: true, kind: 'file', target: realTarget } };
}

type LocalHtmlValidation =
  | { ok: true; target: string }
  | { ok: false; result: PreviewOpenResult };

function validateLocalHtmlFile(raw: string): LocalHtmlValidation {
  if (!path.isAbsolute(raw)) {
    return { ok: false, result: fail(`preview_open: o caminho deve ser absoluto (recebido "${raw}").`) };
  }
  if (!fs.existsSync(raw)) {
    return { ok: false, result: fail(`preview_open: arquivo nao encontrado: ${raw}`) };
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, result: fail(`preview_open: nao foi possivel resolver o caminho "${raw}": ${msg}`) };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realTarget);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, result: fail(`preview_open: nao foi possivel ler "${realTarget}": ${msg}`) };
  }
  if (!stat.isFile()) {
    return { ok: false, result: fail(`preview_open: "${realTarget}" nao e um arquivo.`) };
  }

  const ext = path.extname(realTarget).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      result: fail(`preview_open: apenas arquivos .html/.htm podem ser abertos (recebido "${ext || 'sem extensao'}").`),
    };
  }

  const realRoots = resolveAllowedRealRoots();
  const allowed = realRoots.some((root) => isUnderRoot(realTarget, root));
  if (!allowed) {
    return {
      ok: false,
      result: fail('preview_open: caminho fora das raizes permitidas (project paths dos pipelines e a pasta de dados do LionClaw).'),
    };
  }
  return { ok: true, target: realTarget };
}

export async function previewCaptureCore(
  target: string,
  options: { width?: number; height?: number } = {},
): Promise<PreviewOpenResult> {
  const validated = validateLocalHtmlFile(target.trim());
  if (!validated.ok) return validated.result;

  const width = Math.max(320, Math.min(3840, Math.round(options.width ?? 1440)));
  const requestedHeight = options.height === undefined
    ? null
    : Math.max(320, Math.min(4096, Math.round(options.height)));
  const isolatedSession = session.fromPartition(`lionclaw-preview-${crypto.randomUUID()}`, {
    cache: false,
  });
  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isPreviewRequestAllowed(details.url, validated.target) });
  });
  isolatedSession.setPermissionCheckHandler(() => false);
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  isolatedSession.on('will-download', (event) => event.preventDefault());

  const win = new BrowserWindow({
    show: false,
    width,
    height: requestedHeight ?? 900,
    webPreferences: {
      session: isolatedSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('will-navigate', (event, url) => {
    if (!isPreviewMainNavigationAllowed(url, validated.target)) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isPreviewMainNavigationAllowed(url, validated.target)) event.preventDefault();
  });
  const timeoutMs = 20_000;
  try {
    await Promise.race([
      win.loadFile(validated.target),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout de ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const documentHeight = requestedHeight ?? await win.webContents.executeJavaScript(
      'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, 900)',
      true,
    ) as number;
    const height = Math.max(320, Math.min(4096, Math.ceil(documentHeight)));
    win.setContentSize(width, height);
    const image = await win.webContents.capturePage();
    const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const outputPath = path.join(
      path.dirname(validated.target),
      `${path.basename(validated.target, path.extname(validated.target))}.preview-${suffix}.png`,
    );
    const tempPath = `${outputPath}.tmp-${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(tempPath, image.toPNG(), { mode: 0o600, flag: 'wx' });
      fs.linkSync(tempPath, outputPath);
      fs.unlinkSync(tempPath);
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch { /* temp pode não ter sido criado */ }
      throw error;
    }
    logger.info({ target: validated.target, outputPath, width, height }, 'preview_capture concluido');
    return { ok: true, value: { captured: true, target: validated.target, outputPath, width, height } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ target: validated.target, error: message }, 'preview_capture falhou');
    return fail(`preview_capture: falha ao renderizar "${validated.target}": ${message}`);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

export async function previewOpenCore(target: string): Promise<PreviewOpenResult> {
  if (typeof target !== 'string' || !target.trim()) {
    return fail(
      'preview_open: target obrigatorio (caminho absoluto de um arquivo .html/.htm ou url http(s) de localhost).',
    );
  }
  const trimmed = target.trim();
  if (isHttpUrl(trimmed)) {
    return openLocalUrl(trimmed);
  }
  return openLocalHtmlFile(trimmed);
}

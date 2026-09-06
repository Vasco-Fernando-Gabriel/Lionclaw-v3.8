
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../../logger';
import { tryResolveInternalNodeBinary } from '../../distribution-runtime';

const logger = createLogger('cursor-sidecar-node');

export const CURSOR_SIDECAR_MIN_NODE_VERSION = '22.13.0';

export interface ParsedNodeVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface CursorSidecarNodeResolution {
  nodePath: string;
  version: string;
  source: 'internal' | 'payload' | 'system';
}

export interface CursorSidecarNodeStatus {
  ok: boolean;
  nodePath?: string;
  version?: string;
  source?: 'internal' | 'payload' | 'system';
  error?: string;
}

export function parseNodeVersion(raw: string): ParsedNodeVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

export function isNodeVersionSufficient(
  version: ParsedNodeVersion,
  minimum: string = CURSOR_SIDECAR_MIN_NODE_VERSION,
): boolean {
  const min = parseNodeVersion(minimum);
  if (!min) return false;
  if (version.major !== min.major) return version.major > min.major;
  if (version.minor !== min.minor) return version.minor > min.minor;
  return version.patch >= min.patch;
}

type ExecFileProbe = (nodePath: string) => Promise<string>;

function defaultProbe(nodePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      nodePath,
      ['--version'],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

export interface ResolveCursorSidecarNodeOptions {
  probe?: ExecFileProbe;
  tryInternal?: () => string | null;
  tryPayload?: () => string | null;
  packaged?: boolean;
  env?: NodeJS.ProcessEnv;
}

function tryInternalNodeDefault(): string | null {
  try {
    return tryResolveInternalNodeBinary().path;
  } catch (err) {
    logger.warn({ err }, 'Node interno da distribution indisponivel para o sidecar Cursor');
    return null;
  }
}

function isElectronPackagedDefault(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { app?: { isPackaged?: boolean } };
    return electron?.app?.isPackaged === true;
  } catch {
    return false;
  }
}


interface CursorNodePayloadManifestFile {
  path?: string;
  sha256?: string;
  size?: number;
}

interface CursorNodePayloadManifest {
  component?: string;
  target?: string;
  version?: string;
  files?: CursorNodePayloadManifestFile[];
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function resolveCursorPayloadNodeAt(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const binaryName = platform === 'win32' ? 'node.exe' : 'node';
  const binaryPath = path.join(dir, binaryName);
  const manifestPath = path.join(dir, 'node-manifest.json');
  const binaryExists = fs.existsSync(binaryPath);
  const manifestExists = fs.existsSync(manifestPath);
  if (!binaryExists && !manifestExists) return null;
  if (!binaryExists || !manifestExists) {
    throw new Error(
      `Payload Node do sidecar Cursor incompleto em ${dir}: ` +
        `${binaryExists ? 'manifesto' : 'binario'} ausente. Refaca o payload com ` +
        'node scripts/prepare-cursor-node-runtime.js',
    );
  }
  let manifest: CursorNodePayloadManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CursorNodePayloadManifest;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Manifesto do payload Node do sidecar Cursor ilegivel (${manifestPath}): ${detail}`);
  }
  const entry = manifest.files?.find((file) => file.path === binaryName);
  if (manifest.component !== 'cursor-sidecar-node' || !entry?.sha256) {
    throw new Error(
      `Manifesto do payload Node do sidecar Cursor invalido (${manifestPath}): ` +
        `component=${String(manifest.component)}, entrada de ${binaryName} ausente`,
    );
  }
  const stat = fs.statSync(binaryPath);
  if (entry.size !== undefined && entry.size !== stat.size) {
    throw new Error(`Payload Node do sidecar Cursor com tamanho divergente: ${binaryPath}`);
  }
  if (sha256File(binaryPath) !== entry.sha256) {
    throw new Error(`Payload Node do sidecar Cursor com hash divergente: ${binaryPath}`);
  }
  return binaryPath;
}

function tryPayloadNodeDefault(packaged: boolean): string | null {
  if (!packaged) return null;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return null;
  const target = `${process.platform}-${process.arch}`;
  return resolveCursorPayloadNodeAt(path.join(resourcesPath, 'cursor-sidecar', 'node', target));
}

async function probeVersion(
  nodePath: string,
  probe: ExecFileProbe,
): Promise<ParsedNodeVersion & { raw: string }> {
  const raw = (await probe(nodePath)).trim();
  const parsed = parseNodeVersion(raw);
  if (!parsed) {
    throw new Error(`saida inesperada de "${nodePath} --version": ${raw || '(vazia)'}`);
  }
  return { ...parsed, raw };
}

let cachedResolution: CursorSidecarNodeResolution | null = null;

export async function resolveCursorSidecarNode(
  options: ResolveCursorSidecarNodeOptions = {},
): Promise<CursorSidecarNodeResolution> {
  const injected =
    options.probe !== undefined ||
    options.tryInternal !== undefined ||
    options.tryPayload !== undefined ||
    options.packaged !== undefined ||
    options.env !== undefined;
  if (cachedResolution && !injected) return cachedResolution;

  const probe = options.probe ?? defaultProbe;
  const tryInternal = options.tryInternal ?? tryInternalNodeDefault;
  const packaged = options.packaged ?? isElectronPackagedDefault();
  const tryPayload = options.tryPayload ?? ((): string | null => tryPayloadNodeDefault(packaged));
  const env = options.env ?? process.env;

  const internalPath = tryInternal();
  if (internalPath) {
    const version = await probeVersion(internalPath, probe);
    if (!isNodeVersionSufficient(version)) {
      throw new Error(
        `Node interno empacotado (${internalPath}) tem versao ${version.raw}, abaixo do minimo ` +
          `${CURSOR_SIDECAR_MIN_NODE_VERSION} exigido pelo @cursor/sdk. O payload da distribution ` +
          'precisa embarcar Node >=22.13 para o runtime Cursor.',
      );
    }
    const resolution: CursorSidecarNodeResolution = {
      nodePath: internalPath,
      version: version.raw,
      source: 'internal',
    };
    if (!injected) cachedResolution = resolution;
    return resolution;
  }

  const payloadPath = tryPayload();
  if (payloadPath) {
    const version = await probeVersion(payloadPath, probe);
    if (!isNodeVersionSufficient(version)) {
      throw new Error(
        `Node do payload do sidecar Cursor (${payloadPath}) tem versao ${version.raw}, abaixo do ` +
          `minimo ${CURSOR_SIDECAR_MIN_NODE_VERSION} exigido pelo @cursor/sdk. Refaca o payload com ` +
          'node scripts/prepare-cursor-node-runtime.js',
      );
    }
    const resolution: CursorSidecarNodeResolution = {
      nodePath: payloadPath,
      version: version.raw,
      source: 'payload',
    };
    if (!injected) cachedResolution = resolution;
    return resolution;
  }

  if (packaged && env['LIONCLAW_CURSOR_SIDECAR_SYSTEM_NODE'] !== '1') {
    throw new Error(
      'Instalacao empacotada sem o payload Node do sidecar Cursor ' +
        '(resources/cursor-sidecar/node/<target>). O build de release deve produzi-lo ' +
        '(npm run prepare:cursor-payload antes do electron-builder). Usar o Node do sistema no ' +
        'empacotado e decisao explicita, nao default: defina LIONCLAW_CURSOR_SIDECAR_SYSTEM_NODE=1 ' +
        'para permitir (a versao minima 22.13 continua exigida).',
    );
  }

  const systemNode = process.platform === 'win32' ? 'node.exe' : 'node';
  let version: ParsedNodeVersion & { raw: string };
  try {
    version = await probeVersion(systemNode, probe);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      'Node.js nao encontrado no PATH. O runtime Cursor roda o @cursor/sdk num sidecar Node ' +
        `e exige Node >=${CURSOR_SIDECAR_MIN_NODE_VERSION} instalado no sistema (dev). ` +
        `Instale Node 22.13+ ou use a build empacotada com Node interno. Detalhe: ${detail}`,
    );
  }
  if (!isNodeVersionSufficient(version)) {
    throw new Error(
      `Node do sistema tem versao ${version.raw}, abaixo do minimo ` +
        `${CURSOR_SIDECAR_MIN_NODE_VERSION} exigido pelo @cursor/sdk para o runtime Cursor. ` +
        'Atualize o Node do sistema para 22.13 ou superior.',
    );
  }
  const resolution: CursorSidecarNodeResolution = {
    nodePath: systemNode,
    version: version.raw,
    source: 'system',
  };
  if (!injected) cachedResolution = resolution;
  return resolution;
}

let bootStatus: CursorSidecarNodeStatus | null = null;

export async function checkCursorSidecarNodeAtBoot(): Promise<CursorSidecarNodeStatus> {
  try {
    const resolution = await resolveCursorSidecarNode();
    bootStatus = { ok: true, ...resolution };
    logger.info(
      { nodePath: resolution.nodePath, version: resolution.version, source: resolution.source },
      'Node do sidecar Cursor validado no boot',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bootStatus = { ok: false, error: message };
    logger.error({ err }, `Sidecar Cursor indisponivel: ${message}`);
  }
  return bootStatus;
}

export function getCursorSidecarNodeStatus(): CursorSidecarNodeStatus | null {
  return bootStatus;
}


export interface ResolveCursorSidecarEntryOptions {
  candidates?: string[];
}

function defaultEntryCandidates(): string[] {
  const candidates: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  let packaged = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { app?: { isPackaged?: boolean; getAppPath?: () => string } };
    packaged = electron?.app?.isPackaged === true;
    if (packaged && resourcesPath) {
      candidates.push(path.join(resourcesPath, 'cursor-sidecar', 'sidecar.cjs'));
    }
    const appPath = electron?.app?.getAppPath?.();
    if (!packaged && appPath) {
      candidates.push(path.join(appPath, 'resources', 'cursor-sidecar', 'sidecar.cjs'));
    }
  } catch {
  }
  if (candidates.length === 0) {
    candidates.push(path.join(process.cwd(), 'resources', 'cursor-sidecar', 'sidecar.cjs'));
  }
  return candidates;
}

export function resolveCursorSidecarEntry(
  options: ResolveCursorSidecarEntryOptions = {},
): string {
  const candidates = options.candidates ?? defaultEntryCandidates();
  const found = candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new Error(
      'Bundle do sidecar Cursor nao encontrado. Rode "npm run build:cursor-sidecar" ' +
        `(gerado em resources/cursor-sidecar/sidecar.cjs). Candidatos: ${candidates.join(', ')}`,
    );
  }
  return found;
}

export function _resetCursorSidecarNodeForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error('_resetCursorSidecarNodeForTesting can only be called in test environment');
  }
  cachedResolution = null;
  bootStatus = null;
}

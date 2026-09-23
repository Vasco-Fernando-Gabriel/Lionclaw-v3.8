import { createRequire } from 'module';
import { spawn } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger';
import { getApiKey } from '../secrets-vault';
import { getSetting } from '../db';
import {
  resolveInternalNodeBinary,
  minimalInternalRuntimeEnv,
  resolvePackagedClaudeCliEntry,
  claudeAgentSdkEntryRelative,
  distributionRuntimeTarget,
  isPackagedDistributionRuntime,
} from '../distribution-runtime';
import type { Options as ClaudeSdkOptions, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

const logger = createLogger('sdk-bootstrap');

function isPackagedApp(): boolean {
  try {
    return isPackagedDistributionRuntime();
  } catch {
    return false;
  }
}

export const SDK_JS_ENTRY_EXTENSIONS = ['.js', '.mjs', '.tsx', '.ts', '.jsx'] as const;

export function isNativeClaudeEntry(entry: string): boolean {
  return !SDK_JS_ENTRY_EXTENSIONS.some((extension) => entry.endsWith(extension));
}

type ClaudeEntrySource = 'override' | 'staged' | 'node_modules' | 'asar-unpacked';

interface ResolvedClaudeEntry {
  entry: string;
  source: ClaudeEntrySource;
  packaged: boolean;
}

function nativeClaudeEntryRelatives(): string[] {
  const { platform, arch } = process;
  const binary = platform === 'win32' ? 'claude.exe' : 'claude';
  const manual = (suffix: string): string =>
    path.join('node_modules', '@anthropic-ai', `claude-agent-sdk-${platform}-${arch}${suffix}`, binary);
  let primary: string;
  try {
    primary = claudeAgentSdkEntryRelative(distributionRuntimeTarget(platform, arch));
  } catch {
    primary = manual('');
  }
  return platform === 'linux' ? [primary, manual('-musl')] : [primary];
}

function toAsarUnpacked(candidate: string): string {
  return path
    .normalize(candidate)
    .split(path.sep)
    .map((segment) => (segment === 'app.asar' ? 'app.asar.unpacked' : segment))
    .join(path.sep);
}

function nodeModulesRootFromSdkEntry(sdkEntry: string): string {
  let packageDir = path.dirname(sdkEntry);
  for (let depth = 0; depth < 4 && path.basename(packageDir) !== 'claude-agent-sdk'; depth++) {
    packageDir = path.dirname(packageDir);
  }
  return path.resolve(packageDir, '..', '..', '..');
}

function isExistingFile(candidate: string): boolean {
  if (!fs.existsSync(candidate)) return false;
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return true;
  }
}

function fallbackAppRoots(): string[] {
  const roots: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { app?: { getAppPath?: () => string } };
    const appPath = electron.app?.getAppPath?.();
    if (typeof appPath === 'string' && appPath.length > 0) roots.push(appPath);
  } catch {}
  roots.push(path.join(__dirname, '..', '..', '..'));
  return roots;
}

function resolveClaudeEntry(): ResolvedClaudeEntry {
  const attempted: string[] = [];
  const packaged = isPackagedApp();

  try {
    const custom = (getSetting('claude_cli_binary_path') || '').trim();
    if (custom) {
      if (isExistingFile(custom)) return { entry: custom, source: 'override', packaged };
      attempted.push(`${custom} (override claude_cli_binary_path)`);
      logger.warn(
        { custom },
        'claude_cli_binary_path configurado mas nao e um arquivo existente; usando resolucao automatica',
      );
    }
  } catch {}

  try {
    return { entry: resolvePackagedClaudeCliEntry(), source: 'staged', packaged };
  } catch (error) {
    attempted.push(`staged: ${error instanceof Error ? error.message : String(error)}`);
  }

  const relatives = nativeClaudeEntryRelatives();
  const roots: string[] = [];
  try {
    const req = createRequire(import.meta.url);
    roots.push(nodeModulesRootFromSdkEntry(req.resolve('@anthropic-ai/claude-agent-sdk')));
  } catch {}
  roots.push(...fallbackAppRoots());

  const seen = new Set<string>();
  for (const root of roots) {
    for (const relative of relatives) {
      const raw = path.join(root, relative);
      const candidate = packaged ? toAsarUnpacked(raw) : raw;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (fs.existsSync(candidate)) {
        return {
          entry: candidate,
          source: packaged && candidate !== raw ? 'asar-unpacked' : 'node_modules',
          packaged,
        };
      }
      attempted.push(candidate);
    }
  }

  throw new Error(`Claude Code engine nao encontrado; candidatos tentados: ${attempted.join(' | ')}`);
}

export function getClaudeCodeExecutablePath(): string {
  return resolveClaudeEntry().entry;
}

export type ClaudeSdkProcessOptions = Required<Pick<ClaudeSdkOptions, 'pathToClaudeCodeExecutable' | 'executable'>> &
  Pick<ClaudeSdkOptions, 'spawnClaudeCodeProcess'>;

export function getClaudeSdkProcessOptions(): ClaudeSdkProcessOptions {
  const { entry: cliEntry, source, packaged } = resolveClaudeEntry();
  const nativeEntry = isNativeClaudeEntry(cliEntry);
  logger.info({ cliEntry, source, nativeEntry, packaged }, 'claude engine: entry resolvido');

  if (nativeEntry) {
    return {
      pathToClaudeCodeExecutable: cliEntry,
      executable: 'node',
    };
  }

  let internalNode: string;
  try {
    internalNode = resolveInternalNodeBinary();
  } catch (error) {
    if (packaged) throw error;
    return {
      pathToClaudeCodeExecutable: cliEntry,
      executable: 'node',
    };
  }
  return {
    pathToClaudeCodeExecutable: cliEntry,
    executable: 'node',
    spawnClaudeCodeProcess: (options: SpawnOptions): SpawnedProcess =>
      spawn(internalNode, options.args, {
        cwd: options.cwd,
        env: minimalInternalRuntimeEnv(internalNode, options.env),
        signal: options.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }) as SpawnedProcess,
  };
}

let _nodePathFixed = false;
export function ensureNodeInPath(): void {
  if (_nodePathFixed) return;
  _nodePathFixed = true;

  let internalNode: string;
  try {
    internalNode = resolveInternalNodeBinary();
  } catch (error) {
    if (isPackagedApp()) throw error;
    logger.debug('Node interno ainda não preparado no ambiente de desenvolvimento');
    return;
  }

  const nodeDir = path.dirname(internalNode);
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (!entries.includes(nodeDir)) {
    process.env.PATH = [nodeDir, ...entries].join(path.delimiter);
  }
  logger.info({ nodePath: internalNode }, 'Node interno adicionado ao PATH dos subprocessos');
}

export async function ensureAuthForSDK(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) {
    logger.info('Auth: using ANTHROPIC_API_KEY from env');
    return;
  }

  const claudeDir = path.join(os.homedir(), '.claude');
  if (fs.existsSync(claudeDir)) {
    logger.info({ claudeDir }, 'Auth: found ~/.claude directory (OAuth likely available)');
    return;
  }

  try {
    const apiKey = await getApiKey();
    if (apiKey) {
      process.env.ANTHROPIC_API_KEY = apiKey;
      logger.info('Auth: injected ANTHROPIC_API_KEY from Vault');
      return;
    }
  } catch {}

  logger.warn(
    'Auth: no ANTHROPIC_API_KEY and no ~/.claude found. CLI may fail to authenticate. Run "claude login" or configure API key in Vault.',
  );
}

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import which from 'which';
import { getSetting } from '../db';
import { KIMI_MODELS, type KimiEffort } from '../../../src/constants/kimi-models';

export type KimiAuthMode = 'subscription' | 'none';

export interface KimiAvailability {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  authMode: KimiAuthMode;
  managedProviderVerified: boolean;
  modelAvailable: boolean;
  usable: boolean;
  availableModels: string[];
  reason?: string;
}

export class KimiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KimiUnavailableError';
  }
}

export class KimiAuthError extends KimiUnavailableError {
  constructor(message = 'Kimi nao esta autenticado. Refaca o login da assinatura.') {
    super(message);
    this.name = 'KimiAuthError';
  }
}

export async function resolveKimiBinary(): Promise<string | null> {
  try {
    const settingPath = getSetting('kimi_binary_path');
    if (settingPath && fs.existsSync(settingPath)) {
      return settingPath;
    }
  } catch {}
  try {
    return await which('kimi');
  } catch {
    if (process.platform === 'win32') {
      const candidates: string[] = [];
      const appData = process.env['APPDATA'];
      const userProfile = process.env['USERPROFILE'] ?? os.homedir();
      if (appData) {
        candidates.push(
          path.join(appData, 'npm', 'kimi.cmd'),
          path.join(appData, 'npm', 'kimi.exe'),
          path.join(appData, 'npm', 'kimi'),
        );
      }
      candidates.push(
        path.join(userProfile, 'AppData', 'Roaming', 'npm', 'kimi.cmd'),
        path.join(userProfile, 'AppData', 'Roaming', 'npm', 'kimi.exe'),
        path.join(userProfile, 'AppData', 'Roaming', 'npm', 'kimi'),
      );
      for (const c of candidates) {
        if (fs.existsSync(c)) return c;
      }
    }
    return null;
  }
}

async function resolveKimiVersion(binary: string): Promise<string | null> {
  try {
    return await new Promise<string | null>((resolve) => {
      const useShellForVersion = process.platform === 'win32' && binary.toLowerCase().endsWith('.cmd');
      const proc = spawn(binary, ['--version'], {
        shell: useShellForVersion,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildKimiChildEnv({ home: resolveKimiHome() }),
      });

      let out = '';
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        resolve(null);
      }, 5000);

      proc.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });

      proc.on('close', () => {
        clearTimeout(timer);
        const trimmed = out.trim();
        resolve(trimmed || null);
      });

      proc.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  } catch {
    return null;
  }
}

export function resolveKimiHome(): string {
  return path.join(os.homedir(), '.kimi-code');
}

export function ensureKimiHome(): string {
  const home = resolveKimiHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

const KIMI_CHILD_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_RUNTIME_DIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);
const KIMI_PROXY_ENV_KEYS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']);

export interface BuildKimiChildEnvOptions {
  baseEnv?: NodeJS.ProcessEnv | Record<string, string>;
  overrides?: Record<string, string>;
  effort?: KimiEffort;
  allowProxy?: boolean;
  home?: string;
}

export function buildKimiChildEnv(options: BuildKimiChildEnvOptions = {}): Record<string, string> {
  const base = options.baseEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (KIMI_CHILD_ENV_KEYS.has(key) || (options.allowProxy === true && KIMI_PROXY_ENV_KEYS.has(key))) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    if (KIMI_CHILD_ENV_KEYS.has(key) || (options.allowProxy === true && KIMI_PROXY_ENV_KEYS.has(key))) {
      env[key] = value;
    }
  }
  delete env['KIMI_MODEL_THINKING_EFFORT'];
  env['KIMI_SHARE_DIR'] = options.home ?? ensureKimiHome();
  if (options.effort) env['KIMI_MODEL_THINKING_EFFORT'] = options.effort;
  return env;
}

export interface KimiManagedConfigStatus {
  authenticated: boolean;
  managedProviderVerified: boolean;
  availableModels: string[];
}

function sectionBody(content: string, header: string): string | null {
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === header);
  if (index < 0) return null;
  const body: string[] = [];
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('[')) break;
    body.push(line);
  }
  return body.join('\n');
}

function configuredManagedModel(content: string, slug: string): boolean {
  const body = sectionBody(content, `[models."${slug}"]`);
  return body !== null && /^\s*provider\s*=\s*"managed:kimi-code"\s*$/m.test(body);
}

function hasOfficialKimiCredentials(home: string): boolean {
  const credentialsPath = path.join(home, 'credentials', 'kimi-code.json');
  if (!fs.existsSync(credentialsPath)) return false;
  try {
    const value = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as Record<string, unknown>;
    return (
      (typeof value['access_token'] === 'string' && value['access_token'].length > 0) ||
      (typeof value['refresh_token'] === 'string' && value['refresh_token'].length > 0)
    );
  } catch {
    return false;
  }
}

export function inspectKimiManagedConfig(home: string = resolveKimiHome()): KimiManagedConfigStatus {
  const configPath = path.join(home, 'config.toml');
  let content = '';
  if (fs.existsSync(configPath)) {
    try {
      content = fs.readFileSync(configPath, 'utf8');
    } catch {
      content = '';
    }
  }
  const oauthBody = sectionBody(content, '[providers."managed:kimi-code".oauth]');
  const hasLegacyOauthReference =
    oauthBody !== null && /^\s*(?:key|access_token|refresh_token)\s*=\s*"[^"]+"\s*$/m.test(oauthBody);
  const authenticated = hasOfficialKimiCredentials(home) || hasLegacyOauthReference;
  const configuredModels = KIMI_MODELS.filter((model) => configuredManagedModel(content, model.slug)).map(
    (model) => model.slug,
  );

  const availableModels =
    authenticated && configuredModels.length === 0 ? KIMI_MODELS.map((model) => model.slug) : configuredModels;
  return {
    authenticated,
    managedProviderVerified: authenticated,
    availableModels,
  };
}

export function detectKimiLoginFromConfig(home: string = resolveKimiHome()): boolean {
  return inspectKimiManagedConfig(home).authenticated;
}

export async function isKimiAvailable(model?: string): Promise<KimiAvailability> {
  const binary = await resolveKimiBinary();
  const config = inspectKimiManagedConfig(resolveKimiHome());
  const modelAvailable = model ? config.availableModels.includes(model) : config.availableModels.length > 0;
  const authenticated = config.authenticated;

  if (!binary) {
    return {
      installed: false,
      version: null,
      authenticated,
      authMode: authenticated ? 'subscription' : 'none',
      managedProviderVerified: config.managedProviderVerified,
      modelAvailable,
      usable: false,
      availableModels: config.availableModels,
      reason: 'CLI Kimi nao encontrado.',
    };
  }

  const version = await resolveKimiVersion(binary);

  const usable = authenticated && config.managedProviderVerified && modelAvailable;
  return {
    installed: true,
    version,
    authenticated,
    authMode: authenticated ? 'subscription' : 'none',
    managedProviderVerified: config.managedProviderVerified,
    modelAvailable,
    usable,
    availableModels: config.availableModels,
    ...(!usable
      ? {
          reason: !authenticated
            ? 'OAuth Kimi ausente na sessao oficial do Kimi CLI.'
            : !config.managedProviderVerified
              ? 'Provider Kimi managed/oficial nao verificado.'
              : 'Modelo Kimi selecionado nao esta disponivel no provider managed.',
        }
      : {}),
  };
}

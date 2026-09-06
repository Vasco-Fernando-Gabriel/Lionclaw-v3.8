import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import which from 'which';
import { getSetting } from '../db';
import { getLionClawHome } from '../paths';
import {
  defaultGrokAcpTransportFactory,
  type GrokAcpTransportFactory,
} from '../grok-acp/acp-transport';
import {
  GrokAuthError,
  GrokBackendError,
  GrokCapabilityError,
  GrokIsolationError,
  GrokJsonRpcError,
  GrokProcessError,
  GrokToolPolicyError,
  GrokUnavailableError,
} from '../grok-acp/errors';
import {
  collectGrokProjectSources,
  inspectGrokWorkspace,
  type GrokManagedCatalogExtras,
  type GrokWorkspaceGrant,
} from '../grok-sdk/workspace';
import {
  buildGrokNativeToolPolicy,
  GROK_0_2_103_NATIVE_TOOL_IDS,
} from './grok-session-config';
import { GROK_DEFAULT_MODEL } from '../../../src/constants/grok-models';

export {
  GrokAuthError,
  GrokBackendError,
  GrokCapabilityError,
  GrokIsolationError,
  GrokJsonRpcError,
  GrokProcessError,
  GrokToolPolicyError,
  GrokUnavailableError,
};

export interface GrokAvailability {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  authMode: 'subscription' | 'none';
  subscriptionRouteVerified: boolean;
  backendVerified: boolean;
  isolationVerified: boolean;
  toolPolicyVerified: boolean;
  modelAvailable: boolean | null;
  usable: boolean;
  reason?: string;
}

const BUNDLED_DISABLED_SKILLS = ['check-work', 'code-review', 'create-skill', 'help', 'imagine'];

let managedCatalogExtras: GrokManagedCatalogExtras = {
  disabledSkills: [],
  disabledPlugins: [],
  ignoredSkillPaths: [],
};

export function getGrokManagedCatalogExtras(): GrokManagedCatalogExtras {
  return {
    disabledSkills: [...managedCatalogExtras.disabledSkills],
    disabledPlugins: [...managedCatalogExtras.disabledPlugins],
    ignoredSkillPaths: [...managedCatalogExtras.ignoredSkillPaths],
  };
}

export function registerGrokManagedCatalogExtras(
  extra: GrokManagedCatalogExtras,
): GrokManagedCatalogExtras {
  managedCatalogExtras = {
    disabledSkills: [...new Set([...managedCatalogExtras.disabledSkills, ...extra.disabledSkills])].sort(),
    disabledPlugins: [...new Set([...managedCatalogExtras.disabledPlugins, ...extra.disabledPlugins])].sort(),
    ignoredSkillPaths: [...new Set([...managedCatalogExtras.ignoredSkillPaths, ...extra.ignoredSkillPaths])].sort(),
  };
  return getGrokManagedCatalogExtras();
}

export function resetGrokManagedCatalogExtrasForTests(): void {
  managedCatalogExtras = { disabledSkills: [], disabledPlugins: [], ignoredSkillPaths: [] };
}

function staticSkillIgnoreRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(resolveGrokHome(), 'bundled', 'skills'),
    path.join(home, '.agents', 'skills'),
    path.join(home, '.agents', 'commands'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.claude', 'commands'),
    path.join(home, '.cursor'),
  ];
}

function buildManagedPolicy(extras: GrokManagedCatalogExtras): string {
  const skillNames = [
    ...BUNDLED_DISABLED_SKILLS,
    ...extras.disabledSkills.filter((name) => !BUNDLED_DISABLED_SKILLS.includes(name)),
  ];
  const ignorePaths = [...new Set([...staticSkillIgnoreRoots(), ...extras.ignoredSkillPaths])].sort();
  return [
    '[grok_com_config]',
    'disable_api_key_auth = true',
    '',
    '[cli]',
    'auto_update = false',
    'use_leader = false',
    '',
    '[subagents]',
    'enabled = false',
    '',
    '[skills]',
    `disabled = [${skillNames.map((name) => JSON.stringify(name)).join(', ')}]`,
    `ignore = [${ignorePaths.map((item) => JSON.stringify(item)).join(', ')}]`,
    '',
    ...(extras.disabledPlugins.length > 0 ? [
      '[plugins]',
      `disabled = [${extras.disabledPlugins.map((name) => JSON.stringify(name)).join(', ')}]`,
      '',
    ] : []),
    '[compat.cursor]',
    'skills = false',
    'rules = false',
    'agents = false',
    'mcps = false',
    'hooks = false',
    'sessions = false',
    '',
    '[compat.claude]',
    'skills = false',
    'rules = false',
    'agents = false',
    'mcps = false',
    'hooks = false',
    'sessions = false',
    '',
    '[compat.codex]',
    'sessions = false',
    '',
  ].join('\n');
}
const MANAGED_CONFIG = [
  '[cli]',
  'auto_update = false',
  'use_leader = false',
  '',
].join('\n');
const GROK_MINIMUM_ACP_VERSION = [0, 2, 103] as const;
const GROK_AVAILABILITY_REQUEST_TIMEOUT_MS = 15_000;
const LOCALE_ENV_KEYS = new Set(['LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE']);

function readSetting(key: string): string | undefined {
  try {
    return getSetting(key) || undefined;
  } catch {
    return undefined;
  }
}

export function resolveGrokHome(): string {
  return path.join(getLionClawHome(), 'runtime', 'grok-home');
}

export function ensureGrokHome(home = resolveGrokHome()): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const managedPolicyPath = path.join(home, 'managed_config.toml');
  const configPath = path.join(home, 'config.toml');
  const userRequirementsPath = path.join(home, 'requirements.toml');
  if (fs.existsSync(userRequirementsPath)) fs.rmSync(userRequirementsPath);
  fs.writeFileSync(managedPolicyPath, buildManagedPolicy(managedCatalogExtras), { mode: 0o600 });
  fs.writeFileSync(configPath, MANAGED_CONFIG, { mode: 0o600 });
  try {
    fs.chmodSync(managedPolicyPath, 0o600);
    fs.chmodSync(configPath, 0o600);
  } catch { /* Windows ACLs are validated separately. */ }
}

export function isGrokHomeIsolated(home = resolveGrokHome()): boolean {
  try {
    const managedPolicy = fs.readFileSync(path.join(home, 'managed_config.toml'), 'utf8');
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    return config === MANAGED_CONFIG
      && managedPolicy === buildManagedPolicy(managedCatalogExtras);
  } catch {
    return false;
  }
}

export function buildGrokChildEnv(
  home = resolveGrokHome(),
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = { GROK_HOME: home, HOME: home };
  const allowedExact = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
    : ['PATH', 'TMPDIR'];
  if (process.platform === 'win32') env['USERPROFILE'] = home;
  for (const key of allowedExact) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (LOCALE_ENV_KEYS.has(key)) env[key] = value;
  }
  if (readSetting('grok_forward_proxy') === 'true') {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) {
      const value = parent[key];
      if (value !== undefined) env[key] = value;
    }
  }
  return env;
}

export function assertGrokChildEnv(env: Readonly<Record<string, string>>): void {
  const allowed = new Set([
    'GROK_HOME',
    'HOME',
    'USERPROFILE',
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    ...LOCALE_ENV_KEYS,
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
  ]);
  for (const key of Object.keys(env)) {
    if (allowed.has(key)) continue;
    throw new GrokIsolationError(`Environment variable is not allowlisted for Grok: ${key}`);
  }
  if (env['GROK_HOME'] !== resolveGrokHome()) {
    throw new GrokIsolationError('GROK_HOME must point to the LionClaw-managed Grok home.');
  }
  if (env['HOME'] !== resolveGrokHome()) {
    throw new GrokIsolationError('HOME must point to the LionClaw-managed Grok home.');
  }
  if (process.platform === 'win32' && env['USERPROFILE'] !== resolveGrokHome()) {
    throw new GrokIsolationError('USERPROFILE must point to the LionClaw-managed Grok home.');
  }
}

export function assertGrokWorkspaceIsolation(cwd: string): void {
  collectGrokProjectSources(path.resolve(cwd));
}

export async function prepareGrokWorkspace(
  grant: GrokWorkspaceGrant,
  binary: string,
  env: Record<string, string>,
): Promise<void> {
  ensureGrokHome();
  await inspectGrokWorkspace(grant, binary, env, {
    currentExtras: getGrokManagedCatalogExtras,
    hardenManagedConfig: (discovered: GrokManagedCatalogExtras) => {
      const merged = registerGrokManagedCatalogExtras(discovered);
      ensureGrokHome();
      return merged;
    },
  });
}

export function grokBinaryFallbackCandidates(home = os.homedir()): string[] {
  return [
    path.join(home, '.grok', 'bin', 'grok'),
    path.join(home, '.local', 'bin', 'grok'),
    '/opt/homebrew/bin/grok',
    '/usr/local/bin/grok',
  ];
}

export async function resolveGrokBinary(): Promise<string | null> {
  const configured = readSetting('grok_binary_path');
  if (configured && fs.existsSync(configured)) return configured;
  try {
    return await which('grok');
  } catch {
    if (process.platform !== 'win32') {
      for (const candidate of grokBinaryFallbackCandidates()) {
        if (fs.existsSync(candidate)) return candidate;
      }
      return null;
    }
    const roots = [
      process.env['APPDATA'] ? path.join(process.env['APPDATA'], 'npm') : null,
      path.join(process.env['USERPROFILE'] ?? os.homedir(), 'AppData', 'Roaming', 'npm'),
    ].filter((value): value is string => value !== null);
    for (const root of roots) {
      for (const name of ['grok.cmd', 'grok.exe', 'grok']) {
        const candidate = path.join(root, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return null;
  }
}

export async function resolveGrokVersion(binary: string): Promise<string | null> {
  const probe = async (args: string[]): Promise<string | null> => new Promise((resolve) => {
    const proc = spawn(binary, args, {
      env: buildGrokChildEnv(),
      shell: process.platform === 'win32' && binary.toLowerCase().endsWith('.cmd'),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* best effort */ }
      finish(null);
    }, 5_000);
    timer.unref?.();
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    proc.once('error', () => finish(null));
    proc.once('close', (code) => finish(code === 0 ? stdout.trim() || null : null));
  });
  return (await probe(['--version'])) ?? probe(['version']);
}

function parseVersion(value: string | null): [number, number, number] | null {
  if (!value) return null;
  const match = value.match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isSupportedGrokVersion(version: string | null): boolean {
  const parsed = parseVersion(version);
  if (parsed === null) return false;
  for (let index = 0; index < GROK_MINIMUM_ACP_VERSION.length; index += 1) {
    const actual = parsed[index] ?? 0;
    const minimum = GROK_MINIMUM_ACP_VERSION[index] ?? 0;
    if (actual > minimum) return true;
    if (actual < minimum) return false;
  }
  return true;
}

export function getGrokToolPolicyAttestation(): {
  verified: boolean;
  pending: readonly string[];
  reason?: string;
} {
  const pending: string[] = [];
  const catalogPolicy = buildGrokNativeToolPolicy(
    'agent-scoped',
    Object.keys(GROK_0_2_103_NATIVE_TOOL_IDS),
  );
  const expectedTools = new Set(Object.values(GROK_0_2_103_NATIVE_TOOL_IDS).flat());
  const actualTools = new Set(catalogPolicy.effectiveTools);
  if (
    expectedTools.size !== actualTools.size
    || [...expectedTools].some((tool) => !actualTools.has(tool))
  ) {
    pending.push('native-tool-catalog');
  }

  const oneShotPolicy = buildGrokNativeToolPolicy('one-shot', Object.keys(GROK_0_2_103_NATIVE_TOOL_IDS));
  if (
    oneShotPolicy.effectiveTools.length !== 0
    || oneShotPolicy.argv.join('\0') !== ['--tools', '', '--disable-web-search'].join('\0')
  ) {
    pending.push('one-shot-empty-catalog');
  }
  return {
    verified: pending.length === 0,
    pending,
    ...(pending.length > 0 ? {
      reason: `Politica local de tools Grok inconsistente: ${pending.join(', ')}`,
    } : {}),
  };
}

export function isGrokRuntimeUsable(input: {
  supportedVersion: boolean;
  subscriptionRouteVerified: boolean;
  toolPolicyVerified: boolean;
}): boolean {
  return input.supportedVersion
    && input.subscriptionRouteVerified
    && input.toolPolicyVerified;
}

export function isSuccessfulGrokAuthResponse(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;
  const auth = value as Record<string, unknown>;
  if (auth['authenticated'] === false) return false;
  const subscription = auth['subscription'];
  if (subscription === false) return false;
  if (subscription !== null && typeof subscription === 'object' && !Array.isArray(subscription)) {
    if ((subscription as Record<string, unknown>)['active'] === false) return false;
  }
  return true;
}

export function inspectGrokSessionModelAttestation(value: unknown): {
  model: string | null;
  conflicting: boolean;
} {
  const session = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const models = session['models'] !== null && typeof session['models'] === 'object'
    && !Array.isArray(session['models'])
    ? session['models'] as Record<string, unknown>
    : {};
  const meta = session['_meta'] !== null && typeof session['_meta'] === 'object'
    && !Array.isArray(session['_meta'])
    ? session['_meta'] as Record<string, unknown>
    : {};
  const config = meta['x.ai/sessionConfig'] !== null && typeof meta['x.ai/sessionConfig'] === 'object'
    && !Array.isArray(meta['x.ai/sessionConfig'])
    ? meta['x.ai/sessionConfig'] as Record<string, unknown>
    : {};
  const values = [
    session['modelId'],
    session['model'],
    models['currentModelId'],
    models['currentModel'],
    models['modelId'],
    config['modelId'],
    config['model'],
  ].filter((candidate): candidate is string => typeof candidate === 'string');
  if (values.length === 0) return { model: null, conflicting: false };
  return {
    model: values[0]!,
    conflicting: values.some((candidate) => candidate !== values[0]),
  };
}

function baseAgentArgs(sandboxProfile?: string): string[] {
  return [
    '--no-auto-update',
    '--no-subagents',
    '--no-memory',
    ...(sandboxProfile ? ['--sandbox', sandboxProfile] : []),
    'agent',
    '--no-leader',
    '--model',
    GROK_DEFAULT_MODEL,
    '--effort',
    'high',
    'stdio',
  ];
}

export async function probeGrokSubscription(
  binary: string,
  factory: GrokAcpTransportFactory = defaultGrokAcpTransportFactory,
  sandboxProfile?: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{
  authenticated: boolean;
  cachedTokenAdvertised: boolean;
  modelAvailable: boolean;
}> {
  ensureGrokHome();
  const transport = await factory({
    binary,
    args: baseAgentArgs(sandboxProfile),
    cwd: resolveGrokHome(),
    env: buildGrokChildEnv(),
  });
  const requestOptions = {
    timeoutMs: options.timeoutMs ?? GROK_AVAILABILITY_REQUEST_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  let cachedTokenAdvertised = false;
  try {
    const initialized = await transport.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    }, requestOptions) as Record<string, unknown>;
    const methods = Array.isArray(initialized?.['authMethods'])
      ? initialized['authMethods'] as Array<Record<string, unknown>>
      : [];
    cachedTokenAdvertised = methods.some((method) => method['id'] === 'cached_token');
    if (!cachedTokenAdvertised) {
      return {
        authenticated: false,
        cachedTokenAdvertised: false,
        modelAvailable: false,
      };
    }
    const auth = await transport.request('authenticate', {
      methodId: 'cached_token',
      _meta: { headless: true },
    }, requestOptions) as Record<string, unknown>;
    if (!isSuccessfulGrokAuthResponse(auth)) {
      return {
        authenticated: false,
        cachedTokenAdvertised: true,
        modelAvailable: false,
      };
    }
    let session: Record<string, unknown>;
    try {
      session = await transport.request('session/new', {
        cwd: resolveGrokHome(),
        mcpServers: [],
      }, requestOptions) as Record<string, unknown>;
    } catch {
      return {
        authenticated: true,
        cachedTokenAdvertised: true,
        modelAvailable: false,
      };
    }
    const modelAttestation = inspectGrokSessionModelAttestation(session);
    return {
      authenticated: true,
      cachedTokenAdvertised: true,
      modelAvailable: !modelAttestation.conflicting && modelAttestation.model === GROK_DEFAULT_MODEL,
    };
  } catch {
    return {
      authenticated: false,
      cachedTokenAdvertised,
      modelAvailable: false,
    };
  } finally {
    transport.kill('availability-probe-complete');
    await transport.waitClosed(2_000);
  }
}

export async function isGrokAvailable(): Promise<GrokAvailability> {
  const binary = await resolveGrokBinary();
  if (!binary) {
    return {
      installed: false,
      version: null,
      authenticated: false,
      authMode: 'none',
      subscriptionRouteVerified: false,
      backendVerified: false,
      isolationVerified: false,
      toolPolicyVerified: false,
      modelAvailable: null,
      usable: false,
      reason: 'grok binary not found',
    };
  }
  ensureGrokHome();
  const managedPolicyPrepared = isGrokHomeIsolated();
  const versionPromise = resolveGrokVersion(binary);
  let probe: Awaited<ReturnType<typeof probeGrokSubscription>> = {
    authenticated: false,
    cachedTokenAdvertised: false,
    modelAvailable: false,
  };
  probe = await probeGrokSubscription(binary);
  const version = await versionPromise;
  const isolationVerified = managedPolicyPrepared;
  const supported = isSupportedGrokVersion(version);
  const toolPolicyAttestation = getGrokToolPolicyAttestation();
  const subscriptionRouteVerified = probe.authenticated && probe.modelAvailable;
  const usable = isGrokRuntimeUsable({
    supportedVersion: supported,
    subscriptionRouteVerified,
    toolPolicyVerified: toolPolicyAttestation.verified,
  });
  return {
    installed: true,
    version,
    authenticated: probe.authenticated,
    authMode: probe.authenticated ? 'subscription' : 'none',
    subscriptionRouteVerified,
    backendVerified: subscriptionRouteVerified,
    isolationVerified,
    toolPolicyVerified: toolPolicyAttestation.verified,
    modelAvailable: probe.modelAvailable,
    usable,
    ...(!usable ? {
      reason: !supported
        ? 'Grok Build 0.2.103 ou superior e necessario para o ACP do LionClaw'
        : !probe.authenticated
            ? 'cached_token authentication failed'
            : !probe.modelAvailable
                ? `${GROK_DEFAULT_MODEL} is not available in the authenticated subscription`
                : !isolationVerified
                  ? 'Ambiente gerenciado do Grok nao foi preparado'
                  : toolPolicyAttestation.reason ?? 'Politica local de tools Grok nao foi validada',
    } : {}),
  };
}

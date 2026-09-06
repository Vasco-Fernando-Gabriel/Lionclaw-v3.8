import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getLionClawHome } from '../paths';
import { validateRepoRootPath } from '../repo-graph/validate-root';
import { GrokIsolationError } from '../grok-acp/errors';

const execFileAsync = promisify(execFile);
const INSTRUCTION_NAMES = new Set([
  'Agents.md',
  'Claude.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENT.md',
  'AGENTS.md',
]);
const MAX_SCANNED_ENTRIES = 100_000;
const OPAQUE_PROJECT_DIRECTORIES = new Set([
  '.cache',
  '.gradle',
  '.next',
  '.nuxt',
  '.pnpm-store',
  '.svn',
  '.turbo',
  '.venv',
  '.yarn',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'graphify-out',
  'node_modules',
  'out',
  'target',
  'venv',
]);
const MANAGED_SANDBOX_HEADER = '# LionClaw-managed Grok sandbox profiles v1';
const GROK_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GROK_PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

export interface GrokManagedCatalogExtras {
  disabledSkills: string[];
  disabledPlugins: string[];
  ignoredSkillPaths: string[];
}

const EMPTY_CATALOG_EXTRAS: GrokManagedCatalogExtras = {
  disabledSkills: [],
  disabledPlugins: [],
  ignoredSkillPaths: [],
};

export interface GrokSandboxAttestation {
  eventsPath: string;
  offset: number;
  profile: string;
  workspace: string;
  deniedPaths: string[];
  kernelEventRequired: boolean;
}

let sandboxSpawnTail: Promise<void> = Promise.resolve();

export async function acquireGrokSandboxSpawnLock(): Promise<() => void> {
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const previous = sandboxSpawnTail;
  sandboxSpawnTail = previous.then(() => turn);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

export interface GrokProjectSource {
  path: string;
  sha256: string;
  content: string;
  initial: boolean;
}

export interface GrokWorkspaceGrant {
  processCwd: string;
  sessionCwd: string;
  readRoots: string[];
  writeRoots: string[];
  source: 'desktop-repository' | 'neutral';
  projectSources: GrokProjectSource[];
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePhysicalFile(left: string, right: string): boolean {
  try {
    const leftStat = fs.statSync(left);
    const rightStat = fs.statSync(right);
    return leftStat.ino !== 0
      && rightStat.ino !== 0
      && leftStat.dev === rightStat.dev
      && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function isRulesMarkdown(relative: string): boolean {
  const parts = relative.split(path.sep);
  if (!relative.toLowerCase().endsWith('.md')) return false;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (
      (parts[index] === '.grok' || parts[index] === '.claude' || parts[index] === '.cursor')
      && parts[index + 1] === 'rules'
    ) return true;
  }
  return false;
}

function isInstruction(relative: string): boolean {
  return INSTRUCTION_NAMES.has(path.basename(relative)) || isRulesMarkdown(relative);
}

function isInitialInstruction(relative: string): boolean {
  const parts = relative.split(path.sep);
  if (parts.length === 1 && INSTRUCTION_NAMES.has(parts[0])) return true;
  return parts.length === 3
    && (parts[0] === '.grok' || parts[0] === '.claude' || parts[0] === '.cursor')
    && parts[1] === 'rules'
    && parts[2].toLowerCase().endsWith('.md');
}

function isOpaqueProjectDirectory(relative: string, name: string): boolean {
  if (OPAQUE_PROJECT_DIRECTORIES.has(name)) return true;
  const normalized = relative.split(path.sep).join('/');
  return normalized === '.claude/worktrees' || normalized === '.lionclaw';
}

export function isForbiddenGrokWorkspaceExtension(relative: string): boolean {
  const normalized = relative.split(path.sep).join('/');
  const parts = normalized.split('/');
  const base = parts.at(-1) ?? '';
  if (base === '.mcp.json' || base === '.claude.json') return true;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const next = parts[index + 1] ?? '';
    if (part === '.grok') {
      if (
        next === 'config.toml'
        || next === 'mcp.json'
        || next === 'sandbox.toml'
        || next === 'lsp.json'
        || ['skills', 'plugins', 'agents', 'hooks', 'marketplaces'].includes(next)
      ) return true;
    }
    if (part === '.claude' || part === '.cursor') {
      if (
        next === 'settings.json'
        || next === 'settings.local.json'
        || next === 'mcp.json'
        || ['skills', 'plugins', 'agents', 'hooks', 'marketplaces'].includes(next)
      ) return true;
    }
  }
  return false;
}

function protectedNamespacePath(relative: string): boolean {
  return relative.split(path.sep).some((part) =>
    part === '.grok' || part === '.claude' || part === '.cursor');
}

export function collectGrokProjectSources(root: string): GrokProjectSource[] {
  const canonicalRoot = fs.realpathSync(root);
  const pending = [canonicalRoot];
  const sources: GrokProjectSource[] = [];
  let scanned = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(canonicalRoot, absolute);
      if (entry.isDirectory() && isOpaqueProjectDirectory(relative, entry.name)) continue;
      scanned += 1;
      if (scanned > MAX_SCANNED_ENTRIES) {
        throw new GrokIsolationError(`Repositorio excede o limite de ${MAX_SCANNED_ENTRIES} entradas relevantes do snapshot Grok.`);
      }
      if (entry.isSymbolicLink()) {
        if (isInstruction(relative) || protectedNamespacePath(relative) || isForbiddenGrokWorkspaceExtension(relative)) {
          throw new GrokIsolationError(`Fonte/configuracao Grok via symlink nao e permitida: ${relative}`);
        }
        continue;
      }
      const forbiddenExtension = isForbiddenGrokWorkspaceExtension(relative);
      if (forbiddenExtension && entry.isDirectory()) {
        throw new GrokIsolationError(`Configuracao extensivel de projeto nao permitida pelo Grok: ${relative}`);
      }
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile() || (!isInstruction(relative) && !forbiddenExtension)) continue;
      const canonical = fs.realpathSync(absolute);
      if (!inside(canonicalRoot, canonical)) {
        throw new GrokIsolationError(`Instrucao Grok escapou da raiz autorizada: ${relative}`);
      }
      const content = fs.readFileSync(canonical, 'utf8');
      sources.push({
        path: canonical,
        sha256: sha256(content),
        content,
        initial: !forbiddenExtension && isInitialInstruction(relative),
      });
    }
  }
  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

export function resolveGrokWorkspaceGrant(input: {
  lane: 'desktop' | 'telegram' | 'cron';
  repoRootSnapshot?: string;
}): GrokWorkspaceGrant {
  const neutral = path.join(getLionClawHome(), 'runtime', 'grok-workspace');
  fs.mkdirSync(neutral, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(neutral, 0o700); } catch { /* best effort on Windows */ }
  const neutralCwd = fs.realpathSync(neutral);

  if (input.lane !== 'desktop' || !input.repoRootSnapshot) {
    return {
      processCwd: neutralCwd,
      sessionCwd: neutralCwd,
      readRoots: [],
      writeRoots: [],
      source: 'neutral',
      projectSources: [],
    };
  }

  const validated = validateRepoRootPath(input.repoRootSnapshot);
  if ('error' in validated) {
    throw new GrokIsolationError(`Repositorio ativo invalido para o Grok: ${validated.error}`);
  }
  const projectCwd = validated.canonicalRootPath;
  return {
    processCwd: projectCwd,
    sessionCwd: projectCwd,
    readRoots: [projectCwd],
    writeRoots: [projectCwd],
    source: 'desktop-repository',
    projectSources: collectGrokProjectSources(projectCwd),
  };
}

function assertEmptyArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.length > 0) {
    throw new GrokIsolationError(`grok inspect encontrou configuracao nao permitida em ${field}.`);
  }
}

function assertNoActiveMcpServers(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new GrokIsolationError('grok inspect encontrou configuracao nao permitida em mcpServers.');
  }
  for (const raw of value) {
    const server = record(raw);
    const name = String(server['name'] ?? server['id'] ?? 'desconhecido');
    if (server['disabled'] !== true || server['compatibilityStatus'] !== 'disabled') {
      throw new GrokIsolationError(`grok inspect encontrou MCP ativo ou sem atestacao de bloqueio: ${name}.`);
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function assertNoCustomBackendConfig(inspected: Record<string, unknown>): void {
  const forbiddenKeys = new Set(['api_key', 'apiKey', 'base_url', 'baseUrl', 'auth_provider', 'authProvider']);
  const customCatalogs = new Set(['providers', 'customProviders', 'backends', 'customModels', 'modelOverrides']);
  const pending: unknown[] = [inspected];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (forbiddenKeys.has(key) && child !== undefined && child !== null && child !== '' && child !== false) {
        throw new GrokIsolationError(`grok inspect encontrou backend/auth custom em ${key}.`);
      }
      if (customCatalogs.has(key)) {
        const emptyArray = Array.isArray(child) && child.length === 0;
        const emptyObject = child !== null
          && typeof child === 'object'
          && !Array.isArray(child)
          && Object.keys(child as Record<string, unknown>).length === 0;
        if (!emptyArray && !emptyObject && child !== undefined && child !== null) {
          throw new GrokIsolationError(`grok inspect encontrou catalogo custom em ${key}.`);
        }
      }
      pending.push(child);
    }
  }
}

const DISABLED_BUNDLED_SKILLS = new Set([
  'check-work',
  'code-review',
  'create-skill',
  'help',
  'imagine',
]);
const BUILT_IN_AGENTS = new Set(['general-purpose', 'explore', 'plan']);

function assertManagedGrokInspect(
  inspected: Record<string, unknown>,
  grokHome: string,
  extras: GrokManagedCatalogExtras,
): void {
  const loginPolicy = record(inspected['loginPolicy']);
  if (loginPolicy['disableApiKeyAuth'] !== true || loginPolicy['apiKeyAuthDisabled'] !== true) {
    throw new GrokIsolationError('grok inspect nao confirmou API key auth desabilitada.');
  }

  const configSources = record(inspected['configSources']);
  const layers = Array.isArray(configSources['layers']) ? configSources['layers'] : [];
  const expectedLayers = [
    ['managed', path.join(grokHome, 'managed_config.toml')],
    ['user', path.join(grokHome, 'config.toml')],
  ];
  if (layers.length !== expectedLayers.length || layers.some((raw, index) => {
    const layer = record(raw);
    return layer['role'] !== expectedLayers[index]?.[0]
      || path.resolve(String(layer['path'] ?? '')) !== path.resolve(expectedLayers[index]?.[1] ?? '');
  })) {
    throw new GrokIsolationError('grok inspect carregou camadas de configuracao fora do home gerenciado.');
  }

  const externalCompat = record(inspected['externalCompat']);
  const cells = Array.isArray(externalCompat['cells']) ? externalCompat['cells'] : [];
  if (externalCompat['remoteSettingsLoaded'] !== false || cells.length === 0
    || cells.some((raw) => record(raw)['enabled'] !== false)) {
    throw new GrokIsolationError('grok inspect encontrou compatibilidade externa habilitada.');
  }

  const skills = Array.isArray(inspected['skills']) ? inspected['skills'] : [];
  const bundledNames = new Set<string>();
  const disabledSkillNames = new Set(extras.disabledSkills);
  for (const raw of skills) {
    const skill = record(raw);
    const name = String(skill['name'] ?? '');
    const source = record(skill['source']);
    if (source['type'] === 'bundled') {
      const sourcePath = path.resolve(String(source['path'] ?? ''));
      if ((!DISABLED_BUNDLED_SKILLS.has(name) && !disabledSkillNames.has(name))
        || skill['disabled'] !== true
        || !inside(path.resolve(grokHome), sourcePath)) {
        throw new GrokIsolationError(`grok inspect encontrou skill executavel ou externa: ${name || 'desconhecida'}.`);
      }
      bundledNames.add(name);
      continue;
    }
    if (skill['disabled'] !== true || !disabledSkillNames.has(name)) {
      throw new GrokIsolationError(`grok inspect encontrou skill executavel ou externa: ${name || 'desconhecida'}.`);
    }
  }
  void bundledNames;

  const agents = Array.isArray(inspected['agents']) ? inspected['agents'] : [];
  const agentNames = new Set<string>();
  for (const raw of agents) {
    const agent = record(raw);
    const name = String(agent['name'] ?? '');
    if (!BUILT_IN_AGENTS.has(name) || record(agent['source'])['type'] !== 'builtin') {
      throw new GrokIsolationError(`grok inspect encontrou subagente externo: ${name || 'desconhecido'}.`);
    }
    agentNames.add(name);
  }
  if (agentNames.size !== BUILT_IN_AGENTS.size
    || [...BUILT_IN_AGENTS].some((name) => !agentNames.has(name))) {
    throw new GrokIsolationError('grok inspect nao confirmou o catalogo builtin esperado de subagentes.');
  }
}

export function assertGrokInspect(
  grant: GrokWorkspaceGrant,
  inspected: Record<string, unknown>,
  grokHome: string,
  extras: GrokManagedCatalogExtras = EMPTY_CATALOG_EXTRAS,
): void {
  let inspectedCwd: string;
  try { inspectedCwd = fs.realpathSync(String(inspected['cwd'] ?? '')); } catch {
    throw new GrokIsolationError('grok inspect nao confirmou o CWD da sessao.');
  }
  if (inspectedCwd !== grant.sessionCwd) throw new GrokIsolationError('grok inspect usou CWD diferente do grant.');
  assertInstructionSet(grant, inspected['projectInstructions'], false);
  const disabledPlugins = new Set(extras.disabledPlugins);
  const plugins = inspected['plugins'];
  if (!Array.isArray(plugins)) throw new GrokIsolationError('grok inspect encontrou configuracao nao permitida em plugins.');
  for (const raw of plugins) {
    const name = String(record(raw)['name'] ?? '');
    if (!disabledPlugins.has(name)) {
      throw new GrokIsolationError(`grok inspect encontrou plugin fora da politica gerenciada: ${name || 'desconhecido'}.`);
    }
  }
  const hooks = inspected['hooks'];
  if (!Array.isArray(hooks)) throw new GrokIsolationError('grok inspect encontrou configuracao nao permitida em hooks.');
  for (const raw of hooks) {
    const source = record(record(raw)['source']);
    const pluginName = String(source['plugin_name'] ?? '');
    if (source['type'] !== 'plugin' || !disabledPlugins.has(pluginName)) {
      throw new GrokIsolationError('grok inspect encontrou hook fora de plugin desabilitado.');
    }
  }
  for (const field of ['marketplaces', 'lspServers']) {
    assertEmptyArray(inspected[field], field);
  }
  assertNoActiveMcpServers(inspected['mcpServers']);
  const permissions = record(inspected['permissions']);
  assertEmptyArray(permissions['sources'], 'permissions.sources');
  assertEmptyArray(permissions['mcpServerAllowlist'], 'permissions.mcpServerAllowlist');
  assertEmptyArray(permissions['marketplaceAllowlist'], 'permissions.marketplaceAllowlist');
  assertNoCustomBackendConfig(inspected);
  assertManagedGrokInspect(inspected, grokHome, extras);
}

function isNativeInitialInstruction(grant: GrokWorkspaceGrant, canonical: string): boolean {
  const parts = path.relative(grant.sessionCwd, canonical).split(path.sep);
  if (parts.length === 1 && INSTRUCTION_NAMES.has(parts[0]!)) return true;
  return parts.length === 3
    && parts[0] === '.grok'
    && parts[1] === 'rules'
    && parts[2]!.toLowerCase().endsWith('.md');
}

function assertInstructionSet(
  grant: GrokWorkspaceGrant,
  rows: unknown,
  withContent: boolean,
  requireComplete = true,
): void {
  if (!Array.isArray(rows)) throw new GrokIsolationError('Grok nao reportou project instructions de forma atestavel.');
  const expected = new Map(
    grant.projectSources
      .filter((source) => source.initial && isNativeInitialInstruction(grant, source.path))
      .map((source) => [source.path, source]),
  );
  const actual = new Set<string>();
  for (const raw of rows) {
    const row = record(raw);
    if (!withContent && row['disabled'] === true) continue;
    const candidate = row['file_path'] ?? row['path'];
    if (typeof candidate !== 'string') throw new GrokIsolationError('Grok reportou instruction sem path.');
    let canonical: string;
    try { canonical = fs.realpathSync(candidate); } catch { throw new GrokIsolationError('Grok reportou instruction inexistente.'); }
    const source = expected.get(canonical) ?? (
      inside(grant.sessionCwd, canonical)
        ? [...expected.values()].find((item) => samePhysicalFile(item.path, canonical))
        : undefined
    );
    if (!source) throw new GrokIsolationError(`Grok carregou instruction inesperada: ${path.basename(canonical)}`);
    if (withContent) {
      const content = row['content'];
      if (typeof content !== 'string' || sha256(content) !== source.sha256) {
        throw new GrokIsolationError(`Conteudo atestado divergiu para ${path.basename(canonical)}.`);
      }
    }
    actual.add(source.path);
  }
  if (
    requireComplete
    && (actual.size !== expected.size || [...expected.keys()].some((item) => !actual.has(item)))
  ) {
    throw new GrokIsolationError('Grok nao atestou exatamente todas as instructions iniciais do snapshot.');
  }
}

export function collectGrokExternalCatalog(
  inspected: Record<string, unknown>,
): GrokManagedCatalogExtras {
  const disabledSkills = new Set<string>();
  const ignoredSkillPaths = new Set<string>();
  const skills = Array.isArray(inspected['skills']) ? inspected['skills'] : [];
  for (const raw of skills) {
    const skill = record(raw);
    if (skill['disabled'] === true) continue;
    const name = String(skill['name'] ?? '');
    if (!GROK_SKILL_NAME_PATTERN.test(name)) {
      throw new GrokIsolationError(`Skill externa com nome fora do formato atestavel: ${name || '(vazio)'}.`);
    }
    disabledSkills.add(name);
    const sourcePath = String(record(skill['source'])['path'] ?? '');
    if (sourcePath.length > 0) {
      const directory = path.dirname(path.resolve(sourcePath));
      if (/[\r\n"\u0000-\u001f]/.test(directory)) {
        throw new GrokIsolationError(`Skill externa com path fora do formato atestavel: ${name}.`);
      }
      ignoredSkillPaths.add(directory);
    }
  }
  const disabledPlugins = new Set<string>();
  const plugins = Array.isArray(inspected['plugins']) ? inspected['plugins'] : [];
  for (const raw of plugins) {
    const name = String(record(raw)['name'] ?? '');
    if (!GROK_PLUGIN_NAME_PATTERN.test(name)) {
      throw new GrokIsolationError(`Plugin com nome fora do formato atestavel: ${name || '(vazio)'}.`);
    }
    disabledPlugins.add(name);
  }
  return {
    disabledSkills: [...disabledSkills].sort(),
    disabledPlugins: [...disabledPlugins].sort(),
    ignoredSkillPaths: [...ignoredSkillPaths].sort(),
  };
}

function catalogMissing(
  discovered: GrokManagedCatalogExtras,
  allowed: GrokManagedCatalogExtras,
): GrokManagedCatalogExtras | null {
  const skills = new Set(allowed.disabledSkills);
  const plugins = new Set(allowed.disabledPlugins);
  const ignored = new Set(allowed.ignoredSkillPaths);
  const missing: GrokManagedCatalogExtras = {
    disabledSkills: discovered.disabledSkills.filter((name) => !skills.has(name)),
    disabledPlugins: discovered.disabledPlugins.filter((name) => !plugins.has(name)),
    ignoredSkillPaths: discovered.ignoredSkillPaths.filter((item) => !ignored.has(item)),
  };
  return missing.disabledSkills.length > 0
    || missing.disabledPlugins.length > 0
    || missing.ignoredSkillPaths.length > 0
    ? missing
    : null;
}

export interface GrokWorkspaceIsolationHooks {
  currentExtras: () => GrokManagedCatalogExtras;
  hardenManagedConfig: (discovered: GrokManagedCatalogExtras) => GrokManagedCatalogExtras;
}

async function runGrokInspect(
  grant: GrokWorkspaceGrant,
  binary: string,
  env: Record<string, string>,
): Promise<Record<string, unknown>> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(binary, ['inspect', '--json'], {
      cwd: grant.sessionCwd,
      env,
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    throw new GrokIsolationError('Falha no grok inspect do workspace final.', { cause: error });
  }
  try { return record(JSON.parse(stdout)); } catch (error) {
    throw new GrokIsolationError('grok inspect nao retornou JSON valido.', { cause: error });
  }
}

export async function inspectGrokWorkspace(
  grant: GrokWorkspaceGrant,
  binary: string,
  env: Record<string, string>,
  isolation?: GrokWorkspaceIsolationHooks,
): Promise<void> {
  const grokHome = env['GROK_HOME'];
  if (!grokHome) throw new GrokIsolationError('grok inspect foi executado sem GROK_HOME gerenciado.');
  let inspected = await runGrokInspect(grant, binary, env);
  let allowed = isolation ? isolation.currentExtras() : EMPTY_CATALOG_EXTRAS;
  const missing = catalogMissing(collectGrokExternalCatalog(inspected), allowed);
  if (missing) {
    if (!isolation) {
      throw new GrokIsolationError('grok inspect encontrou catalogo externo sem canal de hardening gerenciado.');
    }
    allowed = isolation.hardenManagedConfig(missing);
    inspected = await runGrokInspect(grant, binary, env);
    const remaining = catalogMissing(collectGrokExternalCatalog(inspected), allowed);
    if (remaining) {
      throw new GrokIsolationError(
        `Grok manteve catalogo externo apos hardening gerenciado: ${[...remaining.disabledSkills, ...remaining.disabledPlugins].join(', ')}.`,
      );
    }
  }
  assertGrokInspect(grant, inspected, grokHome, allowed);
}

export function attestGrokSession(
  grant: GrokWorkspaceGrant,
  grokHome: string,
  sessionId: string,
): void {
  const cwdKey = encodeURIComponent(grant.sessionCwd);
  const contextPath = path.join(grokHome, 'sessions', cwdKey, sessionId, 'prompt_context.json');
  let context: Record<string, unknown>;
  try { context = record(JSON.parse(fs.readFileSync(contextPath, 'utf8'))); } catch (error) {
    throw new GrokIsolationError('Sessao Grok nao produziu prompt_context.json atestavel.', { cause: error });
  }
  let workingDirectory: string;
  try { workingDirectory = fs.realpathSync(String(context['working_directory'] ?? '')); } catch {
    throw new GrokIsolationError('prompt_context.json nao confirmou o workspace.');
  }
  if (workingDirectory !== grant.sessionCwd) throw new GrokIsolationError('prompt_context.json pertence a outro workspace.');
  if (context['memory_enabled'] !== false) throw new GrokIsolationError('Grok iniciou com memoria nativa habilitada.');
  assertInstructionSet(grant, context['agents_md_files'], true, false);
}

export function assertGrokWorkspaceUnchanged(grant: GrokWorkspaceGrant): void {
  const current = collectGrokProjectSources(grant.sessionCwd);
  if (current.length !== grant.projectSources.length) {
    throw new GrokIsolationError('Fontes de projeto Grok mudaram durante o turno.');
  }
  for (let index = 0; index < current.length; index += 1) {
    const before = grant.projectSources[index];
    const after = current[index];
    if (before.path !== after.path || before.sha256 !== after.sha256) {
      throw new GrokIsolationError(`Fonte de projeto Grok mudou durante o turno: ${path.basename(after.path)}`);
    }
  }
}

export function ensureGrokSandboxProfile(
  grant: GrokWorkspaceGrant,
  grokHome: string,
  baseOverride?: 'workspace' | 'read-only' | 'strict',
): string {
  const base = baseOverride ?? (grant.source === 'neutral' ? 'read-only' : 'workspace');
  const identity = sha256([
    base,
    grant.source,
    grant.processCwd,
    ...grant.projectSources.map((source) => `${source.path}:${source.sha256}`),
  ].join('\n')).slice(0, 16);
  const profile = `lionclaw_${identity}`;
  const sandboxPath = path.join(grokHome, 'sandbox.toml');
  const protectedPaths = grant.projectSources.map((source) => JSON.stringify(source.path)).join(', ');
  const content = [
    MANAGED_SANDBOX_HEADER,
    '',
    `[profiles.${profile}]`,
    `extends = ${JSON.stringify(base)}`,
    'restrict_network = true',
    `deny = [${protectedPaths}]`,
    '',
  ].join('\n');
  fs.writeFileSync(sandboxPath, content, { encoding: 'utf8', mode: 0o600 });
  return profile;
}

export function snapshotGrokSandboxAttestation(
  grokHome: string,
  profile: string,
  workspace: string,
  deniedPaths: readonly string[],
): GrokSandboxAttestation {
  const eventsPath = path.join(grokHome, 'sandbox-events.jsonl');
  let offset = 0;
  try { offset = fs.statSync(eventsPath).size; } catch { /* primeiro evento */ }
  return {
    eventsPath,
    offset,
    profile,
    workspace: path.resolve(workspace),
    deniedPaths: deniedPaths.map((item) => path.resolve(item)),
    kernelEventRequired: process.platform === 'linux',
  };
}

function sandboxApplied(attestation: GrokSandboxAttestation): boolean {
  let content: string;
  try {
    const fd = fs.openSync(attestation.eventsPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= attestation.offset) return false;
      const buffer = Buffer.alloc(size - attestation.offset);
      fs.readSync(fd, buffer, 0, buffer.length, attestation.offset);
      content = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  return content.split(/\r?\n/).some((line) => {
    if (!line.trim()) return false;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { return false; }
    if (event['event_type'] !== 'ProfileApplied'
      || event['profile'] !== attestation.profile
      || event['enforced'] !== true
      || event['restrict_network'] !== true
      || !String(event['platform'] ?? '').startsWith('linux/')) return false;
    if (path.resolve(String(event['workspace'] ?? '')) !== attestation.workspace) return false;
    const denied = Array.isArray(event['deny_paths'])
      ? new Set(event['deny_paths'].map((item) => path.resolve(String(item))))
      : new Set<string>();
    return attestation.deniedPaths.every((item) => denied.has(item));
  });
}

export async function waitForGrokSandboxApplied(
  attestation: GrokSandboxAttestation,
  timeoutMs = 2_000,
): Promise<void> {
  if (!attestation.kernelEventRequired) return;
  const deadline = Date.now() + timeoutMs;
  do {
    if (sandboxApplied(attestation)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new GrokIsolationError(
    `Grok nao comprovou aplicacao kernel-enforced do sandbox ${attestation.profile}.`,
  );
}

export function grokInputTouchesProtectedSource(
  grant: GrokWorkspaceGrant,
  value: unknown,
): boolean {
  const strings: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === 'string') strings.push(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') Object.values(item as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  const protectedPaths = new Set(grant.projectSources.map((source) => source.path));
  return strings.some((text) => {
    if ([...protectedPaths].some((source) => text.includes(source))) return true;
    return /(^|[\\/])(?:\.grok|\.claude|\.cursor)(?:[\\/]|$)|(?:^|[\\/])(?:AGENTS?|CLAUDE)(?:\.local)?\.md\b|\.mcp\.json\b/i.test(text);
  });
}

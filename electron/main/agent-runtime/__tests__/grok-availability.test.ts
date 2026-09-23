import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertGrokChildEnv,
  assertGrokWorkspaceIsolation,
  buildGrokChildEnv,
  ensureGrokHome,
  getGrokManagedCatalogExtras,
  getGrokToolPolicyAttestation,
  grokBinaryFallbackCandidates,
  isGrokHomeIsolated,
  isGrokRuntimeUsable,
  isSupportedGrokVersion,
  probeGrokSubscription,
  registerGrokManagedCatalogExtras,
  resetGrokManagedCatalogExtrasForTests,
  resolveGrokHome,
} from '../grok-availability';
import { FakeGrokAcpTransport, fakeGrokTransportFactory } from '../../grok-acp/__tests__/fake-acp-transport';

describe('Grok availability/isolation', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lion-grok-availability-'));
    process.env['LIONCLAW_TEST_HOME'] = home;
  });

  afterEach(() => {
    delete process.env['LIONCLAW_TEST_HOME'];
    resetGrokManagedCatalogExtrasForTests();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('semeia home gerenciado sem credencial e valida requisitos', () => {
    ensureGrokHome();
    expect(resolveGrokHome()).toBe(path.join(home, 'runtime', 'grok-home'));
    expect(isGrokHomeIsolated()).toBe(true);
    const managed = fs.readFileSync(path.join(resolveGrokHome(), 'managed_config.toml'), 'utf8');
    expect(managed).toContain('disable_api_key_auth = true');
    expect(managed).toMatch(/\[compat\.cursor\][\s\S]*skills = false[\s\S]*mcps = false/);
    expect(managed).toMatch(/\[compat\.claude\][\s\S]*skills = false[\s\S]*mcps = false/);
    expect(managed).toMatch(/\[skills\][\s\S]*disabled = \["check-work"/);

    fs.writeFileSync(path.join(resolveGrokHome(), 'managed_config.toml'), '[mcp]\nserver = "untrusted"\n');
    fs.writeFileSync(path.join(resolveGrokHome(), 'requirements.toml'), '[mcp]\nserver = "untrusted"\n');
    expect(isGrokHomeIsolated()).toBe(false);
    ensureGrokHome();
    expect(isGrokHomeIsolated()).toBe(true);
    expect(fs.existsSync(path.join(resolveGrokHome(), 'requirements.toml'))).toBe(false);
  });

  it('desliga catalogo externo por nome em toda escrita da managed config', () => {
    ensureGrokHome();
    const managedPath = path.join(resolveGrokHome(), 'managed_config.toml');
    expect(fs.readFileSync(managedPath, 'utf8')).not.toContain('[plugins]');

    const merged = registerGrokManagedCatalogExtras({
      disabledSkills: ['framer', 'graphify'],
      disabledPlugins: ['understand-anything'],
      ignoredSkillPaths: ['/h/.agents/skills/framer'],
    });
    expect(merged).toEqual({
      disabledSkills: ['framer', 'graphify'],
      disabledPlugins: ['understand-anything'],
      ignoredSkillPaths: ['/h/.agents/skills/framer'],
    });
    ensureGrokHome();
    const managed = fs.readFileSync(managedPath, 'utf8');
    expect(managed).toContain('"check-work", "code-review", "create-skill", "help", "imagine", "framer", "graphify"');
    expect(managed).toMatch(/\[plugins\][\s\S]*disabled = \["understand-anything"\]/);
    expect(isGrokHomeIsolated()).toBe(true);

    registerGrokManagedCatalogExtras({ disabledSkills: ['e2e-from-spec'], disabledPlugins: [], ignoredSkillPaths: [] });
    expect(getGrokManagedCatalogExtras().disabledSkills).toEqual(['e2e-from-spec', 'framer', 'graphify']);
    expect(isGrokHomeIsolated()).toBe(false);
    ensureGrokHome();
    expect(isGrokHomeIsolated()).toBe(true);

    resetGrokManagedCatalogExtrasForTests();
    ensureGrokHome();
    expect(fs.readFileSync(managedPath, 'utf8')).not.toContain('[plugins]');
  });

  it('constroi env por allowlist positiva sem canarios nem API keys', () => {
    const env = buildGrokChildEnv(resolveGrokHome(), {
      PATH: '/bin',
      LANG: 'pt_BR.UTF-8',
      XAI_API_KEY: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      GITHUB_TOKEN: 'secret',
      DATABASE_URL: 'secret',
      SECRET_CANARY: 'secret',
      LC_SECRET_CANARY: 'secret',
    });
    expect(env).toMatchObject({
      PATH: '/bin',
      LANG: 'pt_BR.UTF-8',
      GROK_HOME: resolveGrokHome(),
      HOME: resolveGrokHome(),
    });
    expect(env).not.toHaveProperty('XAI_API_KEY');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('SECRET_CANARY');
    expect(env).not.toHaveProperty('LC_SECRET_CANARY');
    expect(() => assertGrokChildEnv({ ...env, XAI_API_KEY: 'bad' })).toThrow(/not allowlisted/);
    expect(() => assertGrokChildEnv({ ...env, HOME: os.homedir() })).toThrow(/managed Grok home/);
  });

  it('protege arquivos de config e bloqueia diretorios extensiveis do projeto', () => {
    const clean = path.join(home, 'clean');
    fs.mkdirSync(clean);
    expect(() => assertGrokWorkspaceIsolation(clean)).not.toThrow();
    fs.mkdirSync(path.join(clean, '.grok'));
    fs.writeFileSync(path.join(clean, '.grok', 'config.toml'), '[mcp]');
    expect(() => assertGrokWorkspaceIsolation(clean)).not.toThrow();
    fs.rmSync(path.join(clean, '.grok', 'config.toml'));
    fs.writeFileSync(path.join(clean, '.grok', 'mcp.json'), '{}');
    expect(() => assertGrokWorkspaceIsolation(clean)).not.toThrow();
    fs.rmSync(path.join(clean, '.grok', 'mcp.json'));
    fs.mkdirSync(path.join(clean, '.grok', 'marketplaces'));
    expect(() => assertGrokWorkspaceIsolation(clean)).toThrow(/nao permitida/);
  });

  it('aceita a versao ACP minima e atualizacoes posteriores', () => {
    expect(isSupportedGrokVersion('grok 0.2.102')).toBe(false);
    expect(isSupportedGrokVersion('grok 0.2.103')).toBe(true);
    expect(isSupportedGrokVersion('0.2.104')).toBe(true);
    expect(isSupportedGrokVersion('0.2.999')).toBe(true);
    expect(isSupportedGrokVersion('0.3.0')).toBe(true);
    expect(isSupportedGrokVersion('invalida')).toBe(false);
  });

  it('descobre a instalacao oficial mesmo quando o app empacotado nao herda o PATH do shell', () => {
    expect(grokBinaryFallbackCandidates('/Users/teste')).toEqual([
      '/Users/teste/.grok/bin/grok',
      '/Users/teste/.local/bin/grok',
      '/opt/homebrew/bin/grok',
      '/usr/local/bin/grok',
    ]);
  });

  it('atesta o catalogo nativo e o one-shot vazio implementados', () => {
    expect(getGrokToolPolicyAttestation()).toEqual({
      verified: true,
      pending: [],
    });
    expect(
      isGrokRuntimeUsable({
        supportedVersion: true,
        subscriptionRouteVerified: true,
        toolPolicyVerified: true,
      }),
    ).toBe(true);
  });

  it.each([
    ['resposta vazia', {}],
    ['authenticated sem metadado', { authenticated: true }],
    ['metadado legado', { authenticated: true, subscription: { active: true } }],
  ])('aceita authenticate bem-sucedido sem exigir shape privado: %s', async (_label, auth) => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return auth;
        if (method === 'session/new') return { models: { currentModelId: 'grok-4.6' } };
        throw new Error(`unexpected ${method}`);
      },
    });
    const result = await probeGrokSubscription('/fake/grok', fakeGrokTransportFactory(transport));
    expect(result).toEqual({
      authenticated: true,
      cachedTokenAdvertised: true,
      modelAvailable: true,
    });
    expect(transport.requests.map(({ method }) => method)).toContain('session/new');
  });

  it.each([
    ['authenticated=false', { authenticated: false, subscription: { active: true } }],
    ['subscription.active=false', { authenticated: true, subscription: { active: false } }],
  ])('rejeita negacao explicita do provider: %s', async (_label, auth) => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return auth;
        throw new Error(`unexpected ${method}`);
      },
    });
    await expect(probeGrokSubscription('/fake/grok', fakeGrokTransportFactory(transport))).resolves.toEqual({
      authenticated: false,
      cachedTokenAdvertised: true,
      modelAvailable: false,
    });
    expect(transport.requests.map(({ method }) => method)).not.toContain('session/new');
  });

  it('aceita o shape legado com assinatura ativa', async () => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') return { models: { currentModelId: 'grok-4.6' } };
        throw new Error(`unexpected ${method}`);
      },
    });
    await expect(probeGrokSubscription('/fake/grok', fakeGrokTransportFactory(transport))).resolves.toEqual({
      authenticated: true,
      cachedTokenAdvertised: true,
      modelAvailable: true,
    });
  });

  it('nao atesta modelo quando session/new retorna campos conflitantes', async () => {
    const transport = new FakeGrokAcpTransport({
      onRequest: async (method) => {
        if (method === 'initialize') return { authMethods: [{ id: 'cached_token' }] };
        if (method === 'authenticate') return { authenticated: true, subscription: { active: true } };
        if (method === 'session/new') {
          return { modelId: 'grok-4.6', models: { currentModelId: 'grok-internal' } };
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    await expect(probeGrokSubscription('/fake/grok', fakeGrokTransportFactory(transport))).resolves.toEqual({
      authenticated: true,
      cachedTokenAdvertised: true,
      modelAvailable: false,
    });
  });

  it('limita e encerra o probe pendente em timeout ou abort', async () => {
    const timed = new FakeGrokAcpTransport({
      onRequest: async () => new Promise(() => undefined),
    });
    await expect(
      probeGrokSubscription('/fake/grok', fakeGrokTransportFactory(timed), undefined, { timeoutMs: 5 }),
    ).resolves.toEqual({
      authenticated: false,
      cachedTokenAdvertised: false,
      modelAvailable: false,
    });
    expect(timed.killed).toBe(true);

    const aborted = new FakeGrokAcpTransport({
      onRequest: async () => new Promise(() => undefined),
    });
    const controller = new AbortController();
    const pending = probeGrokSubscription('/fake/grok', fakeGrokTransportFactory(aborted), undefined, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ authenticated: false, modelAvailable: false });
    expect(aborted.killed).toBe(true);
  });
});

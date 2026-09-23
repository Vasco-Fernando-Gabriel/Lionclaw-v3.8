import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertGrokWorkspaceUnchanged,
  assertGrokInspect,
  attestGrokSession,
  collectGrokExternalCatalog,
  collectGrokProjectSources,
  ensureGrokSandboxProfile,
  resolveGrokWorkspaceGrant,
  snapshotGrokSandboxAttestation,
  waitForGrokSandboxApplied,
} from '../grok-sdk/workspace';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lion-grok-workspace-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env['LIONCLAW_TEST_HOME'];
});

describe('Grok workspace isolation', () => {
  it.each(['telegram', 'cron'] as const)('%s uses a neutral cwd without filesystem grants', (lane) => {
    const home = temporaryRoot();
    const repo = temporaryRoot();
    process.env['NODE_ENV'] = 'test';
    process.env['LIONCLAW_TEST_HOME'] = home;
    const grant = resolveGrokWorkspaceGrant({ lane, repoRootSnapshot: repo });
    expect(grant.source).toBe('neutral');
    expect(grant.sessionCwd).toBe(grant.processCwd);
    expect(grant.sessionCwd).not.toBe(fs.realpathSync(repo));
    expect(grant.readRoots).toEqual([]);
    expect(grant.writeRoots).toEqual([]);
    expect(grant.projectSources).toEqual([]);
  });

  it('snapshots instructions and protects inert project config files', () => {
    const repo = temporaryRoot();
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'trusted instructions');
    expect(collectGrokProjectSources(repo)).toMatchObject([{ content: 'trusted instructions', initial: true }]);
    fs.mkdirSync(path.join(repo, '.grok'));
    fs.writeFileSync(path.join(repo, '.grok', 'config.toml'), '[mcp]');
    expect(collectGrokProjectSources(repo)).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: '[mcp]', initial: false })]),
    );
  });

  it('protege arquivos de config e rejeita diretorios extensaveis pela mesma varredura do rehash', () => {
    const repo = temporaryRoot();
    fs.mkdirSync(path.join(repo, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.grok', 'mcp.json'), '{}');
    expect(collectGrokProjectSources(repo)).toEqual([expect.objectContaining({ content: '{}', initial: false })]);

    fs.rmSync(path.join(repo, '.grok', 'mcp.json'));
    fs.mkdirSync(path.join(repo, '.grok', 'marketplaces'));
    expect(() => collectGrokProjectSources(repo)).toThrow('nao permitida');
  });

  it('rejeita namespace extensivel apontado por symlink de diretorio', () => {
    const repo = temporaryRoot();
    const outside = temporaryRoot();
    fs.writeFileSync(path.join(outside, 'config.toml'), '[mcp]');
    fs.symlinkSync(outside, path.join(repo, '.grok'), 'dir');
    expect(() => collectGrokProjectSources(repo)).toThrow(/symlink/);
  });

  it('ignora arvores opacas de dependencias sem deixar de inspecionar o projeto', () => {
    const repo = temporaryRoot();
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'root instructions');
    fs.mkdirSync(path.join(repo, 'node_modules', 'dependency', '.grok'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'dependency', 'AGENTS.md'), 'dependency instructions');
    fs.writeFileSync(path.join(repo, 'node_modules', 'dependency', '.grok', 'config.toml'), '[mcp]');

    expect(collectGrokProjectSources(repo)).toMatchObject([{ content: 'root instructions', initial: true }]);

    fs.mkdirSync(path.join(repo, 'src', '.grok'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', '.grok', 'config.toml'), '[mcp]');
    expect(collectGrokProjectSources(repo)).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: '[mcp]', initial: false })]),
    );
  });

  it('protege config Claude existente e ignora worktrees e estado LionClaw opacos', () => {
    const repo = temporaryRoot();
    fs.mkdirSync(path.join(repo, '.claude', 'worktrees', 'copy', '.grok'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{"enabled":true}');
    fs.writeFileSync(path.join(repo, '.claude', 'worktrees', 'copy', '.grok', 'config.toml'), '[mcp]');
    fs.mkdirSync(path.join(repo, '.lionclaw'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.lionclaw', 'AGENTS.md'), 'runtime state');

    expect(collectGrokProjectSources(repo)).toEqual([
      expect.objectContaining({ content: '{"enabled":true}', initial: false }),
    ]);
  });

  it('attests prompt_context content and detects TOCTOU changes', () => {
    const repo = temporaryRoot();
    const home = temporaryRoot();
    const sourcePath = path.join(repo, 'AGENTS.md');
    fs.writeFileSync(sourcePath, 'v1');
    const projectSources = collectGrokProjectSources(repo);
    const grant = {
      processCwd: home,
      sessionCwd: fs.realpathSync(repo),
      readRoots: [fs.realpathSync(repo)],
      writeRoots: [fs.realpathSync(repo)],
      source: 'desktop-repository' as const,
      projectSources,
    };
    const sessionId = 'session-1';
    const sessionDir = path.join(home, 'sessions', encodeURIComponent(grant.sessionCwd), sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'prompt_context.json'),
      JSON.stringify({
        working_directory: grant.sessionCwd,
        memory_enabled: false,
        agents_md_files: [{ file_path: sourcePath, content: 'v1' }],
      }),
    );
    expect(() => attestGrokSession(grant, home, sessionId)).not.toThrow();
    expect(ensureGrokSandboxProfile(grant, home)).toMatch(/^lionclaw_/);
    const sandbox = fs.readFileSync(path.join(home, 'sandbox.toml'), 'utf8');
    expect(sandbox).toContain('extends = "workspace"');
    expect(sandbox).toContain('restrict_network = true');
    expect(sandbox).toContain(`deny = [${JSON.stringify(fs.realpathSync(sourcePath))}]`);
    fs.mkdirSync(path.join(repo, '.grok'));
    fs.writeFileSync(path.join(repo, '.grok', 'mcp.json'), '{}');
    expect(() => assertGrokWorkspaceUnchanged(grant)).toThrow('mudaram');
    fs.rmSync(path.join(repo, '.grok'), { recursive: true });
    fs.writeFileSync(sourcePath, 'v2');
    expect(() => assertGrokWorkspaceUnchanged(grant)).toThrow('mudou');
  });

  it('aceita alias de casing somente quando aponta para o mesmo arquivo fisico', () => {
    const repo = temporaryRoot();
    const home = temporaryRoot();
    const sourcePath = path.join(repo, 'AGENTS.md');
    const reportedPath = path.join(repo, 'Reported.md');
    fs.writeFileSync(sourcePath, 'trusted instructions');
    const grant = {
      processCwd: home,
      sessionCwd: fs.realpathSync(repo),
      readRoots: [fs.realpathSync(repo)],
      writeRoots: [fs.realpathSync(repo)],
      source: 'desktop-repository' as const,
      projectSources: collectGrokProjectSources(repo),
    };
    fs.linkSync(sourcePath, reportedPath);
    const sessionId = 'session-physical-alias';
    const sessionDir = path.join(home, 'sessions', encodeURIComponent(grant.sessionCwd), sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'prompt_context.json'),
      JSON.stringify({
        working_directory: grant.sessionCwd,
        memory_enabled: false,
        agents_md_files: [{ file_path: reportedPath, content: 'trusted instructions' }],
      }),
    );

    expect(() => attestGrokSession(grant, home, sessionId)).not.toThrow();

    fs.unlinkSync(reportedPath);
    fs.writeFileSync(reportedPath, 'trusted instructions');
    expect(() => attestGrokSession(grant, home, sessionId)).toThrow(/instruction inesperada/);
  });

  it('aceita somente config gerenciada e extensoes builtin inertes no inspect', () => {
    const home = temporaryRoot();
    process.env['LIONCLAW_TEST_HOME'] = home;
    const grokHome = path.join(home, 'runtime', 'grok-home');
    fs.mkdirSync(grokHome, { recursive: true });
    const grant = resolveGrokWorkspaceGrant({ lane: 'cron' });
    const inspected = {
      cwd: grant.sessionCwd,
      projectInstructions: [],
      hooks: [],
      plugins: [],
      marketplaces: [],
      mcpServers: [],
      lspServers: [],
      permissions: { sources: [], mcpServerAllowlist: [], marketplaceAllowlist: [] },
      loginPolicy: { disableApiKeyAuth: true, apiKeyAuthDisabled: true },
      configSources: {
        layers: [
          { role: 'managed', path: path.join(grokHome, 'managed_config.toml') },
          { role: 'user', path: path.join(grokHome, 'config.toml') },
        ],
      },
      externalCompat: { remoteSettingsLoaded: false, cells: [{ enabled: false }] },
      skills: ['check-work', 'code-review', 'create-skill', 'help', 'imagine'].map((name) => ({
        name,
        disabled: true,
        source: { type: 'bundled', path: path.join(grokHome, 'skills', name, 'SKILL.md') },
      })),
      agents: ['general-purpose', 'explore', 'plan'].map((name) => ({
        name,
        source: { type: 'builtin' },
      })),
    };
    expect(() => assertGrokInspect(grant, inspected, grokHome)).not.toThrow();
    expect(() => assertGrokInspect(grant, { ...inspected, skills: [] }, grokHome)).not.toThrow();
    expect(() =>
      assertGrokInspect(
        grant,
        {
          ...inspected,
          providerConfig: { base_url: 'https://payg.example/v1' },
        },
        grokHome,
      ),
    ).toThrow(/backend\/auth custom/);
    expect(() =>
      assertGrokInspect(
        grant,
        {
          ...inspected,
          customModels: [{ id: 'grok-4.5', provider: 'third-party' }],
        },
        grokHome,
      ),
    ).toThrow(/catalogo custom/);
    expect(() =>
      assertGrokInspect(
        grant,
        {
          ...inspected,
          mcpServers: [
            {
              name: 'codegraph',
              disabled: true,
              compatibilityStatus: 'disabled',
              source: { type: 'claudeJson', path: '/home/user/.claude.json' },
            },
          ],
        },
        grokHome,
      ),
    ).not.toThrow();
    expect(() =>
      assertGrokInspect(
        grant,
        {
          ...inspected,
          mcpServers: [
            {
              name: 'codegraph',
              disabled: false,
              compatibilityStatus: 'enabled',
              source: { type: 'claudeJson', path: '/home/user/.claude.json' },
            },
          ],
        },
        grokHome,
      ),
    ).toThrow(/MCP ativo/);
    expect(() =>
      assertGrokInspect(
        grant,
        {
          ...inspected,
          mcpServers: [
            {
              name: 'codegraph',
              disabled: true,
              source: { type: 'claudeJson', path: '/home/user/.claude.json' },
            },
          ],
        },
        grokHome,
      ),
    ).toThrow(/MCP ativo/);
    inspected.skills[0]!.disabled = false;
    expect(() => assertGrokInspect(grant, inspected, grokHome)).toThrow(/skill executavel/);
  });

  it('trata instruction enumerada como inerte quando o CLI a atesta desabilitada', () => {
    const home = temporaryRoot();
    process.env['LIONCLAW_TEST_HOME'] = home;
    const grokHome = path.join(home, 'runtime', 'grok-home');
    fs.mkdirSync(grokHome, { recursive: true });
    const outside = temporaryRoot();
    const compatInstruction = path.join(outside, 'Agents.md');
    fs.writeFileSync(compatInstruction, 'externa via compat');
    const grant = resolveGrokWorkspaceGrant({ lane: 'cron' });
    const base = {
      cwd: grant.sessionCwd,
      hooks: [],
      plugins: [],
      marketplaces: [],
      mcpServers: [],
      lspServers: [],
      permissions: { sources: [], mcpServerAllowlist: [], marketplaceAllowlist: [] },
      loginPolicy: { disableApiKeyAuth: true, apiKeyAuthDisabled: true },
      configSources: {
        layers: [
          { role: 'managed', path: path.join(grokHome, 'managed_config.toml') },
          { role: 'user', path: path.join(grokHome, 'config.toml') },
        ],
      },
      externalCompat: { remoteSettingsLoaded: false, cells: [{ enabled: false }] },
      skills: [],
      agents: ['general-purpose', 'explore', 'plan'].map((name) => ({
        name,
        source: { type: 'builtin' },
      })),
    };
    expect(() =>
      assertGrokInspect(
        grant,
        {
          ...base,
          projectInstructions: [{ path: compatInstruction, disabled: true, compatibilityStatus: 'disabled' }],
        },
        grokHome,
      ),
    ).not.toThrow();
    expect(() =>
      assertGrokInspect(
        grant,
        {
          ...base,
          projectInstructions: [{ path: compatInstruction }],
        },
        grokHome,
      ),
    ).toThrow(/instruction inesperada/);
  });

  it('atesta a carga efetiva do ACP sem aceitar rules de compat desabilitadas', () => {
    const home = temporaryRoot();
    const repo = temporaryRoot();
    fs.mkdirSync(path.join(repo, '.grok', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.claude', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'raiz');
    fs.writeFileSync(path.join(repo, '.grok', 'rules', 'g.md'), 'nativa');
    fs.writeFileSync(path.join(repo, '.claude', 'rules', 'c.md'), 'compat');
    const grant = {
      processCwd: home,
      sessionCwd: fs.realpathSync(repo),
      readRoots: [fs.realpathSync(repo)],
      writeRoots: [fs.realpathSync(repo)],
      source: 'desktop-repository' as const,
      projectSources: collectGrokProjectSources(repo),
    };
    const sessionId = 'session-native';
    const sessionDir = path.join(home, 'sessions', encodeURIComponent(grant.sessionCwd), sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const nativeRows = [
      { file_path: path.join(repo, 'AGENTS.md'), content: 'raiz' },
      { file_path: path.join(repo, '.grok', 'rules', 'g.md'), content: 'nativa' },
    ];
    fs.writeFileSync(
      path.join(sessionDir, 'prompt_context.json'),
      JSON.stringify({
        working_directory: grant.sessionCwd,
        memory_enabled: false,
        agents_md_files: nativeRows,
      }),
    );
    expect(() => attestGrokSession(grant, home, sessionId)).not.toThrow();
    fs.writeFileSync(
      path.join(sessionDir, 'prompt_context.json'),
      JSON.stringify({
        working_directory: grant.sessionCwd,
        memory_enabled: false,
        agents_md_files: [],
      }),
    );
    expect(() => attestGrokSession(grant, home, sessionId)).not.toThrow();
    fs.writeFileSync(
      path.join(sessionDir, 'prompt_context.json'),
      JSON.stringify({
        working_directory: grant.sessionCwd,
        memory_enabled: false,
        agents_md_files: [...nativeRows, { file_path: path.join(repo, '.claude', 'rules', 'c.md'), content: 'compat' }],
      }),
    );
    expect(() => attestGrokSession(grant, home, sessionId)).toThrow(/instruction inesperada/);
  });

  it('aceita catalogo externo somente desligado por nome na managed config', () => {
    const home = temporaryRoot();
    process.env['LIONCLAW_TEST_HOME'] = home;
    const grokHome = path.join(home, 'runtime', 'grok-home');
    fs.mkdirSync(grokHome, { recursive: true });
    const grant = resolveGrokWorkspaceGrant({ lane: 'cron' });
    const inspected = {
      cwd: grant.sessionCwd,
      projectInstructions: [],
      hooks: [
        {
          event: '(plugin)',
          source: { type: 'plugin', plugin_name: 'understand-anything' },
        },
      ],
      plugins: [{ name: 'understand-anything', enabled: true }],
      marketplaces: [],
      mcpServers: [],
      lspServers: [],
      permissions: { sources: [], mcpServerAllowlist: [], marketplaceAllowlist: [] },
      loginPolicy: { disableApiKeyAuth: true, apiKeyAuthDisabled: true },
      configSources: {
        layers: [
          { role: 'managed', path: path.join(grokHome, 'managed_config.toml') },
          { role: 'user', path: path.join(grokHome, 'config.toml') },
        ],
      },
      externalCompat: { remoteSettingsLoaded: false, cells: [{ enabled: false }] },
      skills: [
        { name: 'framer', disabled: true, source: { type: 'user', path: '/home/user/.agents/skills/framer/SKILL.md' } },
      ],
      agents: ['general-purpose', 'explore', 'plan'].map((name) => ({
        name,
        source: { type: 'builtin' },
      })),
    };
    const extras = { disabledSkills: ['framer'], disabledPlugins: ['understand-anything'], ignoredSkillPaths: [] };
    expect(() => assertGrokInspect(grant, inspected, grokHome, extras)).not.toThrow();
    expect(() => assertGrokInspect(grant, inspected, grokHome)).toThrow(/plugin fora da politica/);
    expect(() =>
      assertGrokInspect(
        grant,
        {
          ...inspected,
          skills: [{ ...inspected.skills[0]!, disabled: false }],
        },
        grokHome,
        extras,
      ),
    ).toThrow(/skill executavel/);
    expect(() =>
      assertGrokInspect(
        grant,
        {
          ...inspected,
          hooks: [{ event: 'file', source: { type: 'project' } }],
        },
        grokHome,
        extras,
      ),
    ).toThrow(/hook fora de plugin desabilitado/);
    expect(() =>
      assertGrokInspect(
        grant,
        {
          ...inspected,
          skills: [{ name: 'intrusa', disabled: true, source: { type: 'user', path: '/x/SKILL.md' } }],
        },
        grokHome,
        extras,
      ),
    ).toThrow(/skill executavel/);
  });

  it('enumera o catalogo externo com nomes atestaveis e rejeita nomes fora do formato', () => {
    expect(
      collectGrokExternalCatalog({
        skills: [
          { name: 'imagine', disabled: true, source: { type: 'bundled', path: '/gh/skills/imagine/SKILL.md' } },
          { name: 'build-with-ai', source: { type: 'bundled', path: '/gh/bundled/skills/build-with-ai/SKILL.md' } },
          { name: 'framer', source: { type: 'user', path: '/h/.agents/skills/framer/SKILL.md' } },
          { name: 'graphify', source: { type: 'claude', path: '/h/.claude/skills/graphify/SKILL.md' } },
          { name: 'framer', source: { type: 'user', path: '/h/.agents/skills/framer/SKILL.md' } },
        ],
        plugins: [{ name: 'understand-anything' }],
      }),
    ).toEqual({
      disabledSkills: ['build-with-ai', 'framer', 'graphify'],
      disabledPlugins: ['understand-anything'],
      ignoredSkillPaths: ['/gh/bundled/skills/build-with-ai', '/h/.agents/skills/framer', '/h/.claude/skills/graphify'],
    });
    expect(() =>
      collectGrokExternalCatalog({
        skills: [{ name: 'Nome Invalido"', source: { type: 'user', path: '/x' } }],
        plugins: [],
      }),
    ).toThrow(/formato atestavel/);
    expect(() =>
      collectGrokExternalCatalog({
        skills: [],
        plugins: [{ name: 'plug"in' }],
      }),
    ).toThrow(/formato atestavel/);
  });

  it('exige ProfileApplied novo, kernel-enforced e com todos os deny paths', async () => {
    if (process.platform !== 'linux') return;
    const home = temporaryRoot();
    const workspace = temporaryRoot();
    const denied = path.join(workspace, 'AGENTS.md');
    fs.writeFileSync(denied, 'rules');
    const eventsPath = path.join(home, 'sandbox-events.jsonl');
    fs.writeFileSync(
      eventsPath,
      `${JSON.stringify({
        event_type: 'ApplyFailed',
        profile: 'old',
        workspace,
        enforced: false,
      })}\n`,
    );
    const attestation = snapshotGrokSandboxAttestation(home, 'lionclaw_test', workspace, [denied]);
    fs.appendFileSync(
      eventsPath,
      `${JSON.stringify({
        event_type: 'ProfileApplied',
        profile: 'lionclaw_test',
        workspace,
        platform: 'linux/landlock',
        enforced: true,
        restrict_network: true,
        deny_paths: [denied],
      })}\n`,
    );
    await expect(waitForGrokSandboxApplied(attestation, 100)).resolves.toBeUndefined();

    const missingDeny = snapshotGrokSandboxAttestation(home, 'lionclaw_missing', workspace, [denied]);
    fs.appendFileSync(
      eventsPath,
      `${JSON.stringify({
        event_type: 'ProfileApplied',
        profile: 'lionclaw_missing',
        workspace,
        platform: 'linux/landlock',
        enforced: true,
        restrict_network: true,
        deny_paths: [],
      })}\n`,
    );
    await expect(waitForGrokSandboxApplied(missingDeny, 50)).rejects.toThrow(/nao comprovou/);
  });
});

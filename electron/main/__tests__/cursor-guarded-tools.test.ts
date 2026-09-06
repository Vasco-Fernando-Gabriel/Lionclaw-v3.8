
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import {
  CURSOR_GUARDED_NATIVE_ALLOWLIST,
  buildCursorGuardedToolset,
} from '../agent-runtime/cursor-sidecar/guarded-tools';
import type { CursorToolDispatchContext } from '../agent-runtime/cursor-sidecar/sidecar-manager';

interface GuardCall {
  toolName: string;
  input: Record<string, unknown>;
}

function makeGuard(
  decide: (toolName: string, input: Record<string, unknown>) => PermissionResult,
): { guard: CanUseTool; calls: GuardCall[] } {
  const calls: GuardCall[] = [];
  const guard: CanUseTool = async (toolName, input) => {
    calls.push({ toolName, input });
    return decide(toolName, input);
  };
  return { guard, calls };
}

const allowAll = (): PermissionResult => ({ behavior: 'allow' });

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-guarded-'));
  return root;
}

function ctx(signal?: AbortSignal): CursorToolDispatchContext {
  return { signal: signal ?? new AbortController().signal };
}

function invoke(toolName: string, args: Record<string, unknown>): {
  executionId: string;
  toolName: string;
  args: Record<string, unknown>;
} {
  return { executionId: 'exec-test', toolName, args };
}

describe('buildCursorGuardedToolset — shape', () => {
  it('allowlist nativa guardada e SO o grupo mcp (leitura nativa fora, G11-b)', () => {
    expect(CURSOR_GUARDED_NATIVE_ALLOWLIST).toEqual(['mcp']);
  });

  it('declara as 7 tools host-controladas e nenhuma delegacao lateral', () => {
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: makeRoot(), canUseTool: guard });
    const names = toolset.declarations.map((d) => d.name).sort();
    expect(names).toEqual([
      'lion_edit',
      'lion_glob',
      'lion_grep',
      'lion_list',
      'lion_read',
      'lion_shell',
      'lion_write',
    ]);
    expect(Object.keys(toolset.handlers).sort()).toEqual(names);
    expect(names.some((n) => /task|agent|subagent/i.test(n))).toBe(false);
    for (const decl of toolset.declarations) {
      expect(decl.description.length).toBeGreaterThan(0);
      expect(decl.inputSchema['type']).toBe('object');
    }
  });
});

describe('extraRoots — workspace conectado da sessao de chat', () => {
  it('permite leitura por caminho ABSOLUTO sob a raiz extra (repo conectado)', async () => {
    const root = makeRoot();
    const repo = makeRoot();
    fs.writeFileSync(path.join(repo, 'app.ts'), 'conteudo do repo', 'utf8');
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({
      cwd: root,
      canUseTool: guard,
      extraRoots: [repo],
    });
    const out = await toolset.handlers['lion_read']!(
      invoke('lion_read', { file_path: path.join(repo, 'app.ts') }),
      ctx(),
    );
    expect(out).toContain('conteudo do repo');
  });

  it('lion_glob com base na raiz extra devolve matches de la', async () => {
    const root = makeRoot();
    const repo = makeRoot();
    fs.writeFileSync(path.join(repo, 'index.ts'), 'x', 'utf8');
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({
      cwd: root,
      canUseTool: guard,
      extraRoots: [repo],
    });
    const out = await toolset.handlers['lion_glob']!(
      invoke('lion_glob', { pattern: '**/*.ts', path: repo }),
      ctx(),
    );
    expect(out).toContain('index.ts');
  });

  it('continua negando path fora de TODAS as raizes permitidas', async () => {
    const root = makeRoot();
    const repo = makeRoot();
    const fora = makeRoot();
    fs.writeFileSync(path.join(fora, 'secreto.txt'), 'nao', 'utf8');
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({
      cwd: root,
      canUseTool: guard,
      extraRoots: [repo],
    });
    await expect(
      toolset.handlers['lion_read']!(
        invoke('lion_read', { file_path: path.join(fora, 'secreto.txt') }),
        ctx(),
      ),
    ).rejects.toThrow(/fora das raizes permitidas/);
  });

  it('deniedRoots negam mesmo sob uma raiz extra', async () => {
    const root = makeRoot();
    const repo = makeRoot();
    const denied = path.join(repo, 'segredos');
    fs.mkdirSync(denied, { recursive: true });
    fs.writeFileSync(path.join(denied, 'r.md'), 'rules', 'utf8');
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({
      cwd: root,
      canUseTool: guard,
      extraRoots: [repo],
      deniedRoots: [denied],
    });
    await expect(
      toolset.handlers['lion_read']!(
        invoke('lion_read', { file_path: path.join(denied, 'r.md') }),
        ctx(),
      ),
    ).rejects.toThrow(/PROTEGIDA/);
  });
});

describe('lion_read / lion_list — leitura confinada', () => {
  it('le arquivo dentro da raiz consultando a policy como Read', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'a.txt'), 'linha1\nlinha2\nlinha3', 'utf8');
    const { guard, calls } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });

    const out = await toolset.handlers['lion_read']!(
      invoke('lion_read', { file_path: 'a.txt' }),
      ctx(),
    );
    expect(out).toContain('linha1');
    expect(calls[0]?.toolName).toBe('Read');
  });

  it('offset/limit fatiam por linhas', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'a.txt'), 'l1\nl2\nl3\nl4', 'utf8');
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });
    const out = await toolset.handlers['lion_read']!(
      invoke('lion_read', { file_path: 'a.txt', offset: 1, limit: 2 }),
      ctx(),
    );
    expect(out).toContain('l2\nl3');
    expect(out).not.toContain('l1\n');
  });

  it('NEGA leitura fora da raiz mesmo com a policy permitindo (fecha o G11-b)', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'MARCADOR-VAZOU', 'utf8');
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });

    await expect(
      toolset.handlers['lion_read']!(
        invoke('lion_read', { file_path: path.join(outside, 'secret.txt') }),
        ctx(),
      ),
    ).rejects.toThrow(/fora das raizes permitidas/);
    await expect(
      toolset.handlers['lion_read']!(
        invoke('lion_read', { file_path: '../' + path.basename(outside) + '/secret.txt' }),
        ctx(),
      ),
    ).rejects.toThrow(/fora das raizes permitidas/);
  });

  it('lista diretorio dentro da raiz e nega fora', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'f.txt'), 'x', 'utf8');
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });

    const out = await toolset.handlers['lion_list']!(invoke('lion_list', {}), ctx());
    expect(out).toContain('sub');
    expect(out).toContain('f.txt');
    await expect(
      toolset.handlers['lion_list']!(invoke('lion_list', { path: os.tmpdir() }), ctx()),
    ).rejects.toThrow(/fora das raizes permitidas/);
  });
});

describe('lion_glob / lion_grep — busca confinada', () => {
  it('glob encontra por pattern dentro da raiz', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'x.ts'), 'export {};', 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'y.md'), '# doc', 'utf8');
    const { guard, calls } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });

    const out = await toolset.handlers['lion_glob']!(
      invoke('lion_glob', { pattern: '**/*.ts' }),
      ctx(),
    );
    expect(out).toContain('x.ts');
    expect(out).not.toContain('y.md');
    expect(calls[0]?.toolName).toBe('Glob');
  });

  it('grep acha por regex com file:line e respeita o filtro glob', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'a.ts'), 'const alvoUnico = 1;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'b.md'), 'alvoUnico em doc\n', 'utf8');
    const { guard, calls } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });

    const all = await toolset.handlers['lion_grep']!(
      invoke('lion_grep', { pattern: 'alvoUnico' }),
      ctx(),
    );
    expect(all).toContain('a.ts:1:');
    expect(all).toContain('b.md:1:');
    expect(calls[0]?.toolName).toBe('Grep');

    const filtered = await toolset.handlers['lion_grep']!(
      invoke('lion_grep', { pattern: 'alvoUnico', glob: '*.ts' }),
      ctx(),
    );
    expect(filtered).toContain('a.ts:1:');
    expect(filtered).not.toContain('b.md');

    const none = await toolset.handlers['lion_grep']!(
      invoke('lion_grep', { pattern: 'naoExisteNadaAssim' }),
      ctx(),
    );
    expect(none).toContain('Nenhum resultado');
  });

  it('glob NEGA pattern absoluto (glob v7 ignora o cwd e enumeraria o disco)', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    fs.writeFileSync(path.join(outside, 'segredo.key'), 'x', 'utf8');
    const { guard, calls } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });

    const absolutePatterns = [
      outside.replace(/\\/g, '/') + '/**/*.key',
      'C:/Users/**/*.key',
      '/etc/**',
    ];
    for (const pattern of absolutePatterns) {
      await expect(
        toolset.handlers['lion_glob']!(invoke('lion_glob', { pattern }), ctx()),
      ).rejects.toThrow(/pattern absoluto nao e permitido/);
    }
    expect(calls).toHaveLength(0);
  });

  it('glob NEGA pattern com segmento ".." (atravessa para fora da base)', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    fs.writeFileSync(path.join(outside, 'fora.txt'), 'x', 'utf8');
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });

    for (const pattern of ['../**/*.txt', '../' + path.basename(outside) + '/*.txt', 'a/../../**']) {
      await expect(
        toolset.handlers['lion_glob']!(invoke('lion_glob', { pattern }), ctx()),
      ).rejects.toThrow(/segmento "\.\." nao e permitido/);
    }
  });

  it('grep fora da raiz e negado', async () => {
    const root = makeRoot();
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });
    await expect(
      toolset.handlers['lion_grep']!(
        invoke('lion_grep', { pattern: 'x', path: os.tmpdir() }),
        ctx(),
      ),
    ).rejects.toThrow(/fora das raizes permitidas/);
  });
});

describe('lion_write / lion_edit — policy composta ANTES de agir', () => {
  it('deny do guard vira erro com a mensagem real e NADA e escrito', async () => {
    const root = makeRoot();
    const { guard, calls } = makeGuard((toolName) =>
      toolName === 'Write'
        ? { behavior: 'deny', message: 'fora do writeSet do node' }
        : { behavior: 'allow' },
    );
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });

    await expect(
      toolset.handlers['lion_write']!(
        invoke('lion_write', { file_path: 'hack.txt', content: 'x' }),
        ctx(),
      ),
    ).rejects.toThrow(/Permissao negada \(Write\): fora do writeSet do node/);
    expect(fs.existsSync(path.join(root, 'hack.txt'))).toBe(false);
    expect(calls[0]).toEqual({
      toolName: 'Write',
      input: { file_path: 'hack.txt', content: 'x' },
    });
  });

  it('allow escreve (criando diretorios) e honra updatedInput do guard', async () => {
    const root = makeRoot();
    const { guard } = makeGuard((toolName, input) =>
      toolName === 'Write'
        ? {
            behavior: 'allow',
            updatedInput: { ...input, file_path: 'redirecionado/ok.txt' },
          }
        : { behavior: 'allow' },
    );
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });

    const out = await toolset.handlers['lion_write']!(
      invoke('lion_write', { file_path: 'orig/ok.txt', content: 'conteudo' }),
      ctx(),
    );
    expect(out).toContain('sucesso');
    expect(fs.readFileSync(path.join(root, 'redirecionado', 'ok.txt'), 'utf8')).toBe('conteudo');
    expect(fs.existsSync(path.join(root, 'orig', 'ok.txt'))).toBe(false);
  });

  it('escrita fora da raiz e negada mesmo com allow do guard (defesa em profundidade)', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });
    const target = path.join(outside, 'hack.txt');
    await expect(
      toolset.handlers['lion_write']!(
        invoke('lion_write', { file_path: target, content: 'x' }),
        ctx(),
      ),
    ).rejects.toThrow(/fora das raizes permitidas/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('edit substitui a primeira ocorrencia (ou todas com replace_all) e consulta Edit', async () => {
    const root = makeRoot();
    const file = path.join(root, 'e.txt');
    fs.writeFileSync(file, 'aa bb aa', 'utf8');
    const { guard, calls } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });

    await toolset.handlers['lion_edit']!(
      invoke('lion_edit', { file_path: 'e.txt', old_string: 'aa', new_string: 'cc' }),
      ctx(),
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('cc bb aa');
    expect(calls[0]?.toolName).toBe('Edit');

    await toolset.handlers['lion_edit']!(
      invoke('lion_edit', {
        file_path: 'e.txt',
        old_string: 'aa',
        new_string: 'dd',
        replace_all: true,
      }),
      ctx(),
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('cc bb dd');

    await expect(
      toolset.handlers['lion_edit']!(
        invoke('lion_edit', { file_path: 'e.txt', old_string: 'zzz' }),
        ctx(),
      ),
    ).rejects.toThrow(/old_string nao encontrado/);
  });
});

describe('consultGuard — contrato CanUseTool do Agent SDK 0.3 (D11)', () => {
  interface GuardOptionsSeen {
    toolUseID: string | undefined;
    requestId: string | undefined;
  }

  function makeGuardWithOptions(
    decide: () => PermissionResult | null,
  ): { guard: CanUseTool; seen: GuardOptionsSeen[] } {
    const seen: GuardOptionsSeen[] = [];
    const guard: CanUseTool = async (_toolName, _input, options) => {
      seen.push({ toolUseID: options.toolUseID, requestId: options.requestId });
      return decide();
    };
    return { guard, seen };
  }

  it('(a) o guard recebe requestId string nao-vazia e toolUseID', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    const { guard, seen } = makeGuardWithOptions(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });
    await toolset.handlers['lion_read']!(invoke('lion_read', { file_path: 'a.txt' }), ctx());
    expect(seen).toHaveLength(1);
    expect(typeof seen[0]!.requestId).toBe('string');
    expect(seen[0]!.requestId!.length).toBeGreaterThan(0);
    expect(seen[0]!.toolUseID).toMatch(/^cursor-guarded-/);
  });

  it('(b) guard resolvendo null NEGA fail-closed e NADA e escrito', async () => {
    const root = makeRoot();
    const { guard, seen } = makeGuardWithOptions(() => null);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });
    await expect(
      toolset.handlers['lion_write']!(
        invoke('lion_write', { file_path: 'novo.txt', content: 'nunca' }),
        ctx(),
      ),
    ).rejects.toThrow(/Permissao negada \(Write\): policy sem decisao/);
    expect(seen).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'novo.txt'))).toBe(false);
  });

  it('(b) guard null no lion_shell nao executa NADA (marker ausente)', async () => {
    const root = makeRoot();
    const marker = path.join(root, 'marker-null.txt');
    const { guard } = makeGuardWithOptions(() => null);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });
    await expect(
      toolset.handlers['lion_shell']!(
        invoke('lion_shell', { command: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"` }),
        ctx(),
      ),
    ).rejects.toThrow(/Permissao negada \(Bash\)/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('(c) deny continua negando com a mensagem real do guard', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    const { guard } = makeGuardWithOptions(() => ({ behavior: 'deny', message: 'leitura vetada' }));
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });
    await expect(
      toolset.handlers['lion_read']!(invoke('lion_read', { file_path: 'a.txt' }), ctx()),
    ).rejects.toThrow(/Permissao negada \(Read\): leitura vetada/);
  });
});

describe('lion_shell — spawn cancelavel, nunca execSync', () => {
  it('deny do guard nao executa NADA (marker ausente)', async () => {
    const root = makeRoot();
    const marker = path.join(root, 'shell-proof.txt');
    const { guard, calls } = makeGuard((toolName) =>
      toolName === 'Bash'
        ? { behavior: 'deny', message: 'comando fora do allowedCommands do node' }
        : { behavior: 'allow' },
    );
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });

    await expect(
      toolset.handlers['lion_shell']!(
        invoke('lion_shell', { command: `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}','ran')"` }),
        ctx(),
      ),
    ).rejects.toThrow(/Permissao negada \(Bash\)/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(calls[0]?.toolName).toBe('Bash');
  });

  it('allow executa no cwd do run e devolve stdout', async () => {
    const root = makeRoot();
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });
    const out = await toolset.handlers['lion_shell']!(
      invoke('lion_shell', { command: 'node -e "console.log(process.cwd())"' }),
      ctx(),
    );
    expect(path.resolve(out.trim())).toBe(path.resolve(root));
  });

  it('exit nao-zero volta como Error (exit N) com o output, sem lancar', async () => {
    const root = makeRoot();
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });
    const out = await toolset.handlers['lion_shell']!(
      invoke('lion_shell', { command: 'node -e "console.error(\'quebrou\');process.exit(3)"' }),
      ctx(),
    );
    expect(out).toContain('Error (exit 3)');
    expect(out).toContain('quebrou');
  });

  it('timeout mata o processo e lanca com a mensagem de timeout', async () => {
    const root = makeRoot();
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });
    await expect(
      toolset.handlers['lion_shell']!(
        invoke('lion_shell', {
          command: 'node -e "setTimeout(()=>{},10000)"',
          timeout_ms: 400,
        }),
        ctx(),
      ),
    ).rejects.toThrow(/timeout de 400ms/);
  }, 15_000);

  it('abort da execucao mata o processo em voo (contrato G12)', async () => {
    const root = makeRoot();
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });
    const controller = new AbortController();
    const pending = toolset.handlers['lion_shell']!(
      invoke('lion_shell', { command: 'node -e "setTimeout(()=>{},10000)"' }),
      ctx(controller.signal),
    );
    const outcome = pending.catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 200);
    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('session-aborted');
  }, 15_000);

  it('abort ANTES do spawn rejeita sem executar', async () => {
    const root = makeRoot();
    const marker = path.join(root, 'pre-abort.txt');
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({ cwd: root, canUseTool: guard });
    const controller = new AbortController();
    controller.abort();
    await expect(
      toolset.handlers['lion_shell']!(
        invoke('lion_shell', { command: `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}','ran')"` }),
        ctx(controller.signal),
      ),
    ).rejects.toThrow(/session-aborted/);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('gate final r2 — includeShell:false e deniedRoots estrutural', () => {
  function makeDeniedSetup(): {
    root: string;
    denied: string;
    rulesFile: string;
    toolset: ReturnType<typeof buildCursorGuardedToolset>;
  } {
    const root = makeRoot();
    const denied = path.join(root, 'runtime', 'cursor-chat-workspaces');
    const rulesDir = path.join(denied, 'desktop', 'hash-b', '.cursor', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    const rulesFile = path.join(rulesDir, 'lionclaw-identity.internal.mdc');
    fs.writeFileSync(rulesFile, 'IDENTIDADE DA SESSAO B', 'utf8');
    fs.writeFileSync(
      path.join(denied, 'desktop', 'hash-b', 'vazavel.mdc'),
      'IDENTIDADE DA SESSAO B em arquivo nao-dot',
      'utf8',
    );
    const { guard } = makeGuard(allowAll);
    const toolset = buildCursorGuardedToolset({
      cwd: root,
      canUseTool: guard,
      includeShell: false,
      deniedRoots: [denied],
    });
    return { root, denied, rulesFile, toolset };
  }

  it('includeShell:false EXCLUI lion_shell de declaracoes e handlers (surface de chat)', () => {
    const { toolset } = makeDeniedSetup();
    const names = toolset.declarations.map((d) => d.name);
    expect(names).not.toContain('lion_shell');
    expect(toolset.handlers['lion_shell']).toBeUndefined();
    expect(names).toEqual(
      expect.arrayContaining(['lion_read', 'lion_write', 'lion_edit', 'lion_glob', 'lion_grep', 'lion_list']),
    );
  });

  it('escrita/edicao sob a raiz negada e bloqueada MESMO com o guard permitindo (relativo e ".." absoluto)', async () => {
    const { root, rulesFile, toolset } = makeDeniedSetup();
    const relative = path
      .join('runtime', 'cursor-chat-workspaces', 'desktop', 'hash-b', '.cursor', 'rules', 'lionclaw-identity.internal.mdc')
      .replace(/\\/g, '/');
    await expect(
      toolset.handlers['lion_write']!(
        invoke('lion_write', { file_path: relative, content: 'INJETADO' }),
        ctx(),
      ),
    ).rejects.toThrow(/raiz PROTEGIDA/);
    const dotted = path.join(root, 'qualquer', '..', 'runtime', 'cursor-chat-workspaces', 'desktop', 'hash-b', '.cursor', 'rules', 'x.mdc');
    await expect(
      toolset.handlers['lion_write']!(
        invoke('lion_write', { file_path: dotted, content: 'INJETADO' }),
        ctx(),
      ),
    ).rejects.toThrow(/raiz PROTEGIDA/);
    await expect(
      toolset.handlers['lion_edit']!(
        invoke('lion_edit', { file_path: relative, old_string: 'IDENTIDADE', new_string: 'HACK' }),
        ctx(),
      ),
    ).rejects.toThrow(/raiz PROTEGIDA/);
    expect(fs.readFileSync(rulesFile, 'utf8')).toBe('IDENTIDADE DA SESSAO B');
  });

  it('leitura/listagem sob a raiz negada e bloqueada (conteudo das rules nunca vaza)', async () => {
    const { denied, rulesFile, toolset } = makeDeniedSetup();
    await expect(
      toolset.handlers['lion_read']!(invoke('lion_read', { file_path: rulesFile }), ctx()),
    ).rejects.toThrow(/raiz PROTEGIDA/);
    await expect(
      toolset.handlers['lion_list']!(invoke('lion_list', { path: denied }), ctx()),
    ).rejects.toThrow(/raiz PROTEGIDA/);
  });

  it('glob e grep na raiz do cwd NAO devolvem nada de dentro da raiz negada', async () => {
    const { root, toolset } = makeDeniedSetup();
    fs.writeFileSync(path.join(root, 'legit.mdc'), 'IDENTIDADE legitima fora da raiz negada', 'utf8');

    const globOut = await toolset.handlers['lion_glob']!(
      invoke('lion_glob', { pattern: '**/*.mdc' }),
      ctx(),
    );
    expect(globOut).toContain('legit.mdc');
    expect(globOut).not.toContain('lionclaw-identity.internal.mdc');
    expect(globOut).not.toContain('vazavel.mdc');

    const grepOut = await toolset.handlers['lion_grep']!(
      invoke('lion_grep', { pattern: 'IDENTIDADE' }),
      ctx(),
    );
    expect(grepOut).toContain('legit.mdc');
    expect(grepOut).not.toContain('SESSAO B');
  });
});

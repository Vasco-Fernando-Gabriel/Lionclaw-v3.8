
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
  CURSOR_SIDECAR_MIN_NODE_VERSION,
  _resetCursorSidecarNodeForTesting,
  isNodeVersionSufficient,
  parseNodeVersion,
  resolveCursorPayloadNodeAt,
  resolveCursorSidecarEntry,
  resolveCursorSidecarNode,
} from '../agent-runtime/cursor-sidecar/node-resolver';

beforeEach(() => {
  _resetCursorSidecarNodeForTesting();
});

describe('parseNodeVersion / isNodeVersionSufficient', () => {
  it('parseia v24.14.1 e variantes sem prefixo', () => {
    expect(parseNodeVersion('v24.14.1')).toEqual({ major: 24, minor: 14, patch: 1 });
    expect(parseNodeVersion('22.13.0')).toEqual({ major: 22, minor: 13, patch: 0 });
    expect(parseNodeVersion('lixo')).toBeNull();
  });

  it('aplica o piso 22.13 do @cursor/sdk', () => {
    expect(CURSOR_SIDECAR_MIN_NODE_VERSION).toBe('22.13.0');
    expect(isNodeVersionSufficient({ major: 22, minor: 13, patch: 0 })).toBe(true);
    expect(isNodeVersionSufficient({ major: 24, minor: 0, patch: 0 })).toBe(true);
    expect(isNodeVersionSufficient({ major: 22, minor: 12, patch: 9 })).toBe(false);
    expect(isNodeVersionSufficient({ major: 20, minor: 18, patch: 3 })).toBe(false);
  });
});

describe('resolveCursorSidecarNode', () => {
  it('prefere o Node interno empacotado quando presente e suficiente', async () => {
    const resolution = await resolveCursorSidecarNode({
      tryInternal: () => '/fake/internal/node',
      probe: async () => 'v22.13.1\n',
    });
    expect(resolution).toEqual({
      nodePath: '/fake/internal/node',
      version: 'v22.13.1',
      source: 'internal',
    });
  });

  it('Node interno antigo e erro claro (nao cai silencioso para o sistema)', async () => {
    await expect(
      resolveCursorSidecarNode({
        tryInternal: () => '/fake/internal/node',
        probe: async () => 'v20.18.3',
      }),
    ).rejects.toThrow(/abaixo do minimo 22\.13\.0/);
  });

  it('sem interno, usa o Node do sistema validando a versao', async () => {
    const probed: string[] = [];
    const resolution = await resolveCursorSidecarNode({
      tryInternal: () => null,
      probe: async (nodePath) => {
        probed.push(nodePath);
        return 'v24.14.1';
      },
    });
    expect(resolution.source).toBe('system');
    expect(resolution.version).toBe('v24.14.1');
    expect(probed).toHaveLength(1);
  });

  it('Node do sistema antigo: erro claro citando o minimo', async () => {
    await expect(
      resolveCursorSidecarNode({
        tryInternal: () => null,
        probe: async () => 'v20.18.3',
      }),
    ).rejects.toThrow(/22\.13/);
  });

  it('Node ausente no PATH: erro claro com acao corretiva', async () => {
    await expect(
      resolveCursorSidecarNode({
        tryInternal: () => null,
        probe: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).rejects.toThrow(/Node\.js nao encontrado no PATH/);
  });

  it('sem interno, prefere o payload do sidecar (E7) antes do sistema', async () => {
    const probed: string[] = [];
    const resolution = await resolveCursorSidecarNode({
      tryInternal: () => null,
      tryPayload: () => '/fake/payload/node.exe',
      packaged: true,
      probe: async (nodePath) => {
        probed.push(nodePath);
        return 'v22.22.3';
      },
    });
    expect(resolution).toEqual({
      nodePath: '/fake/payload/node.exe',
      version: 'v22.22.3',
      source: 'payload',
    });
    expect(probed).toEqual(['/fake/payload/node.exe']);
  });

  it('payload com Node antigo: erro claro citando o prepare script', async () => {
    await expect(
      resolveCursorSidecarNode({
        tryInternal: () => null,
        tryPayload: () => '/fake/payload/node.exe',
        packaged: true,
        probe: async () => 'v20.18.3',
      }),
    ).rejects.toThrow(/prepare-cursor-node-runtime/);
  });

  it('EMPACOTADO sem payload: erro (fallback para o sistema NAO e default)', async () => {
    await expect(
      resolveCursorSidecarNode({
        tryInternal: () => null,
        tryPayload: () => null,
        packaged: true,
        env: {},
        probe: async () => 'v24.14.1',
      }),
    ).rejects.toThrow(/LIONCLAW_CURSOR_SIDECAR_SYSTEM_NODE/);
  });

  it('EMPACOTADO sem payload + decisao explicita via env: usa o sistema validando versao', async () => {
    const resolution = await resolveCursorSidecarNode({
      tryInternal: () => null,
      tryPayload: () => null,
      packaged: true,
      env: { LIONCLAW_CURSOR_SIDECAR_SYSTEM_NODE: '1' },
      probe: async () => 'v24.14.1',
    });
    expect(resolution.source).toBe('system');
  });

  it('payload corrompido lanca (nao cai silencioso para o sistema)', async () => {
    await expect(
      resolveCursorSidecarNode({
        tryInternal: () => null,
        tryPayload: () => {
          throw new Error('Payload Node do sidecar Cursor com hash divergente: x');
        },
        packaged: true,
        probe: async () => 'v24.14.1',
      }),
    ).rejects.toThrow(/hash divergente/);
  });
});

describe('resolveCursorPayloadNodeAt', () => {
  const makeDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-payload-'));

  const writePayload = (dir: string, content: string, manifestPatch?: Record<string, unknown>): void => {
    const binary = path.join(dir, 'node.exe');
    fs.writeFileSync(binary, content);
    const manifest = {
      component: 'cursor-sidecar-node',
      target: 'win32-x64',
      version: '22.22.3',
      files: [
        {
          path: 'node.exe',
          sha256: createHash('sha256').update(content).digest('hex'),
          size: Buffer.byteLength(content),
        },
      ],
      ...manifestPatch,
    };
    fs.writeFileSync(path.join(dir, 'node-manifest.json'), JSON.stringify(manifest));
  };

  it('payload valido resolve o binario', () => {
    const dir = makeDir();
    writePayload(dir, 'fake-node-binary');
    expect(resolveCursorPayloadNodeAt(dir, 'win32')).toBe(path.join(dir, 'node.exe'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ausencia limpa retorna null', () => {
    const dir = makeDir();
    expect(resolveCursorPayloadNodeAt(dir, 'win32')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('binario sem manifesto: fail-loud (corrompido nunca vira ausente)', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'node.exe'), 'x');
    expect(() => resolveCursorPayloadNodeAt(dir, 'win32')).toThrow(/incompleto/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('hash divergente: fail-loud', () => {
    const dir = makeDir();
    writePayload(dir, 'fake-node-binary');
    fs.appendFileSync(path.join(dir, 'node.exe'), 'tamper');
    expect(() => resolveCursorPayloadNodeAt(dir, 'win32')).toThrow(/divergente/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('resolveCursorSidecarEntry', () => {
  it('resolve o primeiro candidato existente', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-entry-'));
    const bundle = path.join(dir, 'sidecar.cjs');
    fs.writeFileSync(bundle, '// bundle');
    expect(
      resolveCursorSidecarEntry({ candidates: [path.join(dir, 'nao-existe.cjs'), bundle] }),
    ).toBe(bundle);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bundle ausente: erro cita npm run build:cursor-sidecar', () => {
    expect(() =>
      resolveCursorSidecarEntry({ candidates: ['/nao/existe/sidecar.cjs'] }),
    ).toThrow(/build:cursor-sidecar/);
  });
});

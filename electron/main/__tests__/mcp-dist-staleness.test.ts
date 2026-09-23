import { describe, it, expect } from 'vitest';
import path from 'path';
import { checkMcpDistEntryStaleness, locateMcpDistEntry, newestMtimeMs, type McpDistFs } from '../mcp-dist-staleness';

type Node = { kind: 'dir'; children: Record<string, Node> } | { kind: 'file'; mtimeMs: number };

function dir(children: Record<string, Node>): Node {
  return { kind: 'dir', children };
}

function file(mtimeMs: number): Node {
  return { kind: 'file', mtimeMs };
}

function fakeFs(root: string, tree: Node): McpDistFs {
  const resolve = (target: string): Node | null => {
    const rel = path.relative(root, target);
    if (rel.startsWith('..')) return null;
    let node: Node = tree;
    for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
      if (node.kind !== 'dir') return null;
      const next: Node | undefined = node.children[part];
      if (!next) return null;
      node = next;
    }
    return node;
  };
  return {
    stat: (target) => {
      const node = resolve(target);
      if (!node) return null;
      return {
        isDirectory: () => node.kind === 'dir',
        mtimeMs: node.kind === 'file' ? node.mtimeMs : 0,
      };
    },
    readdir: (target) => {
      const node = resolve(target);
      return node && node.kind === 'dir' ? Object.keys(node.children) : [];
    },
  };
}

const ROOT = path.join('C:', 'repo', 'mcp-servers');
const entry = (id: string, ...rest: string[]) => path.join(ROOT, id, 'dist', ...rest);

function tree(opts: { distMtime: number; srcMtime: number; sharedMtime?: number; pkgMtime?: number }): Node {
  return dir({
    _shared: dir({ 'local-ipc-client.ts': file(opts.sharedMtime ?? 0) }),
    gateway: dir({
      'package.json': file(opts.pkgMtime ?? 0),
      src: dir({ 'index.ts': file(opts.srcMtime), nested: dir({ 'tool-args.ts': file(opts.srcMtime - 1) }) }),
      dist: dir({ gateway: dir({ src: dir({ 'index.js': file(opts.distMtime) }) }) }),
      node_modules: dir({ zod: dir({ 'index.js': file(9_999_999) }) }),
    }),
  });
}

describe('locateMcpDistEntry', () => {
  it('extrai serversRoot e serverId de um entrypoint em dist/ (layout plano e aninhado)', () => {
    expect(locateMcpDistEntry(entry('gateway', 'gateway', 'src', 'index.js'))).toEqual({
      serversRoot: ROOT,
      serverId: 'gateway',
      entryPath: entry('gateway', 'gateway', 'src', 'index.js'),
    });
    expect(locateMcpDistEntry(`${ROOT}/youtube/dist/index.js`)?.serverId).toBe('youtube');
  });

  it('ignora caminhos fora de mcp-servers/<id>/dist/', () => {
    expect(locateMcpDistEntry(path.join('C:', 'repo', 'out', 'main', 'index.js'))).toBeNull();
    expect(locateMcpDistEntry(path.join(ROOT, 'gateway', 'src', 'index.ts'))).toBeNull();
  });
});

describe('checkMcpDistEntryStaleness (fixtures de mtime)', () => {
  const target = entry('gateway', 'gateway', 'src', 'index.js');

  it('dist mais novo que src, package.json e _shared = fresco', () => {
    const fsImpl = fakeFs(ROOT, tree({ distMtime: 1000, srcMtime: 900, sharedMtime: 800, pkgMtime: 700 }));
    expect(checkMcpDistEntryStaleness(target, fsImpl)).toEqual({
      serverId: 'gateway',
      stale: false,
      distMtimeMs: 1000,
      sourceMtimeMs: 900,
    });
  });

  it('src/** mais novo que o dist = desatualizado', () => {
    const fsImpl = fakeFs(ROOT, tree({ distMtime: 1000, srcMtime: 1500 }));
    expect(checkMcpDistEntryStaleness(target, fsImpl)).toMatchObject({ stale: true, sourceMtimeMs: 1500 });
  });

  it('_shared/** mais novo que o dist = desatualizado (helpers dependem do cliente compartilhado)', () => {
    const fsImpl = fakeFs(ROOT, tree({ distMtime: 1000, srcMtime: 500, sharedMtime: 1200 }));
    expect(checkMcpDistEntryStaleness(target, fsImpl)).toMatchObject({ stale: true, sourceMtimeMs: 1200 });
  });

  it('package.json mais novo que o dist = desatualizado', () => {
    const fsImpl = fakeFs(ROOT, tree({ distMtime: 1000, srcMtime: 500, pkgMtime: 1001 }));
    expect(checkMcpDistEntryStaleness(target, fsImpl)).toMatchObject({ stale: true });
  });

  it('mtime igual conta como desatualizado (nunca assume frescor por empate)', () => {
    const fsImpl = fakeFs(ROOT, tree({ distMtime: 1000, srcMtime: 1000 }));
    expect(checkMcpDistEntryStaleness(target, fsImpl)).toMatchObject({ stale: true });
  });

  it('node_modules e dist nao entram no mtime das fontes', () => {
    const fsImpl = fakeFs(ROOT, tree({ distMtime: 1000, srcMtime: 500 }));
    expect(newestMtimeMs(path.join(ROOT, 'gateway'), fsImpl)).toBe(500);
  });

  it('sem src/ (instalacao empacotada) = nao ha o que comparar (null)', () => {
    const fsImpl = fakeFs(
      ROOT,
      dir({ gateway: dir({ dist: dir({ gateway: dir({ src: dir({ 'index.js': file(1) }) }) }) }) }),
    );
    expect(checkMcpDistEntryStaleness(target, fsImpl)).toBeNull();
  });

  it('dist ausente = null (o resolver de entrypoint ja trata a ausencia)', () => {
    const fsImpl = fakeFs(ROOT, dir({ gateway: dir({ src: dir({ 'index.ts': file(1) }) }) }));
    expect(checkMcpDistEntryStaleness(target, fsImpl)).toBeNull();
  });
});

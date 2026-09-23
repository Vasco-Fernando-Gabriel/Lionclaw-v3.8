import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveCodegraphBinary,
  resolveCodegraphSpawn,
  parseCodegraphJson,
  parseStatusText,
  stripAnsi,
} from '../repo-graph/provider-codegraph';

const CMD_TIMEOUT_MS = 120_000;

let fixtureDir = '';
let binary = '';
const resolvedPhysicalBinary = resolveCodegraphBinary();
const requirePhysicalRuntime = process.env.LIONCLAW_REQUIRE_CODEGRAPH_RUNTIME === '1';

function runCli(args: string[]): string {
  const { file, args: spawnArgs, runAsNode, windowsHide } = resolveCodegraphSpawn(binary, args);
  return execFileSync(file, spawnArgs, {
    cwd: fixtureDir,
    encoding: 'utf8',
    timeout: CMD_TIMEOUT_MS,
    env: runAsNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
    windowsHide,
  });
}

beforeAll(() => {
  if (!resolvedPhysicalBinary) return;
  binary = resolvedPhysicalBinary;

  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-cg-fixture-'));
  fs.mkdirSync(path.join(fixtureDir, 'src'));
  fs.writeFileSync(
    path.join(fixtureDir, 'src', 'math.ts'),
    [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      'export function double(x: number): number {',
      '  return add(x, x);',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(fixtureDir, 'src', 'main.ts'),
    ["import { double } from './math';", 'export function run(): number {', '  return double(21);', '}', ''].join('\n'),
  );
}, CMD_TIMEOUT_MS);

afterAll(() => {
  if (fixtureDir) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

(resolvedPhysicalBinary ? describe : describe.skip)('gate de fixture da CLI codegraph (17.1.1, versao pinada)', () => {
  it(
    'init --index cria .codegraph/codegraph.db (flag deprecated ACEITA na 0.9.9)',
    () => {
      runCli(['init', '--index']);
      expect(fs.existsSync(path.join(fixtureDir, '.codegraph', 'codegraph.db'))).toBe(true);
    },
    CMD_TIMEOUT_MS,
  );

  it(
    'status: saida TEXTO parseavel best-effort (Files/Nodes/Edges) — nunca JSON assumido',
    () => {
      const out = runCli(['status']);
      const stats = parseStatusText(out);
      expect(stats.files).toBe(2);
      expect(stats.nodes).toBeGreaterThan(0);
      expect(stats.edges).toBeGreaterThan(0);
      expect(stripAnsi(out)).toContain('Files:');
    },
    CMD_TIMEOUT_MS,
  );

  it(
    'query <termo> --json: array de { node, score } com simbolos do fixture',
    () => {
      const out = runCli(['query', 'add', '--json']);
      const parsed = parseCodegraphJson(out) as Array<{
        node: { name: string; kind: string; filePath: string };
        score: number;
      }>;
      expect(Array.isArray(parsed)).toBe(true);
      const names = parsed.map((entry) => entry.node.name);
      expect(names).toContain('add');
    },
    CMD_TIMEOUT_MS,
  );

  it(
    'query --kind e --limit aceitos',
    () => {
      const out = runCli(['query', 'add', '--kind', 'function', '--limit', '5', '--json']);
      const parsed = parseCodegraphJson(out) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeLessThanOrEqual(5);
    },
    CMD_TIMEOUT_MS,
  );

  it(
    'callers <simbolo> --json: { symbol, callers: [...] } (double chama add)',
    () => {
      const out = runCli(['callers', 'add', '--limit', '10', '--json']);
      const parsed = parseCodegraphJson(out) as {
        symbol: string;
        callers: Array<{ name: string }>;
      };
      expect(parsed.symbol).toBe('add');
      expect(parsed.callers.map((c) => c.name)).toContain('double');
    },
    CMD_TIMEOUT_MS,
  );

  it(
    'callees <simbolo> --json: { symbol, callees: [...] } (double chama add)',
    () => {
      const out = runCli(['callees', 'double', '--limit', '10', '--json']);
      const parsed = parseCodegraphJson(out) as {
        symbol: string;
        callees: Array<{ name: string }>;
      };
      expect(parsed.symbol).toBe('double');
      expect(parsed.callees.map((c) => c.name)).toContain('add');
    },
    CMD_TIMEOUT_MS,
  );

  it(
    'impact <simbolo> --depth --json (SEM --limit: drift da 0.9.9 documentado no provider)',
    () => {
      const out = runCli(['impact', 'add', '--depth', '2', '--json']);
      const parsed = parseCodegraphJson(out) as {
        symbol: string;
        affected: Array<{ name: string }>;
      };
      expect(parsed.symbol).toBe('add');
      const names = parsed.affected.map((a) => a.name);
      expect(names).toContain('double');
      expect(() => runCli(['impact', 'add', '--limit', '5', '--json'])).toThrow();
    },
    CMD_TIMEOUT_MS,
  );

  it(
    'files --json: lista de { path, language, nodeCount, size }',
    () => {
      const out = runCli(['files', '--json']);
      const parsed = parseCodegraphJson(out) as Array<{
        path: string;
        nodeCount: number;
      }>;
      expect(Array.isArray(parsed)).toBe(true);
      const paths = parsed.map((f) => f.path);
      expect(paths).toContain('src/math.ts');
      expect(paths).toContain('src/main.ts');
    },
    CMD_TIMEOUT_MS,
  );

  it(
    'sync: incremental apos edicao (exit 0; novo simbolo encontravel)',
    () => {
      fs.appendFileSync(
        path.join(fixtureDir, 'src', 'math.ts'),
        'export function triple(x: number): number {\n  return x * 3;\n}\n',
      );
      runCli(['sync']);
      const out = runCli(['query', 'triple', '--json']);
      const parsed = parseCodegraphJson(out) as Array<{
        node: { name: string };
      }>;
      expect(parsed.map((entry) => entry.node.name)).toContain('triple');
    },
    CMD_TIMEOUT_MS,
  );

  it(
    'index --force: re-index completo (exit 0; graph continua consultavel)',
    () => {
      runCli(['index', '--force']);
      const out = runCli(['query', 'run', '--json']);
      const parsed = parseCodegraphJson(out) as Array<{
        node: { name: string };
      }>;
      expect(parsed.map((entry) => entry.node.name)).toContain('run');
    },
    CMD_TIMEOUT_MS,
  );
});

describe('disponibilidade da closure física CodeGraph', () => {
  (requirePhysicalRuntime ? it : it.skip)('é obrigatória nos jobs nativos de package', () => {
    expect(resolvedPhysicalBinary, 'closure física target-specific do CodeGraph ausente').toBeTruthy();
  });
});

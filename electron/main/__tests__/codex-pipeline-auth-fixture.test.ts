
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getOfficialPhaseCodexSpawnExtraArgs,
  listConfiguredCodexMcpServerNames,
} from '../codex-pipeline-config';


function resolveCodexBinaryForFixture(): string | null {
  try {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], {
      encoding: 'utf-8',
    });
    if (probe.status !== 0) return null;
    const bin = probe.stdout.split('\n')[0]?.trim();
    if (!bin) return null;

    return path.isAbsolute(bin) ? bin : path.resolve(process.cwd(), bin);
  } catch {
    return null;
  }
}

const codexBin = resolveCodexBinaryForFixture();
const realCodexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const realAuthPath = path.join(realCodexHome, 'auth.json');
const realConfigPath = path.join(realCodexHome, 'config.toml');
const hasAuth = fs.existsSync(realAuthPath);
const canRun = codexBin !== null && hasAuth;
const canSampleChildren = process.platform !== 'win32';

const PROMPT = 'Responda apenas com a palavra: ok';


function extractServerCommandTokens(configRaw: string): string[] {
  const tokens = new Set<string>();
  let inServerBlock = false;
  for (const line of configRaw.split('\n')) {
    const header = /^\s*\[(.+?)\]\s*$/.exec(line);
    if (header) {
      inServerBlock = header[1].startsWith('mcp_servers.');
      continue;
    }
    if (!inServerBlock) continue;
    for (const m of line.matchAll(/"([^"]+)"/g)) {
      const v = m[1];
      if ((v.includes('/') || v.includes('\\')) && v.length > 8) tokens.add(v);
    }
  }
  return [...tokens];
}

function sampleChildren(pid: number): string[] {
  const ps = spawnSync('ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf-8' });
  if (ps.status !== 0) return [];
  const out: string[] = [];
  for (const line of ps.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[2]) === pid) out.push(m[3]);
  }
  return out;
}

interface ExecRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  childCommandLines: string[];
}

function runCodexExecSamplingChildren(bin: string, extraArgs: string[]): Promise<ExecRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...extraArgs, 'exec', '--skip-git-repo-check', PROMPT], {
      cwd: os.tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const childCommandLines = new Set<string>();
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });

    const sampler = canSampleChildren
      ? setInterval(() => {
          if (typeof child.pid === 'number') {
            for (const line of sampleChildren(child.pid)) childCommandLines.add(line);
          }
        }, 250)
      : null;

    child.on('error', (err) => {
      if (sampler) clearInterval(sampler);
      reject(err);
    });
    child.on('exit', (code) => {
      if (sampler) clearInterval(sampler);
      resolve({ exitCode: code, stdout, stderr, childCommandLines: [...childCommandLines] });
    });
  });
}


describe.skipIf(!canRun)('gate 17.1.5 - codex com frota minima configura E autentica (LIVE)', () => {
  it(
    'B6-AC1 primario: exec real com os overrides -c -> resposta do modelo (auth OK) e NENHUM server do config sobe (ps/children)',
    async () => {
      const extraArgs = getOfficialPhaseCodexSpawnExtraArgs();
      const serverNames = listConfiguredCodexMcpServerNames();

      expect(extraArgs.length).toBeGreaterThan(0);
      expect(extraArgs.length % 2).toBe(0);
      expect(extraArgs.length).toBeLessThanOrEqual(serverNames.length * 2);

      const result = await runCodexExecSamplingChildren(codexBin as string, extraArgs);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toContain('ok');

      if (canSampleChildren && serverNames.length > 0 && fs.existsSync(realConfigPath)) {
        const tokens = extractServerCommandTokens(fs.readFileSync(realConfigPath, 'utf-8'));
        expect(tokens.length).toBeGreaterThan(0);
        const offenders = result.childCommandLines.filter((cmd) =>
          tokens.some((t) => cmd.includes(t)),
        );
        expect(offenders).toEqual([]);
      }
    },
    240_000,
  );

  it('auth intacta com o override: `codex -c ... login status` continua logado', () => {
    const extraArgs = getOfficialPhaseCodexSpawnExtraArgs();
    const res = spawnSync(codexBin as string, [...extraArgs, 'login', 'status'], {
      encoding: 'utf-8',
    });
    expect(res.status).toBe(0);
    expect(`${res.stdout}\n${res.stderr}`.toLowerCase()).toMatch(/logged in/);
  }, 60_000);

  it('fallback CODEX_HOME dedicado + symlink de auth.json autentica (mecanismo validado em home temporario; auth real intocado)', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pipeline-home-fixture-'));
    try {
      fs.writeFileSync(
        path.join(tmpHome, 'config.toml'),
        '# config minimo do fixture B6 (sem nenhum mcp_server)\n',
        'utf-8',
      );
      fs.symlinkSync(realAuthPath, path.join(tmpHome, 'auth.json'));

      const res = spawnSync(codexBin as string, ['login', 'status'], {
        encoding: 'utf-8',
        env: { ...process.env, CODEX_HOME: tmpHome },
      });
      expect(res.status).toBe(0);
      expect(`${res.stdout}\n${res.stderr}`.toLowerCase()).toMatch(/logged in/);

      expect(fs.lstatSync(path.join(tmpHome, 'auth.json')).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(realAuthPath).isSymbolicLink()).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!process.env.CODEX_FIXTURE_CONTROL)(
    'controle (CODEX_FIXTURE_CONTROL=1): SEM override os servers do config sobem como children',
    async () => {
      const serverNames = listConfiguredCodexMcpServerNames();
      if (serverNames.length === 0 || !canSampleChildren) return;

      const result = await runCodexExecSamplingChildren(codexBin as string, []);
      expect(result.exitCode).toBe(0);

      const tokens = extractServerCommandTokens(fs.readFileSync(realConfigPath, 'utf-8'));
      const seen = result.childCommandLines.filter((cmd) => tokens.some((t) => cmd.includes(t)));
      expect(seen.length).toBeGreaterThan(0);
    },
    300_000,
  );
});

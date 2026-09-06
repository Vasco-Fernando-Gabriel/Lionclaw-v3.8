
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
  claudeAgentSdkEntryRelative,
  resolvePackagedClaudeCliEntry,
  resetDistributionRuntimeValidationCacheForTests,
  type DistributionRuntimeTarget,
} from '../distribution-runtime';

const TARGETS: DistributionRuntimeTarget[] = ['linux-x64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];

describe('claudeAgentSdkEntryRelative', () => {
  it.each(TARGETS)('%s -> node_modules/@anthropic-ai/claude-agent-sdk-<target>/claude[.exe]', (target) => {
    const binary = target.startsWith('win32-') ? 'claude.exe' : 'claude';
    expect(claudeAgentSdkEntryRelative(target)).toBe(
      path.join('node_modules', '@anthropic-ai', `claude-agent-sdk-${target}`, binary),
    );
  });

  it('nunca aponta para cli.js', () => {
    for (const target of TARGETS) {
      expect(claudeAgentSdkEntryRelative(target).endsWith('cli.js')).toBe(false);
    }
  });
});

describe('resolvePackagedClaudeCliEntry', () => {
  const tmpRoots: string[] = [];

  beforeEach(() => {
    resetDistributionRuntimeValidationCacheForTests();
  });

  afterAll(() => {
    for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
  });

  it('procura o binario nativo do target dentro da closure staged e lanca listando o candidato', () => {
    const devRoot = path.join('/dev', 'out');
    const probed: string[] = [];
    expect(() =>
      resolvePackagedClaudeCliEntry({
        platform: 'win32',
        arch: 'x64',
        devRoot,
        packaged: false,
        exists: (candidate) => {
          probed.push(candidate);
          return false;
        },
      }),
    ).toThrow(/Claude CLI físico não encontrado/);

    const expected = path.join(
      devRoot,
      'runtime',
      'node-tools',
      'win32-x64',
      'claude-agent-sdk',
      claudeAgentSdkEntryRelative('win32-x64'),
    );
    expect(probed).toEqual([expected]);
    expect(probed.some((candidate) => candidate.endsWith('cli.js'))).toBe(false);
  });

  it('em linux o candidato e o binario `claude` sem extensao', () => {
    const probed: string[] = [];
    expect(() =>
      resolvePackagedClaudeCliEntry({
        platform: 'linux',
        arch: 'x64',
        devRoot: '/dev/out',
        packaged: false,
        exists: (candidate) => {
          probed.push(candidate);
          return false;
        },
      }),
    ).toThrow();
    expect(probed).toHaveLength(1);
    expect(path.basename(probed[0])).toBe('claude');
    expect(probed[0]).toContain(path.join('claude-agent-sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64'));
  });

  it('com payload fisico e manifesto validos devolve o path do binario nativo', () => {
    const target: DistributionRuntimeTarget = 'win32-x64';
    const devRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-claude-entry-')));
    tmpRoots.push(devRoot);

    const relative = claudeAgentSdkEntryRelative(target);
    const toolRoot = path.join(devRoot, 'runtime', 'node-tools', target, 'claude-agent-sdk');
    const binaryPath = path.join(toolRoot, relative);
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    const bytes = Buffer.from('fake native engine');
    fs.writeFileSync(binaryPath, bytes);

    const manifestDir = path.join(devRoot, 'distribution', 'manifests', 'claude-agent-sdk');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, `${target}.json`),
      JSON.stringify({
        component: 'claude-agent-sdk',
        target,
        files: [
          {
            path: relative.split(path.sep).join('/'),
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
            kind: 'file',
          },
        ],
      }),
    );

    const resolved = resolvePackagedClaudeCliEntry({
      platform: 'win32',
      arch: 'x64',
      devRoot,
      packaged: false,
      exists: (candidate) => fs.existsSync(candidate),
    });
    expect(resolved).toBe(binaryPath);
    expect(path.basename(resolved)).toBe('claude.exe');
  });
});

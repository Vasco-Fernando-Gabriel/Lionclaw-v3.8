import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSwarmToolDispatch, createSwarmPermission, swarmEffectiveTools } from '../swarm-policy';
import { createWatchdog } from '../watchdog';
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-policy-'));
  dirs.push(cwd);
  const abort = new AbortController();
  const writer = vi.fn(async (_s: string) => {});
  const opts = {
    cwd,
    findingsPath: path.join(cwd, 'findings.md'),
    allowedTools: swarmEffectiveTools(['Read', 'Glob', 'Grep', 'Write', 'Bash', 'Edit', 'Agent', 'mcp__evil__write']),
    signal: abort.signal,
    writeFindings: writer,
  };
  return { ...opts, abort, writer, dispatch: createSwarmToolDispatch(opts) };
}
describe('Swarm effective policy', () => {
  it('blocks shell, editing, delegation, unknown MCP and other attempts while writing through host', async () => {
    const f = await fixture();
    for (const name of ['Bash', 'Edit', 'Agent', 'mcp__evil__write'])
      expect((await f.dispatch(name, { command: 'touch victim' })).isError).toBe(true);
    expect((await f.dispatch('Write', { file_path: path.join(f.cwd, 'other.md'), content: 'attack' })).isError).toBe(
      true,
    );
    expect(f.writer).not.toHaveBeenCalled();
    expect((await f.dispatch('Write', { file_path: f.findingsPath, content: 'evidence' })).isError).toBe(false);
    expect(f.writer).toHaveBeenCalledExactlyOnceWith('evidence');
  });
  it('rejects symlink read escapes and revoked writes', async () => {
    const f = await fixture();
    await fs.symlink(os.tmpdir(), path.join(f.cwd, 'escape'));
    expect((await f.dispatch('Read', { file_path: path.join(f.cwd, 'escape', 'outside') })).isError).toBe(true);
    f.abort.abort();
    await expect(f.dispatch('Write', { file_path: f.findingsPath, content: 'late' })).rejects.toThrow();
    expect(f.writer).not.toHaveBeenCalled();
  });
  it('Claude cannot get native Write approval, even to its findings', async () => {
    const f = await fixture();
    const permission = createSwarmPermission(f);
    const response = await permission.canUseTool!(
      'Write',
      { file_path: f.findingsPath, content: 'report' },
      { signal: f.signal, toolUseID: 't', requestId: 'test-t' },
    );
    expect(response?.behavior).toBe('deny');
    expect(f.writer).toHaveBeenCalledWith('report');
  });
  it('reads and searches real fixture without shell', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, 'code.ts'), 'const needle = 1;');
    expect((await f.dispatch('Grep', { pattern: 'needle|absent' })).result).toContain('code.ts:1:const needle');
    expect((await f.dispatch('Read', { file_path: 'code.ts' })).result).toBe('const needle = 1;');
    expect((await f.dispatch('Glob', { pattern: '**/*.ts' })).result).toContain('code.ts');
    expect((await f.dispatch('Grep', { pattern: '[' })).isError).toBe(true);
  });
});
describe('Swarm watchdog lifecycle primitive', () => {
  it('activity extends idle but never hard timeout; stop removes timers', () => {
    vi.useFakeTimers();
    const idle = vi.fn();
    const hard = vi.fn();
    const w = createWatchdog(100, idle, { limitMs: 250, onHardTimeout: hard });
    vi.advanceTimersByTime(90);
    w.reset();
    vi.advanceTimersByTime(90);
    w.reset();
    vi.advanceTimersByTime(70);
    expect(idle).not.toHaveBeenCalled();
    expect(hard).toHaveBeenCalledTimes(1);
    w.stop();
    vi.advanceTimersByTime(500);
    expect(idle).not.toHaveBeenCalled();
  });
});

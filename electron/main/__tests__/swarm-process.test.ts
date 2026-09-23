import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSwarmProcessOwner } from '../agent-runtime/swarm-process';

describe('createSwarmProcessOwner', () => {
  it('supervisor grava o pid no marker e repassa stdout/exit do worker', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-owner-'));
    const owner = createSwarmProcessOwner(directory);
    const controller = new AbortController();
    const child = owner.spawnProcess({
      command: 'node',
      args: [
        '-e',
        'process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("worker-ok");process.exit(7)})',
      ],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      signal: controller.signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const markers = fs.readdirSync(directory).filter((name) => name.startsWith('.owner-'));
    expect(markers).toHaveLength(1);
    const marker = JSON.parse(fs.readFileSync(path.join(directory, markers[0]), 'utf8')) as { pid: number | null };
    expect(stderr).toBe('');
    expect(typeof marker.pid).toBe('number');
    expect(stdout).toBe('worker-ok');
    expect(exitCode).toBe(7);
    await owner.closeConfirmed();
    fs.rmSync(directory, { recursive: true, force: true });
  }, 30_000);

  it('morte do host (fd 3 fechado) encerra supervisor e worker', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-owner-'));
    const owner = createSwarmProcessOwner(directory);
    const controller = new AbortController();
    const child = owner.spawnProcess({
      command: 'node',
      args: ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      signal: controller.signal,
    });
    child.stdout.resume();
    child.stderr.resume();
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const markerPath = path.join(directory, await waitForMarker(directory));
    expect(typeof (JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { pid: unknown }).pid).toBe('number');
    (child.stdio[3] as NodeJS.WritableStream).end();
    await expect(
      Promise.race([
        exited,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('supervisor nao encerrou apos fechamento do fd 3')), 10_000),
        ),
      ]),
    ).resolves.toBeUndefined();
    await owner.closeConfirmed();
    fs.rmSync(directory, { recursive: true, force: true });
  }, 30_000);
});

async function waitForMarker(directory: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const marker = fs.readdirSync(directory).find((name) => name.startsWith('.owner-'));
    if (marker) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(directory, marker), 'utf8')) as { pid: unknown };
        if (typeof parsed.pid === 'number') return marker;
      } catch {
        /* marker ainda sendo escrito */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('marker do supervisor nao apareceu');
}

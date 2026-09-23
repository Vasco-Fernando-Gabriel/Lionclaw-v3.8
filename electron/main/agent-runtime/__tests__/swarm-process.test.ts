import { it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Duplex } from 'node:stream';
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
import { createSwarmProcessOwner, recoverSwarmProcessMarker } from '../swarm-process';

it('real supervised process exits after owner pipe EOF, with durable ownership before worker execution', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-owner-'));
  const owner = createSwarmProcessOwner(dir);
  const child = owner.spawnProcess({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
    env: process.env,
    cwd: dir,
    signal: new AbortController().signal,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
    });
    const marker = (await fs.readdir(dir)).find((n) => n.startsWith('.owner-'))!;
    expect(JSON.parse(await fs.readFile(path.join(dir, marker), 'utf8')).pid).toBe(child.pid);
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    (child.stdio[3] as Duplex).destroy();
    await exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  } finally {
    await owner.closeConfirmed();
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 10000);

it('abort kills and confirms the supervised process before resolving close', async () => {
  const abort = new AbortController();
  const owner = createSwarmProcessOwner();
  const child = owner.spawnProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    env: process.env,
    signal: abort.signal,
  });
  abort.abort();
  await owner.closeConfirmed();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

it('recovery distinguishes pre-spawn intent and reused PID from a live owned supervisor', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-recovery-'));
  const marker = path.join(dir, '.owner-00000000-0000-0000-0000-000000000000.json');
  try {
    await fs.writeFile(marker, JSON.stringify({ pid: null }));
    expect(await recoverSwarmProcessMarker(marker)).toBe(true);
    await fs.writeFile(marker, JSON.stringify({ pid: process.pid }));
    expect(await recoverSwarmProcessMarker(marker)).toBe(true);
    const owner = createSwarmProcessOwner(dir);
    const child = owner.spawnProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
      env: process.env,
      cwd: dir,
      signal: new AbortController().signal,
    });
    try {
      await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
      const live = (await fs.readdir(dir)).find((name) => name !== path.basename(marker))!;
      expect(await recoverSwarmProcessMarker(path.join(dir, live))).toBe(true);
      await owner.closeConfirmed();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      await owner.closeConfirmed();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 10000);

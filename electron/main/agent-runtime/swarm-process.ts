import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import {
  resolveInternalNodeBinary,
  isPackagedDistributionRuntime,
  minimalInternalRuntimeEnv,
} from '../distribution-runtime';
import { DETACH_FOR_TREE_KILL, killProcessTree } from '../kill-process-tree';

const SUPERVISOR = String.raw`
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const owner=new (require('node:net').Socket)({fd:3,readable:true,writable:false,allowHalfOpen:false});
const marker=process.argv[1];
if(marker){const fd=fs.openSync(marker,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|(fs.constants.O_NOFOLLOW||0));fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));fs.fsyncSync(fd);fs.closeSync(fd)}
const worker=spawn(process.argv[2],process.argv.slice(3),{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:process.platform==='win32'&&/\.(cmd|bat)$/i.test(process.argv[2])});
const stop=()=>{
 if(process.platform==='win32') {
  const killer=spawn('taskkill',['/pid',String(process.pid),'/t','/f'],{stdio:'ignore'});
  killer.on('error',()=>{worker.kill('SIGKILL');process.exit(1)});
 } else {try{process.kill(-process.pid,'SIGKILL')}catch{worker.kill('SIGKILL');process.exit(1)}}
};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
owner.on('end',stop);owner.on('error',stop);owner.resume();
process.stdin.pipe(worker.stdin);worker.stdout.pipe(process.stdout);worker.stderr.pipe(process.stderr);
worker.stdin.on('error',()=>{});
worker.on('error',e=>{process.exitCode=1;owner.destroy();process.stdin.destroy();process.stderr.write(String(e),()=>process.exit())});
worker.on('close',(code)=>{process.exitCode=code===null?1:code;owner.destroy();process.stdin.destroy();process.stdout.write('',()=>process.exit())});
`;

export function createSwarmProcessOwner(directory?: string) {
  const children: ChildProcessWithoutNullStreams[] = [];
  const spawnProcess = (options: SpawnOptions): ChildProcessWithoutNullStreams => {
    options.signal.throwIfAborted();
    let marker = '';
    if (directory) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      marker = path.join(directory, `.owner-${randomUUID()}.json`);
      const fd = fs.openSync(marker, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: null }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    let guardianNode: string;
    try {
      guardianNode = resolveInternalNodeBinary();
    } catch (error) {
      if (isPackagedDistributionRuntime()) throw error;
      guardianNode = process.execPath;
    }
    const nodeWorker = options.command === 'node' || options.command === 'node.exe';
    const workerCommand = nodeWorker ? guardianNode : options.command;
    const workerEnv = nodeWorker ? minimalInternalRuntimeEnv(guardianNode, options.env) : options.env;
    const child = spawn(guardianNode, ['-e', SUPERVISOR.replace(/\n/g, ' '), marker, workerCommand, ...options.args], {
      cwd: options.cwd,
      env: { ...workerEnv, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      detached: DETACH_FOR_TREE_KILL,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    const killSingle = child.kill.bind(child);
    child.kill = (signal = 'SIGTERM'): boolean => {
      if (!child.pid) return false;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('error', () => killSingle(signal));
        return true;
      }
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        return killSingle(signal);
      }
    };
    children.push(child);
    const abort = (): void => killProcessTree(child, 'SIGKILL');
    options.signal.addEventListener('abort', abort, { once: true });
    child.once('exit', () => options.signal.removeEventListener('abort', abort));
    if (options.signal.aborted) abort();
    return child;
  };
  const closeConfirmed = async (): Promise<void> => {
    await Promise.all(
      children.map(async (child) => {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
        killProcessTree(child, 'SIGKILL');
        await new Promise<void>((resolve) => {
          const exited = (): void => resolve();
          child.once('exit', exited);
          if (child.exitCode !== null || child.signalCode !== null) exited();
        });
      }),
    );
  };
  return { spawnProcess, closeConfirmed };
}

export async function recoverSwarmProcessMarker(marker: string): Promise<boolean> {
  const { promisify } = await import('node:util');
  const exec = promisify((await import('node:child_process')).execFile);
  const owners = async (): Promise<number[]> => {
    if (process.platform === 'win32') {
      const { stdout } = await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
        ],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      const data = JSON.parse(stdout) as unknown;
      const rows = Array.isArray(data) ? data : [data];
      return rows.flatMap((row) => {
        const record = row as { ProcessId?: unknown; CommandLine?: unknown };
        return typeof record.ProcessId === 'number' &&
          typeof record.CommandLine === 'string' &&
          record.CommandLine.includes(marker) &&
          record.CommandLine.includes('node:child_process')
          ? [record.ProcessId]
          : [];
      });
    }
    const { stdout } = await exec('ps', ['-axo', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 });
    return stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return match && match[2].includes(marker) && match[2].includes('node:child_process') ? [Number(match[1])] : [];
    });
  };
  try {
    for (const pid of await owners()) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
      if (process.platform === 'win32') await exec('taskkill', ['/pid', String(pid), '/t', '/f']);
      else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
    for (let i = 0; i < 50; i++) {
      if ((await owners()).length === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  } catch {
    return false;
  }
}

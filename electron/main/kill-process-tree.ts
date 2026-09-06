import { spawn, type ChildProcess } from 'child_process';
import { createLogger } from './logger';

const logger = createLogger('process-tree');

export const DETACH_FOR_TREE_KILL = process.platform !== 'win32';

export function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = proc.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    } catch (error) {
      logger.warn({ pid, error }, 'taskkill falhou; usando proc.kill como fallback');
      try { proc.kill(); } catch { /* ja morreu */ }
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try { proc.kill(signal); } catch { /* ja morreu */ }
  }
}

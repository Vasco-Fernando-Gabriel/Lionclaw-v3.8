import path from 'path';
import fs from 'fs';
import { getLionClawHome } from './paths';

const STATE_FILE = path.join(getLionClawHome(), 'data', '.kb-active-agent');

export function setActiveAgentId(agentId: string): void {
  fs.writeFileSync(STATE_FILE, agentId, 'utf-8');
}

export function getActiveAgentId(): string {
  try {
    return fs.readFileSync(STATE_FILE, 'utf-8').trim();
  } catch {
    return '';
  }
}

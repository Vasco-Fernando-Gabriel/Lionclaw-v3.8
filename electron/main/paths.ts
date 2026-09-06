import path from 'path';
import os from 'os';

export function getLionClawHome(): string {
  const testHome = process.env['LIONCLAW_TEST_HOME']?.trim();
  if (process.env['NODE_ENV'] === 'test' && testHome) {
    return path.resolve(testHome);
  }
  return path.join(os.homedir(), '.lionclaw');
}

export function getAgentCwd(_isOnboarding: boolean): string {
  return getLionClawHome();
}

export function getBackgroundCwd(): string {
  return path.join(getLionClawHome(), 'background');
}

export function getCronCwd(): string {
  return path.join(getLionClawHome(), 'cron');
}

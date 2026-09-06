import { OfficialAppServerDriver } from './official-app-server-driver';

export function getActiveCodexImplementation(): 'official-app-server' {
  return 'official-app-server';
}

export function createCodexDriver(): OfficialAppServerDriver {
  return new OfficialAppServerDriver();
}

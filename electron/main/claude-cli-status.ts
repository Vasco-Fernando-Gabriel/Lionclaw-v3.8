import fs from 'fs';
import os from 'os';
import path from 'path';
import { getApiKey } from './secrets-vault';
import { getClaudeCodeExecutablePath } from './pipeline-shared/sdk-bootstrap';

export type ClaudeAuthMode = 'oauth' | 'api-key' | 'none';

export interface ClaudeCliStatus {
  installed: boolean;
  authenticated: boolean;
  authMode: ClaudeAuthMode;
  resolvedPath: string;
  resolveError: string | null;
}

export async function detectClaudeAuthMode(): Promise<ClaudeAuthMode> {
  if (process.env.ANTHROPIC_API_KEY) return 'api-key';
  const claudeDir = path.join(os.homedir(), '.claude');
  if (fs.existsSync(claudeDir)) return 'oauth';
  try {
    const apiKey = await getApiKey();
    if (apiKey) return 'api-key';
  } catch {}
  return 'none';
}

export async function detectClaudeCliStatus(): Promise<ClaudeCliStatus> {
  let resolvedPath = '';
  let resolveError: string | null = null;
  try {
    resolvedPath = getClaudeCodeExecutablePath();
  } catch (err) {
    resolveError = err instanceof Error ? err.message : String(err);
  }
  const installed = resolvedPath !== '' && fs.existsSync(resolvedPath);
  const authMode = await detectClaudeAuthMode();
  return {
    installed,
    authenticated: authMode !== 'none',
    authMode,
    resolvedPath,
    resolveError,
  };
}

export function describeClaudeCliUnavailable(status: ClaudeCliStatus): string | null {
  if (!status.installed) {
    return status.resolveError
      ? `Engine Claude Code nao encontrado: ${status.resolveError}`
      : 'Engine Claude Code nao encontrado.';
  }
  if (!status.authenticated) {
    return 'Claude Code sem autenticacao (faca login com `claude` ou configure ANTHROPIC_API_KEY).';
  }
  return null;
}


import crypto from 'crypto';
import { createLogger } from './logger';

const logger = createLogger('helper-identity');

export const LIONCLAW_HELPER_TOKEN_ENV = 'LIONCLAW_HELPER_TOKEN';

export const CHAT_GATED_HELPER_IDS: ReadonlySet<string> = new Set([
  'lionclaw-pipeline-control',
  'lionclaw-dynamic-workflows',
]);

export const ALWAYS_IDENTITY_HELPER_IDS: ReadonlySet<string> = new Set([
  'lionclaw-agents',
  'lionclaw-preview',
  'lionclaw-telegram',
  'lionclaw-toolscript',
]);

export const PROCESS_IDENTITY_HELPER_IDS: ReadonlySet<string> = new Set([
  ...CHAT_GATED_HELPER_IDS,
  ...ALWAYS_IDENTITY_HELPER_IDS,
]);

export const IDENTITY_METHOD_OWNERS: Readonly<Record<string, string>> = Object.freeze({
  preview_open: 'lionclaw-preview',
  preview_capture: 'lionclaw-preview',
  telegram_notify: 'lionclaw-telegram',
  run_tool_script: 'lionclaw-toolscript',
});

export const GATED_METHOD_PREFIXES: ReadonlyArray<{
  prefix: string;
  serverId: string;
}> = [
  { prefix: 'pipeline_', serverId: 'lionclaw-pipeline-control' },
  { prefix: 'dynamic_workflow_', serverId: 'lionclaw-dynamic-workflows' },
];

export function gatedServerIdForMethod(method: string): string | null {
  for (const { prefix, serverId } of GATED_METHOD_PREFIXES) {
    if (method.startsWith(prefix)) return serverId;
  }
  return null;
}

const mintedTokenOwners = new Map<string, string>();

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function truncateHash(tokenHash: string): string {
  return tokenHash.slice(0, 12);
}

export function mintHelperToken(serverId = 'unknown-helper'): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  mintedTokenOwners.set(tokenHash, serverId.trim().toLowerCase() || 'unknown-helper');
  logger.debug(
    { tokenHash: truncateHash(tokenHash), serverId, activeTokens: mintedTokenOwners.size },
    'helper token cunhado',
  );
  return token;
}

export function isValidHelperToken(token: string): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  return mintedTokenOwners.has(hashToken(token));
}

export function resolveHelperTokenOwner(token: string): string | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  return mintedTokenOwners.get(hashToken(token)) ?? null;
}

export function revokeHelperToken(token: string): void {
  if (typeof token !== 'string' || token.length === 0) return;
  const tokenHash = hashToken(token);
  const removed = mintedTokenOwners.delete(tokenHash);
  logger.debug(
    { tokenHash: truncateHash(tokenHash), removed, activeTokens: mintedTokenOwners.size },
    'helper token revogado',
  );
}

export function __resetHelperIdentityForTests(): void {
  mintedTokenOwners.clear();
}

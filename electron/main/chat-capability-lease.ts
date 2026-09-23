import crypto from 'crypto';
import { createLogger } from './logger';
import { normalizeChatCapabilityServerId } from './chat-capability-context';

const logger = createLogger('chat-capability-lease');

export const INTERNAL_CAPABILITY_COORDINATORS = [
  'pipeline-drive-coordinator',
  'dynamic-workflow-ignition',
  'scheduler-internal',
] as const;

export type InternalCapabilityCoordinator = (typeof INTERNAL_CAPABILITY_COORDINATORS)[number];

const COORDINATOR_SET: ReadonlySet<string> = new Set(INTERNAL_CAPABILITY_COORDINATORS);

export interface InternalCapabilityLeaseInput {
  coordinator: InternalCapabilityCoordinator;
  driveProjectId: string;
  driveTurnId: string;
  allowedServerIds: string[];
  allowedToolPrefixes: string[];
  ttlMs: number;
  maxUses?: number;
}

export interface VerifyInternalCapabilityLeaseInput {
  token: string;
  coordinator: string;
  driveProjectId: string;
  driveTurnId: string;
  serverId: string;
  toolName: string;
  dryRun?: boolean;
  denyLogLevel?: 'warn' | 'debug';
}

interface LeaseRecord {
  coordinator: InternalCapabilityCoordinator;
  driveProjectId: string;
  driveTurnId: string;
  allowedServerIds: ReadonlySet<string>;
  allowedToolPrefixes: readonly string[];
  createdAt: number;
  expiresAt: number;
  maxUses?: number;
  uses: number;
}

const leases = new Map<string, LeaseRecord>();

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function truncateHash(tokenHash: string): string {
  return tokenHash.slice(0, 12);
}

function sweepExpiredLeases(now: number): void {
  for (const [tokenHash, record] of leases) {
    if (now >= record.expiresAt) {
      leases.delete(tokenHash);
      logger.debug(
        { tokenHash: truncateHash(tokenHash), coordinator: record.coordinator },
        'lease interna expirada removida na varredura',
      );
    }
  }
}

export function createInternalCapabilityLease(input: InternalCapabilityLeaseInput): { token: string } {
  const now = Date.now();
  sweepExpiredLeases(now);

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);

  leases.set(tokenHash, {
    coordinator: input.coordinator,
    driveProjectId: input.driveProjectId,
    driveTurnId: input.driveTurnId,
    allowedServerIds: new Set(input.allowedServerIds.map(normalizeChatCapabilityServerId)),
    allowedToolPrefixes: [...input.allowedToolPrefixes],
    createdAt: now,
    expiresAt: now + input.ttlMs,
    maxUses: input.maxUses,
    uses: 0,
  });

  logger.debug(
    {
      tokenHash: truncateHash(tokenHash),
      coordinator: input.coordinator,
      driveProjectId: input.driveProjectId,
      driveTurnId: input.driveTurnId,
      ttlMs: input.ttlMs,
      maxUses: input.maxUses,
    },
    'lease interna criada',
  );
  return { token };
}

export function verifyInternalCapabilityLease(input: VerifyInternalCapabilityLeaseInput): boolean {
  const deny = (reason: string, tokenHash?: string): false => {
    const log = input.denyLogLevel === 'debug' ? logger.debug.bind(logger) : logger.warn.bind(logger);
    log(
      {
        reason,
        tokenHash: tokenHash !== undefined ? truncateHash(tokenHash) : undefined,
        coordinator: input.coordinator,
        driveProjectId: input.driveProjectId,
        driveTurnId: input.driveTurnId,
        serverId: input.serverId,
        toolName: input.toolName,
      },
      'lease interna NEGADA',
    );
    return false;
  };

  if (typeof input.token !== 'string' || input.token.length === 0) {
    return deny('token-ausente');
  }

  const tokenHash = hashToken(input.token);
  const record = leases.get(tokenHash);
  if (!record) return deny('token-desconhecido', tokenHash);

  if (!COORDINATOR_SET.has(input.coordinator)) {
    return deny('coordinator-fora-da-enum', tokenHash);
  }
  if (input.coordinator !== record.coordinator) {
    return deny('coordinator-divergente', tokenHash);
  }
  if (input.driveProjectId !== record.driveProjectId || input.driveTurnId !== record.driveTurnId) {
    return deny('drive-ids-divergentes', tokenHash);
  }

  const now = Date.now();
  if (now >= record.expiresAt) {
    leases.delete(tokenHash);
    return deny('expirada', tokenHash);
  }
  if (record.maxUses !== undefined && record.uses >= record.maxUses) {
    return deny('max-uses-excedido', tokenHash);
  }

  const serverId = normalizeChatCapabilityServerId(input.serverId);
  if (!record.allowedServerIds.has(serverId)) {
    return deny('server-fora-da-allowlist', tokenHash);
  }
  if (!record.allowedToolPrefixes.some((prefix) => input.toolName.startsWith(prefix))) {
    return deny('tool-fora-do-prefixo', tokenHash);
  }

  if (input.dryRun !== true) {
    record.uses += 1;
  }
  return true;
}

export function __resetInternalCapabilityLeasesForTests(): void {
  leases.clear();
}

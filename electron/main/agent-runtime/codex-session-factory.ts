
import type {
  CodexSessionOptions,
  CodexSession,
} from '../codex-runtime/types';
import {
  type OfficialAppServerDriver,
} from '../codex-runtime/official-app-server-driver';
import { createCodexDriver } from '../codex-runtime/factory';
import type {
  CodexMcpProfile,
  CodexOwnerKind,
  CodexRunOptions,
  CodexRunSessionKey,
  CodexSurface,
  CodexSelectableSurface,
} from '../codex-runtime/types';
import { createLogger } from '../logger';
import { getOfficialPhaseCodexSpawnExtraArgs } from '../codex-pipeline-config';
import type { CodexChatReasoningEffort } from '../../../src/types';
import {
  isKnownStaticCodexModel,
  staticEffortsFor,
} from '../../../src/constants/codex-models';
import { CodexCapabilityUnsupportedError } from '../codex-runtime/errors';
import {
  getCodexModelCapabilities,
  getCodexModelCapabilitiesState,
  clampCodexEffortForModelDiscovered,
} from '../codex-runtime/model-capabilities';
import { registerCodexSessionSignature, registerCodexUsageSemantics } from './codex-session-signature';

const logger = createLogger('codex-session-factory');

const officialDriverCache = new Map<string, OfficialAppServerDriver>();

function getOfficialCodexDriver(): OfficialAppServerDriver {
  const key = 'official-app-server';
  const cached = officialDriverCache.get(key);
  if (cached) return cached;
  const driver = createCodexDriver();
  officialDriverCache.set(key, driver);
  return driver;
}

export function __resetOfficialCodexDriverCacheForTests(): void {
  officialDriverCache.clear();
}

export function resetOfficialProjectRunsNow(projectId: string, reason: string): void {
  for (const driver of officialDriverCache.values()) driver.resetProjectNow(projectId, reason);
}

export function hasActiveOfficialRun(scope: Partial<CodexRunSessionKey>): boolean {
  for (const driver of officialDriverCache.values()) {
    if (driver.hasActiveRun(scope)) return true;
  }
  return false;
}

export async function closeAllOfficialRuns(reason: string): Promise<void> {
  await Promise.allSettled(
    [...officialDriverCache.values()].map((driver) => driver.closeAll(reason)),
  );
}

export async function shutdownOfficialCodexDrivers(reason: string): Promise<void> {
  const drivers = [...officialDriverCache.values()];
  officialDriverCache.clear();
  await Promise.allSettled(drivers.map((driver) => driver.shutdown()));
  logger.info({ reason, count: drivers.length }, 'drivers Codex oficiais encerrados');
}

export interface ResolveCodexSessionArgs {
  surface: CodexSelectableSurface;
  mcpProfile: CodexMcpProfile;
  sessionOptions: CodexSessionOptions;
  disableGlobalMcp?: boolean;
  reasoningEffortOverride?: CodexChatReasoningEffort;
  extraArgs?: string[];
}

function freshRunId(): string {
  return `s9-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toLifecycleSurface(surface: CodexSelectableSurface): CodexSurface {
  return surface === 'agent-scoped' ? 'codex-agents-mcp' : surface;
}

function buildRunKey(args: ResolveCodexSessionArgs): CodexRunSessionKey {
  const ownerKind: CodexOwnerKind =
    args.sessionOptions.ownerKind === 'chat' ? 'chat' : 'pipeline';
  return {
    surface: toLifecycleSurface(args.surface),
    projectId: args.sessionOptions.projectId,
    runId: freshRunId(),
    ownerKind,
    ownerId: args.sessionOptions.ownerId,
    mcpProfile: args.mcpProfile,
  };
}

function buildRunOptions(
  args: ResolveCodexSessionArgs,
  effectiveEffort?: CodexChatReasoningEffort,
): CodexRunOptions {
  const b = args.sessionOptions;
  return {
    key: buildRunKey(args),
    model: b.model,
    cwd: b.cwd,
    systemPrompt: b.systemPrompt,
    approvalPolicy: b.approvalPolicy ?? 'never',
    sandbox: b.sandbox ?? 'workspace-write',
    reasoningEffort: effectiveEffort ?? b.reasoningEffort,
    timeoutMs: b.timeoutMs,
    idleTimeoutMs: b.idleTimeoutMs,
    disableGlobalMcp: args.disableGlobalMcp,
    extraArgs: args.extraArgs,
  };
}

function hasStructuralExtraArgs(args: ResolveCodexSessionArgs): boolean {
  return args.extraArgs !== undefined && args.extraArgs.length > 0;
}

export async function resolveCodexSessionForRun(
  args: ResolveCodexSessionArgs,
): Promise<CodexSession> {
  const requestedEffort = args.reasoningEffortOverride ?? args.sessionOptions.reasoningEffort;

  const discovered = await getCodexModelCapabilities();
  if (getCodexModelCapabilitiesState() === 'ready') {
    const model = args.sessionOptions.model;
    const slug = model.trim().toLowerCase();
    const cap = discovered?.find((c) => c.id.toLowerCase() === slug);
    if (!cap && !isKnownStaticCodexModel(model)) {
      throw new CodexCapabilityUnsupportedError(
        `O modelo "${model}" nao existe no model/list do Codex CLI instalado nem no catalogo local. ` +
          `Modelos disponiveis: ${(discovered ?? []).map((c) => c.id).join(', ')}.`,
      );
    }
    if (!cap) {
      throw new CodexCapabilityUnsupportedError(
        `O modelo "${model}" nao e anunciado pelo Codex CLI instalado. ` +
          `Modelos anunciados: ${(discovered ?? []).map((c) => c.id).join(', ')}.`,
      );
    }
    const req = requestedEffort as CodexChatReasoningEffort | undefined;
    if (
      req !== undefined &&
      staticEffortsFor(model).includes(req) &&
      !cap.supportedEfforts.includes(req)
    ) {
      throw new CodexCapabilityUnsupportedError(
        `O effort "${req}" nao e anunciado pelo Codex CLI para "${model}" ` +
          `(anuncia: ${cap.supportedEfforts.join(', ')}).`,
      );
    }
  }
  const signature = {
    model: args.sessionOptions.model,
    requestedEffort: requestedEffort as string | undefined,
  };

  const effectiveEffort =
    requestedEffort !== undefined
      ? clampCodexEffortForModelDiscovered(
          requestedEffort as CodexChatReasoningEffort,
          args.sessionOptions.model,
        )
      : undefined;

  const runOptions = buildRunOptions(args, effectiveEffort);

  if (runOptions.key.ownerKind !== 'chat') {
    if (hasStructuralExtraArgs(args)) {
      throw new Error(
        'extraArgs estruturais em spawn codex de fase/subagente (ownerKind nao-chat): a composicao index e exclusiva do chat (mcp-index-codex P6/P8)',
      );
    }
    if (!args.disableGlobalMcp) {
      const phaseExtras = getOfficialPhaseCodexSpawnExtraArgs();
      if (phaseExtras.length > 0) {
        runOptions.extraArgs = phaseExtras;
      }
    }
  }

  const driver = getOfficialCodexDriver();
  const handle = await driver.createRun(runOptions);
  const officialSession = driver.toSyncCodexSession(handle) as CodexSession;
  registerCodexSessionSignature(officialSession, signature);
  registerCodexUsageSemantics(officialSession, 'thread-cumulative');
  return officialSession;
}

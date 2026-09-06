
import { getAllMCPServers, getSetting } from './db';
import {
  codexManagedBlockDeclaresServer,
  listCodexManagedBlockServerNames,
  tomlKeyForConfigPath,
} from './codex-pipeline-config';
import { createLogger } from './logger';
import { CODEX_GATEWAY_SERVER_ID } from './mcp-display';
import { isDirectMcpHelper } from './mcp-risk-patterns';

const logger = createLogger('codex-chat-spawn-extras');

export type ChatCodexMcpMode = 'index' | 'full';

export interface ChatCodexMcpComposition {
  mode: ChatCodexMcpMode;
  extraArgs: string[];
  fingerprint: string | null;
}

function fullComposition(): ChatCodexMcpComposition {
  return { mode: 'full', extraArgs: [], fingerprint: null };
}

export interface ResolveChatCodexMcpCompositionOptions {
  agentId?: string;
  isOnboarding?: boolean;
  lane?: string;
}

export function resolveChatCodexMcpComposition(
  opts: ResolveChatCodexMcpCompositionOptions = {},
): ChatCodexMcpComposition {
  if (opts.agentId) return fullComposition();
  if (opts.isOnboarding) return fullComposition();
  try {
    if (getSetting('mcp_prompt_mode') === 'full') return fullComposition();
  } catch (err) {
    logger.error({ err }, 'leitura de mcp_prompt_mode falhou na composicao do chat codex; degrada para full');
    return fullComposition();
  }

  if (!codexManagedBlockDeclaresServer(CODEX_GATEWAY_SERVER_ID)) {
    logger.error(
      { id: CODEX_GATEWAY_SERVER_ID },
      'entry do gateway ausente do bloco LIONCLAW_MANAGED (sync falhou ou colisao); chat codex degrada para modo full neste spawn',
    );
    return fullComposition();
  }

  let all: ReturnType<typeof getAllMCPServers>;
  try {
    all = getAllMCPServers();
  } catch (err) {
    logger.error({ err }, 'getAllMCPServers falhou na composicao do chat codex; degrada para full');
    return fullComposition();
  }
  if (all.some((s) => s.id === CODEX_GATEWAY_SERVER_ID)) {
    logger.error(
      { id: CODEX_GATEWAY_SERVER_ID },
      'server do DB com o id reservado do gateway (colisao P4); a entry homonima do managed block NAO e o gateway — chat codex degrada para modo full neste spawn',
    );
    return fullComposition();
  }
  const active = all.filter((s) => s.isActive);
  const business = active
    .filter((s) => !isDirectMcpHelper(s.id) && s.id !== CODEX_GATEWAY_SERVER_ID)
    .sort((a, b) => a.id.localeCompare(b.id));

  const extraArgs: string[] = [];
  for (const name of listCodexManagedBlockServerNames()) {
    if (name === CODEX_GATEWAY_SERVER_ID || isDirectMcpHelper(name)) continue;
    const key = tomlKeyForConfigPath(name);
    if (!key) continue;
    extraArgs.push('-c', `mcp_servers.${key}.enabled=false`);
  }
  extraArgs.push('-c', `mcp_servers.${CODEX_GATEWAY_SERVER_ID}.enabled=true`);
  if (opts.lane === 'desktop' || opts.lane === 'telegram' || opts.lane === 'cron') {
    extraArgs.push(
      '-c',
      `mcp_servers.${CODEX_GATEWAY_SERVER_ID}.env.LIONCLAW_MCP_LANE="${opts.lane}"`,
    );
  }

  const visibleIds = business
    .filter((s) => {
      const vis = s.visibleTo ?? 'all';
      return vis === 'all' || vis === 'codex-lion-only';
    })
    .map((s) => s.id);
  const fingerprint = JSON.stringify({ servers: visibleIds, gatewayEntry: true });

  return { mode: 'index', extraArgs, fingerprint };
}

export interface ChatThreadSignatureBase {
  pipelineControl: boolean | null;
  dynamicWorkflows: boolean | null;
  onboarding: boolean;
  repoContextFingerprint: string | null;
}

export interface ChatThreadRepoContext {
  repositoryId: string;
  canonicalRootPath: string;
  status: 'ready' | 'stale';
  statsResumo: string | null;
}

export function buildChatRepoContextFingerprint(
  context: ChatThreadRepoContext | null,
): string | null {
  if (!context) return null;
  return JSON.stringify({
    repositoryId: context.repositoryId,
    canonicalRootPath: context.canonicalRootPath,
    status: context.status,
    statsResumo: context.statsResumo,
  });
}

export function buildChatThreadConfigSignature(
  base: ChatThreadSignatureBase,
  composition: ChatCodexMcpComposition,
): string {
  if (composition.mode !== 'index') {
    const signature = {
      pipelineControl: base.pipelineControl,
      dynamicWorkflows: base.dynamicWorkflows,
      onboarding: base.onboarding,
      ...(base.repoContextFingerprint
        ? { repoContextFingerprint: base.repoContextFingerprint }
        : {}),
    };
    return JSON.stringify(signature);
  }
  return JSON.stringify({
    pipelineControl: base.pipelineControl,
    dynamicWorkflows: base.dynamicWorkflows,
    onboarding: base.onboarding,
    ...(base.repoContextFingerprint
      ? { repoContextFingerprint: base.repoContextFingerprint }
      : {}),
    mcpMode: 'index',
    mcpFingerprint: composition.fingerprint,
  });
}

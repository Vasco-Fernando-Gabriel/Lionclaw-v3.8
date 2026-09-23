import path from 'node:path';
import fs from 'node:fs/promises';
import { getLionClawHome } from '../paths';
import { createSwarmWorkerBridge } from '../swarm/worker-bridge';
import { randomUUID } from 'node:crypto';
import { getAgent, getAllAgents, getEnabledTools } from '../db';
import { resolveAgentQueryConfig, type AgentQueryConfig } from '../agent-config-resolver';
import type { AgentConfig } from '../../../src/types';
import type {
  SwarmMember,
  SwarmRuntime,
  SwarmSettings,
  SwarmCatalog,
  SwarmFindingsOperation,
  SwarmFindingsAck,
} from '../../../src/types/swarm';
import { executeAgent } from './execute';
import type { AgentExecutionResult } from './types';
import { assertSwarmBackendAvailable } from './swarm-availability';
import { recoverSwarmProcessMarker } from './swarm-process';
import { createSwarmPermission, createSwarmToolDispatch, swarmEffectiveTools } from './swarm-policy';
import { pruneStaleRuntimeConfigs, swarmEffectiveModel } from './swarm-member-config';

export interface SwarmResolvedMember {
  runtime: SwarmRuntime;
  model: string;
  snapshot: Record<string, unknown>;
  agent: AgentConfig;
  config: AgentQueryConfig;
}
export interface SwarmAttemptExecution {
  resolved: SwarmResolvedMember;
  cwd: string;
  prompt: string;
  findingsPath: string;
  runId: string;
  slug: string;
  attemptId: string;
  settings: SwarmSettings;
  abortController: AbortController;
  onText?: (text: string) => void;
  onActivity?: () => void;
  onStopping?: (reason: 'timeout-idle' | 'timeout-hard') => void;
  writeFindings?: (content: string) => Promise<void>;
  uploadFindings?: (operation: SwarmFindingsOperation) => Promise<SwarmFindingsAck>;
}
export class SwarmCapabilityError extends Error {
  readonly code = 'unsupported-capability';
}
function validateCapability(
  agent: AgentConfig,
  tools: string[],
): asserts agent is AgentConfig & { runtime: SwarmRuntime } {
  if (agent.runtime === 'grok' || agent.runtime === 'cursor')
    throw new SwarmCapabilityError(`${agent.runtime} fora do escopo Swarm V1`);
  if (agent.runtime === 'codex' && !agent.codexConfig) throw new SwarmCapabilityError('codexConfig obrigatoria');
  if (agent.runtime === 'local' && !agent.localConfig) throw new SwarmCapabilityError('localConfig obrigatoria');
  if (agent.runtime === 'external' && !agent.externalConfig)
    throw new SwarmCapabilityError('externalConfig obrigatoria');
  if (
    (agent.runtime === 'local' || agent.runtime === 'external') &&
    tools.some((t) => t === 'WebSearch' || t === 'WebFetch')
  )
    throw new SwarmCapabilityError('Busca/leitura web nao implementada neste dispatcher');
  const webRole = agent.allowedTools.some((tool) => tool === 'WebSearch' || tool === 'WebFetch');
  const essential = webRole ? ['WebSearch', 'WebFetch'] : ['Read', 'Glob', 'Grep'];
  if (essential.some((tool) => !tools.includes(tool)))
    throw new SwarmCapabilityError(
      `Ferramentas essenciais indisponiveis: ${essential.filter((tool) => !tools.includes(tool)).join(', ')}`,
    );
  if (webRole && !['cloud', 'zai', 'minimax-tp'].includes(agent.runtime))
    throw new SwarmCapabilityError('Busca/leitura web sem dispatcher seguro neste runtime');
  if (agent.externalConfig?.extraHeaders && Object.keys(agent.externalConfig.extraHeaders).length)
    throw new SwarmCapabilityError('Perfil Swarm requer autenticacao por referencia Vault, sem extraHeaders');
}
export async function resolveSwarmMember(member: SwarmMember, _cwd: string): Promise<SwarmResolvedMember> {
  let agent: AgentConfig;
  let config: AgentQueryConfig;
  if (member.kind === 'registered') {
    const record = getAgent(member.agentId);
    if (!record?.isActive || record.squad !== 'swarm')
      throw new SwarmCapabilityError('Agente Swarm ativo nao encontrado');
    agent = pruneStaleRuntimeConfigs(structuredClone(record));
    config = await resolveAgentQueryConfig(record.id);
  } else {
    const profile = member.providerProfileId;
    const providerRecord = profile?.startsWith('agent:') ? getAgent(profile.slice(6)) : undefined;
    const provider = providerRecord ? pruneStaleRuntimeConfigs(providerRecord) : undefined;
    if (profile && !provider && profile !== `settings:${member.runtime}`)
      throw new SwarmCapabilityError('provider-profile-required: perfil inexistente');
    if (provider && (!provider.isActive || provider.runtime !== member.runtime))
      throw new SwarmCapabilityError('Perfil de provider incompativel');
    if (!provider && ['local', 'external', 'codex'].includes(member.runtime))
      throw new SwarmCapabilityError('provider-profile-required: selecione agent:<id>');
    agent = {
      id: `swarm-ephemeral-${randomUUID()}`,
      name: 'Persona Swarm',
      description: '',
      systemPrompt: member.rolePrompt,
      runtime: member.runtime,
      model: member.model,
      allowedTools: [...member.allowedTools],
      mcpServers: [],
      skills: [],
      squad: 'swarm',
      isActive: true,
      sortOrder: 0,
      effort: provider?.effort ?? 'high',
      thinking: provider?.thinking ?? 'adaptive',
      ...(provider?.localConfig ? { localConfig: { ...provider.localConfig, model: member.model } } : {}),
      ...(provider?.externalConfig ? { externalConfig: { ...provider.externalConfig, model: member.model } } : {}),
      ...(provider?.codexConfig ? { codexConfig: { ...provider.codexConfig, model: member.model } } : {}),
      maxTurns: provider?.maxTurns,
      maxToolRounds: provider?.maxToolRounds,
    };
    config = {
      model: agent.model,
      runtime: agent.runtime,
      systemPrompt: member.rolePrompt,
      allowedTools: agent.allowedTools,
      mcpServers: [],
      maxTurns: agent.maxTurns,
      effort: agent.effort,
      thinking: agent.thinking,
      thinkingBudget: agent.thinkingBudget,
    };
  }
  const enabled = new Set(getEnabledTools());
  config = {
    ...config,
    allowedTools: swarmEffectiveTools(config.allowedTools.filter((tool) => enabled.has(tool))),
    mcpServers: [],
  };
  validateCapability(agent, config.allowedTools);
  agent = {
    ...agent,
    model: swarmEffectiveModel(agent),
    allowedTools: [...config.allowedTools],
    mcpServers: [],
    skills: [],
  };
  config = { ...config, model: agent.model };
  try {
    await assertSwarmBackendAvailable(agent);
  } catch (error) {
    throw new SwarmCapabilityError(error instanceof Error ? error.message : String(error));
  }
  const snapshot = JSON.parse(JSON.stringify({ agent, config })) as Record<string, unknown>;
  return { runtime: agent.runtime as SwarmRuntime, model: agent.model, snapshot, agent, config };
}
export async function getSwarmCatalog(): Promise<SwarmCatalog> {
  const agents = getAllAgents()
    .filter((a) => a.isActive && a.runtime !== 'grok' && a.runtime !== 'cursor')
    .map(pruneStaleRuntimeConfigs);
  const status = async (a: AgentConfig): Promise<{ available: boolean; reason?: string }> => {
    try {
      validateCapability(a, swarmEffectiveTools(a.allowedTools.filter((tool) => getEnabledTools().includes(tool))));
      await assertSwarmBackendAvailable(a);
      return { available: true };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
  return {
    members: await Promise.all(
      agents
        .filter((a) => a.squad === 'swarm')
        .map(async (a) => ({
          agentId: a.id,
          name: a.name,
          description: a.description,
          runtime: a.runtime as SwarmRuntime,
          model: swarmEffectiveModel(a),
          ...(await status(a)),
        })),
    ),
    profiles: await Promise.all(
      agents.map(async (a) => ({
        id: `agent:${a.id}`,
        runtime: a.runtime as SwarmRuntime,
        model: swarmEffectiveModel(a),
        ...(await status(a)),
      })),
    ),
  };
}
export async function executeSwarmAttempt(req: SwarmAttemptExecution): Promise<AgentExecutionResult> {
  req.abortController.signal.throwIfAborted();
  validateCapability(req.resolved.agent, req.resolved.config.allowedTools);
  if (!req.writeFindings) throw new SwarmCapabilityError('Host writer obrigatorio');
  const dispatch = createSwarmToolDispatch({
    cwd: req.cwd,
    findingsPath: path.resolve(req.findingsPath),
    allowedTools: req.resolved.config.allowedTools,
    signal: req.abortController.signal,
    writeFindings: req.writeFindings,
  });
  const bridge =
    req.resolved.runtime === 'codex' ? (req.uploadFindings ? createSwarmWorkerBridge(req.uploadFindings) : null) : null;
  if (req.resolved.runtime === 'codex' && !bridge) throw new SwarmCapabilityError('Codex requer uploadFindings');
  const revoke = (): void => {
    bridge?.dispose();
  };
  req.abortController.signal.addEventListener('abort', revoke, { once: true });
  const runDirectory = path.resolve(path.dirname(req.findingsPath), '../../..');
  const expand = (value: string): string =>
    value.replace(/\{\{(RUN_DIR|SLUG|FINDINGS_PATH)\}\}/g, (_token, key: string) =>
      key === 'RUN_DIR' ? runDirectory : key === 'SLUG' ? req.slug : req.findingsPath,
    );
  const prompt = expand(req.prompt);
  try {
    return await executeAgent({
      agentId: req.resolved.agent.id,
      executionAgent: { ...req.resolved.agent, systemPrompt: expand(req.resolved.agent.systemPrompt) },
      resolvedConfigOverride: { ...req.resolved.config, systemPrompt: expand(req.resolved.config.systemPrompt) },
      swarmFindingsMcpArgs: bridge?.extraArgs,
      swarmFindingsMcpEnv: bridge?.spawnEnv,
      swarmOwnerDirectory: path.dirname(req.findingsPath),
      cwd: req.cwd,
      prompt: bridge
        ? `${prompt}\n\nEntrega pelo MCP swarm-worker: use swarm_write_findings operation begin/chunk/finalize. Cada chunk UTF-8 ate 32768 bytes; seq inicia 0. Use sha256 e nextSeq retornados pelo host para finalize. Nao use Write nem shell para salvar findings.`
        : `${prompt}\n\nEntrega: use Write com file_path ${JSON.stringify(req.findingsPath)}. O host grava o conteudo; se a tool informar operacao concluida pelo host, prossiga para o trailer sem repetir.`,
      abortController: req.abortController,
      permission: createSwarmPermission({
        cwd: req.cwd,
        allowedTools: req.resolved.config.allowedTools,
        signal: req.abortController.signal,
        dispatch,
      }),
      swarmToolDispatch: dispatch,
      swarmLifecycle: {
        idleTimeoutMs: req.settings.idleTimeoutMs,
        hardTimeoutMs: req.settings.hardTimeoutMs,
        onTimeout: (reason) => req.onStopping?.(reason),
      },
      onText: req.onText,
      onActivity: req.onActivity,
      onThinking: () => req.onActivity?.(),
      onToolUse: () => req.onActivity?.(),
      onToolUseComplete: () => req.onActivity?.(),
    });
  } finally {
    req.abortController.signal.removeEventListener('abort', revoke);
    bridge?.dispose();
  }
}

export async function recoverSwarmAttempt(input: {
  runId: string;
  slug: string;
  attemptId: string;
  runtime: SwarmRuntime;
}): Promise<boolean> {
  if (input.runtime === 'local' || input.runtime === 'external') return true;
  if (
    !/^swarm-\d{8}_\d{6}-[a-f0-9]{6}$/.test(input.runId) ||
    !/^[a-z0-9-]{1,80}$/.test(input.slug) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(input.attemptId)
  )
    return false;
  const directory = path.join(
    getLionClawHome(),
    'artifacts',
    'swarm',
    input.runId,
    '_attempts',
    input.slug,
    input.attemptId,
  );
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  for (const name of names.filter((n) => /^\.owner-[a-f0-9-]+\.json$/.test(n))) {
    if (!(await recoverSwarmProcessMarker(path.join(directory, name)))) return false;
  }
  return true;
}

import fs from 'node:fs';
import type { AgentConfig } from '../../../src/types';
export async function assertSwarmBackendAvailable(agent: AgentConfig): Promise<void> {
  if (agent.runtime === 'codex') {
    const status = await (await import('../codex-runtime/binary')).getCodexBinaryStatus();
    if (!status.installed || !status.appServerSupported || !status.authenticated)
      throw new Error('Codex App Server instalado e autenticado é obrigatório');
    const mcp = (await import('../mcp-path-resolver')).resolveMcpServerRuntime(
      'lionclaw-swarm',
      'dist/lionclaw-swarm/src/index.js',
    );
    if (!mcp.command || !mcp.entryPath || !fs.existsSync(mcp.entryPath))
      throw new Error('MCP findings Swarm não instalado');
  } else if (agent.runtime === 'kimi') {
    const status = await (await import('./kimi-availability')).isKimiAvailable(agent.model);
    if (!status.usable) throw new Error(status.reason ?? 'Kimi não está pronto/autenticado para este modelo');
  } else if (['cloud', 'zai', 'minimax-tp'].includes(agent.runtime)) {
    const sdk = await import('../pipeline-shared/sdk-bootstrap');
    if (!fs.existsSync(sdk.getClaudeSdkProcessOptions().pathToClaudeCodeExecutable))
      throw new Error('Claude SDK não instalado');
    if (agent.runtime === 'cloud') await sdk.ensureAuthForSDK();
    else if (agent.runtime === 'zai') await (await import('./zai-executor')).resolveZaiApiKey();
    else await (await import('./minimax-tokenplan-executor')).resolveMinimaxTpApiKey();
  } else if (agent.runtime === 'external') {
    if (!agent.externalConfig) throw new Error('Perfil external ausente');
    const secret = await (await import('../vault-registry')).getSecret(agent.externalConfig.apiKeyRef);
    if (!secret) throw new Error('Credencial external ausente no Vault');
  }
}

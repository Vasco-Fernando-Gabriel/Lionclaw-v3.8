import { ipcMain } from 'electron';
import { createLogger } from '../logger';
import type { IpcContext } from './context';
import { getAllAgents, getAgent, insertAgent, updateAgent, deleteAgent } from '../db';
import type { AgentUpdatePatch } from '../db';
import { listSkills, getSkill, createSkill, updateSkill, updateSkillRaw, deleteSkill } from '../skills';
import type { SkillCreateInput } from '../skills';
import {
  getAllMCPServers,
  createMCPServer,
  updateMCPServer,
  deleteMCPServer,
  testServer,
  restartServer,
  stopServer,
  registerMcpStatusChangedEmitter,
  registerMcpDistStaleEmitter,
  getMcpDistStaleState,
} from '../mcp-manager';
import {
  discoverSDKMcpServers,
  refreshSDKMcpServers,
  getCachedSDKMcpServers,
  getDisabledSDKMcps,
  setSDKMcpDisabled,
} from '../mcp-discovery';
import { syncAgentsToOrchestrator } from '../agent-sync';
import type { AgentConfig, SyncAgentsToOrchestratorRequest } from '../../../src/types';

const logger = createLogger('ipc');

const KB_PROMPT_MARKER = '<!-- kb-agent-id-instruction -->';

function injectKbInstruction<T extends { mcpServers?: string[]; systemPrompt?: string }>(
  agentId: string,
  updates: T,
): T {
  const mcpServers = updates.mcpServers;
  if (!Array.isArray(mcpServers)) return updates;

  const hasKb = mcpServers.includes('knowledge-base');
  const currentPrompt = updates.systemPrompt || '';
  const alreadyInjected = currentPrompt.includes(KB_PROMPT_MARKER);

  if (hasKb && !alreadyInjected) {
    const instruction = `\n${KB_PROMPT_MARKER}\nAo chamar knowledge_base_search, SEMPRE passe agent_id="${agentId}" como parametro.`;
    return { ...updates, systemPrompt: currentPrompt + instruction };
  }

  if (!hasKb && alreadyInjected) {
    const cleaned = currentPrompt.replace(new RegExp(`\\n${KB_PROMPT_MARKER}\\n.*`), '');
    return { ...updates, systemPrompt: cleaned };
  }

  return updates;
}

export function registerAgentsHandlers(ctx: IpcContext): void {
  ipcMain.handle('agents:list', () => {
    return getAllAgents();
  });

  ipcMain.handle('agents:get', (_event, id: string) => {
    return getAgent(id);
  });

  ipcMain.handle('agents:create', (_event, agent: Omit<AgentConfig, 'sortOrder'> & { sortOrder?: number }) => {
    const withKbInstruction = injectKbInstruction(agent.id, agent);
    return insertAgent(withKbInstruction);
  });

  ipcMain.handle('agents:update', (_event, id: string, updates: AgentUpdatePatch) => {
    const withKbInstruction = injectKbInstruction(id, updates);
    return updateAgent(id, withKbInstruction);
  });

  ipcMain.handle('agents:delete', (_event, id: string) => {
    deleteAgent(id);
  });

  ipcMain.handle('agents:sync-to-orchestrator', async (_event, req: SyncAgentsToOrchestratorRequest = {}) => {
    try {
      return await syncAgentsToOrchestrator(req, {
        getHarnessEngine: ctx.getHarnessEngine,
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'agents:sync-to-orchestrator failed');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('skills:list', () => {
    return listSkills();
  });

  ipcMain.handle('skills:get', (_event, name: string) => {
    return getSkill(name);
  });

  ipcMain.handle('skills:create', (_event, skill: SkillCreateInput) => {
    return createSkill(skill);
  });

  ipcMain.handle('skills:update', (_event, name: string, skill: SkillCreateInput) => {
    return updateSkill(name, skill);
  });

  ipcMain.handle('skills:update-raw', (_event, name: string, content: string) => {
    return updateSkillRaw(name, content);
  });

  ipcMain.handle('skills:delete', (_event, name: string) => {
    deleteSkill(name);
  });

  registerMcpStatusChangedEmitter((payload) => {
    ctx.getMainWindow()?.webContents.send('mcp:status-changed', payload);
  });

  registerMcpDistStaleEmitter((payload) => {
    ctx.getMainWindow()?.webContents.send('mcp:dist-stale', payload);
  });

  ipcMain.handle('mcp:get-dist-stale', () => {
    return getMcpDistStaleState();
  });

  ipcMain.handle('mcp:list', () => {
    return getAllMCPServers();
  });

  ipcMain.handle('mcp:create', (_event, config) => {
    return createMCPServer(config);
  });

  ipcMain.handle('mcp:update', (_event, id: string, updates) => {
    return updateMCPServer(id, updates);
  });

  ipcMain.handle('mcp:delete', (_event, id: string) => {
    deleteMCPServer(id);
  });

  ipcMain.handle('mcp:test', async (_event, id: string) => {
    return testServer(id);
  });

  ipcMain.handle('mcp:restart', async (_event, id: string) => {
    await restartServer(id);
  });

  ipcMain.handle('mcp:toggle', async (_event, id: string, active: boolean) => {
    const updated = updateMCPServer(id, { isActive: active });
    if (active) {
      await restartServer(id);
    } else {
      stopServer(id);
    }
    return updated;
  });

  ipcMain.handle('mcp:list-sdk', async () => {
    let servers = getCachedSDKMcpServers();
    if (servers.length === 0) {
      servers = await discoverSDKMcpServers();
    }
    const disabled = new Set(getDisabledSDKMcps());
    return servers.map((s) => ({
      ...s,
      isDisabledLocally: disabled.has(s.name),
    }));
  });

  ipcMain.handle('mcp:refresh-sdk', async () => {
    return refreshSDKMcpServers();
  });

  ipcMain.handle('mcp:toggle-sdk', (_event, serverName: string, enabled: boolean) => {
    setSDKMcpDisabled(serverName, !enabled);
  });
}

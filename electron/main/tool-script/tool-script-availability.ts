import { createLogger } from '../logger';
import { TOOL_SCRIPT_HELPER_ID } from '../mcp-risk-patterns';
import { isToolScriptAvailable, getToolScriptAvailabilityReason } from './tool-script-engine';
import { isToolScriptSettingEnabled } from './tool-script-settings';

const logger = createLogger('tool-script-availability');

export interface ToolScriptRegistrationDecision {
  register: boolean;
  available: boolean;
  enabled: boolean;
  reason?: string;
}

export function resolveToolScriptRegistration(): ToolScriptRegistrationDecision {
  const available = isToolScriptAvailable();
  const enabled = isToolScriptSettingEnabled();
  if (available && enabled) {
    return { register: true, available, enabled };
  }
  const reason = !available
    ? `python3 nao encontrado (${getToolScriptAvailabilityReason() ?? 'deteccao falhou'})`
    : 'desabilitado nas Settings (tool_script_enabled=false)';
  return { register: false, available, enabled, reason };
}

export async function applyToolScriptEnabledChange(enabled: boolean): Promise<void> {
  try {
    const { getAllMCPServers, updateMCPServer, startServer, stopServer } = await import('../mcp-manager');
    const row = getAllMCPServers().find((s) => s.id === TOOL_SCRIPT_HELPER_ID);

    if (!enabled) {
      if (row !== undefined) {
        try {
          stopServer(TOOL_SCRIPT_HELPER_ID);
        } catch (err) {
          logger.warn({ err }, 'stop do helper do Tool Script falhou (segue desativacao)');
        }
        updateMCPServer(TOOL_SCRIPT_HELPER_ID, { isActive: false });
        logger.info('Tool Script desligado por setting: helper parado e desativado');
      } else {
        logger.info('Tool Script desligado por setting: helper nao estava registrado');
      }
    } else {
      if (!isToolScriptAvailable()) {
        logger.warn(
          { reason: getToolScriptAvailabilityReason() },
          'Tool Script habilitado por setting mas python3 ausente: helper segue fora',
        );
        return;
      }
      if (row === undefined) {
        logger.warn(
          'Tool Script habilitado por setting mas o helper nao esta registrado; reinicie o app para o registro de boot',
        );
        return;
      }
      updateMCPServer(TOOL_SCRIPT_HELPER_ID, { isActive: true });
      try {
        await startServer(TOOL_SCRIPT_HELPER_ID);
      } catch (err) {
        logger.warn({ err }, 'start do helper do Tool Script falhou (isActive gravado; restart resolve)');
      }
      logger.info('Tool Script ligado por setting: helper reativado');
    }

    try {
      const { syncCodexMcpConfig } = await import('../codex-sdk/mcp-config-sync');
      await syncCodexMcpConfig();
    } catch (err) {
      logger.warn({ err }, 're-sync do codex apos flip do Tool Script falhou (restart resolve)');
    }
  } catch (err) {
    logger.error({ err }, 'applyToolScriptEnabledChange falhou (setting ja gravado; restart resolve)');
  }
}

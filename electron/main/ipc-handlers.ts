import { ipcMain, BrowserWindow } from 'electron';
import { createLogger } from './logger';
import {
  getSetting,
  setSetting,
} from './db';
import {
  getSecret,
  invalidateVaultStatusCache,
} from './vault-registry';
import { PROVIDER_PRESETS } from '../../src/lib/provider-presets';
import type { IpcContext } from './ipc/context';
import { registerAllIpcHandlers } from './ipc';
import type { HarnessEngine } from './harness-engine';
import type { PipelineEngine } from './pipeline-engine';
import {
  listProviderStatuses,
  checkProvider,
  invalidateProviderStatusCache,
  probeOpenAiCompatibleModels,
} from './provider-availability';
import { setSecret, deleteSecret } from './secrets-vault';
import { syncCodexMcpConfig } from './codex-sdk/mcp-config-sync';
import type {
  OrchestratorProvider,
  OrchestratorRuntime,
  OpenAiCompatiblePreset,
} from '../../src/types';

const logger = createLogger('ipc');

const COMPAT_VAULT_REFS: Record<
  'zai' | 'minimax',
  { vaultKey: string; settingKey: string }
> = {
  zai: {
    vaultKey: 'ORCHESTRATOR_ZAI_API_KEY',
    settingKey: 'orchestrator_zai_api_key_ref',
  },
  minimax: {
    vaultKey: 'ORCHESTRATOR_MINIMAX_API_KEY',
    settingKey: 'orchestrator_minimax_api_key_ref',
  },
};

function registerProviderHandlers(_ctx: IpcContext): void {
  ipcMain.handle(
    'provider:test-connection',
    async (
      _event,
      providerName: string,
      baseUrl: string,
      apiKeyRef: string,
    ) => {
      try {
        const resolvedApiKeyRef =
          providerName === 'gemini-agent-platform' &&
          apiKeyRef === 'orchestrator_vertex_api_key_ref'
            ? getSetting('orchestrator_vertex_api_key_ref') || apiKeyRef
            : apiKeyRef;
        const apiKey = await getSecret(resolvedApiKeyRef);
        if (!apiKey)
          return { ok: false, error: 'API key nao configurada no Vault.' };

        if (providerName === 'gemini-agent-platform') {
          const { GoogleGenAI } = await import('@google/genai');
          const { normalizeGoogleGenAiError } = await import(
            './lion-sdk/adapters/google-genai-errors'
          );
          const { VERTEX_DEFAULT_MODEL } = await import(
            '../../src/constants/vertex-gemini-models'
          );

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15_000);
          try {
            const client = new GoogleGenAI({ apiKey, vertexai: true });
            await client.models.generateContent({
              model: VERTEX_DEFAULT_MODEL,
              contents: 'Respond with OK.',
              config: {
                maxOutputTokens: 8,
                abortSignal: controller.signal,
              },
            });
            return { ok: true };
          } catch (err) {
            const normalized = normalizeGoogleGenAiError(err);
            logger.warn(
              {
                provider: 'gemini-agent-platform',
                model: VERTEX_DEFAULT_MODEL,
                code: normalized.code,
                status: normalized.status,
              },
              'provider:test-connection gemini-agent-platform failed',
            );
            return { ok: false, error: normalized.userMessage };
          } finally {
            clearTimeout(timeout);
          }
        }

        const preset = PROVIDER_PRESETS[providerName];

        const headers: Record<string, string> = {
          ...(preset?.extraHeaders ?? {}),
          Authorization: `Bearer ${apiKey}`,
        };

        if (preset?.testEndpoint) {
          const testUrl = `${baseUrl}${preset.testEndpoint}`;
          const res = await fetch(testUrl, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) {
            return {
              ok: false,
              error: `HTTP ${res.status}: Key invalida ou expirada.`,
            };
          }
          return { ok: true };
        }

        const modelsEndpoint = preset?.modelsEndpoint ?? '/models';
        const res = await fetch(`${baseUrl}${modelsEndpoint}`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(15000),
        });

        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            error: `HTTP ${res.status}: Key invalida ou sem permissao.`,
          };
        }
        if (!res.ok) {
          return { ok: false, error: `HTTP ${res.status}` };
        }

        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Erro desconhecido',
        };
      }
    },
  );


  ipcMain.handle('provider:list-statuses', async () => {
    try {
      return await listProviderStatuses();
    } catch (err) {
      logger.error({ err }, 'provider:list-statuses failed');
      return {
        error: err instanceof Error ? err.message : 'Erro desconhecido',
      };
    }
  });

  ipcMain.handle(
    'provider:check',
    async (
      _event,
      payload: { runtime: OrchestratorRuntime; provider: OrchestratorProvider },
    ) => {
      try {
        invalidateProviderStatusCache();
        return await checkProvider(payload.runtime, payload.provider);
      } catch (err) {
        logger.error({ err }, 'provider:check failed');
        return {
          error: err instanceof Error ? err.message : 'Erro desconhecido',
        };
      }
    },
  );

  ipcMain.handle(
    'provider:test-openai-compatible',
    async (
      _event,
      payload: {
        baseUrl?: string;
        apiKey?: string;
        preset?: string;
      },
    ) => {
      try {
        const baseUrl = (payload.baseUrl ?? '').trim();
        const apiKey = (payload.apiKey ?? '').trim();
        if (!baseUrl) return { ok: false, error: 'baseUrl obrigatorio.' };
        if (!apiKey) return { ok: false, error: 'apiKey obrigatorio.' };

        const preset = payload.preset
          ? (payload.preset as OpenAiCompatiblePreset)
          : undefined;
        const probe = await probeOpenAiCompatibleModels(baseUrl, apiKey, preset);
        if (!probe.ok) {
          return {
            ok: false,
            error: probe.error ?? `HTTP ${probe.status ?? 'unknown'} on ${probe.url}.`,
          };
        }

        return { ok: true, models: probe.models?.length ?? 0 };
      } catch (err) {
        logger.error({ err }, 'provider:test-openai-compatible failed');
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Erro desconhecido',
        };
      }
    },
  );

  ipcMain.handle(
    'provider:connect',
    async (
      _event,
      payload: {
        provider: OrchestratorProvider;
        apiKey?: string;
        baseUrl?: string;
        preset?: string; // OpenAI-compatible preset id
      },
    ) => {
      try {
        let mustSyncCodex = false;

        if (payload.provider === 'zai' || payload.provider === 'minimax') {
          if (!payload.apiKey || payload.apiKey.trim().length === 0) {
            const label = payload.provider === 'zai' ? 'Z.ai' : 'MiniMax';
            return { error: `apiKey obrigatorio para ${label}.` };
          }
          const cfg = COMPAT_VAULT_REFS[payload.provider];
          await setSecret(cfg.vaultKey, payload.apiKey.trim());
          setSetting(cfg.settingKey, cfg.vaultKey);
        } else if (payload.provider === 'ollama') {
          const baseUrl =
            (payload.baseUrl ?? '').trim() || 'http://localhost:11434';
          setSetting('orchestrator_ollama_base_url', baseUrl);
        } else if (payload.provider === 'lmstudio') {
          const baseUrl =
            (payload.baseUrl ?? '').trim() || 'http://localhost:1234';
          setSetting('orchestrator_lmstudio_base_url', baseUrl);
        } else if (payload.provider === 'openai-compatible') {
          if (!payload.apiKey || payload.apiKey.trim().length === 0) {
            return { error: 'apiKey obrigatorio para OpenAI-compatible.' };
          }
          if (!payload.baseUrl || payload.baseUrl.trim().length === 0) {
            return { error: 'baseUrl obrigatorio para OpenAI-compatible.' };
          }
          const presetSafe =
            payload.preset && payload.preset.length > 0
              ? payload.preset
              : 'custom';
          const vaultRef = 'ORCHESTRATOR_OPENAI_COMPAT_API_KEY';
          await setSecret(vaultRef, payload.apiKey.trim());
          setSetting('orchestrator_openai_compat_api_key_ref', vaultRef);
          setSetting(
            'orchestrator_openai_compat_base_url',
            payload.baseUrl.trim(),
          );
          setSetting('orchestrator_openai_compat_preset', presetSafe);
          mustSyncCodex = true;
        } else if (payload.provider === 'vertex-ai') {
          const vaultRef = 'ORCHESTRATOR_VERTEX_API_KEY';
          const existingRef = getSetting('orchestrator_vertex_api_key_ref');
          const hasNewKey =
            typeof payload.apiKey === 'string' && payload.apiKey.trim().length > 0;
          if (!hasNewKey && !existingRef) {
            return { error: 'apiKey obrigatorio para Vertex Gemini.' };
          }
          if (hasNewKey) {
            await setSecret(vaultRef, payload.apiKey!.trim());
            setSetting('orchestrator_vertex_api_key_ref', vaultRef);
          }
          setSetting('orchestrator_vertex_location', '');
          setSetting('orchestrator_vertex_project_id', '');
          const existingAuthMode = getSetting('orchestrator_vertex_auth_mode');
          if (!existingAuthMode || existingAuthMode.trim().length === 0) {
            setSetting('orchestrator_vertex_auth_mode', 'api-key');
          }
        } else if (payload.provider === 'cursor') {
          if (!payload.apiKey || payload.apiKey.trim().length === 0) {
            return { error: 'apiKey obrigatorio para Cursor.' };
          }
          await setSecret('CURSOR_API_KEY', payload.apiKey.trim());
          invalidateVaultStatusCache('CURSOR_API_KEY');
        } else if (payload.provider === 'anthropic') {
          return {
            error:
              'Anthropic auth is managed via the Vault page, not this handler.',
          };
        } else if (payload.provider === 'codex') {
          return {
            error:
              'Codex login is handled by the Codex CLI; use codex:open-login.',
          };
        } else {
          return { error: `Unknown provider: ${String(payload.provider)}` };
        }

        invalidateProviderStatusCache();
        if (mustSyncCodex) {
          try {
            await syncCodexMcpConfig();
          } catch (err) {
            logger.warn(
              { err },
              'syncCodexMcpConfig failed after provider:connect',
            );
          }
        }
        return { ok: true };
      } catch (err) {
        logger.error({ err }, 'provider:connect failed');
        return {
          error: err instanceof Error ? err.message : 'Erro desconhecido',
        };
      }
    },
  );

  ipcMain.handle(
    'provider:disconnect',
    async (_event, payload: { provider: OrchestratorProvider }) => {
      try {
        let mustSyncCodex = false;

        if (payload.provider === 'zai' || payload.provider === 'minimax') {
          const cfg = COMPAT_VAULT_REFS[payload.provider];
          const vaultRef = getSetting(cfg.settingKey);
          if (vaultRef) {
            await deleteSecret(vaultRef);
          }
          setSetting(cfg.settingKey, '');
        } else if (payload.provider === 'ollama') {
          setSetting('orchestrator_ollama_base_url', '');
        } else if (payload.provider === 'lmstudio') {
          setSetting('orchestrator_lmstudio_base_url', '');
        } else if (payload.provider === 'openai-compatible') {
          const vaultRef = getSetting('orchestrator_openai_compat_api_key_ref');
          if (vaultRef) {
            await deleteSecret(vaultRef);
          }
          setSetting('orchestrator_openai_compat_api_key_ref', '');
          setSetting('orchestrator_openai_compat_base_url', '');
          setSetting('orchestrator_openai_compat_preset', '');
          mustSyncCodex = true;
        } else if (payload.provider === 'vertex-ai') {
          const vaultRef = getSetting('orchestrator_vertex_api_key_ref');
          if (vaultRef) {
            await deleteSecret(vaultRef);
          }
          setSetting('orchestrator_vertex_api_key_ref', '');
          setSetting('orchestrator_vertex_location', '');
          setSetting('orchestrator_vertex_project_id', '');
        } else if (payload.provider === 'cursor') {
          await deleteSecret('CURSOR_API_KEY');
          invalidateVaultStatusCache('CURSOR_API_KEY');
        } else if (payload.provider === 'anthropic') {
          return {
            error:
              'Anthropic auth is managed via the Vault page, not this handler.',
          };
        } else if (payload.provider === 'codex') {
          return {
            error:
              'Codex disconnect is handled by `codex logout`; not via this handler.',
          };
        } else {
          return { error: `Unknown provider: ${String(payload.provider)}` };
        }

        invalidateProviderStatusCache();
        if (mustSyncCodex) {
          try {
            await syncCodexMcpConfig();
          } catch (err) {
            logger.warn(
              { err },
              'syncCodexMcpConfig failed after provider:disconnect',
            );
          }
        }
        return { ok: true };
      } catch (err) {
        logger.error({ err }, 'provider:disconnect failed');
        return {
          error: err instanceof Error ? err.message : 'Erro desconhecido',
        };
      }
    },
  );

  ipcMain.handle(
    'provider:test-vertex-ai',
    async (
      _event,
      payload: {
        apiKey?: string;
        model?: string;
      },
    ): Promise<
      { ok: true; models?: number } | { ok: false; error: string }
    > => {
      const { GoogleGenAI } = await import('@google/genai');
      const { normalizeGoogleGenAiError } = await import(
        './lion-sdk/adapters/google-genai-errors'
      );

      try {
        let apiKey = (payload.apiKey ?? '').trim();
        if (!apiKey) {
          const vaultRef = getSetting('orchestrator_vertex_api_key_ref');
          if (vaultRef) {
            const stored = await getSecret(vaultRef);
            if (stored) apiKey = stored;
          }
        }
        if (!apiKey) {
          return {
            ok: false,
            error: 'Google API key not configured. Connect Vertex Gemini first.',
          };
        }

        const model =
          (payload.model ?? '').trim().length > 0
            ? payload.model!.trim()
            : 'gemini-3-flash-preview';

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
          const client = new GoogleGenAI({
            apiKey,
            vertexai: true,
          });
          await client.models.generateContent({
            model,
            contents: 'Respond with OK.',
            config: {
              maxOutputTokens: 8,
              abortSignal: controller.signal,
            },
          });
          const { VERTEX_MODEL_CATALOG } = await import(
            '../../src/constants/vertex-gemini-models'
          );
          return { ok: true, models: VERTEX_MODEL_CATALOG.length };
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        const normalized = normalizeGoogleGenAiError(err);
        logger.warn(
          {
            provider: 'vertex-ai',
            model: payload.model,
            code: normalized.code,
            status: normalized.status,
          },
          'provider:test-vertex-ai failed',
        );
        return { ok: false, error: normalized.userMessage };
      }
    },
  );
}

export function registerIPCHandlers(
  getMainWindow: () => BrowserWindow | null,
  getHarnessEngine: () => HarnessEngine | null = () => null,
  getPipelineEngine: () => PipelineEngine | null = () => null,
): void {
  const ctx: IpcContext = { getMainWindow, getHarnessEngine, getPipelineEngine };
  registerAllIpcHandlers(ctx);
  registerProviderHandlers(ctx);
  logger.info('All IPC handlers registered');
}

import { ipcMain } from 'electron';
import type { IpcContext } from './context';
import { checkOllamaAvailable } from '../ollama-client';

export function registerLocalLlmHandlers(_ctx: IpcContext): void {
  ipcMain.handle(
    'ollama:check',
    async (_event, baseUrl: string, model: string, provider?: string, authHeaders?: Record<string, string>) => {
      return checkOllamaAvailable(
        baseUrl,
        model,
        (provider as 'ollama' | 'lmstudio' | 'openai-compatible') || 'ollama',
        authHeaders,
      );
    },
  );

  const ollamaListModels = async (
    _event: unknown,
    provider: string,
    baseUrl: string,
    authHeaders?: Record<string, string>,
  ) => {
    try {
      if (provider === 'ollama') {
        const res = await fetch(`${baseUrl}/api/tags`, {
          method: 'GET',
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return { models: [], error: `HTTP ${res.status}` };
        const json = (await res.json()) as { models?: Array<{ name: string }> };
        return { models: (json.models || []).map((m) => m.name) };
      } else {
        const res = await fetch(`${baseUrl}/v1/models`, {
          method: 'GET',
          signal: AbortSignal.timeout(15000),
          headers: { ...authHeaders },
        });
        if (!res.ok) return { models: [], error: `HTTP ${res.status}` };
        const json = (await res.json()) as { data?: Array<{ id: string }> };
        return { models: (json.data || []).map((m) => m.id) };
      }
    } catch (err) {
      return {
        models: [],
        error: err instanceof Error ? err.message : 'Erro desconhecido',
      };
    }
  };
  ipcMain.handle('ollama:list-models', ollamaListModels);
  ipcMain.handle('ollama:listModels', ollamaListModels);
}

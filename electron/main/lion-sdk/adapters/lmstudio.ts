
import { createOpenAiCompatibleAdapter } from './openai-compatible';
import type { AdapterConfig, LionAdapter } from './types';

export function createLmStudioAdapter(config: AdapterConfig): LionAdapter {
  return {
    ...createOpenAiCompatibleAdapter({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      extraHeaders: config.extraHeaders,
      requireApiKey: false,
      localStreamNoBodyTimeout: true,
    }),
    name: 'lmstudio',
  };
}

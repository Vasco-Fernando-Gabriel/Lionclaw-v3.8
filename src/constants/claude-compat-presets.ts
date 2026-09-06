
import type { OrchestratorProvider } from '../types';

export interface ClaudeCompatModelInfo {
  id: string;         // slug sent to the provider (e.g. 'glm-4.7')
  displayName: string;
  supportTier?: 'official' | 'parameter-only' | 'highspeed-only';
  notes?: string;
}

export interface ClaudeCompatPreset {
  id: OrchestratorProvider;     // 'zai'
  displayName: string;
  baseUrl: string;              // ANTHROPIC_BASE_URL value (no trailing /v1)
  apiKeyVaultRef: string;       // settings key holding the Vault reference
  models: ClaudeCompatModelInfo[];
}

export const CLAUDE_COMPAT_PRESETS: ClaudeCompatPreset[] = [
  {
    id: 'zai',
    displayName: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/anthropic',
    apiKeyVaultRef: 'orchestratorZaiApiKeyRef',
    models: [
      { id: 'glm-5.2',     displayName: 'GLM-5.2' },
      { id: 'glm-5.3',     displayName: 'GLM-5.3', notes: 'Rollout em andamento na Z.ai: tool-calling pode falhar. Prefira o 5.2 para agentes ate estabilizar.' },
      { id: 'glm-5.1',     displayName: 'GLM-5.1' },
      { id: 'glm-5-turbo', displayName: 'GLM-5-Turbo' },
      { id: 'glm-4.7',     displayName: 'GLM-4.7' },
      { id: 'glm-4.5-air', displayName: 'GLM-4.5-Air' },
    ],
  },
  {
    id: 'minimax',
    displayName: 'Minimax TokenPlan',
    baseUrl: 'https://api.minimax.io/anthropic',
    apiKeyVaultRef: 'orchestratorMinimaxApiKeyRef',
    models: [
      { id: 'MiniMax-M2.7',           displayName: 'MiniMax M2.7',                supportTier: 'official' },
      { id: 'MiniMax-M2.7-highspeed', displayName: 'MiniMax M2.7 (High-Speed)',   supportTier: 'official' },
      { id: 'MiniMax-M2.5',           displayName: 'MiniMax M2.5',                supportTier: 'parameter-only', notes: 'Aceito no parametro, sem quota dedicada. Pode degradar.' },
      { id: 'MiniMax-M2.5-highspeed', displayName: 'MiniMax M2.5 (High-Speed)',   supportTier: 'highspeed-only', notes: 'Disponivel apenas via endpoint High-Speed.' },
      { id: 'MiniMax-M3',             displayName: 'MiniMax M3',                  supportTier: 'official' },
    ],
  },
];

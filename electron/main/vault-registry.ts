import { createLogger } from './logger';
import {
  getSecret,
  getSecretNonInteractive,
  setSecret,
  deleteSecret,
  getSecretReadError,
} from './secrets-vault';
import { HIGGSFIELD_SESSION_SECRET_KEY } from './higgsfield-auth';
import { BLOTATO_API_KEY_SECRET } from './blotato-auth';

const logger = createLogger('vault-registry');

export interface VaultEntry {
  key: string;
  label: string;
  description: string;
  service: string;
  required: boolean;
  configured: boolean;
  placeholder?: string;
  docsUrl?: string;
  status?: 'error';
  error?: string;
}

const VAULT_ENTRIES: Omit<VaultEntry, 'configured'>[] = [
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API Key',
    description: 'Chave da API do Claude. Obrigatoria para o agente funcionar.',
    service: 'anthropic',
    required: true,
    placeholder: 'sk-ant-...',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    key: 'ELEVENLABS_API_KEY',
    label: 'ElevenLabs API Key',
    description: 'Chave da ElevenLabs para voz sintetica (TTS). Necessaria para o agente falar.',
    service: 'elevenlabs',
    required: false,
    placeholder: 'xi-...',
    docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
  {
    key: 'CARTESIA_API_KEY',
    label: 'Cartesia API Key',
    description: 'Chave da Cartesia para TTS de baixa latencia no chat ao vivo.',
    service: 'cartesia',
    required: false,
    placeholder: 'sk_car_...',
    docsUrl: 'https://play.cartesia.ai/keys',
  },
  {
    key: 'OPENAI_API_KEY',
    label: 'OpenAI API Key',
    description: 'Chave da OpenAI para embeddings (memoria semantica) e transcricao de audio (Whisper).',
    service: 'openai',
    required: false,
    placeholder: 'sk-...',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    key: 'SHOPIFY_STORE_URL',
    label: 'Shopify Store URL',
    description: 'URL da loja Shopify (ex: minha-loja.myshopify.com). Necessario para o MCP Shopify.',
    service: 'shopify',
    required: false,
    placeholder: 'minha-loja.myshopify.com',
    docsUrl: 'https://shopify.dev/docs/apps/build/authentication-authorization/client-secrets',
  },
  {
    key: 'SHOPIFY_CLIENT_ID',
    label: 'Shopify Client ID',
    description: 'Client ID do app Shopify. Encontre em Dev Dashboard > App > Settings.',
    service: 'shopify',
    required: false,
    placeholder: 'shp_...',
    docsUrl: 'https://shopify.dev/docs/apps/build/authentication-authorization/client-secrets',
  },
  {
    key: 'SHOPIFY_CLIENT_SECRET',
    label: 'Shopify Client Secret',
    description: 'Client Secret do app Shopify. Encontre em Dev Dashboard > App > Settings.',
    service: 'shopify',
    required: false,
    placeholder: 'shps_...',
    docsUrl: 'https://shopify.dev/docs/apps/build/authentication-authorization/client-secrets',
  },
  {
    key: 'GOOGLE_GEMINI_API_KEY',
    label: 'Google Gemini API Key',
    description: 'Chave da API Gemini (Google AI Studio). Necessario para geracao de imagens com Nano Banana. Gratuito ate 500 imagens/dia.',
    service: 'google',
    required: false,
    placeholder: 'AIza...',
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  {
    key: HIGGSFIELD_SESSION_SECRET_KEY,
    label: 'Higgsfield MCP',
    description: 'Sessao OAuth da Higgsfield usada pelo MCP remoto para geracao de imagens, videos e analise de criativos.',
    service: 'higgsfield',
    required: false,
    placeholder: 'Autentique pelo botao Conectar.',
    docsUrl: 'https://higgsfield.ai/mcp',
  },
  {
    key: BLOTATO_API_KEY_SECRET,
    label: 'Blotato API Key',
    description: 'Chave da Blotato para publicacao em redes sociais (Instagram, TikTok, etc) via MCP remoto. Se rotacionar, desative e reative o MCP para o spawn ler a nova chave.',
    service: 'blotato',
    required: false,
    placeholder: 'blt_...',
    docsUrl: 'https://blotato.com/settings/api',
  },
  {
    key: 'CURSOR_API_KEY',
    label: 'Cursor API Key',
    description: 'User API key do Cursor (cursor.com/dashboard > API). Necessaria para o runtime Cursor (@cursor/sdk). A cobranca real e o plano de assinatura do Cursor; o custo em USD exibido e equivalente-API.',
    service: 'cursor',
    required: false,
    placeholder: 'key_...',
    docsUrl: 'https://cursor.com/dashboard',
  },
  {
    key: 'COHERE_API_KEY',
    label: 'Cohere API Key',
    description: 'Chave da API Cohere. Necessaria para reranking na Knowledge Base (melhora a qualidade dos resultados de busca).',
    service: 'cohere',
    required: false,
    placeholder: 'co-...',
    docsUrl: 'https://dashboard.cohere.com/api-keys',
  },
];

let statusCache: Map<string, boolean> = new Map();

export async function getVaultEntries(): Promise<VaultEntry[]> {
  const entries: VaultEntry[] = [];
  for (const entry of VAULT_ENTRIES) {
    let configured = statusCache.get(entry.key) ?? false;
    if (!statusCache.has(entry.key)) {
      const result = await getSecretNonInteractive(entry.key);
      configured = result.status === 'found' && result.value.length > 0;
      if (result.status !== 'error') statusCache.set(entry.key, configured);
    }
    const readError = getSecretReadError(entry.key);
    if (readError !== undefined) {
      entries.push({ ...entry, configured: false, status: 'error', error: readError });
    } else {
      entries.push({ ...entry, configured });
    }
  }
  return entries;
}

export async function setVaultSecret(key: string, value: string): Promise<void> {
  const entry = VAULT_ENTRIES.find(e => e.key === key);
  if (!entry) {
    throw new Error(`Chave desconhecida: ${key}. Use registerVaultEntry() primeiro.`);
  }
  await setSecret(key, value);
  statusCache.set(key, true);
  logger.info({ key, service: entry.service }, 'vault: secret updated');
}

export async function deleteVaultSecret(key: string): Promise<void> {
  await deleteSecret(key);
  statusCache.set(key, false);
  logger.info({ key }, 'vault: secret deleted');
}

export async function checkVaultSecret(key: string): Promise<boolean> {
  const value = await getSecret(key);
  const configured = value !== null && value.length > 0;
  statusCache.set(key, configured);
  return configured;
}

export function invalidateVaultStatusCache(key?: string): void {
  if (key) {
    statusCache.delete(key);
    return;
  }
  statusCache = new Map();
}

export function registerVaultEntry(entry: Omit<VaultEntry, 'configured'>): void {
  const exists = VAULT_ENTRIES.find(e => e.key === entry.key);
  if (!exists) {
    VAULT_ENTRIES.push(entry);
    logger.info({ key: entry.key, service: entry.service }, 'vault: new entry registered');
  }
}

export { getSecret } from './secrets-vault';

export function registerExternalProviderVaultEntries(): void {
  registerVaultEntry({
    key: 'HARNESS_OPENROUTER_KEY',
    label: 'OpenRouter API Key',
    description: 'Chave da API OpenRouter para usar modelos externos no Harness.',
    service: 'openrouter',
    required: false,
    placeholder: 'sk-or-v1-...',
    docsUrl: 'https://openrouter.ai/settings/keys',
  });

  registerVaultEntry({
    key: 'HARNESS_OPENAI_KEY',
    label: 'OpenAI API Key (Harness)',
    description: 'Chave da OpenAI dedicada ao Harness. Separada da key de embeddings.',
    service: 'openai-harness',
    required: false,
    placeholder: 'sk-...',
    docsUrl: 'https://platform.openai.com/api-keys',
  });

  registerVaultEntry({
    key: 'HARNESS_KIMI_KEY',
    label: 'Kimi (Moonshot) API Key',
    description: 'Chave da API Moonshot Kimi para SubAgents.',
    service: 'kimi',
    required: false,
    placeholder: 'sk-...',
    docsUrl: 'https://platform.moonshot.ai/console/api-keys',
  });

  registerVaultEntry({
    key: 'HARNESS_DEEPSEEK_KEY',
    label: 'DeepSeek API Key',
    description: 'Chave da API DeepSeek para SubAgents.',
    service: 'deepseek',
    required: false,
    placeholder: 'sk-...',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  });

  registerVaultEntry({
    key: 'HARNESS_QWEN_KEY',
    label: 'Qwen (DashScope) API Key',
    description: 'Chave da API Alibaba DashScope (Qwen) para SubAgents.',
    service: 'qwen',
    required: false,
    placeholder: 'sk-...',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key',
  });

  registerVaultEntry({
    key: 'HARNESS_MINIMAX_PAYG_KEY',
    label: 'MiniMax (Pay-as-you-go) API Key',
    description: 'Chave da API MiniMax (pay-as-you-go) para SubAgents.',
    service: 'minimax-payg',
    required: false,
    placeholder: '...',
    docsUrl: 'https://platform.minimax.io/document/Quick%20Start',
  });

  registerVaultEntry({
    key: 'ORCHESTRATOR_VERTEX_API_KEY',
    label: 'Vertex / Gemini Agent Platform API Key',
    description: 'Chave Google Cloud usada por SubAgents Gemini e pelo orquestrador Vertex no chat. Compartilhada entre Settings > Vertex Gemini e AgentForm.',
    service: 'gemini-agent-platform',
    required: false,
    placeholder: '...',
    docsUrl: 'https://aistudio.google.com/apikey',
  });

  registerVaultEntry({
    key: 'ORCHESTRATOR_MINIMAX_API_KEY',
    label: 'MiniMax TokenPlan API Key',
    description: 'Chave MiniMax compartilhada entre Settings > Provedores externos (chat) e SubAgents MiniMax TokenPlan.',
    service: 'minimax-tp',
    required: false,
    placeholder: '...',
    docsUrl: 'https://platform.minimax.io/document/Quick%20Start',
  });
}

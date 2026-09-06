
export interface TranslatedLlmError {
  code: string;
  title: string;
  body: string;
  action?: string;
  persist: boolean;
  detail?: string;
}

export interface TranslateLlmErrorInput {
  code?: string | null;
  error?: string | null;
  reason?: string | null;
}

interface TranslationEntry {
  title: string;
  body: string;
  action?: string;
  persist: boolean;
}

const TRANSLATION_TABLE: Record<string, TranslationEntry> = {
  'LLM-QUOTA': {
    title: 'Limite do provedor',
    body: 'Cota ou creditos do provider esgotados.',
    action: 'Verifique o plano/billing do provider ou troque de modelo nas configuracoes.',
    persist: true,
  },
  'LLM-RATE-429': {
    title: 'Muitas requisicoes',
    body: 'Limite de requisicoes (rate limit) do provider atingido.',
    action: 'Aguarde alguns segundos e tente de novo.',
    persist: false,
  },
  'LLM-OVERLOADED-529': {
    title: 'Provider sobrecarregado',
    body: 'O provider esta sobrecarregado neste momento.',
    action: 'Aguarde alguns minutos e tente de novo, ou troque de modelo.',
    persist: false,
  },
  'LLM-AUTH-401': {
    title: 'Autenticacao caiu',
    body: 'Credencial do provider rejeitada (nao autorizado).',
    action: 'Verifique a API key ou refaca o login do provider nas configuracoes.',
    persist: true,
  },
  'LLM-MODEL-404': {
    title: 'Modelo indisponivel',
    body: 'Modelo nao encontrado ou indisponivel para esta credencial.',
    action: 'Confira o nome do modelo nas configuracoes ou escolha outro modelo.',
    persist: false,
  },
  'LLM-EMPTY': {
    title: 'Sem resposta',
    body: 'O agente terminou sem resposta.',
    action: 'Tente de novo; se persistir, troque de modelo ou verifique o provider.',
    persist: false,
  },
  'LLM-NET': {
    title: 'Falha de rede',
    body: 'Falha de rede ao falar com o provider.',
    action: 'Verifique sua conexao com a internet e tente de novo.',
    persist: false,
  },
  'LLM-TIMEOUT': {
    title: 'Tempo esgotado',
    body: 'A chamada ao provider excedeu o tempo limite.',
    action: 'Tente de novo; se persistir, reduza o prompt ou troque de modelo.',
    persist: false,
  },
  'LLM-LOCAL-DOWN': {
    title: 'Provider local fora do ar',
    body: 'Provider local (Ollama/LM Studio) inacessivel.',
    action: 'Verifique se o servidor local esta rodando e se a URL configurada esta correta.',
    persist: false,
  },
  'CODEX-EXIT': {
    title: 'Codex encerrou',
    body: 'O processo do Codex encerrou inesperadamente.',
    action: 'Tente de novo; a sessao do Codex sera recriada automaticamente.',
    persist: false,
  },
  'CODEX-WEDGE': {
    title: 'Codex travado',
    body: 'O Codex parou de responder (travado, sem progresso).',
    action: 'Aborte o turno e tente de novo; se persistir, reinicie o app.',
    persist: false,
  },
  'COMPACT-EMPTY': {
    title: 'Compactacao sem resposta',
    body: 'A compactacao recebeu resposta vazia do modelo sumarizador.',
    action: 'O contexto foi preservado; a compactacao sera retentada no proximo ciclo.',
    persist: false,
  },
  'COMPACT-SKIPPED': {
    title: 'Compactacao pulada',
    body: 'A compactacao foi pulada nesta operacao.',
    action: 'A operacao concluiu sem compactar; voce pode compactar manualmente depois.',
    persist: false,
  },
  'EMBED-FAIL': {
    title: 'Falha nos embeddings',
    body: 'Falha ao gerar embeddings.',
    action: 'Verifique a credencial do provider de embeddings; a busca semantica fica degradada ate resolver.',
    persist: false,
  },
  'DB-MIGRATION': {
    title: 'Falha na migration do banco',
    body: 'Falha ao migrar o banco de dados no boot.',
    action: 'Veja o log do app e, se necessario, restaure o backup do banco.',
    persist: false,
  },
  'DB-FULL': {
    title: 'Disco cheio',
    body: 'Disco cheio ao gravar no banco de dados.',
    action: 'Libere espaco em disco e tente de novo.',
    persist: false,
  },
  'DB-BUSY': {
    title: 'Banco ocupado',
    body: 'Banco de dados ocupado (lock concorrente).',
    action: 'Tente de novo em alguns instantes.',
    persist: false,
  },
  'DB-CORRUPT-ROW': {
    title: 'Registro corrompido',
    body: 'Registro corrompido encontrado no banco de dados.',
    action: 'O registro foi ignorado; veja o log para identificar o dado afetado.',
    persist: false,
  },
  'VEC-UNAVAILABLE': {
    title: 'Busca vetorial indisponivel',
    body: 'Extensao de busca vetorial (sqlite-vec) indisponivel.',
    action: 'Busca semantica degradada; reinstale as dependencias nativas (rebuild:electron).',
    persist: false,
  },
  'MCP-START-FAIL': {
    title: 'Servidor MCP falhou',
    body: 'Servidor MCP falhou ao iniciar.',
    action: 'Veja o log do servidor MCP e revise a configuracao dele.',
    persist: false,
  },
  'MCP-DISCOVERY-FAIL': {
    title: 'Descoberta MCP falhou',
    body: 'Descoberta de tools de um servidor MCP falhou.',
    action: 'O servidor fica marcado com erro; verifique-o e reinicie-o.',
    persist: false,
  },
  'MCP-EMPTY': {
    title: 'Tool MCP sem resposta',
    body: 'Tool MCP retornou resposta vazia.',
    action: 'Tente de novo ou verifique o servidor MCP correspondente.',
    persist: false,
  },
  'SECRET-UNREADABLE': {
    title: 'Segredo ilegivel',
    body: 'Um segredo do cofre esta ilegivel (falha ao descriptografar).',
    action: 'Reconfigure a credencial afetada nas configuracoes.',
    persist: false,
  },
  'KEYTAR-DEGRADED': {
    title: 'Keychain indisponivel',
    body: 'Keychain do sistema indisponivel; segredos em modo degradado.',
    action: 'Verifique o keychain do sistema operacional e reinicie o app.',
    persist: false,
  },
  'VAULT-CORRUPT': {
    title: 'Cofre corrompido',
    body: 'Arquivo de segredos corrompido.',
    action: 'Um backup .bak foi criado; reconfigure as credenciais afetadas.',
    persist: false,
  },
  'REVOKE-UNCONFIRMED': {
    title: 'Revogacao nao confirmada',
    body: 'Revogacao remota da credencial NAO foi confirmada pelo provedor.',
    action: 'As credenciais locais foram limpas, mas revogue o acesso manualmente no painel do provedor.',
    persist: false,
  },
  'CRON-INVALID': {
    title: 'Cron invalido',
    body: 'Expressao cron invalida; a task agendada nao vai rodar.',
    action: 'Corrija a expressao cron da task no Scheduler.',
    persist: false,
  },
  'STT-FAIL': {
    title: 'Transcricao falhou',
    body: 'Transcricao de audio (STT) falhou.',
    action: 'Tente de novo ou verifique o provider de voz nas configuracoes.',
    persist: false,
  },
  'TTS-FAIL': {
    title: 'Voz falhou',
    body: 'Sintese de voz (TTS) falhou.',
    action: 'Tente de novo ou verifique o provider de voz nas configuracoes.',
    persist: false,
  },
  'IMG-FAIL': {
    title: 'Imagem falhou',
    body: 'Geracao ou processamento de imagem falhou.',
    action: 'Tente de novo ou verifique o provider de imagem nas configuracoes.',
    persist: false,
  },
  'LLM-UNKNOWN': {
    title: 'Erro do provider',
    body: 'Erro inesperado do provider.',
    action: 'Veja o log para detalhes e tente de novo.',
    persist: false,
  },
};

const MESSAGE_HINTS: Array<{ code: string; hints: string[] }> = [
  {
    code: 'LLM-QUOTA',
    hints: [
      'usage_limit_exceeded',
      'usagelimitexceeded',
      'usage limit',
      'quota',
      'insufficient credit',
      'insufficient_quota',
      'credit balance',
      'sem credito',
      'billing',
    ],
  },
  {
    code: 'LLM-AUTH-401',
    hints: [
      'unauthorized',
      'invalid api key',
      'invalid_api_key',
      'authentication',
      'forbidden',
      'credential',
      '401',
    ],
  },
  { code: 'LLM-RATE-429', hints: ['rate limit', 'rate_limit', 'rate-limit', 'too many requests', '429'] },
  {
    code: 'LLM-OVERLOADED-529',
    hints: ['overloaded', 'sobrecarregado', 'service unavailable', 'temporarily unavailable', '529'],
  },
  { code: 'LLM-TIMEOUT', hints: ['timed out', 'timeout', 'etimedout', 'deadline exceeded'] },
  {
    code: 'LLM-NET',
    hints: ['econnreset', 'econnrefused', 'enotfound', 'socket hang up', 'fetch failed', 'network error'],
  },
  {
    code: 'CODEX-EXIT',
    hints: ['app-server exited', 'app-server transport closed', 'codexsession is already closed'],
  },
  { code: 'LLM-EMPTY', hints: ['empty response', 'resposta vazia', 'terminou sem resposta'] },
];

function normalizeInput(
  input: TranslateLlmErrorInput | string | Error | null | undefined,
): { code?: string; message?: string } {
  if (input == null) return {};
  if (typeof input === 'string') return { message: input };
  if (input instanceof Error) return { message: input.message };
  const message = input.error ?? input.reason ?? undefined;
  return {
    ...(input.code ? { code: input.code } : {}),
    ...(message ? { message } : {}),
  };
}

function codeFromMessage(message: string): string | null {
  const lower = message.toLowerCase();
  for (const { code, hints } of MESSAGE_HINTS) {
    if (hints.some((h) => lower.includes(h))) return code;
  }
  return null;
}

export function translateLlmError(
  input: TranslateLlmErrorInput | string | Error | null | undefined,
): TranslatedLlmError {
  const { code, message } = normalizeInput(input);

  if (code && TRANSLATION_TABLE[code]) {
    const entry = TRANSLATION_TABLE[code];
    return {
      code,
      title: entry.title,
      body: entry.body,
      ...(entry.action ? { action: entry.action } : {}),
      persist: entry.persist,
      ...(message && message !== entry.body ? { detail: message } : {}),
    };
  }

  if (message) {
    const hinted = codeFromMessage(message);
    if (hinted && TRANSLATION_TABLE[hinted]) {
      const entry = TRANSLATION_TABLE[hinted];
      return {
        code: hinted,
        title: entry.title,
        body: entry.body,
        ...(entry.action ? { action: entry.action } : {}),
        persist: entry.persist,
        ...(message !== entry.body ? { detail: message } : {}),
      };
    }
    return { code: 'UNKNOWN', title: 'Erro', body: message, persist: false };
  }

  return { code: 'UNKNOWN', title: 'Erro', body: 'Erro desconhecido', persist: false };
}

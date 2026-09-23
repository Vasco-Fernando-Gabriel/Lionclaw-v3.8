export type LlmErrorCode =
  | 'LLM-QUOTA'
  | 'LLM-RATE-429'
  | 'LLM-OVERLOADED-529'
  | 'LLM-AUTH-401'
  | 'LLM-MODEL-404'
  | 'LLM-EMPTY'
  | 'LLM-NET'
  | 'LLM-TIMEOUT'
  | 'LLM-LOCAL-DOWN'
  | 'CODEX-EXIT'
  | 'CODEX-WEDGE'
  | 'COMPACT-EMPTY'
  | 'COMPACT-SKIPPED'
  | 'EMBED-FAIL'
  | 'DB-MIGRATION'
  | 'DB-FULL'
  | 'DB-BUSY'
  | 'DB-CORRUPT-ROW'
  | 'VEC-UNAVAILABLE'
  | 'MCP-START-FAIL'
  | 'MCP-DISCOVERY-FAIL'
  | 'MCP-EMPTY'
  | 'SECRET-UNREADABLE'
  | 'KEYTAR-DEGRADED'
  | 'VAULT-CORRUPT'
  | 'REVOKE-UNCONFIRMED'
  | 'CRON-INVALID'
  | 'STT-FAIL'
  | 'TTS-FAIL'
  | 'IMG-FAIL'
  | 'LLM-UNKNOWN';

export type LlmErrorCategory =
  | 'quota'
  | 'rate-limit'
  | 'overloaded'
  | 'auth'
  | 'model-unavailable'
  | 'empty-response'
  | 'network'
  | 'timeout'
  | 'local-provider'
  | 'codex'
  | 'compaction'
  | 'embedding'
  | 'database'
  | 'mcp'
  | 'secrets'
  | 'scheduler'
  | 'media'
  | 'unknown';

export interface LlmErrorDescriptor {
  category: LlmErrorCategory;
  userMessage: string;
  suggestedAction: string;
}

export const LLM_ERROR_TABLE: Record<LlmErrorCode, LlmErrorDescriptor> = {
  'LLM-QUOTA': {
    category: 'quota',
    userMessage: 'Cota ou creditos do provider esgotados.',
    suggestedAction: 'Verifique o plano/billing do provider ou troque de modelo nas configuracoes.',
  },
  'LLM-RATE-429': {
    category: 'rate-limit',
    userMessage: 'Limite de requisicoes (rate limit) do provider atingido.',
    suggestedAction: 'Aguarde alguns segundos e tente de novo.',
  },
  'LLM-OVERLOADED-529': {
    category: 'overloaded',
    userMessage: 'O provider esta sobrecarregado neste momento.',
    suggestedAction: 'Aguarde alguns minutos e tente de novo, ou troque de modelo.',
  },
  'LLM-AUTH-401': {
    category: 'auth',
    userMessage: 'Credencial do provider rejeitada (nao autorizado).',
    suggestedAction: 'Verifique a API key ou refaca o login do provider nas configuracoes.',
  },
  'LLM-MODEL-404': {
    category: 'model-unavailable',
    userMessage: 'Modelo nao encontrado ou indisponivel para esta credencial.',
    suggestedAction: 'Confira o nome do modelo nas configuracoes ou escolha outro modelo.',
  },
  'LLM-EMPTY': {
    category: 'empty-response',
    userMessage: 'O agente terminou sem resposta.',
    suggestedAction: 'Tente de novo; se persistir, troque de modelo ou verifique o provider.',
  },
  'LLM-NET': {
    category: 'network',
    userMessage: 'Falha de rede ao falar com o provider.',
    suggestedAction: 'Verifique sua conexao com a internet e tente de novo.',
  },
  'LLM-TIMEOUT': {
    category: 'timeout',
    userMessage: 'A chamada ao provider excedeu o tempo limite.',
    suggestedAction: 'Tente de novo; se persistir, reduza o prompt ou troque de modelo.',
  },
  'LLM-LOCAL-DOWN': {
    category: 'local-provider',
    userMessage: 'Provider local (Ollama/LM Studio) inacessivel.',
    suggestedAction: 'Verifique se o servidor local esta rodando e se a URL configurada esta correta.',
  },
  'CODEX-EXIT': {
    category: 'codex',
    userMessage: 'O processo do Codex encerrou inesperadamente.',
    suggestedAction: 'Tente de novo; a sessao do Codex sera recriada automaticamente.',
  },
  'CODEX-WEDGE': {
    category: 'codex',
    userMessage: 'O Codex parou de responder (travado, sem progresso).',
    suggestedAction: 'Aborte o turno e tente de novo; se persistir, reinicie o app.',
  },
  'COMPACT-EMPTY': {
    category: 'compaction',
    userMessage: 'A compactacao recebeu resposta vazia do modelo sumarizador.',
    suggestedAction: 'O contexto foi preservado; a compactacao sera retentada no proximo ciclo.',
  },
  'COMPACT-SKIPPED': {
    category: 'compaction',
    userMessage: 'A compactacao foi pulada nesta operacao.',
    suggestedAction: 'A operacao concluiu sem compactar; voce pode compactar manualmente depois.',
  },
  'EMBED-FAIL': {
    category: 'embedding',
    userMessage: 'Falha ao gerar embeddings.',
    suggestedAction: 'Verifique a credencial do provider de embeddings; a busca semantica fica degradada ate resolver.',
  },
  'DB-MIGRATION': {
    category: 'database',
    userMessage: 'Falha ao migrar o banco de dados no boot.',
    suggestedAction: 'Veja o log do app e, se necessario, restaure o backup do banco.',
  },
  'DB-FULL': {
    category: 'database',
    userMessage: 'Disco cheio ao gravar no banco de dados.',
    suggestedAction: 'Libere espaco em disco e tente de novo.',
  },
  'DB-BUSY': {
    category: 'database',
    userMessage: 'Banco de dados ocupado (lock concorrente).',
    suggestedAction: 'Tente de novo em alguns instantes.',
  },
  'DB-CORRUPT-ROW': {
    category: 'database',
    userMessage: 'Registro corrompido encontrado no banco de dados.',
    suggestedAction: 'O registro foi ignorado; veja o log para identificar o dado afetado.',
  },
  'VEC-UNAVAILABLE': {
    category: 'database',
    userMessage: 'Extensao de busca vetorial (sqlite-vec) indisponivel.',
    suggestedAction: 'Busca semantica degradada; reinstale as dependencias nativas (rebuild:electron).',
  },
  'MCP-START-FAIL': {
    category: 'mcp',
    userMessage: 'Servidor MCP falhou ao iniciar.',
    suggestedAction: 'Veja o log do servidor MCP e revise a configuracao dele.',
  },
  'MCP-DISCOVERY-FAIL': {
    category: 'mcp',
    userMessage: 'Descoberta de tools de um servidor MCP falhou.',
    suggestedAction: 'O servidor fica marcado com erro; verifique-o e reinicie-o.',
  },
  'MCP-EMPTY': {
    category: 'mcp',
    userMessage: 'Tool MCP retornou resposta vazia.',
    suggestedAction: 'Tente de novo ou verifique o servidor MCP correspondente.',
  },
  'SECRET-UNREADABLE': {
    category: 'secrets',
    userMessage: 'Um segredo do cofre esta ilegivel (falha ao descriptografar).',
    suggestedAction: 'Reconfigure a credencial afetada nas configuracoes.',
  },
  'KEYTAR-DEGRADED': {
    category: 'secrets',
    userMessage: 'Keychain do sistema indisponivel; segredos em modo degradado.',
    suggestedAction: 'Verifique o keychain do sistema operacional e reinicie o app.',
  },
  'VAULT-CORRUPT': {
    category: 'secrets',
    userMessage: 'Arquivo de segredos corrompido.',
    suggestedAction: 'Um backup .bak foi criado; reconfigure as credenciais afetadas.',
  },
  'REVOKE-UNCONFIRMED': {
    category: 'secrets',
    userMessage: 'Revogacao remota da credencial NAO foi confirmada pelo provedor.',
    suggestedAction: 'As credenciais locais foram limpas, mas revogue o acesso manualmente no painel do provedor.',
  },
  'CRON-INVALID': {
    category: 'scheduler',
    userMessage: 'Expressao cron invalida; a task agendada nao vai rodar.',
    suggestedAction: 'Corrija a expressao cron da task no Scheduler.',
  },
  'STT-FAIL': {
    category: 'media',
    userMessage: 'Transcricao de audio (STT) falhou.',
    suggestedAction: 'Tente de novo ou verifique o provider de voz nas configuracoes.',
  },
  'TTS-FAIL': {
    category: 'media',
    userMessage: 'Sintese de voz (TTS) falhou.',
    suggestedAction: 'Tente de novo ou verifique o provider de voz nas configuracoes.',
  },
  'IMG-FAIL': {
    category: 'media',
    userMessage: 'Geracao ou processamento de imagem falhou.',
    suggestedAction: 'Tente de novo ou verifique o provider de imagem nas configuracoes.',
  },
  'LLM-UNKNOWN': {
    category: 'unknown',
    userMessage: 'Erro inesperado do provider.',
    suggestedAction: 'Veja o log para detalhes e tente de novo.',
  },
};

export interface AgentExecutionError {
  code: LlmErrorCode;
  category: LlmErrorCategory;
  userMessage: string;
  suggestedAction: string;
  raw?: string;
}

export function buildExecutionError(code: LlmErrorCode, raw?: string): AgentExecutionError {
  const entry = LLM_ERROR_TABLE[code];
  return {
    code,
    category: entry.category,
    userMessage: entry.userMessage,
    suggestedAction: entry.suggestedAction,
    ...(raw !== undefined ? { raw } : {}),
  };
}

export function emptyResponseExecutionError(args: {
  content: string;
  toolUses: number;
  aborted?: boolean;
  provider?: string;
  model?: string;
}): AgentExecutionError | undefined {
  if (args.aborted === true) return undefined;
  if (args.content !== '') return undefined;
  if (args.toolUses > 0) return undefined;
  const rawParts: string[] = [];
  if (args.provider) rawParts.push(`provider=${args.provider}`);
  if (args.model) rawParts.push(`model=${args.model}`);
  return buildExecutionError('LLM-EMPTY', rawParts.length > 0 ? rawParts.join(' ') : undefined);
}

export function isEmptyFailedTurn(args: {
  assistantContent: string;
  outputTokens: number;
  artifactCount: number;
}): boolean {
  return args.assistantContent === '' && args.outputTokens === 0 && args.artifactCount === 0;
}

export interface TypedProviderErrorOptions {
  message?: string;
  raw?: string;
  cause?: unknown;
  status?: number;
}

export class TypedProviderError extends Error {
  readonly code: LlmErrorCode;
  readonly category: LlmErrorCategory;
  readonly userMessage: string;
  readonly suggestedAction: string;
  readonly raw?: string;
  readonly status?: number;

  constructor(code: LlmErrorCode, options?: TypedProviderErrorOptions) {
    const entry = LLM_ERROR_TABLE[code];
    super(options?.message ?? entry.userMessage, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TypedProviderError';
    this.code = code;
    this.category = entry.category;
    this.userMessage = entry.userMessage;
    this.suggestedAction = entry.suggestedAction;
    if (options?.raw !== undefined) this.raw = options.raw;
    if (options?.status !== undefined) this.status = options.status;
  }

  toExecutionError(): AgentExecutionError {
    return {
      code: this.code,
      category: this.category,
      userMessage: this.userMessage,
      suggestedAction: this.suggestedAction,
      ...(this.raw !== undefined ? { raw: this.raw } : {}),
    };
  }
}

export class EmptyProviderResponseError extends Error {
  readonly code: LlmErrorCode = 'COMPACT-EMPTY';
  readonly category: LlmErrorCategory;
  readonly userMessage: string;
  readonly suggestedAction: string;
  readonly provider: string;
  readonly model: string;
  readonly runtime: string;

  constructor(provider: string, model: string, runtime: string) {
    super(`Resposta vazia do provider ${provider}/${model} (runtime ${runtime})`);
    this.name = 'EmptyProviderResponseError';
    const entry = LLM_ERROR_TABLE['COMPACT-EMPTY'];
    this.category = entry.category;
    this.userMessage = entry.userMessage;
    this.suggestedAction = entry.suggestedAction;
    this.provider = provider;
    this.model = model;
    this.runtime = runtime;
  }
}

export interface TranslateProviderErrorContext {
  runtime?: string;
  provider?: string;
  model?: string;
  httpStatus?: number;
}

function errorMessageOf(input: unknown): string {
  if (typeof input === 'string') return input.toLowerCase();
  if (input && typeof input === 'object') {
    const m = (input as { message?: unknown }).message;
    if (typeof m === 'string') return m.toLowerCase();
  }
  return '';
}

function rawMessageOf(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const m = (input as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return undefined;
}

function httpStatusOf(input: unknown): number | undefined {
  if (input && typeof input === 'object') {
    const e = input as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
    if (e.response && typeof e.response === 'object' && typeof e.response.status === 'number') {
      return e.response.status;
    }
  }
  return undefined;
}

const QUOTA_HINTS = [
  'usage_limit_exceeded',
  'usagelimitexceeded',
  'usage limit',
  'limite da sua assinatura',
  'quota',
  'insufficient credit',
  'insufficient_quota',
  'out of credit',
  'no credit',
  'sem credito',
  'credit balance',
  'billing',
  'resource_exhausted',
];

const AUTH_HINTS = [
  'unauthorized',
  'invalid api key',
  'invalid_api_key',
  'api key rejected',
  'authentication',
  'authentication_error',
  'forbidden',
  'login required',
  're-login',
  'credential',
];

const RATE_HINTS = ['rate limit', 'rate_limit', 'rate-limit', 'too many requests', '429'];

const OVERLOADED_HINTS = [
  'overloaded',
  'overloaded_error',
  'server_overloaded',
  'sobrecarregado',
  'service unavailable',
  'temporarily unavailable',
  'bad gateway',
  'internal server error',
  '529',
];

const MODEL_HINTS = ['model not found', 'model_not_found', 'no such model', 'unknown model'];

const TIMEOUT_HINTS = ['timed out', 'timeout', 'etimedout', 'deadline exceeded'];

const NET_HINTS = [
  'econnreset',
  'econnrefused',
  'enotfound',
  'eai_again',
  'epipe',
  'socket hang up',
  'fetch failed',
  'network error',
  'gateway timeout',
];

const CODEX_EXIT_HINTS = ['app-server exited', 'app-server transport closed', 'codexsession is already closed'];

const CODEX_WEDGE_HINTS = ['stalled: no progress', 'codex wedge'];

const EMPTY_HINTS = ['empty response', 'resposta vazia'];

function isLocalConnectionRefused(msg: string, ctx?: TranslateProviderErrorContext): boolean {
  if (!msg.includes('econnrefused') && !msg.includes('connection refused')) return false;
  if (ctx?.runtime === 'local') return true;
  const provider = ctx?.provider?.toLowerCase() ?? '';
  if (provider === 'ollama' || provider === 'lmstudio') return true;
  return msg.includes('localhost') || msg.includes('127.0.0.1');
}

function codeFromHttpStatus(status: number): LlmErrorCode | null {
  if (status === 402) return 'LLM-QUOTA';
  if (status === 401 || status === 403) return 'LLM-AUTH-401';
  if (status === 404) return 'LLM-MODEL-404';
  if (status === 408) return 'LLM-TIMEOUT';
  if (status === 429) return 'LLM-RATE-429';
  if (status >= 500 && status <= 599) return 'LLM-OVERLOADED-529';
  return null;
}

function codeFromMessage(msg: string, ctx?: TranslateProviderErrorContext): LlmErrorCode | null {
  if (!msg) return null;
  if (CODEX_EXIT_HINTS.some((h) => msg.includes(h))) return 'CODEX-EXIT';
  if (CODEX_WEDGE_HINTS.some((h) => msg.includes(h))) return 'CODEX-WEDGE';
  if (QUOTA_HINTS.some((h) => msg.includes(h))) return 'LLM-QUOTA';
  if (AUTH_HINTS.some((h) => msg.includes(h))) return 'LLM-AUTH-401';
  if (RATE_HINTS.some((h) => msg.includes(h))) return 'LLM-RATE-429';
  if (OVERLOADED_HINTS.some((h) => msg.includes(h))) return 'LLM-OVERLOADED-529';
  if (MODEL_HINTS.some((h) => msg.includes(h))) return 'LLM-MODEL-404';
  if (isLocalConnectionRefused(msg, ctx)) return 'LLM-LOCAL-DOWN';
  if (TIMEOUT_HINTS.some((h) => msg.includes(h))) return 'LLM-TIMEOUT';
  if (NET_HINTS.some((h) => msg.includes(h))) return 'LLM-NET';
  if (EMPTY_HINTS.some((h) => msg.includes(h))) return 'LLM-EMPTY';
  return null;
}

export function translateProviderError(input: unknown, ctx?: TranslateProviderErrorContext): TypedProviderError {
  if (input instanceof TypedProviderError) return input;

  const raw = rawMessageOf(input);

  if (input instanceof EmptyProviderResponseError) {
    return new TypedProviderError(input.code, {
      message: input.message,
      raw: input.message,
      cause: input,
    });
  }

  const status = ctx?.httpStatus ?? httpStatusOf(input);
  const msg = errorMessageOf(input);

  let code: LlmErrorCode | null = null;
  if (typeof status === 'number') code = codeFromHttpStatus(status);
  if (code === null) code = codeFromMessage(msg, ctx);
  if (code === null) code = 'LLM-UNKNOWN';

  return new TypedProviderError(code, {
    ...(raw !== undefined ? { message: raw, raw } : {}),
    cause: input,
    ...(typeof status === 'number' ? { status } : {}),
  });
}

export function codexTurnFailureError(args: {
  status: 'failed' | 'timeout';
  errorCode?: string;
  model?: string;
  detail?: string;
}): TypedProviderError {
  const codePart = args.errorCode ? ` [${args.errorCode}]` : '';
  const detailPart = args.detail ? `: ${args.detail.slice(0, 500)}` : '';
  const message = `codex turn ${args.status}${codePart}${detailPart}`;
  return translateProviderError(new Error(message), {
    runtime: 'codex',
    ...(args.model !== undefined ? { model: args.model } : {}),
  });
}

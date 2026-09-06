
import {
  translateProviderError,
  type LlmErrorCode,
  type TranslateProviderErrorContext,
} from '../../agent-runtime/llm-error';

export interface NormalizedOpenAiCompatError {
  code: LlmErrorCode;
  status?: number;
  userMessage: string;
}

function shortenDetail(raw: string): string {
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= 200) return trimmed;
  return trimmed.slice(0, 197) + '...';
}

export interface OpenAiEmbeddedError {
  message: string;
  type?: string;
  code?: string;
}

export function extractOpenAiEmbeddedError(parsed: unknown): OpenAiEmbeddedError | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const err = (parsed as { error?: unknown }).error;
  if (typeof err === 'string' && err.trim().length > 0) {
    return { message: err };
  }
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const message = typeof e['message'] === 'string' ? e['message'] : '';
    const type = typeof e['type'] === 'string' ? e['type'] : undefined;
    const code =
      typeof e['code'] === 'string'
        ? e['code']
        : typeof e['code'] === 'number'
          ? String(e['code'])
          : undefined;
    if (message || type || code) {
      return {
        message: message || type || code || 'erro do provider sem mensagem',
        ...(type !== undefined ? { type } : {}),
        ...(code !== undefined ? { code } : {}),
      };
    }
  }
  return null;
}

function formatNormalized(
  code: LlmErrorCode,
  userMessage: string,
  detail: string | undefined,
  status?: number,
): NormalizedOpenAiCompatError {
  const statusPart = typeof status === 'number' ? `HTTP ${status}` : '';
  const detailPart = detail ? shortenDetail(detail) : '';
  const tail = [statusPart, detailPart].filter((p) => p.length > 0).join(': ');
  return {
    code,
    ...(typeof status === 'number' ? { status } : {}),
    userMessage: tail.length > 0 ? `[${code}] ${userMessage} (${tail})` : `[${code}] ${userMessage}`,
  };
}

export function normalizeOpenAiCompatHttpError(args: {
  status: number;
  bodyText?: string;
  ctx?: TranslateProviderErrorContext;
}): NormalizedOpenAiCompatError {
  const embedded = args.bodyText ? tryExtractFromBodyText(args.bodyText) : null;
  const detail = embedded?.message ?? args.bodyText ?? '';
  const translated = translateProviderError(new Error(detail || `HTTP ${args.status}`), {
    ...(args.ctx ?? {}),
    httpStatus: args.status,
  });
  return formatNormalized(translated.code, translated.userMessage, detail, args.status);
}

function tryExtractFromBodyText(bodyText: string): OpenAiEmbeddedError | null {
  try {
    return extractOpenAiEmbeddedError(JSON.parse(bodyText));
  } catch {
    return null;
  }
}

export function normalizeOpenAiCompatEmbeddedError(
  embedded: OpenAiEmbeddedError,
  ctx?: TranslateProviderErrorContext,
): NormalizedOpenAiCompatError {
  const combined = [embedded.message, embedded.type, embedded.code]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' | ');
  const translated = translateProviderError(new Error(combined), ctx);
  return formatNormalized(translated.code, translated.userMessage, combined, translated.status);
}

export function normalizeOpenAiCompatTransportError(
  err: unknown,
  ctx?: TranslateProviderErrorContext,
): NormalizedOpenAiCompatError {
  const translated = translateProviderError(err, ctx);
  const detail = err instanceof Error ? err.message : String(err);
  return formatNormalized(translated.code, translated.userMessage, detail, translated.status);
}

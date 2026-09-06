
export interface NormalizedGoogleGenAiError {
  code?: string;
  status?: number;
  userMessage: string;
}


function shortenMessage(raw: string): string {
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= 140) return trimmed;
  return trimmed.slice(0, 137) + '...';
}

interface ParsedError {
  status?: number;
  code?: string;
  rawMessage: string;
  upperMessage: string;
  finishReason?: string;
}

function parseError(err: unknown): ParsedError {
  if (err == null) {
    return { rawMessage: '', upperMessage: '' };
  }
  if (typeof err === 'string') {
    return { rawMessage: err, upperMessage: err.toUpperCase() };
  }
  if (typeof err !== 'object') {
    const s = String(err);
    return { rawMessage: s, upperMessage: s.toUpperCase() };
  }

  const e = err as Record<string, unknown>;

  let status: number | undefined;
  let code: string | undefined;
  let message = '';
  let finishReason: string | undefined;

  if (typeof e.status === 'number') status = e.status;
  if (typeof e.statusCode === 'number' && status === undefined) status = e.statusCode;
  if (typeof e.code === 'string') code = e.code;
  if (typeof e.message === 'string') message = e.message;

  const nested = e.error;
  if (nested && typeof nested === 'object') {
    const n = nested as Record<string, unknown>;
    if (typeof n.status === 'number' && status === undefined) status = n.status;
    if (typeof n.status === 'string' && code === undefined) code = n.status;
    if (typeof n.code === 'string' && code === undefined) code = n.code;
    if (typeof n.code === 'number' && status === undefined) status = n.code;
    if (typeof n.message === 'string' && !message) message = n.message;
  }

  if (typeof e.finishReason === 'string') {
    finishReason = e.finishReason;
  }

  const response = e.response;
  if (response && typeof response === 'object') {
    const r = response as Record<string, unknown>;
    const candidates = r.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
      const first = candidates[0] as Record<string, unknown> | undefined;
      if (first && typeof first.finishReason === 'string' && !finishReason) {
        finishReason = first.finishReason;
      }
    }
    const promptFeedback = r.promptFeedback;
    if (promptFeedback && typeof promptFeedback === 'object') {
      const pf = promptFeedback as Record<string, unknown>;
      if (typeof pf.blockReason === 'string' && !finishReason) {
        finishReason = pf.blockReason;
      }
    }
  }

  if (!finishReason) {
    const pf = e.promptFeedback;
    if (pf && typeof pf === 'object') {
      const pfo = pf as Record<string, unknown>;
      if (typeof pfo.blockReason === 'string') {
        finishReason = pfo.blockReason;
      }
    }
  }

  return {
    status,
    code,
    rawMessage: message,
    upperMessage: message.toUpperCase(),
    finishReason: finishReason?.toUpperCase(),
  };
}

const SAFETY_REASONS = new Set(['SAFETY']);
const POLICY_REASONS = new Set([
  'RECITATION',
  'LANGUAGE',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);
const TOOL_REASONS = new Set([
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
]);


export function normalizeGoogleGenAiError(
  err: unknown,
): NormalizedGoogleGenAiError {
  const parsed = parseError(err);
  const out: NormalizedGoogleGenAiError = { userMessage: '' };
  if (parsed.code) out.code = parsed.code;
  if (parsed.status !== undefined) out.status = parsed.status;

  if (parsed.status === 401 || parsed.status === 403) {
    out.userMessage =
      'Google API key rejected. Check the key and API restrictions.';
    return out;
  }

  if (
    parsed.status === 404 ||
    /MODEL.+NOT.+FOUND|NOT FOUND|NOT_FOUND/.test(parsed.upperMessage)
  ) {
    out.userMessage =
      'This Gemini model is not available for this key, project, or location.';
    return out;
  }

  if (
    parsed.status === 429 ||
    /QUOTA|RATE.?LIMIT|RESOURCE_EXHAUSTED/.test(parsed.upperMessage)
  ) {
    out.userMessage = 'Google quota exceeded for this project or key.';
    return out;
  }

  if (
    parsed.status === 400 &&
    /LOCATION|REGION|UNAVAILABLE IN/.test(parsed.upperMessage)
  ) {
    out.userMessage =
      'Model is not available in this location. Try global.';
    return out;
  }

  if (
    parsed.status === 400 &&
    (parsed.code === 'INVALID_ARGUMENT' ||
      /INVALID_ARGUMENT/.test(parsed.upperMessage)) &&
    /TOOL|PARAMETERS?|SCHEMA|FUNCTION_DECLARATIONS?/.test(parsed.upperMessage)
  ) {
    out.userMessage =
      'Gemini rejected a tool schema. Check adapter schema conversion logs.';
    return out;
  }

  if (parsed.finishReason) {
    if (SAFETY_REASONS.has(parsed.finishReason)) {
      out.code = out.code ?? parsed.finishReason;
      out.userMessage =
        'Gemini blocked this response due to safety settings.';
      return out;
    }
    if (POLICY_REASONS.has(parsed.finishReason)) {
      out.code = out.code ?? parsed.finishReason;
      out.userMessage =
        'Gemini blocked this response due to policy settings.';
      return out;
    }
    if (TOOL_REASONS.has(parsed.finishReason)) {
      out.code = out.code ?? parsed.finishReason;
      out.userMessage = 'Gemini returned an invalid tool call.';
      return out;
    }
  }

  const safeTail = parsed.rawMessage
    ? shortenMessage(parsed.rawMessage)
    : 'unknown error';
  out.userMessage = `Vertex Gemini request failed: ${safeTail}`;
  return out;
}

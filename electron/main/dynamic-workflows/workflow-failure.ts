import type { DynamicWorkflowFailureClass, DynamicWorkflowRetryPolicy } from '../../../src/types/dynamic-workflow';

export type WorkflowFailureRuntime =
  'cloud' | 'local' | 'external' | 'codex' | 'kimi' | 'grok' | 'zai' | 'minimax-tp' | 'cursor';

export interface FailureClassificationInput {
  runtime: WorkflowFailureRuntime;
  error: unknown;
  timedOut?: boolean;
  aborted?: boolean;
  schemaExhausted?: boolean;
  httpStatus?: number;
}

const CODEX_AUTH_ERROR_NAME = 'CodexAuthError';
const CODEX_UNAVAILABLE_ERROR_NAME = 'CodexUnavailableError';

const CODEX_PERMANENT_INFRA_HINTS = [
  'codex binary not found',
  'resolvecodexbinary returned null',
  'thread/start returned no threadid',
];

const USER_ABORT_HINTS = ['aborted by user', 'canceled by user', 'cancelled by user', 'the operation was aborted'];

function isUserAbort(error: unknown): boolean {
  if (errorName(error) === 'AbortError') return true;
  const msg = errorMessage(error).toLowerCase();
  return USER_ABORT_HINTS.some((hint) => msg.includes(hint));
}

function isCodexPermanentInfra(error: unknown): boolean {
  const msg = errorMessage(error);
  if (!msg) return false;
  return CODEX_PERMANENT_INFRA_HINTS.some((h) => msg.includes(h));
}

const KIMI_UNAVAILABLE_ERROR_NAME = 'KimiUnavailableError';
const KIMI_QUOTA_ERROR_NAME = 'KimiQuotaError';

function errorName(error: unknown): string | null {
  if (error && typeof error === 'object') {
    const named = error as { name?: unknown; constructor?: { name?: unknown } };
    if (typeof named.name === 'string' && named.name.length > 0) {
      return named.name;
    }
    if (named.constructor && typeof named.constructor.name === 'string' && named.constructor.name.length > 0) {
      return named.constructor.name;
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error.toLowerCase();
  if (error && typeof error === 'object') {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string') return m.toLowerCase();
  }
  return '';
}

function httpStatusFromError(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const e = error as { status?: unknown; statusCode?: unknown };
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
  }
  return undefined;
}

const AUTH_HINTS = [
  'unauthorized',
  'invalid api key',
  'invalid_api_key',
  'authentication',
  'authentication_error',
  'forbidden',
  're-login',
  'relogin',
  'login required',
  'reconnect',
  'credential',
];

const LIMIT_HINTS = [
  'rate limit',
  'rate_limit',
  'rate-limit',
  'too many requests',
  'quota',
  'insufficient credit',
  'insufficient_quota',
  'out of credit',
  'no credit',
  'sem credito',
  'billing',
  'usage limit',
  'limit reached',
  'window',
];

const TRANSIENT_HINTS = [
  'overloaded',
  'overloaded_error',
  'service unavailable',
  'temporarily unavailable',
  'bad gateway',
  'gateway timeout',
  'internal server error',
  'econnreset',
  'etimedout',
  'socket hang up',
  'fetch failed',
];

const TIMEOUT_HINTS = ['timed out', 'timeout', 'deadline exceeded'];

function classifyFromHttpStatus(status: number): DynamicWorkflowFailureClass | null {
  if (status === 401 || status === 403) return 'provider-auth';
  if (status === 429) return 'provider-limit';
  if (status === 408) return 'timeout';
  if (status >= 500 && status <= 599) return 'provider-error';
  return null;
}

function classifyFromMessage(msg: string): DynamicWorkflowFailureClass | null {
  if (!msg) return null;
  if (AUTH_HINTS.some((h) => msg.includes(h))) return 'provider-auth';
  if (LIMIT_HINTS.some((h) => msg.includes(h))) return 'provider-limit';
  if (TIMEOUT_HINTS.some((h) => msg.includes(h))) return 'timeout';
  if (TRANSIENT_HINTS.some((h) => msg.includes(h))) return 'provider-error';
  return null;
}

export function classifyFailure(input: FailureClassificationInput): DynamicWorkflowFailureClass {
  if (input.schemaExhausted) return 'schema';

  const name = errorName(input.error);
  if (name === CODEX_AUTH_ERROR_NAME) return 'provider-auth';
  if (name === CODEX_UNAVAILABLE_ERROR_NAME) {
    if (isCodexPermanentInfra(input.error)) return 'provider-auth';
    return 'provider-limit';
  }
  if (name === KIMI_QUOTA_ERROR_NAME) return 'provider-limit';
  if (name === KIMI_UNAVAILABLE_ERROR_NAME) return 'provider-auth';

  if (input.aborted || isUserAbort(input.error)) return 'cancelled';

  if (input.timedOut) return 'timeout';

  const status = input.httpStatus ?? httpStatusFromError(input.error);
  if (typeof status === 'number') {
    const byStatus = classifyFromHttpStatus(status);
    if (byStatus) return byStatus;
  }

  const byMessage = classifyFromMessage(errorMessage(input.error));
  if (byMessage) return byMessage;

  return 'logic';
}

export const DEFAULT_RETRY_POLICY: DynamicWorkflowRetryPolicy = {
  maxAutoRetries: 3,
  backoff: 'exponential-jitter',
  retryOn: ['provider-limit', 'provider-error', 'timeout'],
  blockOn: ['provider-auth'],
  escalateAfterRetries: true,
};

const BACKOFF_BASE_MS = 30_000;

const BACKOFF_FACTOR = 4;

export interface RetryDecision {
  shouldRetry: boolean;
  backoffMs: number;
  escalate: boolean;
  blockImmediately: boolean;
}

export function computeBackoffMs(retryIndex: number): number {
  const capped = Math.max(0, retryIndex);
  return BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, capped);
}

export function decideRetry(
  failureClass: DynamicWorkflowFailureClass,
  attemptsMade: number,
  policy: DynamicWorkflowRetryPolicy = DEFAULT_RETRY_POLICY,
): RetryDecision {
  const noRetry: RetryDecision = {
    shouldRetry: false,
    backoffMs: 0,
    escalate: false,
    blockImmediately: false,
  };

  if (policy.blockOn.includes(failureClass)) {
    return { ...noRetry, blockImmediately: true };
  }

  if (!policy.retryOn.includes(failureClass)) {
    return noRetry;
  }

  if (attemptsMade < policy.maxAutoRetries) {
    return {
      shouldRetry: true,
      backoffMs: computeBackoffMs(attemptsMade - 1),
      escalate: false,
      blockImmediately: false,
    };
  }

  return {
    shouldRetry: false,
    backoffMs: 0,
    escalate: policy.escalateAfterRetries,
    blockImmediately: false,
  };
}

const WINDOW_LIMIT_HINTS = [
  'usage limit reached',
  'usage limit',
  '5-hour limit',
  'five hour limit',
  'weekly limit',
  'daily limit',
  'limit will reset',
  'limit resets',
  'try again later',
  'please wait',
  'janela',
];

const OVERLOADED_HINTS = ['overloaded', 'overloaded_error', 'capacity', 'congestion'];

const CLI_RELOGIN_HINTS = ['run /login', 'please re-authenticate', 'session expired', 'token expired', 'codex login'];

function refineFromRuntimeMessage(runtime: WorkflowFailureRuntime, msg: string): DynamicWorkflowFailureClass | null {
  if (!msg) return null;

  if (runtime === 'codex' && CLI_RELOGIN_HINTS.some((h) => msg.includes(h))) {
    return 'provider-auth';
  }

  if (WINDOW_LIMIT_HINTS.some((h) => msg.includes(h))) {
    return 'provider-limit';
  }

  if (OVERLOADED_HINTS.some((h) => msg.includes(h))) {
    return 'provider-error';
  }

  return null;
}

export function classifyFailureByRuntime(input: FailureClassificationInput): DynamicWorkflowFailureClass {
  const base = classifyFailure(input);
  if (base !== 'logic') return base;
  const refined = refineFromRuntimeMessage(input.runtime, errorMessage(input.error));
  return refined ?? 'logic';
}

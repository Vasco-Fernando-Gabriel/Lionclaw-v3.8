export class GrokUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'GrokUnavailableError';
  }
}

export class GrokAuthError extends GrokUnavailableError {
  constructor(message = 'Grok Build nao esta autenticado no home isolado do LionClaw.', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GrokAuthError';
  }
}

export class GrokBackendError extends GrokUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GrokBackendError';
  }
}

export class GrokIsolationError extends GrokUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GrokIsolationError';
  }
}

export class GrokToolPolicyError extends GrokUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GrokToolPolicyError';
  }
}

export class GrokCapabilityError extends GrokUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GrokCapabilityError';
  }
}

export class GrokProcessError extends GrokUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GrokProcessError';
  }
}

export class GrokJsonRpcError extends GrokProcessError {
  readonly code: string | number | undefined;
  readonly data: unknown;
  readonly method: string;

  constructor(
    message: string,
    options: { method: string; code?: string | number; data?: unknown; cause?: unknown },
  ) {
    super(message, options);
    this.name = 'GrokJsonRpcError';
    this.method = options.method;
    this.code = options.code;
    this.data = options.data;
  }
}

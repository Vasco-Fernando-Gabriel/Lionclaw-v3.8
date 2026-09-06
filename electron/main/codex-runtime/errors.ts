export class CodexAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexAuthError';
  }
}

export class CodexUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexUnavailableError';
  }
}

export const CODEX_CAPABILITY_UNSUPPORTED_CODE = 'codex-capability-unsupported' as const;

export class CodexCapabilityUnsupportedError extends Error {
  readonly code = CODEX_CAPABILITY_UNSUPPORTED_CODE;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexCapabilityUnsupportedError';
  }
}

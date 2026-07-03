export class ProviderError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    provider: string,
    message: string,
    options: { retryable?: boolean; status?: number; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export class RetryableProviderError extends ProviderError {
  constructor(provider: string, message: string, status?: number, cause?: unknown) {
    super(provider, message, { retryable: true, status, cause });
    this.name = "RetryableProviderError";
  }
}

export class NoAvailableModelError extends Error {
  constructor(message = "No available model matched the router request") {
    super(message);
    this.name = "NoAvailableModelError";
  }
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return error.retryable;
  }

  return false;
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

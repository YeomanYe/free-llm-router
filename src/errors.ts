export class ProviderError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly status?: number;
  // Parsed Retry-After hint (ms) when the upstream sent one. The router uses
  // it instead of the fixed cooldown when present.
  readonly retryAfterMs?: number;

  constructor(
    provider: string,
    message: string,
    options: { retryable?: boolean; status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class RetryableProviderError extends ProviderError {
  constructor(
    provider: string,
    message: string,
    status?: number,
    retryAfterMs?: number,
    cause?: unknown,
  ) {
    super(provider, message, { retryable: true, status, retryAfterMs, cause });
    this.name = "RetryableProviderError";
  }
}

export class NoAvailableModelError extends Error {
  constructor(message = "No available model matched the router request") {
    super(message);
    this.name = "NoAvailableModelError";
  }
}

// Raised when a provider call exceeds its timeout. Always retryable — the next
// candidate or retry attempt may land on a faster endpoint.
export class TimeoutError extends ProviderError {
  constructor(provider: string, ms: number) {
    super(provider, `request timed out after ${ms}ms`, { retryable: true });
    this.name = "TimeoutError";
  }
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return error.retryable;
  }

  // Native fetch throws a DOMException('AbortError') when an AbortSignal fires.
  // Treat aborts (which we use for timeouts) as retryable.
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }

  return false;
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

// Parses a Retry-After header value into milliseconds. Accepts both the
// delta-seconds form ("30") and the HTTP-date form
// ("Wed, 21 Oct 2026 07:28:00 GMT"). Returns undefined when absent or unparseable.
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

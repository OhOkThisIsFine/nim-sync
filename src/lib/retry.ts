export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default: 1000) */
  initialDelay?: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelay?: number;
  /** Whether to retry on network errors (default: true) */
  retryOnNetworkError?: boolean;
  /** Status codes to retry (default: [429, 500, 502, 503, 504]) */
  retryStatusCodes?: number[];
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Callback fired on each retry attempt */
  onRetry?: (info: {
    attempt: number;
    delay: number;
    error: Error;
    maxRetries: number;
  }) => void;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  retryOnNetworkError: true,
  retryStatusCodes: [429, 500, 502, 503, 504],
  timeoutMs: 30_000,
  onRetry: undefined!,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        console.info(
          "[NIM-Sync] Retry succeeded on attempt %d/%d",
          attempt + 1,
          opts.maxRetries,
        );
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const shouldRetry = shouldRetryError(error, opts);

      if (!shouldRetry || attempt === opts.maxRetries) {
        if (attempt > 0) {
          console.error(
            "[NIM-Sync] All %d retry attempts exhausted for: %s",
            opts.maxRetries,
            lastError.message,
          );
        }
        throw lastError;
      }

      const baseDelay = Math.min(
        opts.initialDelay * Math.pow(2, attempt),
        opts.maxDelay,
      );
      const delay = Math.random() * baseDelay;

      console.warn(
        "[NIM-Sync] Retry attempt %d/%d failed: %s. Retrying in %dms...",
        attempt + 1,
        opts.maxRetries,
        lastError.message,
        delay,
      );

      opts.onRetry?.({
        attempt: attempt + 1,
        delay,
        error: lastError,
        maxRetries: opts.maxRetries,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error("Retry logic failed unexpectedly");
}

function shouldRetryError(
  error: unknown,
  options: Required<RetryOptions>,
): boolean {
  if (options.retryOnNetworkError && isNetworkError(error)) {
    return true;
  }

  if (isHttpError(error)) {
    const statusCode = getStatusCode(error);
    return options.retryStatusCodes.includes(statusCode);
  }

  return false;
}

export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const codePatterns = [
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETUNREACH",
    "ECONNRESET",
    "EPIPE",
    "ENETDOWN",
    "ECONNABORTED",
    "ABORT_ERR",
    "ERR_NETWORK",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ];

  const namePatterns = ["AbortError", "TimeoutError", "FetchError"];

  if (
    (error as NodeJS.ErrnoException).code &&
    codePatterns.includes((error as NodeJS.ErrnoException).code!)
  ) {
    return true;
  }

  if (namePatterns.includes(error.name)) {
    return true;
  }

  let cause: unknown = (error as Error & { cause?: unknown }).cause;
  while (cause) {
    if (cause instanceof Error) {
      if (
        (cause as NodeJS.ErrnoException).code &&
        codePatterns.includes((cause as NodeJS.ErrnoException).code!)
      ) {
        return true;
      }
      if (namePatterns.includes(cause.name)) {
        return true;
      }
    }
    cause = (cause as Error & { cause?: unknown }).cause;
  }

  return false;
}

function isHttpError(
  error: unknown,
): error is { statusCode: number; statusText: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof (error as Record<string, unknown>).statusCode === "number"
  );
}

function getStatusCode(error: unknown): number {
  if (isHttpError(error)) {
    return error.statusCode;
  }
  return 0;
}

/**
 * Exponential backoff retry utility for API calls.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number
  /** Initial delay in milliseconds (default: 1000) */
  initialDelay?: number
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelay?: number
  /** Whether to retry on network errors (default: true) */
  retryOnNetworkError?: boolean
  /** Status codes to retry (default: [429, 500, 502, 503, 504]) */
  retryStatusCodes?: number[]
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  retryOnNetworkError: true,
  retryStatusCodes: [429, 500, 502, 503, 504]
}

/**
 * Executes a function with exponential backoff retry logic.
 * 
 * @param fn - Function to execute with retry logic
 * @param options - Retry configuration options
 * @returns Result of the function if successful
 * @throws Last error if all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      
      // Determine if we should retry
      const shouldRetry = shouldRetryError(error, opts)
      
      if (!shouldRetry || attempt === opts.maxRetries) {
        throw lastError
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        opts.initialDelay * Math.pow(2, attempt),
        opts.maxDelay
      )
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  // This should never be reached due to throw in loop, but TypeScript needs it
  throw lastError || new Error('Retry logic failed unexpectedly')
}

/**
 * Determines if an error should trigger a retry.
 * 
 * @param error - The caught error
 * @param options - Retry configuration
 * @returns True if the error should trigger a retry
 */
function shouldRetryError(error: unknown, options: Required<RetryOptions>): boolean {
  // Network errors (timeouts, connection refused, etc.)
  if (options.retryOnNetworkError && isNetworkError(error)) {
    return true
  }

  // Check if it's an HTTP error with retryable status code
  if (isHttpError(error)) {
    const statusCode = getStatusCode(error)
    return options.retryStatusCodes.includes(statusCode)
  }

  return false
}

/**
 * Checks if an error is a network error (timeout, connection refused, etc.).
 */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  
  const networkErrorPatterns = [
    'network',
    'timeout',
    'connection',
    'fetch',
    'abort',
    'ECONNREFUSED',
    'ETIMEDOUT'
  ]
  
  const message = error.message.toLowerCase()
  const name = error.name.toLowerCase()
  
  return networkErrorPatterns.some(pattern => 
    message.includes(pattern) || name.includes(pattern)
  )
}

/**
 * Checks if an error is an HTTP error with a status code.
 */
function isHttpError(error: unknown): error is { statusCode: number; statusText: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof (error as Record<string, unknown>).statusCode === 'number'
  )
}

/**
 * Extracts the status code from an HTTP error.
 */
function getStatusCode(error: unknown): number {
  if (isHttpError(error)) {
    return error.statusCode
  }
  return 0
}

/**
 * Creates a retryable fetch wrapper with exponential backoff.
 * 
 * @param apiKey - API key for authentication
 * @param baseURL - Base URL for the API
 * @param endpoint - API endpoint to call
 * @param options - Retry configuration options
 * @returns Fetch response with retry logic
 */
export async function retryableFetch(
  apiKey: string,
  baseURL: string,
  endpoint: string,
  options: RetryOptions = {}
): Promise<Response> {
  return withRetry(async () => {
    const response = await fetch(`${baseURL}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    })
    
    if (!response.ok) {
      throw { statusCode: response.status, statusText: response.statusText }
    }
    
    return response
  }, options)
}
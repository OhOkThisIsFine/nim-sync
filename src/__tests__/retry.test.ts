import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withRetry, retryableFetch } from '../lib/retry.js'

describe('withRetry', () => {
  it('succeeds on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('success')
    const result = await withRetry(fn)
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not retry on success', async () => {
    const fn = vi.fn().mockResolvedValue('success')
    await withRetry(fn, { maxRetries: 3 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not retry on 400 errors', async () => {
    const error = new Error('Bad Request')
    ;(error as any).statusCode = 400
    const fn = vi.fn().mockRejectedValue(error)

    await expect(
      withRetry(fn, { maxRetries: 3, initialDelay: 10, maxDelay: 100, retryStatusCodes: [429, 500] })
    ).rejects.toThrow('Bad Request')
    
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('throws last error when all retries exhausted', async () => {
    const makeError = (msg: string) => {
      const err = new Error(msg)
      ;(err as any).statusCode = 500
      return err
    }
    
    const fn = vi.fn()
      .mockRejectedValueOnce(makeError('Error 1'))
      .mockRejectedValueOnce(makeError('Error 2'))
      .mockRejectedValueOnce(makeError('Error 3'))

    await expect(
      withRetry(fn, { maxRetries: 2, initialDelay: 10, maxDelay: 100, retryStatusCodes: [500] })
    ).rejects.toThrow('Error 3')
  })

  it('retries on 429 status code', async () => {
    const error = new Error('Too Many Requests')
    ;(error as any).statusCode = 429
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success')

    const result = await withRetry(fn, { maxRetries: 3, initialDelay: 10, maxDelay: 100, retryStatusCodes: [429] })
    
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries on network errors', async () => {
    const error = new Error('fetch failed')
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success')

    const result = await withRetry(fn, { maxRetries: 3, initialDelay: 10, maxDelay: 100, retryOnNetworkError: true })
    
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not retry on non-network errors when retryOnNetworkError is false', async () => {
    const error = new Error('some error')
    const fn = vi.fn().mockRejectedValue(error)

    await expect(
      withRetry(fn, { maxRetries: 3, initialDelay: 10, maxDelay: 100, retryOnNetworkError: false })
    ).rejects.toEqual(error)
    
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('retryableFetch', () => {
  const fetchSpy = vi.spyOn(global, 'fetch')

  beforeEach(() => {
    fetchSpy.mockReset()
  })

  it('makes request and returns response on success', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: [] })
    }
    fetchSpy.mockResolvedValue(mockResponse as unknown as Response)

    const result = await retryableFetch('test-key', 'https://api.example.com', '/models')
    
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example.com/models',
      expect.objectContaining({
        headers: {
          'Authorization': 'Bearer test-key',
          'Content-Type': 'application/json'
        }
      })
    )
    expect(result).toBe(mockResponse)
  })

  it('throws on non-ok response', async () => {
    const mockResponse = {
      ok: false,
      status: 401,
      statusText: 'Unauthorized'
    }
    fetchSpy.mockResolvedValue(mockResponse as unknown as Response)

    await expect(
      retryableFetch('test-key', 'https://api.example.com', '/models')
    ).rejects.toThrow()
  })

  it('retries on 429', async () => {
    const errorResponse = { ok: false, status: 429, statusText: 'Too Many Requests' }
    const successResponse = { ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: [] }) }
    
    fetchSpy
      .mockResolvedValueOnce(errorResponse as unknown as Response)
      .mockResolvedValue(successResponse as unknown as Response)

    const result = await retryableFetch('test-key', 'https://api.example.com', '/models', { maxRetries: 1, initialDelay: 10 })
    
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result).toBe(successResponse)
  })
})

describe('edge cases', () => {
  it('handles non-Error thrown values by wrapping them', async () => {
    const fn = vi.fn().mockRejectedValue('string error')
    
    // withRetry wraps non-Error values in Error objects
    await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow('string error')
  })

  it('does not retry when maxRetries is 0', async () => {
    const error = new Error('Network timeout')
    const fn = vi.fn().mockRejectedValue(error)
    
    await expect(withRetry(fn, { maxRetries: 0, retryOnNetworkError: true })).rejects.toThrow('Network timeout')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('handles plain object errors without statusCode (not retried)', async () => {
    // Plain objects without statusCode should not match HTTP error pattern
    // and if retryOnNetworkError is false, they shouldn't be retried
    const error = { message: 'Custom error object' }
    const fn = vi.fn().mockRejectedValue(error)
    
    // Since the error is not an Error instance, it gets wrapped
    await expect(withRetry(fn, { maxRetries: 1, initialDelay: 10, retryOnNetworkError: false })).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('handles AbortError as network error', async () => {
    const error = new Error('Request aborted')
    error.name = 'AbortError'
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success')
    
    const result = await withRetry(fn, { maxRetries: 1, initialDelay: 10, retryOnNetworkError: true })
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('handles ECONNREFUSED as network error', async () => {
    const error = new Error('ECONNREFUSED: connection refused')
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success')
    
    const result = await withRetry(fn, { maxRetries: 1, initialDelay: 10, retryOnNetworkError: true })
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('handles ETIMEDOUT as network error', async () => {
    const error = new Error('ETIMEDOUT: connection timed out')
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success')
    
    const result = await withRetry(fn, { maxRetries: 1, initialDelay: 10, retryOnNetworkError: true })
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

import { describe, it, expect, vi, afterEach } from "vitest";
import { withRetry } from "../lib/retry.js";

describe("retry integration with fetchModels error patterns", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("withRetry retries 429 errors and succeeds on second attempt", async () => {
    const rateLimitError = Object.assign(new Error("Too Many Requests"), {
      statusCode: 429,
      statusText: "Too Many Requests",
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValue("success");

    const result = await withRetry(fn, {
      maxRetries: 3,
      initialDelay: 10,
      maxDelay: 100,
      retryStatusCodes: [429, 500, 502, 503, 504],
    });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("withRetry retries network errors and succeeds on second attempt", async () => {
    const networkError = new TypeError("fetch failed");
    (networkError as any).code = "ECONNREFUSED";
    const fn = vi
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValue("success");

    const result = await withRetry(fn, {
      maxRetries: 3,
      initialDelay: 10,
      maxDelay: 100,
      retryOnNetworkError: true,
      retryStatusCodes: [429, 500, 502, 503, 504],
    });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("withRetry retries 500 errors matching fetchModels configuration", async () => {
    const serverError = Object.assign(new Error("Internal Server Error"), {
      statusCode: 500,
      statusText: "Internal Server Error",
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(serverError)
      .mockResolvedValue("success");

    const result = await withRetry(fn, {
      maxRetries: 3,
      initialDelay: 10,
      maxDelay: 100,
      retryStatusCodes: [429, 500, 502, 503, 504],
    });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("withRetry does not retry 401 errors matching fetchModels configuration", async () => {
    const authError = Object.assign(new Error("Unauthorized"), {
      statusCode: 401,
      statusText: "Unauthorized",
    });

    const fn = vi.fn().mockRejectedValue(authError);

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        initialDelay: 10,
        maxDelay: 100,
        retryStatusCodes: [429, 500, 502, 503, 504],
      }),
    ).rejects.toThrow("Unauthorized");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("withRetry retries AbortError (timeout) as network error", async () => {
    const abortError = new Error("NVIDIA API request timed out after 10 seconds");
    abortError.name = "AbortError";

    const fn = vi
      .fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValue("success");

    const result = await withRetry(fn, {
      maxRetries: 3,
      initialDelay: 10,
      maxDelay: 100,
      retryOnNetworkError: true,
      retryStatusCodes: [429, 500, 502, 503, 504],
    });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("withRetry exhausts retries on persistent 503 errors", async () => {
    const serviceUnavailable = Object.assign(
      new Error("Service Unavailable"),
      { statusCode: 503, statusText: "Service Unavailable" },
    );

    const fn = vi.fn().mockRejectedValue(serviceUnavailable);

    await expect(
      withRetry(fn, {
        maxRetries: 2,
        initialDelay: 10,
        maxDelay: 100,
        retryStatusCodes: [429, 500, 502, 503, 504],
      }),
    ).rejects.toThrow("Service Unavailable");

    expect(fn).toHaveBeenCalledTimes(3);
  });
});

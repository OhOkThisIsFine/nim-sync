import { describe, it, expect, vi, beforeEach } from "vitest";
import { withRetry, isNetworkError } from "../lib/retry.js";

describe("withRetry", () => {
  it("succeeds on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await withRetry(fn);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on success", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    await withRetry(fn, { maxRetries: 3 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 400 errors", async () => {
    const error = new Error("Bad Request");
    (error as any).statusCode = 400;
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        initialDelay: 10,
        maxDelay: 100,
        retryStatusCodes: [429, 500],
      }),
    ).rejects.toThrow("Bad Request");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws last error when all retries exhausted", async () => {
    const makeError = (msg: string) => {
      const err = new Error(msg);
      (err as any).statusCode = 500;
      return err;
    };

    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeError("Error 1"))
      .mockRejectedValueOnce(makeError("Error 2"))
      .mockRejectedValueOnce(makeError("Error 3"));

    await expect(
      withRetry(fn, {
        maxRetries: 2,
        initialDelay: 10,
        maxDelay: 100,
        retryStatusCodes: [500],
      }),
    ).rejects.toThrow("Error 3");
  });

  it("retries on 429 status code", async () => {
    const error = new Error("Too Many Requests");
    (error as any).statusCode = 429;
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("success");

    const result = await withRetry(fn, {
      maxRetries: 3,
      initialDelay: 10,
      maxDelay: 100,
      retryStatusCodes: [429],
    });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on network errors", async () => {
    const error = new Error("fetch failed");
    (error as any).code = "ECONNREFUSED";
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("success");

    const result = await withRetry(fn, {
      maxRetries: 3,
      initialDelay: 10,
      maxDelay: 100,
      retryOnNetworkError: true,
    });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on non-network errors when retryOnNetworkError is false", async () => {
    const error = new Error("some error");
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        initialDelay: 10,
        maxDelay: 100,
        retryOnNetworkError: false,
      }),
    ).rejects.toEqual(error);

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("withRetry observability", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs warning on each retry attempt", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("fetch failed");
    (error as any).code = "ECONNREFUSED";
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue("success");

    await withRetry(fn, {
      maxRetries: 3,
      initialDelay: 10,
      maxDelay: 100,
    });

    expect(warnSpy).toHaveBeenCalledTimes(2);
    for (const call of warnSpy.mock.calls) {
      const msg = String(call[0]);
      expect(msg).toContain("Retry attempt");
      expect(msg).toContain("failed");
    }
  });

  it("logs error when retries exhausted", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("server error");
    (error as any).statusCode = 500;
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, {
        maxRetries: 2,
        initialDelay: 10,
        maxDelay: 100,
        retryStatusCodes: [500],
      }),
    ).rejects.toThrow("server error");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const allArgs = errorSpy.mock.calls[0]?.join(" ");
    expect(allArgs).toContain("retry attempts exhausted");
  });

  it("fires onRetry callback on each retry", async () => {
    const onRetry = vi.fn();
    const error = new Error("fetch failed");
    (error as any).code = "ECONNREFUSED";
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue("success");

    await withRetry(fn, {
      maxRetries: 3,
      initialDelay: 10,
      maxDelay: 100,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({
      attempt: 1,
      maxRetries: 3,
    });
    expect(onRetry.mock.calls[0]?.[0].error).toBeInstanceOf(Error);
    expect(typeof onRetry.mock.calls[0]?.[0].delay).toBe("number");
  });

  it("logs info on success after retries", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = new Error("fetch failed");
    (error as any).code = "ECONNREFUSED";
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("success");

    await withRetry(fn, {
      maxRetries: 3,
      initialDelay: 10,
      maxDelay: 100,
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0]?.[0])).toContain("Retry succeeded");
  });

  it("does not log when first attempt succeeds", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const fn = vi.fn().mockResolvedValue("success");

    await withRetry(fn, { maxRetries: 3 });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });
});

describe("withRetry jitter", () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    setTimeoutSpy?.mockRestore();
  });

  it("applies jitter to backoff delay", async () => {
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;
    setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(
      (fn: any, delay: number, ...args: any[]): any => {
        delays.push(delay);
        return originalSetTimeout(fn, 0, ...args) as unknown as number;
      },
    );

    const error = new Error("fetch failed");
    (error as any).code = "ECONNREFUSED";
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue("success");

    await withRetry(fn, {
      maxRetries: 3,
      initialDelay: 100,
      maxDelay: 1000,
    });

    expect(delays.length).toBeGreaterThanOrEqual(1);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1000);
    }
  });

  it("jitter does not exceed maxDelay cap", async () => {
    const maxDelay = 200;
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;
    setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(
      (fn: any, delay: number, ...args: any[]): any => {
        delays.push(delay);
        return originalSetTimeout(fn, 0, ...args) as unknown as number;
      },
    );

    const error = new Error("fetch failed");
    (error as any).code = "ECONNREFUSED";
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay,
        retryOnNetworkError: true,
      }),
    ).rejects.toThrow();

    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(maxDelay);
    }
  });

  it("jitter preserves existing retry behavior boundaries", async () => {
    const error = new Error("Bad Request");
    (error as any).statusCode = 400;
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        initialDelay: 10,
        maxDelay: 100,
        retryStatusCodes: [429, 500],
      }),
    ).rejects.toThrow("Bad Request");

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("isNetworkError", () => {
  it("detects Node.js system error codes", () => {
    const e1 = new Error("msg");
    (e1 as any).code = "ECONNREFUSED";
    expect(isNetworkError(e1)).toBe(true);

    const e2 = new Error("msg");
    (e2 as any).code = "ENOTFOUND";
    expect(isNetworkError(e2)).toBe(true);

    const e3 = new Error("msg");
    (e3 as any).code = "ETIMEDOUT";
    expect(isNetworkError(e3)).toBe(true);

    const e4 = new Error("msg");
    (e4 as any).code = "EAI_AGAIN";
    expect(isNetworkError(e4)).toBe(true);

    const e5 = new Error("msg");
    (e5 as any).code = "ECONNRESET";
    expect(isNetworkError(e5)).toBe(true);

    const e6 = new Error("msg");
    (e6 as any).code = "ENETUNREACH";
    expect(isNetworkError(e6)).toBe(true);
  });

  it("detects well-known error names", () => {
    const e1 = new Error("msg");
    e1.name = "AbortError";
    expect(isNetworkError(e1)).toBe(true);

    const e2 = new Error("msg");
    e2.name = "TimeoutError";
    expect(isNetworkError(e2)).toBe(true);

    const e3 = new Error("msg");
    e3.name = "FetchError";
    expect(isNetworkError(e3)).toBe(true);
  });

  it("returns false for non-network error codes", () => {
    const e1 = new Error("msg");
    (e1 as any).code = "ERR_INVALID_ARG_TYPE";
    expect(isNetworkError(e1)).toBe(false);

    const e2 = new Error("msg");
    (e2 as any).code = "MODULE_NOT_FOUND";
    expect(isNetworkError(e2)).toBe(false);

    const e3 = new Error("msg");
    expect(isNetworkError(e3)).toBe(false);
  });

  it("returns false for non-Error inputs", () => {
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
    expect(isNetworkError("string error")).toBe(false);
    expect(isNetworkError({ message: "network error" })).toBe(false);
  });

  it("does not match via localized message text", () => {
    const e1 = new Error("RÉSEAU indisponible");
    expect(isNetworkError(e1)).toBe(false);

    const e2 = new Error("connexion refusée");
    expect(isNetworkError(e2)).toBe(false);

    const e3 = new Error("Zeitüberschreitung bei Verbindung");
    expect(isNetworkError(e3)).toBe(false);

    const e4 = new Error("ネットワークエラー");
    expect(isNetworkError(e4)).toBe(false);
  });

  it("inspects error.cause recursively", () => {
    const inner = new Error("inner");
    (inner as any).code = "ECONNREFUSED";
    const outer = new Error("wrapper", { cause: inner });
    expect(isNetworkError(outer)).toBe(true);
  });
});

describe("edge cases", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles non-Error thrown values by wrapping them", async () => {
    const fn = vi.fn().mockRejectedValue("string error");

    await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow(
      "string error",
    );
  });

  it("does not retry when maxRetries is 0", async () => {
    const error = new Error("Network timeout");
    (error as any).code = "ECONNREFUSED";
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, { maxRetries: 0, retryOnNetworkError: true }),
    ).rejects.toThrow("Network timeout");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("handles plain object errors without statusCode (not retried)", async () => {
    const error = { message: "Custom error object" };
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, {
        maxRetries: 1,
        initialDelay: 10,
        retryOnNetworkError: false,
      }),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("handles AbortError as network error", async () => {
    const error = new Error("Request aborted");
    error.name = "AbortError";
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("success");

    const result = await withRetry(fn, {
      maxRetries: 1,
      initialDelay: 10,
      retryOnNetworkError: true,
    });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("handles ECONNREFUSED as network error", async () => {
    const error = new Error("connection refused");
    (error as any).code = "ECONNREFUSED";
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("success");

    const result = await withRetry(fn, {
      maxRetries: 1,
      initialDelay: 10,
      retryOnNetworkError: true,
    });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("handles ETIMEDOUT as network error", async () => {
    const error = new Error("connection timed out");
    (error as any).code = "ETIMEDOUT";
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("success");

    const result = await withRetry(fn, {
      maxRetries: 1,
      initialDelay: 10,
      retryOnNetworkError: true,
    });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

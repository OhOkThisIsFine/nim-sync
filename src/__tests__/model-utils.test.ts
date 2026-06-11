import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateAPIResponse } from "../lib/model-utils.js";
import { NVIDIAApiError } from "../types/index.js";
import { fetchModels } from "../lib/nim-api.js";

describe("validateAPIResponse", () => {
  it("returns models for valid response with data array", () => {
    const result = validateAPIResponse({
      data: [{ id: "model-1", name: "Model 1" }],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("model-1");
  });

  it("throws on null response", () => {
    expect(() => validateAPIResponse(null)).toThrow(
      "Invalid API response: Expected object, got null",
    );
  });

  it("throws on undefined response", () => {
    expect(() => validateAPIResponse(undefined)).toThrow(
      "Invalid API response: Expected object, got undefined",
    );
  });

  it("throws on non-object response", () => {
    expect(() => validateAPIResponse("string")).toThrow(
      "Invalid API response: Expected object, got string",
    );
  });

  it("throws on response missing data field", () => {
    expect(() => validateAPIResponse({})).toThrow("Missing data field");
  });

  it("throws on non-array data", () => {
    expect(() => validateAPIResponse({ data: "not-array" })).toThrow(
      "data must be array",
    );
  });

  it("throws on model with missing id", () => {
    expect(() =>
      validateAPIResponse({ data: [{ name: "No ID" }] }),
    ).toThrow("invalid id");
  });

  it("throws on model with empty string id", () => {
    expect(() =>
      validateAPIResponse({ data: [{ id: "", name: "Empty ID" }] }),
    ).toThrow("invalid id");
  });

  it("throws on duplicate model IDs", () => {
    expect(() =>
      validateAPIResponse({
        data: [
          { id: "dup", name: "First" },
          { id: "dup", name: "Second" },
        ],
      }),
    ).toThrow("Duplicate model ID: dup");
  });

  it("uses name field with fallback to id-based name", () => {
    const result = validateAPIResponse({
      data: [
        { id: "meta/llama-3.1-8b-instruct", name: "" },
        { id: "model-2", name: "Real Name" },
      ],
    });
    expect(result[0]!.name).toBe("llama 3.1 8b instruct");
    expect(result[1]!.name).toBe("Real Name");
  });
});

describe("fetchModels with retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries 3 times on 429 status before throwing", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    });
    global.fetch = mockFetch;

    const promise = fetchModels("test-key");
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(10000);
    await expect(promise).rejects.toThrow(NVIDIAApiError);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it.each([500, 502, 503, 504])(
    "retries on %i status code",
    async (status) => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status,
        statusText: "Error",
      });
      global.fetch = mockFetch;

      const promise = fetchModels("test-key");
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(10000);
      await expect(promise).rejects.toThrow(NVIDIAApiError);
      expect(mockFetch).toHaveBeenCalledTimes(4);
    },
  );

  it("succeeds on retry if subsequent attempt returns 200", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "m1", name: "M1" }] }),
      });
    });
    global.fetch = mockFetch;

    const promise = fetchModels("test-key");
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(10000);
    const result = await promise;
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("m1");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403])(
    "throws immediately on %i status code",
    async (status) => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status,
        statusText: "Error",
      });
      global.fetch = mockFetch;

      await expect(fetchModels("test-key")).rejects.toThrow(NVIDIAApiError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    },
  );
});

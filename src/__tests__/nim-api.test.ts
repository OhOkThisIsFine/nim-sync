import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchModels, probeModels } from "../lib/nim-api.js";
import { NVIDIAApiError } from "../types/index.js";

describe("NVIDIA NIM API Client - fetchModels", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Should request models from the NVIDIA v1/models endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: "model-1", name: "Model 1" }] }),
    });
    global.fetch = mockFetch;

    const promise = fetchModels("test-key");
    const result = await promise;
    expect(result).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/models"),
      expect.any(Object),
    );
  });

  it("Should send correct authorization header with the API key", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: "model-1", name: "Model 1" }] }),
    });
    global.fetch = mockFetch;

    await fetchModels("test-key-123");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key-123",
        }),
      }),
    );
  });

  it("Should throw an error if the fetch fails or response is not ok", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
    });
    global.fetch = mockFetch;

    await expect(fetchModels("test-key")).rejects.toThrow(NVIDIAApiError);
  });

  it("Should retry request under retriable error conditions", async () => {
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
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("NVIDIA NIM API Client - probeModels", () => {
  it("Should probe specified models using the chat completions endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          usage: {
            reasoning_tokens: 10,
          },
        }),
    });
    global.fetch = mockFetch;

    const results = await probeModels([{ id: "m1", name: "M1" }], "test-key");
    expect(results["m1"]).toBeDefined();
    expect(results["m1"]?.chatCapable).toBe(true);
    expect(results["m1"]?.reasoning).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/chat/completions"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("m1"),
      }),
    );
  });

  it("Should parse chat capability and reasoning tokens correctly", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            usage: {
              prompt_tokens: 5,
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            usage: {
              reasoning_tokens: 10,
            },
          }),
      });
    global.fetch = mockFetch;

    const results = await probeModels(
      [
        { id: "m1", name: "M1" },
        { id: "m2", name: "M2" },
      ],
      "test-key",
    );
    expect(results["m1"]?.chatCapable).toBe(true);
    expect(results["m1"]?.reasoning).toBe(false);
    expect(results["m2"]?.chatCapable).toBe(true);
    expect(results["m2"]?.reasoning).toBe(true);
  });

  it("Should respect concurrency limits during probe execution", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ usage: {} }),
    });
    global.fetch = mockFetch;

    const models = Array.from({ length: 15 }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`,
    }));

    await probeModels(models, "test-key");
    expect(mockFetch).toHaveBeenCalledTimes(15);
  });
});

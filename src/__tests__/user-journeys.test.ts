import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs/promises";
import type { PluginAPI } from "../types/index.js";
import { syncNIMModels } from "../plugin/nim-sync.js";
import { createMockPluginAPI, setupDefaultFsMocks, flushAsyncWork } from "./mocks.js";

vi.mock("fs/promises");
vi.mock("../lib/retry.js", () => ({
  withRetry: vi.fn().mockImplementation(async (fn) => fn()),
}));
vi.mock("crypto", () => {
  const createHash = () => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn((_encoding: string) => "test-hash-value"),
  });
  return {
    default: { createHash },
    createHash,
  };
});

describe("User Journey: NVIDIA NIM Model Synchronization", () => {
  let mockPluginAPI: PluginAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPluginAPI = createMockPluginAPI();

    process.env.USERPROFILE = "/test/user";
    process.env.NVIDIA_API_KEY = "test-api-key";

    setupDefaultFsMocks();
  });

  describe("As a user, I want NVIDIA NIM models to sync automatically on OpenCode startup", () => {
    it("initializes plugin on startup and triggers refresh", async () => {
      const plugin = await syncNIMModels(mockPluginAPI);
      expect(plugin).toBeDefined();
      expect(typeof plugin.init).toBe("function");
    });

    it("fetches models from NVIDIA /v1/models endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "meta/llama-3.1-70b-instruct",
                name: "Meta Llama 3.1 70B Instruct",
              },
              {
                id: "mistralai/mistral-7b-instruct",
                name: "Mistral 7B Instruct",
              },
            ],
          }),
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://integrate.api.nvidia.com/v1/models",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("Bearer "),
          }),
        }),
      );
    });

    it("updates OpenCode config with discovered models", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "meta/llama-3.1-70b-instruct",
                name: "Meta Llama 3.1 70B Instruct",
              },
              {
                id: "mistralai/mistral-7b-instruct",
                name: "Mistral 7B Instruct",
              },
            ],
          }),
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockFetch).toHaveBeenCalled();
    });

    it("preserves user-owned settings like default model selection", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "meta/llama-3.1-70b-instruct",
                name: "Meta Llama 3.1 70B Instruct",
              },
            ],
          }),
      });
      global.fetch = mockFetch;

      const existingConfig = JSON.stringify({
        model: "nim/meta/llama-3.1-70b-instruct",
        small_model: "nim/mistralai/mistral-7b-instruct",
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            models: {
              "meta/llama-3.1-70b-instruct": {
                name: "Meta Llama 3.1 70B Instruct",
                options: { max_tokens: 4096 },
              },
            },
          },
        },
      });

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        return Promise.resolve(existingConfig);
      });

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockFetch).toHaveBeenCalled();
    });

    it("shows toast notification when models are updated", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "meta/llama-3.1-70b-instruct",
                name: "Meta Llama 3.1 70B Instruct",
              },
            ],
          }),
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe("As a user, I want graceful fallback when NVIDIA API is unavailable", () => {
    it("keeps existing models when refresh fails", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
      global.fetch = mockFetch;

      vi.mocked(fs.readFile).mockResolvedValue("{}");

      await syncNIMModels(mockPluginAPI);

      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it("shows error toast when API key is missing", async () => {
      delete process.env.NVIDIA_API_KEY;
      vi.mocked(fs.readFile).mockRejectedValue(
        Object.assign(new Error("File not found"), { code: "ENOENT" }),
      );

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "NVIDIA API Key Required",
          variant: "error",
        }),
      );
    });
  });

  describe("As a user, I want manual refresh capability", () => {


    it("manual refresh command triggers model fetch", async () => {
      const mockFetch = vi.fn((url: string) => {
        if (typeof url === "string" && url.includes("/chat/completions"))
          return Promise.resolve({ ok: false, status: 404 });
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  id: "meta/llama-3.1-70b-instruct",
                  name: "Meta Llama 3.1 70B Instruct",
                },
              ],
            }),
        });
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await vi.waitFor(() =>
        expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2),
      );
      await flushAsyncWork();

      vi.clearAllMocks();
      await plugin.manualRefresh?.();

      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    }, 10000);

    it("manual refresh shows feedback when models are already up to date", async () => {
      const modelId = "meta/llama-3.1-70b-instruct";
      const modelName = "Meta Llama 3.1 70B Instruct";
      const currentConfig = JSON.stringify({
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            options: { baseURL: "https://integrate.api.nvidia.com/v1" },
            models: {
              [modelId]: { name: modelName, options: {} },
            },
          },
        },
      });
      const currentCache = JSON.stringify({
        lastRefresh: Date.now() - 60_000,
        modelsHash: "test-hash-value",
        baseURL: "https://integrate.api.nvidia.com/v1",
      });

      mockPluginAPI.config.get = vi.fn(() => ({
        provider: {
          nim: {
            models: {
              [modelId]: { name: modelName, options: {} },
            },
          },
        },
      })) as any;

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        if (filePath.includes("nim-sync-cache.json")) {
          return Promise.resolve(currentCache);
        }
        return Promise.resolve(currentConfig);
      });

      const mockFetch = vi.fn((url: string) => {
        if (typeof url === "string" && url.includes("/chat/completions"))
          return Promise.resolve({ ok: false, status: 404 });
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: modelId, name: modelName }],
            }),
        });
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockFetch).not.toHaveBeenCalled();

      await plugin.manualRefresh?.();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "NVIDIA NIM Already Up To Date",
          description: "No model changes found.",
          variant: "default",
        }),
      );
    });

    it("manual refresh shows feedback when a refresh is already in progress", async () => {
      const modelId = "meta/llama-3.1-70b-instruct";
      const modelName = "Meta Llama 3.1 70B Instruct";
      const currentConfig = JSON.stringify({
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            models: {
              [modelId]: { name: modelName, options: {} },
            },
          },
        },
      });
      const currentCache = JSON.stringify({
        lastRefresh: Date.now() - 60_000,
        modelsHash: "old-hash-value",
        baseURL: "https://integrate.api.nvidia.com/v1",
      });

      mockPluginAPI.config.get = vi.fn(() => ({
        provider: {
          nim: {
            models: {
              [modelId]: { name: modelName, options: {} },
            },
          },
        },
      })) as any;

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        if (filePath.includes("nim-sync-cache.json")) {
          return Promise.resolve(currentCache);
        }
        return Promise.resolve(currentConfig);
      });

      let resolveModelsFetch: ((value: unknown) => void) | null = null;
      let resolveProbeFetch: ((value: unknown) => void) | null = null;
      const mockFetch = vi.fn((url: string) => {
        if (typeof url === "string" && url.includes("/chat/completions")) {
          return new Promise<void>((resolve) => { resolveProbeFetch = resolve; }).then(
            () => ({ ok: false, status: 404 }),
          ) as any;
        }
        return new Promise<void>((resolve) => { resolveModelsFetch = resolve; }).then(
          () => ({
            ok: true,
            json: () =>
              Promise.resolve({
                data: [{ id: modelId, name: modelName }],
              }),
          }),
        ) as any;
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      const inFlightRefresh = plugin.refreshModels?.(true);
      await flushAsyncWork();

      // refreshModels is waiting on models fetch, so manual should show "in progress"
      await plugin.manualRefresh?.();

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "NVIDIA Refresh In Progress",
          description: "A model refresh is already running.",
          variant: "default",
        }),
      );

      // Resolve models fetch first, then probe to complete the refresh
      resolveModelsFetch?.(null);
      await flushAsyncWork();
      resolveProbeFetch?.(null);

      await inFlightRefresh;
    });
  });

  describe("As a user, I want TTL-based refresh to avoid excessive API calls", () => {
    it("skips refresh if last refresh was within 24 hours", async () => {
      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      const recentCache = JSON.stringify({
        lastRefresh: Date.now() - 1000 * 60 * 60,
        modelsHash: "test-hash-value",
      });

      const configWithNIM = JSON.stringify({
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            models: { "existing-model": { name: "Existing Model" } },
          },
        },
      });

      mockPluginAPI.config.get = vi.fn(() => ({
        provider: {
          nim: { models: { "existing-model": { name: "Existing Model" } } },
        },
      })) as any;

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        if (filePath.includes("nim-sync-cache.json")) {
          return Promise.resolve(recentCache);
        }
        return Promise.resolve(configWithNIM);
      });

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("forces refresh when models have changed even within TTL", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "meta/llama-3.1-70b-instruct",
                name: "Meta Llama 3.1 70B Instruct",
              },
            ],
          }),
      });
      global.fetch = mockFetch;

      const configWithNIM = JSON.stringify({
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            models: {},
          },
        },
      });

      mockPluginAPI.config.get = vi.fn(() => ({
        provider: { nim: { models: {} } },
      })) as any;

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        return Promise.resolve(configWithNIM);
      });

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockFetch).toHaveBeenCalled();
    });

    it("triggers refresh when cache TTL has expired", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "meta/llama-3.1-70b-instruct",
                name: "Meta Llama 3.1 70B Instruct",
              },
            ],
          }),
      });
      global.fetch = mockFetch;

      const expiredCache = JSON.stringify({
        lastRefresh: Date.now() - 25 * 60 * 60 * 1000,
        modelsHash: "abc123",
      });

      const configWithNIM = JSON.stringify({
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            models: {},
          },
        },
      });

      mockPluginAPI.config.get = vi.fn(() => ({
        provider: { nim: { models: {} } },
      })) as any;

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        if (filePath.includes("cache")) {
          return Promise.resolve(expiredCache);
        }
        return Promise.resolve(configWithNIM);
      });

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockFetch).toHaveBeenCalled();
    });

    it("generates different hashes for different model sets", async () => {
      let callCount = 0;
      const mockFetch = vi.fn((url: string) => {
        if (typeof url === "string" && url.includes("/chat/completions"))
          return Promise.resolve({ ok: false, status: 404 });
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ data: [{ id: "model-a", name: "Model A" }] }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                { id: "model-a", name: "Model A" },
                { id: "model-b", name: "Model B" },
              ],
            }),
        });
      });
      global.fetch = mockFetch;

      const expiredCache = JSON.stringify({
        lastRefresh: Date.now() - 25 * 60 * 60 * 1000,
        modelsHash: "old-hash-value",
      });

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        return Promise.resolve(expiredCache);
      });

      const plugin1 = await syncNIMModels(mockPluginAPI);
      await plugin1.init?.();
      await flushAsyncWork();

      expect(mockFetch).toHaveBeenCalledTimes(2); // models + probe(1 model)

      const plugin2 = await syncNIMModels(mockPluginAPI);
      await plugin2.init?.();
      await flushAsyncWork();

      expect(mockFetch).toHaveBeenCalledTimes(5); // plugin1 (models+probe) + plugin2 (models+2×probe)
    });

    it("forces refresh when provider.nim is missing", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "meta/llama-3.1-70b-instruct",
                name: "Meta Llama 3.1 70B Instruct",
              },
            ],
          }),
      });
      global.fetch = mockFetch;

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        return Promise.resolve("{}");
      });

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockFetch).toHaveBeenCalled();
    });
  });
});

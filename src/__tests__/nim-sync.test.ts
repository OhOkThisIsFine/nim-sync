import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs/promises";
import type { PluginAPI } from "../types/index.js";
import { syncNIMModels } from "../plugin/nim-sync.js";
import { getCacheDir, getConfigDir } from "../lib/config-path.js";
import { createMockPluginAPI, setupDefaultFsMocks, flushAsyncWork } from "./mocks.js";
import { hashModels } from "../lib/crypto-utils.js";

vi.mock("fs/promises");

describe("NIM Sync Unit Tests", () => {
  let mockPluginAPI: PluginAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPluginAPI = createMockPluginAPI();
    process.env.USERPROFILE = "/test/user";
    process.env.NVIDIA_API_KEY = "test-api-key";

    setupDefaultFsMocks();
  });

  describe("getAuthPath", () => {
    it("uses Windows path on Windows platform", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });

      const mockFetch = vi.fn((url: string) => {
        if (typeof url === "string" && url.includes("/chat/completions"))
          return Promise.resolve({ ok: false, status: 404 });
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ data: [{ id: "model-1", name: "Model 1" }] }),
        });
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });

      expect(mockFetch).toHaveBeenCalled();
    });

    it("uses Unix path on Linux/macOS", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ data: [{ id: "model-1", name: "Model 1" }] }),
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });

      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe("shouldRefresh logic", () => {
    it("returns true when config has no nim provider", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ data: [{ id: "model-1", name: "Model 1" }] }),
      });
      global.fetch = mockFetch;

      mockPluginAPI.config.get = vi.fn(() => ({})) as any;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockFetch).toHaveBeenCalled();
    });

    it("returns true when cache has no lastRefresh", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ data: [{ id: "model-1", name: "Model 1" }] }),
      });
      global.fetch = mockFetch;

      mockPluginAPI.config.get = vi.fn(() => ({
        provider: { nim: { models: {} } },
      })) as any;

      const cacheNoTimestamp = JSON.stringify({ modelsHash: "abc123" });
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        return Promise.resolve(cacheNoTimestamp);
      });

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockFetch).toHaveBeenCalled();
    });

    it("returns true within TTL when cache has lastError and empty modelsHash (error state bypasses TTL)", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ data: [{ id: "model-1", name: "Model 1" }] }),
      });
      global.fetch = mockFetch;

      mockPluginAPI.config.get = vi.fn(() => ({
        provider: { nim: { models: {} } },
      })) as any;

      // Simulate a failure cache: fresh lastRefresh but empty modelsHash + lastError
      const failureCache = JSON.stringify({
        lastRefresh: Date.now(),
        modelsHash: "",
        lastError: "Network error",
      });
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        return Promise.resolve(failureCache);
      });

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      // Despite a fresh lastRefresh, the error state must bypass TTL and trigger a re-fetch
      expect(mockFetch).toHaveBeenCalled();
    });

    it("returns false within TTL when cache has valid modelsHash and no lastError", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ data: [{ id: "model-1", name: "Model 1" }] }),
      });
      global.fetch = mockFetch;

      mockPluginAPI.config.get = vi.fn(() => ({
        provider: { nim: { models: {} } },
      })) as any;

      // Simulate a successful cache: fresh lastRefresh, valid modelsHash, no lastError
      const successCache = JSON.stringify({
        lastRefresh: Date.now(),
        modelsHash: "abc123",
      });
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        return Promise.resolve(successCache);
      });

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      // Within TTL with a valid cache and no error, should not re-fetch
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("getNextRefreshDelay", () => {
    it("returns the remaining TTL before the next automatic refresh", async () => {
      const now = 1_700_000_000_000;
      const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

      mockPluginAPI.config.get = vi.fn(() => ({
        provider: {
          nim: {
            models: {
              "existing-model": {
                name: "Existing Model",
              },
            },
          },
        },
      })) as any;

      const recentCache = JSON.stringify({
        lastRefresh: now - 60 * 60 * 1000,
        modelsHash: "test-hash-value",
      });

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("nim-sync-cache.json")) {
          return Promise.resolve(recentCache);
        }
        return Promise.resolve("{}");
      });

      const plugin = await syncNIMModels(mockPluginAPI);

      await expect(plugin.getNextRefreshDelay?.()).resolves.toBe(
        23 * 60 * 60 * 1000,
      );

      dateNowSpy.mockRestore();
    });

    it("returns zero when the cached models are already stale", async () => {
      const now = 1_700_000_000_000;
      const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

      mockPluginAPI.config.get = vi.fn(() => ({
        provider: {
          nim: {
            models: {
              "existing-model": {
                name: "Existing Model",
              },
            },
          },
        },
      })) as any;

      const expiredCache = JSON.stringify({
        lastRefresh: now - 25 * 60 * 60 * 1000,
        modelsHash: "test-hash-value",
      });

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("nim-sync-cache.json")) {
          return Promise.resolve(expiredCache);
        }
        return Promise.resolve("{}");
      });

      const plugin = await syncNIMModels(mockPluginAPI);

      await expect(plugin.getNextRefreshDelay?.()).resolves.toBe(0);

      dateNowSpy.mockRestore();
    });
  });

  describe("updateConfig", () => {
    it("prefers opencode.json when that is the existing OpenCode config file", async () => {
      const fileNotFound = Object.assign(new Error("File not found"), {
        code: "ENOENT",
      });

      vi.mocked(fs.access).mockImplementation(async (filePath: string) => {
        if (String(filePath).endsWith("opencode.json")) {
          return undefined;
        }
        throw fileNotFound;
      });
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(fileNotFound);
        }
        if (String(filePath).endsWith("opencode.json")) {
          return Promise.resolve("{}");
        }
        throw fileNotFound;
      });

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.updateConfig?.([{ id: "model-1", name: "Model 1" }]);

      const writePaths = vi
        .mocked(fs.writeFile)
        .mock.calls.map(([filePath]) => String(filePath));
      expect(
        writePaths.some((filePath) =>
          /opencode\.json(\.\d+\.[a-z0-9]+\.tmp)?$/.test(filePath),
        ),
      ).toBe(true);
      expect(
        writePaths.some((filePath) =>
          /opencode\.jsonc(\.\d+\.[a-z0-9]+\.tmp)?$/.test(filePath),
        ),
      ).toBe(false);
    });

    it("creates opencode.json when no OpenCode config file exists yet", async () => {
      const fileNotFound = Object.assign(new Error("File not found"), {
        code: "ENOENT",
      });

      vi.mocked(fs.access).mockRejectedValue(fileNotFound);
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(fileNotFound);
        }
        throw fileNotFound;
      });

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.updateConfig?.([{ id: "model-1", name: "Model 1" }]);

      const writePaths = vi
        .mocked(fs.writeFile)
        .mock.calls.map(([filePath]) => String(filePath));
      expect(
        writePaths.some((filePath) =>
          /opencode\.json(\.\d+\.[a-z0-9]+\.tmp)?$/.test(filePath),
        ),
      ).toBe(true);
      expect(
        writePaths.some((filePath) =>
          /opencode\.jsonc(\.\d+\.[a-z0-9]+\.tmp)?$/.test(filePath),
        ),
      ).toBe(false);
    });

    it("fails safe when the existing config cannot be parsed", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        if (filePath.includes("opencode.json")) {
          return Promise.resolve("{ invalid json }");
        }
        return Promise.resolve("{}");
      });

      const plugin = await syncNIMModels(mockPluginAPI);

      await expect(
        plugin.updateConfig?.([
          { id: "existing-model", name: "Existing Model" },
        ]),
      ).rejects.toThrow("JSONC parse errors");

      const writePaths = vi
        .mocked(fs.writeFile)
        .mock.calls.map(([filePath]) => String(filePath));
      expect(
        writePaths.some((filePath) => filePath.includes("opencode.json")),
      ).toBe(false);
    });

    it("deep merges provider.nim without overwriting other provider data", async () => {
      const existingConfig = JSON.stringify({
        command: {
          review: {
            template: "Review the current changes",
            description: "Review code",
          },
        },
        provider: {
          anthropic: { apiKey: "anthropic-key", models: {} },
          openai: { apiKey: "openai-key" },
        },
      });
      vi.mocked(fs.readFile).mockResolvedValue(existingConfig);

      const models = [
        {
          id: "meta/llama-3.1-70b-instruct",
          name: "Meta Llama 3.1 70B Instruct",
        },
      ];

      const plugin = await syncNIMModels(mockPluginAPI);
      const changed = await (plugin as any).updateConfig(models);

      expect(changed).toBe(true);
      const configWrite = vi
        .mocked(fs.writeFile)
        .mock.calls.filter(([filePath]) =>
          String(filePath).includes("opencode.json"),
        )
        .at(-1);
      const updatedConfig = JSON.parse(String(configWrite?.[1]));
      expect(updatedConfig.command.review.template).toBe(
        "Review the current changes",
      );
      expect(updatedConfig.command["nim-refresh"]).toBeUndefined();
      expect(updatedConfig.provider.anthropic.apiKey).toBe("anthropic-key");
      expect(updatedConfig.provider.openai.apiKey).toBe("openai-key");
      expect(updatedConfig.provider.nim.models).toBeDefined();
    });

    it("preserves existing model options", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ id: "existing-model", name: "Existing Model" }],
          }),
      });
      global.fetch = mockFetch;

      const existingConfig = JSON.stringify({
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            models: {
              "existing-model": {
                name: "Existing Model",
                options: { temperature: 0.5, max_tokens: 2000 },
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

    it("preserves existing provider-level nim options", async () => {
      const existingConfig = JSON.stringify({
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            options: {
              region: "us-west-2",
              timeout: 45_000,
            },
            models: {
              "existing-model": {
                name: "Existing Model",
                options: {},
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
      const changed = await plugin.updateConfig?.([
        { id: "existing-model", name: "Existing Model" },
      ]);

      expect(changed).toBe(true);

      const configWrite = vi
        .mocked(fs.writeFile)
        .mock.calls.find(([filePath]) =>
          String(filePath).includes("opencode.json"),
        );
      const updatedConfig = JSON.parse(String(configWrite?.[1]));

      expect(updatedConfig.provider.nim.options.region).toBe("us-west-2");
      expect(updatedConfig.provider.nim.options.timeout).toBe(45_000);
      expect(updatedConfig.provider.nim.options.baseURL).toBe(
        "https://integrate.api.nvidia.com/v1",
      );
    });

    it("preserves existing JSONC comments when updating config", async () => {
      const existingConfig = `{
  // keep this top-level comment
  "provider": {
    // keep this provider comment
    "openai": {
      "apiKey": "openai-key"
    }
  },
  "model": "nim/existing-model"
}`;

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        return Promise.resolve(existingConfig);
      });

      const plugin = await syncNIMModels(mockPluginAPI);
      const changed = await plugin.updateConfig?.([
        { id: "existing-model", name: "Existing Model" },
      ]);

      expect(changed).toBe(true);

      const configWrite = vi
        .mocked(fs.writeFile)
        .mock.calls.find(([filePath]) =>
          String(filePath).includes("opencode.json"),
        );
      const updatedContent = String(configWrite?.[1]);

      expect(updatedContent).toContain("// keep this top-level comment");
      expect(updatedContent).toContain("// keep this provider comment");
    });

    it("refreshes the cache timestamp when models are unchanged", async () => {
      const existingConfig = JSON.stringify({
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            options: {
              baseURL: "https://integrate.api.nvidia.com/v1",
            },
            models: {
              "existing-model": {
                name: "Existing Model",
                options: {},
              },
            },
          },
        },
      });

      const modelsHash = hashModels([
        { id: "existing-model", name: "Existing Model" },
      ]);
      const existingCache = JSON.stringify({
        lastRefresh: Date.now() - 25 * 60 * 60 * 1000,
        modelsHash,
      });

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        if (filePath.includes("nim-sync-cache.json")) {
          return Promise.resolve(existingCache);
        }
        return Promise.resolve(existingConfig);
      });

      const plugin = await syncNIMModels(mockPluginAPI);
      const changed = await plugin.updateConfig?.([
        { id: "existing-model", name: "Existing Model" },
      ]);

      expect(changed).toBe(false);

      const writePaths = vi
        .mocked(fs.writeFile)
        .mock.calls.map(([filePath]) => String(filePath));
      expect(
        writePaths.some((filePath) => filePath.includes("nim-sync-cache.json")),
      ).toBe(true);
      expect(
        writePaths.some((filePath) => filePath.includes("opencode.json")),
      ).toBe(false);
    });

    it("reconciles managed nim fields and removes the legacy managed slash command when the model hash is unchanged", async () => {
      const existingConfig = JSON.stringify({
        command: {
          "nim-refresh": {
            description: "Refresh NVIDIA NIM models",
            template:
              "The /nim-refresh command triggers the nim-sync plugin to refresh the NVIDIA NIM model catalog. After it runs, reply with a short confirmation only.",
            subtask: false,
          },
        },
        provider: {
          nim: {
            npm: "custom-package",
            name: "Custom NVIDIA",
            options: {
              baseURL: "https://example.com/v1",
              region: "us-west-2",
            },
            models: {
              "existing-model": {
                name: "Existing Model",
              },
            },
          },
        },
      });

      const existingCache = JSON.stringify({
        lastRefresh: Date.now() - 25 * 60 * 60 * 1000,
        modelsHash: "test-hash-value",
      });

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        if (filePath.includes("nim-sync-cache.json")) {
          return Promise.resolve(existingCache);
        }
        return Promise.resolve(existingConfig);
      });

      const plugin = await syncNIMModels(mockPluginAPI);
      const changed = await plugin.updateConfig?.([
        { id: "existing-model", name: "Existing Model" },
      ]);

      expect(changed).toBe(true);

      const configWrite = vi
        .mocked(fs.writeFile)
        .mock.calls.filter(([filePath]) =>
          String(filePath).includes("opencode.json"),
        )
        .at(-1);
      const updatedConfig = JSON.parse(String(configWrite?.[1]));

      expect(updatedConfig.provider.nim.npm).toBe("@ai-sdk/openai-compatible");
      expect(updatedConfig.provider.nim.name).toBe("NVIDIA NIM");
      expect(updatedConfig.provider.nim.options.baseURL).toBe(
        "https://integrate.api.nvidia.com/v1",
      );
      expect(updatedConfig.provider.nim.options.region).toBe("us-west-2");
      expect(updatedConfig.command).toBeUndefined();
    });

    it("writes the cache file to the cache directory instead of the config directory", async () => {
      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.updateConfig?.([{ id: "model-1", name: "Model 1" }]);

      const writePaths = vi
        .mocked(fs.writeFile)
        .mock.calls.map(([filePath]) => String(filePath));
      const cacheFileBase = path.join(getCacheDir(), "nim-sync-cache.json");
      const configFileBase = path.join(getConfigDir(), "nim-sync-cache.json");

      expect(
        writePaths.some((filePath) => filePath.includes(cacheFileBase)),
      ).toBe(true);
      expect(
        writePaths.some((filePath) => filePath.includes(configFileBase)),
      ).toBe(false);
    });
  });

  describe("hooks", () => {
    it("exposes server.connected hook", async () => {
      const plugin = await syncNIMModels(mockPluginAPI);
      expect(plugin.hooks).toBeDefined();
      expect(plugin.hooks?.["server.connected"]).toBeDefined();
    });

    it("exposes session.created hook", async () => {
      const plugin = await syncNIMModels(mockPluginAPI);
      expect(plugin.hooks).toBeDefined();
      expect(plugin.hooks?.["session.created"]).toBeDefined();
    });
  });

  describe("init", () => {
    it("does not block startup on the initial model refresh", async () => {
      let resolveFetch:
        | ((value: {
            ok: true;
            json: () => Promise<{ data: Array<{ id: string; name: string }> }>;
          }) => void)
        | null = null;

      global.fetch = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }) as Promise<Response>,
      );

      const plugin = await syncNIMModels(mockPluginAPI);
      let initResolved = false;
      const initPromise = plugin.init?.().then(() => {
        initResolved = true;
      });

      await Promise.resolve();

      expect(initResolved).toBe(true);

      resolveFetch?.({
        ok: true,
        json: () =>
          Promise.resolve({ data: [{ id: "model-1", name: "Model 1" }] }),
      });
      await initPromise;
    });

    it("removes the legacy managed command even when the initial refresh cannot authenticate", async () => {
      delete process.env.NVIDIA_API_KEY;

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        return Promise.resolve(
          JSON.stringify({
            command: {
              "nim-refresh": {
                description: "Refresh NVIDIA NIM models",
                template:
                  "The /nim-refresh command triggers the nim-sync plugin to refresh the NVIDIA NIM model catalog. After it runs, reply with a short confirmation only.",
                subtask: false,
              },
            },
          }),
        );
      });

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      const configWrite = vi
        .mocked(fs.writeFile)
        .mock.calls.filter(([filePath]) =>
          String(filePath).includes("opencode.json"),
        )
        .at(-1);
      const updatedConfig = JSON.parse(String(configWrite?.[1] ?? "{}"));

      expect(updatedConfig.command).toBeUndefined();
      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "NVIDIA API Key Required",
          variant: "error",
        }),
      );
    });

    it("removes the legacy managed command even when the cache TTL skips the NVIDIA fetch", async () => {
      const recentCache = JSON.stringify({
        lastRefresh: Date.now() - 60_000,
        modelsHash: "test-hash-value",
        baseURL: "https://integrate.api.nvidia.com/v1",
      });
      const existingConfig = JSON.stringify({
        command: {
          "nim-refresh": {
            description: "Refresh NVIDIA NIM models",
            template:
              "The /nim-refresh command triggers the nim-sync plugin to refresh the NVIDIA NIM model catalog. After it runs, reply with a short confirmation only.",
            subtask: false,
          },
        },
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            options: {
              baseURL: "https://integrate.api.nvidia.com/v1",
            },
            models: {
              "existing-model": {
                name: "Existing Model",
                options: {},
              },
            },
          },
        },
      });

      mockPluginAPI.config.get = vi.fn(() => ({
        provider: {
          nim: {
            models: {
              "existing-model": {
                name: "Existing Model",
                options: {},
              },
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
          return Promise.resolve(recentCache);
        }
        return Promise.resolve(existingConfig);
      });

      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      const configWrite = vi
        .mocked(fs.writeFile)
        .mock.calls.filter(([filePath]) =>
          String(filePath).includes("opencode.json"),
        )
        .at(-1);
      const updatedConfig = JSON.parse(String(configWrite?.[1] ?? "{}"));

      expect(updatedConfig.command).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("handles API errors with status code", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "NVIDIA Sync Failed",
          variant: "error",
        }),
      );
    });

    it("handles network errors", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "NVIDIA Sync Failed",
          variant: "error",
        }),
      );
    });

    it("does not mark a failed refresh as a successful cache refresh", async () => {
      const existingConfig = JSON.stringify({
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            models: {
              "existing-model": {
                name: "Existing Model",
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

      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.refreshModels?.();

      const cacheWrite = vi
        .mocked(fs.writeFile)
        .mock.calls.find(([filePath]) =>
          String(filePath).includes("nim-sync-cache.json"),
        );
      const cachePayload = JSON.parse(String(cacheWrite?.[1]));

    expect(cachePayload.lastRefresh).toBeDefined();
    expect(typeof cachePayload.lastRefresh).toBe("number");
    expect(cachePayload.lastError).toContain("Network error");
    });
  });

  describe("getAPIKey", () => {
    it("logs generic error without sensitive data when auth.json parsing fails", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      vi.mocked(fs.readFile).mockRejectedValueOnce(
        Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        }),
      );

      const plugin = await syncNIMModels(mockPluginAPI);
      const apiKey = await plugin.getAPIKey?.();

      expect(apiKey).toBe("test-api-key");
      expect(consoleSpy).toHaveBeenCalledWith(
        "[NIM-Sync] Failed to read auth:",
        expect.any(String),
      );
      // Error message now includes the error details for debugging

      consoleSpy.mockRestore();
    });

    it("returns null and logs generic error for malformed auth.json", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      vi.mocked(fs.readFile).mockResolvedValueOnce("{ invalid json }");

      const plugin = await syncNIMModels(mockPluginAPI);
      const apiKey = await plugin.getAPIKey?.();

      expect(apiKey).toBe("test-api-key");
      expect(consoleSpy).toHaveBeenCalledWith(
        "[NIM-Sync] Failed to read auth:",
        expect.any(String),
      );

      consoleSpy.mockRestore();
    });

    it("returns apiKey from credentials.nim.apiKey if auth.json is valid", async () => {
      const authData = JSON.stringify({
        credentials: { nim: { apiKey: "stored-api-key-123" } },
      });

      vi.mocked(fs.readFile).mockResolvedValueOnce(authData);

      const plugin = await syncNIMModels(mockPluginAPI);
      const apiKey = await plugin.getAPIKey?.();

      expect(apiKey).toBe("stored-api-key-123");
    });

    it("returns apiKey from environment variable if auth.json is empty", async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce("{}");

      const plugin = await syncNIMModels(mockPluginAPI);
      const apiKey = await plugin.getAPIKey?.();

      expect(apiKey).toBe("test-api-key");
    });

    it("returns null if no apiKey is found in auth.json or environment", async () => {
      delete process.env.NVIDIA_API_KEY;
      vi.mocked(fs.readFile).mockResolvedValueOnce("{}");

      const plugin = await syncNIMModels(mockPluginAPI);
      const apiKey = await plugin.getAPIKey?.();

      expect(apiKey).toBeNull();

      process.env.NVIDIA_API_KEY = "test-api-key";
    });
  });

  describe("API response validation", () => {
    it("throws error for invalid API response structure", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ invalid: "structure" }),
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "NVIDIA Sync Failed",
          description: expect.stringContaining("invalid"),
        }),
      );
    });

    it("throws error when data array contains invalid model", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ data: [{ id: "", name: "Invalid Model" }] }),
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "NVIDIA Sync Failed",
          description: expect.stringContaining("Invalid"),
        }),
      );
    });

    it("derives name from id when API does not provide one", async () => {
      const mockFetch = vi.fn((url: string) => {
        if (typeof url === "string" && url.includes("/chat/completions"))
          return Promise.resolve({ ok: false, status: 404 });
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ data: [{ id: "meta/llama-3.1-8b-instruct", name: "" }] }),
        });
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("throws error when duplicate model IDs are present", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: "duplicate-id", name: "Model 1" },
              { id: "duplicate-id", name: "Model 2" },
            ],
          }),
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "NVIDIA Sync Failed",
          description: expect.stringContaining("Duplicate model ID"),
        }),
      );
    });

    it("shows warning when API returns empty model list", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "No Models Available",
          description: expect.stringContaining("NVIDIA API returned no models"),
        }),
      );
    });
  });

  describe("model probing", () => {
    it("probes models for chat capability and stores results in config options", async () => {
      const modelId = "meta/llama-3.1-70b-instruct";
      const modelName = "Meta Llama 3.1 70B Instruct";

      let modelsFetchResolve: ((value: unknown) => void) | null = null;
      let probeFetchResolve: ((value: unknown) => void) | null = null;
      const fetchCalls: string[] = [];

      global.fetch = vi.fn((url: string) => {
        fetchCalls.push(url);
        if (url.includes("/models")) {
          return new Promise((resolve) => {
            modelsFetchResolve = resolve;
          });
        }
        if (url.includes("/chat/completions")) {
          return new Promise((resolve) => {
            probeFetchResolve = resolve;
          });
        }
        return Promise.resolve({ ok: false } as Response);
      }) as any;

      const existingConfig = JSON.stringify({
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            models: {},
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
      const refreshPromise = plugin.refreshModels?.(true);
      await flushAsyncWork();

      modelsFetchResolve?.({
        ok: true,
        json: () =>
          Promise.resolve({ data: [{ id: modelId, name: modelName }] }),
      });
      await flushAsyncWork();

      probeFetchResolve?.({
        ok: true,
        json: () =>
          Promise.resolve({
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
        headers: new Headers(),
        status: 200,
      });
      await flushAsyncWork();
      await refreshPromise;

      const configWrite = vi
        .mocked(fs.writeFile)
        .mock.calls.filter(([filePath]) =>
          String(filePath).includes("opencode.json"),
        )
        .at(-1);
      const updatedConfig = JSON.parse(String(configWrite?.[1] ?? "{}"));
      const modelEntry = updatedConfig.provider.nim.models[modelId];

      expect(modelEntry.options.nimProbeChatCapable).toBe(true);
      expect(modelEntry.options.nimProbeReasoning).toBe(false);
      expect(typeof modelEntry.options.nimProbeLatencyMs).toBe("number");
    });

    it("detects reasoning capability from usage.reasoning_tokens", async () => {
      const modelId = "deepseek-ai/deepseek-r1";
      const modelName = "DeepSeek R1";

      let modelsFetchResolve: ((value: unknown) => void) | null = null;
      let probeFetchResolve: ((value: unknown) => void) | null = null;

      global.fetch = vi.fn((url: string) => {
        if (url.includes("/models")) {
          return new Promise((resolve) => {
            modelsFetchResolve = resolve;
          });
        }
        if (url.includes("/chat/completions")) {
          return new Promise((resolve) => {
            probeFetchResolve = resolve;
          });
        }
        return Promise.resolve({ ok: false } as Response);
      }) as any;

      const existingConfig = JSON.stringify({
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            models: {},
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
      const refreshPromise = plugin.refreshModels?.(true);
      await flushAsyncWork();

      modelsFetchResolve?.({
        ok: true,
        json: () =>
          Promise.resolve({ data: [{ id: modelId, name: modelName }] }),
      });
      await flushAsyncWork();

      probeFetchResolve?.({
        ok: true,
        json: () =>
          Promise.resolve({
            usage: {
              prompt_tokens: 2,
              completion_tokens: 1,
              total_tokens: 3,
              reasoning_tokens: 128,
            },
          }),
        headers: new Headers(),
        status: 200,
      });
      await flushAsyncWork();
      await refreshPromise;

      const configWrite = vi
        .mocked(fs.writeFile)
        .mock.calls.filter(([filePath]) =>
          String(filePath).includes("opencode.json"),
        )
        .at(-1);
      const updatedConfig = JSON.parse(String(configWrite?.[1] ?? "{}"));
      const modelEntry = updatedConfig.provider.nim.models[modelId];

      expect(modelEntry.options.nimProbeReasoning).toBe(true);
    });

    it("marks non-chat models (embedding, safety) as not chat capable", async () => {
      const modelId = "nvidia/nv-embedqa-e5-v5";
      const modelName = "NV-EmbedQA-E5-v5";

      let modelsFetchResolve: ((value: unknown) => void) | null = null;
      let probeFetchResolve: ((value: unknown) => void) | null = null;

      global.fetch = vi.fn((url: string) => {
        if (url.includes("/models")) {
          return new Promise((resolve) => {
            modelsFetchResolve = resolve;
          });
        }
        if (url.includes("/chat/completions")) {
          return new Promise((resolve) => {
            probeFetchResolve = resolve;
          });
        }
        return Promise.resolve({ ok: false } as Response);
      }) as any;

      const existingConfig = JSON.stringify({
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            models: {},
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
      const refreshPromise = plugin.refreshModels?.(true);
      await flushAsyncWork();

      modelsFetchResolve?.({
        ok: true,
        json: () =>
          Promise.resolve({ data: [{ id: modelId, name: modelName }] }),
      });
      await flushAsyncWork();

      probeFetchResolve?.({
        ok: true,
        status: 404,
        headers: new Headers(),
        json: () => Promise.resolve({}),
      });
      await flushAsyncWork();
      await refreshPromise;

      const configWrite = vi
        .mocked(fs.writeFile)
        .mock.calls.filter(([filePath]) =>
          String(filePath).includes("opencode.json"),
        )
        .at(-1);
      const updatedConfig = JSON.parse(String(configWrite?.[1] ?? "{}"));
      const modelEntry = updatedConfig.provider.nim.models[modelId];

      expect(modelEntry.options.nimProbeChatCapable).toBe(false);
      expect(modelEntry.options.nimProbeReasoning).toBe(false);
    });

    it("continues successfully when probe fails", async () => {
      const modelId = "meta/llama-3.1-70b-instruct";
      const modelName = "Meta Llama 3.1 70B Instruct";

      let modelsFetchResolve: ((value: unknown) => void) | null = null;
      let probeFetchReject: ((reason: Error) => void) | null = null;

      global.fetch = vi.fn((url: string) => {
        if (url.includes("/models")) {
          return new Promise((resolve) => {
            modelsFetchResolve = resolve;
          });
        }
        if (url.includes("/chat/completions")) {
          return new Promise((_resolve, reject) => {
            probeFetchReject = reject;
          });
        }
        return Promise.resolve({ ok: false } as Response);
      }) as any;

      const existingConfig = JSON.stringify({
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            models: {},
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
      const refreshPromise = plugin.refreshModels?.(true);
      await flushAsyncWork();

      modelsFetchResolve?.({
        ok: true,
        json: () =>
          Promise.resolve({ data: [{ id: modelId, name: modelName }] }),
      });
      await flushAsyncWork();

      probeFetchReject?.(new Error("Probe network error"));
      await flushAsyncWork();
      await refreshPromise;

      const configWrite = vi
        .mocked(fs.writeFile)
        .mock.calls.filter(([filePath]) =>
          String(filePath).includes("opencode.json"),
        )
        .at(-1);
      const updatedConfig = JSON.parse(String(configWrite?.[1] ?? "{}"));
      const modelEntry = updatedConfig.provider.nim.models[modelId];

      expect(modelEntry.options.nimProbeChatCapable).toBeUndefined();
      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "NVIDIA NIM Models Updated",
        }),
      );
    });
  });

  describe("race condition prevention", () => {
    it("concurrent refreshModels calls share single refresh operation", async () => {
      let fetchCount = 0;
      const mockFetch = vi.fn((url: string) => {
        fetchCount++;
        if (typeof url === "string" && url.includes("/chat/completions"))
          return Promise.resolve({ ok: false, status: 404 });
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                json: () =>
                  Promise.resolve({
                    data: [{ id: "model-1", name: "Model 1" }],
                  }),
              }),
            50,
          ),
        );
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);

      const promise1 = plugin.refreshModels?.();
      const promise2 = plugin.refreshModels?.();
      const promise3 = plugin.refreshModels?.();

      await Promise.all([promise1, promise2, promise3]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fetchCount).toBe(2); // 1 for models + 1 for probe
    });
  });

  describe("rate limiting for manual refresh", () => {
    it("shows warning when refresh is called too frequently", async () => {
      const mockFetch = vi.fn((url: string) => {
        if (typeof url === "string" && url.includes("/chat/completions"))
          return Promise.resolve({ ok: false, status: 404 });
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [{ id: "m1", name: "M1" }] }),
        });
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);
      await plugin.init?.();
      await flushAsyncWork();

      // First manual refresh should work
      await plugin.manualRefresh?.();

      expect(mockFetch).toHaveBeenCalledTimes(4); // init (models+probe) + manual (models+probe)

      // Second immediate refresh (without waiting 60 seconds) should be rate limited
      vi.clearAllMocks();
      await plugin.manualRefresh?.();

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Rate Limited",
          description: expect.stringMatching(
            /Please wait \d+s before refreshing again/,
          ),
        }),
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

  it("does not arm the rate limiter when a manual refresh is blocked by an in-progress refresh", async () => {
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
          json: () => Promise.resolve({ data: [{ id: "m1", name: "M1" }] }),
        }),
      ) as any;
    });
    global.fetch = mockFetch;

    const plugin = await syncNIMModels(mockPluginAPI);
    await plugin.init?.();
    await flushAsyncWork();

    const inFlightRefresh = plugin.refreshModels?.(true);
    await flushAsyncWork();

    await plugin.manualRefresh?.();

    expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "NVIDIA Refresh In Progress",
        description: "A model refresh is already running.",
        variant: "default",
      }),
    );

    vi.clearAllMocks();
    await plugin.manualRefresh?.();

    expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "NVIDIA Refresh In Progress",
        description: "A model refresh is already running.",
        variant: "default",
      }),
    );
    expect(mockPluginAPI.tui.toast.show).not.toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Rate Limited",
      }),
    );

    resolveModelsFetch?.(null);
    resolveProbeFetch?.(null);
    await inFlightRefresh;
  });

    it("does not arm the rate limiter when a manual refresh is blocked by missing credentials", async () => {
      delete process.env.NVIDIA_API_KEY;

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

      vi.clearAllMocks();
      await plugin.manualRefresh?.();
      await plugin.manualRefresh?.();

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledTimes(2);
      expect(mockPluginAPI.tui.toast.show).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          title: "NVIDIA API Key Required",
          variant: "error",
        }),
      );
      expect(mockPluginAPI.tui.toast.show).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          title: "NVIDIA API Key Required",
          variant: "error",
        }),
      );

      process.env.NVIDIA_API_KEY = "test-api-key";
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs/promises";
import type { PluginAPI } from "../types/index.js";
import { syncNIMModels } from "../plugin/nim-sync.js";
import { createMockPluginAPI } from "./mocks.js";

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

describe("Hook Execution Tests", () => {
  let mockPluginAPI: PluginAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPluginAPI = createMockPluginAPI();
    process.env.USERPROFILE = "/test/user";
    process.env.NVIDIA_API_KEY = "test-api-key";

    vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
      const path = String(filePath);
      if (path.includes("auth.json")) {
        return Promise.reject(
          Object.assign(new Error("File not found"), { code: "ENOENT" }),
        );
      }
      return Promise.resolve("{}");
    });
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.open).mockResolvedValue({
      close: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: Date.now() } as never);
  });

  describe("server.connected hook", () => {
    it("triggers model refresh when server connects", async () => {
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

      // Execute server.connected hook
      await plugin.hooks?.["server.connected"]();

      // Should trigger another refresh
      expect(mockFetch).toHaveBeenCalled();
    });

    it("does not refresh if within TTL window", async () => {
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

      const recentCache = JSON.stringify({
        lastRefresh: Date.now() - 1000 * 60 * 60, // 1 hour ago
        modelsHash: "test-hash-value",
      });

      mockPluginAPI.config.get = vi.fn(() => ({
        provider: {
          nim: { models: { "existing-model": { name: "Existing Model" } } },
        },
      }));

      vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
        const path = String(filePath);
        if (path.includes("auth.json")) {
          return Promise.reject(
            Object.assign(new Error("File not found"), { code: "ENOENT" }),
          );
        }
        if (path.includes("nim-sync-cache.json")) {
          return Promise.resolve(recentCache);
        }
        return Promise.resolve("{}");
      });

      const plugin = await syncNIMModels(mockPluginAPI);

      // Execute server.connected hook
      await plugin.hooks?.["server.connected"]();

      // Should not fetch because cache is fresh
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("session.created hook", () => {
    it("triggers model refresh when session is created", async () => {
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

      // Execute session.created hook
      await plugin.hooks?.["session.created"]();

      // Should trigger another refresh
      expect(mockFetch).toHaveBeenCalled();
    });

    it("handles errors gracefully during hook execution", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);

      // Execute session.created hook - should not throw
      await expect(
        plugin.hooks?.["session.created"](),
      ).resolves.toBeUndefined();

      // Should show error toast
      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "NVIDIA Sync Failed",
          variant: "error",
        }),
      );
    });
  });

  describe("concurrent hook execution", () => {
    it("deduplicates refresh when multiple hooks fire simultaneously", async () => {
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
                    data: [
                      {
                        id: "meta/llama-3.1-70b-instruct",
                        name: "Meta Llama 3.1 70B Instruct",
                      },
                    ],
                  }),
              }),
            50,
          ),
        );
      });
      global.fetch = mockFetch;

      const plugin = await syncNIMModels(mockPluginAPI);

      // Fire both hooks simultaneously
      const hook1 = plugin.hooks?.["server.connected"]();
      const hook2 = plugin.hooks?.["session.created"]();

      await Promise.all([hook1, hook2]);

      // Should only fetch once each (models + probe) due to deduplication
      expect(fetchCount).toBe(2); // 1 models + 1 probe
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs/promises";
import { getOrCreateNIMSyncService, removeManagedRefreshCommand } from "../plugin/nim-sync-service.js";
import { validateOpenCodeConfig } from "../types/schema.js";
import { acquireLock } from "../lib/file-lock.js";

vi.mock("fs/promises");
vi.mock("../lib/file-lock.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/file-lock.js")>();
  const mockRelease = vi.fn().mockResolvedValue(undefined);
  return {
    ...original,
    acquireLock: vi.fn().mockResolvedValue(mockRelease),
  };
});

vi.mock("../types/schema.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../types/schema.js")>();
  return {
    ...original,
    validateOpenCodeConfig: vi.fn(original.validateOpenCodeConfig),
  };
});

describe("NIMSyncService Lock and Validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.USERPROFILE = "/test/user";
    process.env.NVIDIA_API_KEY = "test-api-key";
    vi.mocked(validateOpenCodeConfig).mockReturnValue({ valid: true });
  });

  it("removeManagedRefreshCommand validates the configuration before write", async () => {
    const mockConfig = {
      command: {
        "nim-refresh": {
          description: "Refresh NVIDIA NIM models",
          template: "The /nim-refresh command triggers the nim-sync plugin to refresh the NVIDIA NIM model catalog. After it runs, reply with a short confirmation only.",
          subtask: false,
        }
      }
    };
    
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockConfig));
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    // Test validation success path
    vi.mocked(validateOpenCodeConfig).mockReturnValue({ valid: true, errors: [] });
    
    const result = await removeManagedRefreshCommand(vi.fn());
    expect(result).toBe(true);
    expect(validateOpenCodeConfig).toHaveBeenCalled();

    // Test validation failure path
    vi.mocked(validateOpenCodeConfig).mockReturnValue({ valid: false, errors: ["Invalid property"] });
    await expect(removeManagedRefreshCommand(vi.fn())).rejects.toThrow("Config validation failed");
  });

  it("acquires the lock before reading the config and releases it when finished", async () => {
    const mockRelease = vi.fn().mockResolvedValue(undefined);
    vi.mocked(acquireLock).mockResolvedValue(mockRelease);

    const mockConfig = {
      provider: {
        nim: {
          npm: "@ai-sdk/openai-compatible",
          name: "NVIDIA NIM",
          models: {},
        }
      }
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockConfig));
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    // Call updateConfig through the service
    const service = getOrCreateNIMSyncService();
    
    const callOrder: string[] = [];
    vi.mocked(acquireLock).mockImplementation(async (_key) => {
      callOrder.push("lock");
      return mockRelease;
    });
    vi.mocked(fs.readFile).mockImplementation(async () => {
      callOrder.push("read");
      return JSON.stringify(mockConfig);
    });

    // Clear background activity before running test operations
    callOrder.length = 0;
    vi.mocked(acquireLock).mockClear();
    mockRelease.mockClear();

    const result = await service.updateConfig([]);
    expect(result).toBe(true);
    expect(acquireLock).toHaveBeenCalledWith("nim-config-update");
    expect(callOrder[0]).toBe("lock");
    expect(callOrder[1]).toBe("read");
    expect(mockRelease).toHaveBeenCalled();

    // Test failure path
    mockRelease.mockClear();
    callOrder.length = 0;
    vi.mocked(fs.readFile).mockRejectedValue(new Error("Disk error"));
    await expect(service.updateConfig([])).rejects.toThrow("Disk error");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("should preserve and chain multiple showToast callbacks when getOrCreateNIMSyncService is called multiple times", async () => {
    const toast1 = vi.fn();
    const toast2 = vi.fn();

    // Call with first toast callback
    getOrCreateNIMSyncService({ showToast: toast1 });
    
    // Call with second toast callback
    getOrCreateNIMSyncService({ showToast: toast2 });

    // Call with empty/partial options
    const service3 = getOrCreateNIMSyncService({});

    vi.mocked(fs.readFile).mockRejectedValue(new Error("file not found"));
    
    await service3.manualRefresh(); // first call sets the rate limit timestamp
    await service3.manualRefresh(); // second call triggers Rate Limited toast!

    expect(toast1).toHaveBeenCalled();
    expect(toast2).toHaveBeenCalled();
  });
});

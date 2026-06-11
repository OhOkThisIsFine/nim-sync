import { vi } from "vitest";
import type { PluginAPI } from "../types/index.js";
import type { FileHandle } from "fs/promises";

// Mock type for fs.promises FileHandle
export type MockFileHandle = Pick<FileHandle, "close"> & {
  close: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
};

// Mock type for fs.stat result
export type MockStats = {
  mtimeMs: number;
};

export function createMockPluginAPI(overrides?: Partial<PluginAPI>): PluginAPI {
  return {
    config: {
      get: vi.fn(),
      set: vi.fn(),
    },
    tui: {
      toast: {
        show: vi.fn(),
      },
    },
    command: {
      register: vi.fn(),
      execute: vi.fn(),
    },
    ...overrides,
  };
}

import fs from "fs/promises";

export function setupDefaultFsMocks(): void {
  vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
    if (filePath.includes("auth.json")) {
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
  } as any);
  vi.mocked(fs.unlink).mockResolvedValue(undefined);
  vi.mocked(fs.access).mockResolvedValue(undefined);
  vi.mocked(fs.stat).mockImplementation(async () => ({ mtimeMs: Date.now() } as any));
}

export const flushAsyncWork = async (cycles = 20): Promise<void> => {
  for (let i = 0; i < cycles; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

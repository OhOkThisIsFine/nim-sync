import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs/promises";
import type { MockFileHandle } from "./mocks.js";
import {
  readJSONC,
  writeJSONC,
  atomicWrite,
  ensureDir,
  acquireLock,
  updateJSONCPath,
  updateJSONCPaths,
} from "../lib/file-utils.js";
import {
  getConfigDir,
  getCacheDir,
  getDataDir,
  getConfigFilePath,
} from "../lib/config-path.js";
import { LockError, BackupError, ParseError, ValidationError } from "../lib/errors.js";

vi.mock("fs/promises");

describe("File Utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.USERPROFILE = "/test/user";
    process.env.HOME = "/test/user";
  });

  describe("readJSONC", () => {
    it("reads and parses JSONC file", async () => {
      const mockContent = '{ "key": "value" }';
      vi.mocked(fs.readFile).mockResolvedValue(mockContent);

      const result = await readJSONC("/test/file.json");
      expect(result).toEqual({ key: "value" });
    });

    it("should propagate ENOENT error when file does not exist", async () => {
      const error = new Error("File not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(error);

      await expect(readJSONC("/test/missing.json")).rejects.toThrow();
    });

    it("handles UTF-8 BOM", async () => {
      const mockContent = '\uFEFF{ "key": "value" }';
      vi.mocked(fs.readFile).mockResolvedValue(mockContent);

      const result = await readJSONC("/test/file.json");
      expect(result).toEqual({ key: "value" });
    });

    it("throws ParseError on jsonc parse failure", async () => {
      const mockContent = "{ invalid json }";
      vi.mocked(fs.readFile).mockResolvedValue(mockContent);

      await expect(readJSONC("/test/file.json")).rejects.toThrow(ParseError);
    });

    it("throws error for other read failures", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("Permission denied"));

      await expect(readJSONC("/test/file.json")).rejects.toThrow(
        "Permission denied",
      );
    });

    it("throws error when validation callback returns false", async () => {
      const mockContent = '{ "key": "value" }';
      vi.mocked(fs.readFile).mockResolvedValue(mockContent);

      const failingValidator = (
        _data: unknown,
      ): _data is { required: string } => false;

      await expect(
        readJSONC("/test/file.json", failingValidator),
      ).rejects.toThrow(ValidationError);
    });

    it("passes when validation callback returns true", async () => {
      const mockContent = '{ "key": "value" }';
      vi.mocked(fs.readFile).mockResolvedValue(mockContent);

      const passingValidator = (_data: unknown): _data is { key: string } =>
        true;

      const result = await readJSONC("/test/file.json", passingValidator);
      expect(result).toEqual({ key: "value" });
    });
  });

  describe("writeJSONC", () => {
    it("writes JSON data to file", async () => {
      const fileNotFound = new Error("File not found") as NodeJS.ErrnoException;
      fileNotFound.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(fileNotFound);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);

      await writeJSONC("/test/file.json", { key: "value" });

      expect(fs.writeFile).toHaveBeenCalled();
    });

    it("preserves JSONC comments when file exists", async () => {
      const existingContent = `{
  // This is a comment
  "key": "old"
}`;
      vi.mocked(fs.readFile).mockResolvedValue(existingContent);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);

      await writeJSONC("/test/file.json", { key: "new", other: 1 });

      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]?.[1];
      expect(writtenContent).toContain("// This is a comment");
      expect(writtenContent).toContain('"key"');
      expect(writtenContent).toContain("new");
      expect(writtenContent).toContain("other");
    });

    it("creates new file when none exists", async () => {
      const fileNotFound = new Error("File not found") as NodeJS.ErrnoException;
      fileNotFound.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(fileNotFound);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);

      await writeJSONC("/test/new.json", { data: 42 });

      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]?.[1];
      expect(writtenContent).toBe('{\n  "data": 42\n}');
    });
  });

  describe("updateJSONCPath", () => {
    it("updates a single path in existing JSONC while preserving comments", async () => {
      const existingContent = `{
  // keep me
  "a": 1
}`;
      vi.mocked(fs.readFile).mockResolvedValue(existingContent);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);

      await updateJSONCPath("/test/file.json", ["a"], 2);

      const writtenContent = String(
        vi.mocked(fs.writeFile).mock.calls[0]?.[1],
      );
      expect(writtenContent).toContain("// keep me");
      expect(writtenContent).toContain('"a": 2');
    });

    it("creates file content from scratch when file does not exist", async () => {
      const fileNotFound = new Error("File not found") as NodeJS.ErrnoException;
      fileNotFound.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(fileNotFound);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);

      await updateJSONCPath("/test/new.json", ["key"], "value");

      const writtenContent = String(
        vi.mocked(fs.writeFile).mock.calls[0]?.[1],
      );
      expect(writtenContent).toContain('"key": "value"');
    });

    it("propagates non-ENOENT read errors", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("Permission denied"));

      await expect(
        updateJSONCPath("/test/file.json", ["key"], "value"),
      ).rejects.toThrow("Permission denied");
    });

    it("passes backup options to atomicWrite", async () => {
      const existingContent = '{ "a": 1 }';
      vi.mocked(fs.readFile).mockResolvedValue(existingContent);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);

      await updateJSONCPath("/test/file.json", ["a"], 2, {
        backup: true,
        createBackupDir: true,
      });

      expect(fs.writeFile).toHaveBeenCalled();
    });
  });

  describe("updateJSONCPaths", () => {
    it("applies all updates before a single atomic write", async () => {
      const existingContent = `{
  // comment
  "a": 1,
  "b": 2
}`;
      vi.mocked(fs.readFile).mockResolvedValue(existingContent);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);

      await updateJSONCPaths("/test/file.json", [
        { jsonPath: ["a"], data: 10 },
        { jsonPath: ["b"], data: 20 },
      ]);

      expect(fs.writeFile).toHaveBeenCalledTimes(1);
      const writtenContent = String(
        vi.mocked(fs.writeFile).mock.calls[0]?.[1],
      );
      expect(writtenContent).toContain("// comment");
      expect(writtenContent).toContain('"a": 10');
      expect(writtenContent).toContain('"b": 20');
    });

    it("handles ENOENT by starting from empty string", async () => {
      const fileNotFound = new Error("File not found") as NodeJS.ErrnoException;
      fileNotFound.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(fileNotFound);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);

      await updateJSONCPaths("/test/new.json", [
        { jsonPath: ["a"], data: 1 },
      ]);

      expect(fs.writeFile).toHaveBeenCalledTimes(1);
    });

    it("propagates non-ENOENT read errors", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("Permission denied"));

      await expect(
        updateJSONCPaths("/test/file.json", [{ jsonPath: ["a"], data: 1 }]),
      ).rejects.toThrow("Permission denied");
    });

    it("passes backup options to atomicWrite", async () => {
      const existingContent = '{ "a": 1 }';
      vi.mocked(fs.readFile).mockResolvedValue(existingContent);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);

      await updateJSONCPaths(
        "/test/file.json",
        [{ jsonPath: ["a"], data: 2 }],
        { backup: true, createBackupDir: true },
      );

      expect(fs.writeFile).toHaveBeenCalled();
    });
  });

  describe("atomicWrite", () => {
    it("writes file atomically", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);

      await atomicWrite("/test/file.txt", "content");

      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
      expect(fs.rename).toHaveBeenCalled();
    });

    it("creates backup when requested", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);
      vi.mocked(fs.copyFile).mockResolvedValue(undefined);

      await atomicWrite("/test/file.txt", "content", {
        backup: true,
        createBackupDir: true,
      });

      expect(fs.mkdir).toHaveBeenCalled();
    });

    it("cleans up old backups beyond MAX_BACKUPS threshold", async () => {
      const now = Date.now();
      const mockFiles = Array.from(
        { length: 10 },
        (_, i) => `file.txt.${now - i * 1000}.bak`,
      );

      vi.mocked(fs.readdir).mockResolvedValue(mockFiles as any);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.copyFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await atomicWrite("/test/file.txt", "content", {
        backup: true,
        createBackupDir: true,
      });

      const unlinkCalls = vi.mocked(fs.unlink).mock.calls;
      const backupDeletions = unlinkCalls.filter((call) =>
        String(call[0]).includes(".bak"),
      );
      expect(backupDeletions.length).toBe(5);
    });

    it("does not delete opencode.jsonc backups when cleaning opencode.json backups", async () => {
      const now = Date.now();
      const jsonBackups = Array.from(
        { length: 6 },
        (_, i) => `opencode.json.${now - i * 1000}.bak`,
      );
      const jsoncBackups = [
        `opencode.jsonc.${now - 10000}.bak`,
        `opencode.jsonc.${now - 20000}.bak`,
      ];
      vi.mocked(fs.readdir).mockResolvedValue(
        [...jsonBackups, ...jsoncBackups] as any,
      );
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.copyFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await atomicWrite("/test/opencode.json", "content", {
        backup: true,
        createBackupDir: true,
      });

      const unlinkCalls = vi.mocked(fs.unlink).mock.calls;
      const backupDeletions = unlinkCalls.filter((call) =>
        String(call[0]).endsWith(".bak"),
      );
      expect(backupDeletions.length).toBe(1);
      const jsoncDeletions = backupDeletions.filter((call) =>
        String(call[0]).includes("opencode.jsonc"),
      );
      expect(jsoncDeletions.length).toBe(0);
    });

    it("handles backup cleanup failures gracefully", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(
        new Error("Directory read failed"),
      );
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.copyFile).mockResolvedValue(undefined);

      await expect(
        atomicWrite("/test/file.txt", "content", {
          backup: true,
          createBackupDir: true,
        }),
      ).resolves.toBeUndefined();
    });

    it("throws error when backup creation fails with non-ENOENT error", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.access).mockResolvedValue(undefined);

      vi.mocked(fs.copyFile).mockRejectedValue(new Error("Permission denied"));

      await expect(
        atomicWrite("/test/file.txt", "content", {
          backup: true,
          createBackupDir: true,
        }),
      ).rejects.toThrow(BackupError);
    });

    it("ignores ENOENT when original file does not exist for backup", async () => {
      const error = new Error("No such file") as NodeJS.ErrnoException;
      error.code = "ENOENT";

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.access).mockRejectedValue(error);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);

      await expect(
        atomicWrite("/test/file.txt", "content", {
          backup: true,
          createBackupDir: true,
        }),
      ).resolves.toBeUndefined();
    });

    it("silently handles temp file cleanup failures during error recovery", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockRejectedValue(new Error("Disk full"));
      vi.mocked(fs.unlink).mockRejectedValue(new Error("Cannot unlink"));

      await expect(atomicWrite("/test/file.txt", "content")).rejects.toThrow(
        "Disk full",
      );
    });

    it("cleans up temp file on error", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockRejectedValue(new Error("Write failed"));
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await expect(atomicWrite("/test/file.txt", "content")).rejects.toThrow(
        "Write failed",
      );
      expect(fs.unlink).toHaveBeenCalled();
    });
  });

  describe("ensureDir", () => {
    it("creates directory recursively", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      await ensureDir("/test/dir");

      expect(fs.mkdir).toHaveBeenCalledWith("/test/dir", { recursive: true });
    });

    it("ignores EEXIST error", async () => {
      const error = new Error("Directory exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      vi.mocked(fs.mkdir).mockRejectedValue(error);

      await expect(ensureDir("/test/dir")).resolves.toBeUndefined();
    });

    it("throws other errors", async () => {
      vi.mocked(fs.mkdir).mockRejectedValue(new Error("Permission denied"));

      await expect(ensureDir("/test/dir")).rejects.toThrow("Permission denied");
    });
  });

  describe("getConfigFilePath", () => {
    it("returns opencode.json path when no config file exists", async () => {
      const fileNotFound = new Error(
        "File not found",
      ) as NodeJS.ErrnoException;
      fileNotFound.code = "ENOENT";
      vi.mocked(fs.access).mockRejectedValue(fileNotFound);

      const result = await getConfigFilePath();
      expect(result).toContain("opencode.json");
      expect(result).not.toContain("opencode.jsonc");
    });

    it("returns existing opencode.json path", async () => {
      const fileNotFound = new Error(
        "File not found",
      ) as NodeJS.ErrnoException;
      fileNotFound.code = "ENOENT";
      vi.mocked(fs.access).mockImplementation(async (filePath: string) => {
        if (String(filePath).endsWith("opencode.json")) {
          return undefined;
        }
        throw fileNotFound;
      });

      const result = await getConfigFilePath();
      expect(result).toContain("opencode.json");
      expect(result).not.toContain("opencode.jsonc");
    });

    it("returns existing opencode.jsonc path when opencode.json is missing", async () => {
      const fileNotFound = new Error(
        "File not found",
      ) as NodeJS.ErrnoException;
      fileNotFound.code = "ENOENT";
      vi.mocked(fs.access).mockImplementation(async (filePath: string) => {
        if (String(filePath).endsWith("opencode.jsonc")) {
          return undefined;
        }
        throw fileNotFound;
      });

      const result = await getConfigFilePath();
      expect(result).toContain("opencode.jsonc");
    });

    it("prefers opencode.json over opencode.jsonc when both exist", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);

      const result = await getConfigFilePath();
      expect(result).toContain("opencode.json");
      expect(result).not.toContain("opencode.jsonc");
    });

    it("throws non-ENOENT error from fs.access", async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error("Permission denied"));

      await expect(getConfigFilePath()).rejects.toThrow("Permission denied");
    });
  });

  describe("getConfigDir", () => {
    it("returns Windows config path on Windows", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });

      const dir = getConfigDir();
      expect(dir).toContain(".config");
      expect(dir).toContain("opencode");

      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    });

    it("returns Unix config path on Linux/macOS", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
      });

      const dir = getConfigDir();
      expect(dir).toContain(".config");
      expect(dir).toContain("opencode");

      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    });
  });

  describe("getCacheDir", () => {
    it("returns Windows cache path on Windows", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });

      const dir = getCacheDir();
      expect(dir).toContain(".cache");
      expect(dir).toContain("opencode");

      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    });

    it("returns Unix cache path on Linux/macOS", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
      });

      const dir = getCacheDir();
      expect(dir).toContain(".cache");
      expect(dir).toContain("opencode");

      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    });
  });

  describe("getDataDir", () => {
    it("returns Windows data path on Windows", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });

      const dir = getDataDir();
      expect(dir).toContain(".local");
      expect(dir).toContain("share");
      expect(dir).toContain("opencode");

      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    });

    it("returns Unix data path on Linux/macOS", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
      });

      const dir = getDataDir();
      expect(dir).toContain(".local");
      expect(dir).toContain("share");
      expect(dir).toContain("opencode");

      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    });
  });

  describe("acquireLock", () => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("acquires lock successfully", async () => {
      const mockFd: MockFileHandle = {
        close: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.open).mockResolvedValue(mockFd as never);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const release = await acquireLock("test-lock");
      expect(typeof release).toBe("function");

      await release();
      expect(fs.unlink).toHaveBeenCalled();
    });

    it("retries on EEXIST and eventually succeeds", async () => {
      const mockFd: MockFileHandle = {
        close: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };
      const error = new Error("Lock exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";

      vi.mocked(fs.open)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(mockFd as never);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const release = await acquireLock("test-lock");
      expect(typeof release).toBe("function");
    });

    it("throws after timeout", async () => {
      const error = new Error("Lock exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";

      vi.mocked(fs.open).mockRejectedValue(error);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      await expect(acquireLock("test-lock", 100)).rejects.toThrow(
        LockError,
      );
    });

    it("throws non-EEXIST errors immediately", async () => {
      vi.mocked(fs.open).mockRejectedValue(new Error("Permission denied"));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      await expect(acquireLock("test-lock")).rejects.toThrow(
        "Permission denied",
      );
    });

    it("cleans up stale lock from crashed process", async () => {
      const mockFd: MockFileHandle = {
        close: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };

      const eexistError = new Error("Lock exists") as NodeJS.ErrnoException;
      eexistError.code = "EEXIST";

      const staleLockMetadata = JSON.stringify({
        pid: 99999,
        timestamp: Date.now() - 10 * 60 * 1000,
      });

      vi.mocked(fs.open)
        .mockRejectedValueOnce(eexistError)
        .mockResolvedValueOnce(mockFd as never);
      vi.mocked(fs.readFile).mockResolvedValueOnce(staleLockMetadata);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      const release = await acquireLock("test-lock");
      expect(typeof release).toBe("function");

      expect(fs.unlink).toHaveBeenCalled();
    });

    it("handles release lock failure gracefully", async () => {
      const mockFd: MockFileHandle = {
        close: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.open).mockResolvedValue(mockFd as never);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      vi.mocked(fs.unlink).mockRejectedValue(
        new Error("Failed to release lock"),
      );

      const release = await acquireLock("test-lock");

      await expect(release()).resolves.toBeUndefined();
    });
  });

  describe("Module Structure and Cycle Prevention", () => {
    it("ensures file-utils does not export config paths", async () => {
      const fileUtils = await import("../lib/file-utils.js");
      expect(fileUtils).not.toHaveProperty("getConfigFilePath");
      expect(fileUtils).not.toHaveProperty("getConfigDir");
      expect(fileUtils).not.toHaveProperty("getCacheDir");
      expect(fileUtils).not.toHaveProperty("getDataDir");
    });
  });
});

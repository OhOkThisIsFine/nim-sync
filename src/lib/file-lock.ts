import fs from "fs/promises";
import path from "path";
import type { LockMetadata } from "../types/index.js";
import { getCacheDir } from "./config-path.js";
import { ensureDir } from "./file-utils.js";

export const LOCK_STALE_THRESHOLD_MS = 5 * 60 * 1000;

export const LOCK_RETRY_INTERVAL_MS = 100;

export const MAX_BACKUPS = 5;

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

export async function cleanupOldBackups(
  backupDir: string,
  baseName: string,
): Promise<void> {
  try {
    const files = await fs.readdir(backupDir);
    const backupPattern = new RegExp(
      `^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+\\.bak$`,
    );
    const backups = files
      .filter((f) => backupPattern.test(f))
      .map((f) => ({
        name: f,
        timestamp: parseInt(f.split(".").slice(-2, -1)[0]) || 0,
      }))
      .sort((a, b) => b.timestamp - a.timestamp);

    for (const oldBackup of backups.slice(MAX_BACKUPS)) {
      await fs.unlink(path.join(backupDir, oldBackup.name));
    }
  } catch {
    // Ignore cleanup failures
  }
}

export async function acquireLock(
  lockName: string,
  timeoutMs = 5000,
): Promise<() => Promise<void>> {
  const lockDir = getCacheDir();
  const lockPath = path.join(lockDir, `${lockName}.lock`);

  await ensureDir(lockDir);

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const fd = await fs.open(lockPath, "wx");
      const metadata: LockMetadata = {
        pid: process.pid,
        timestamp: Date.now(),
      };
      await fd.writeFile(JSON.stringify(metadata));
      await fd.close();

      return async () => {
        try {
          await fs.unlink(lockPath);
        } catch {
          // Ignore unlock failures
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const lockContent = await fs.readFile(lockPath, "utf-8");
          const metadata = JSON.parse(lockContent) as LockMetadata;
          const staleThreshold = Date.now() - LOCK_STALE_THRESHOLD_MS;

          const isStale = metadata.timestamp < staleThreshold;
          const processExists = metadata.pid
            ? isProcessRunning(metadata.pid)
            : true;

          if (isStale || !processExists) {
            try {
              await fs.unlink(lockPath);
            } catch {
              // Lock may have been released by another process
            }
          }
        } catch (staleCheckError) {
          if ((staleCheckError as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error("Failed to clean up stale lock");
          }
        }

        await new Promise((resolve) =>
          setTimeout(resolve, LOCK_RETRY_INTERVAL_MS),
        );
      } else {
        throw error;
      }
    }
  }

  throw new Error(`Failed to acquire lock "${lockName}" after ${timeoutMs}ms`);
}

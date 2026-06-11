import fs from "fs/promises";
import path from "path";
import { cleanupOldBackups } from "./file-lock.js";
import { BackupError } from "./errors.js";

export interface AtomicWriteOptions {
  backup?: boolean;
  createBackupDir?: boolean;
}

export async function atomicWrite(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

  try {
    await fs.mkdir(dir, { recursive: true });

    if (options.backup) {
      try {
        await fs.access(filePath);

        const backupDir = path.join(dir, "backups");
        if (options.createBackupDir) {
          await fs.mkdir(backupDir, { recursive: true });
        }

        const backupPath = path.join(
          backupDir,
          `${path.basename(filePath)}.${Date.now()}.bak`,
        );
        await fs.copyFile(filePath, backupPath);

        await cleanupOldBackups(backupDir, path.basename(filePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new BackupError(
            `Failed to create backup: ${error instanceof Error ? error.message : "Unknown error"}`,
          );
        }
      }
    }

    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore temp file cleanup failures
    }
    throw error;
  }
}



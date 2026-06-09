import fs from "fs/promises";

export type { AtomicWriteOptions } from "./atomic-io.js";
export { atomicWrite } from "./atomic-io.js";

export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}
export {
  readJSONC,
  writeJSONC,
  updateJSONCPath,
  updateJSONCPaths,
} from "./jsonc-utils.js";
export {
  API_TIMEOUT_MS,
  CACHE_TTL_MS,
  MIN_MANUAL_REFRESH_INTERVAL_MS,
  OPENCODE_CONFIG_FILENAMES,
  getConfigDir,
  getCacheDir,
  getDataDir,
  getConfigFilePath,
} from "./config-path.js";
export {
  LOCK_STALE_THRESHOLD_MS,
  LOCK_RETRY_INTERVAL_MS,
  MAX_BACKUPS,
  acquireLock,
} from "./file-lock.js";

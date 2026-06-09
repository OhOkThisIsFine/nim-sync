import path from "path";
import { readJSONC, writeJSONC } from "./jsonc-utils.js";
import { acquireLock } from "./file-lock.js";
import { getCacheDir } from "./config-path.js";
import type { CacheData } from "../types/index.js";
import type { NIMSyncToast } from "../types/index.js";

type ToastFn = (toast: NIMSyncToast) => void;

const CACHE_FILE_NAME = "nim-sync-cache.json";

const getCachePath = (): string => path.join(getCacheDir(), CACHE_FILE_NAME);

const readCache = async (): Promise<CacheData | null> => {
  try {
    const cache = await readJSONC<CacheData>(getCachePath());
    return cache?.lastRefresh ? cache : null;
  } catch {
    return null;
  }
};

const writeCache = async (cache: CacheData, showToast: ToastFn): Promise<void> => {
  let releaseLockFn: (() => Promise<void>) | null = null;
  try {
    releaseLockFn = await acquireLock("nim-cache-write");
  } catch (lockError) {
    const msg =
      lockError instanceof Error ? lockError.message : "Unknown error";
    console.error("[NIM-Sync] Cache lock failed:", msg);
    showToast({
      title: "NVIDIA Sync Warning",
      message: "Cache lock failed: " + msg,
      variant: "error",
    });
    throw lockError;
  }
  try {
    await writeJSONC(getCachePath(), cache, { backup: true });
  } catch (writeError) {
    const msg =
      writeError instanceof Error ? writeError.message : "Unknown error";
    console.error("[NIM-Sync] Cache write failed:", msg);
    showToast({
      title: "NVIDIA Sync Failed",
      message: "Failed to write cache: " + msg,
      variant: "error",
    });
    throw writeError;
  } finally {
    if (releaseLockFn) {
      try {
        await releaseLockFn();
      } catch (e) {
        console.error("[NIM-Sync] Failed to release cache lock:", e);
      }
    }
  }
};

export { getCachePath, readCache, writeCache };

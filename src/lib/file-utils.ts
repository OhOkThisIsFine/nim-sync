export type { AtomicWriteOptions } from "./atomic-io.js";
export { atomicWrite } from "./atomic-io.js";

export { ensureDir } from "./file-lock.js";
export {
  readJSONC,
  writeJSONC,
  updateJSONCPath,
  updateJSONCPaths,
} from "./jsonc-utils.js";
export {
  LOCK_STALE_THRESHOLD_MS,
  LOCK_RETRY_INTERVAL_MS,
  MAX_BACKUPS,
  acquireLock,
} from "./file-lock.js";

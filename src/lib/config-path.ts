import path from "path";
import fs from "fs/promises";
import type { PlatformPaths } from "../types/index.js";

export const API_TIMEOUT_MS = 30_000;

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const MIN_MANUAL_REFRESH_INTERVAL_MS = 60_000;

export const OPENCODE_CONFIG_FILENAMES = [
  "opencode.json",
  "opencode.jsonc",
] as const;

function getPlatformPaths(): PlatformPaths {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const dataHome =
    process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(home, ".cache");

  return {
    config: path.join(configHome, "opencode"),
    data: path.join(dataHome, "opencode"),
    cache: path.join(cacheHome, "opencode"),
  };
}

export function getConfigDir(): string {
  return getPlatformPaths().config;
}

export function getCacheDir(): string {
  return getPlatformPaths().cache;
}

export function getDataDir(): string {
  return getPlatformPaths().data;
}

export async function getConfigFilePath(): Promise<string> {
  const configDir = getConfigDir();

  for (const fileName of OPENCODE_CONFIG_FILENAMES) {
    const candidate = path.join(configDir, fileName);
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return path.join(configDir, OPENCODE_CONFIG_FILENAMES[0]);
}

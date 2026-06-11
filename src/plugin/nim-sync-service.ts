import type {
  NIMModel,
  OpenCodeConfig,
  AuthConfig,
  ProbeResult,
  NIMSyncToast,
} from "../types/index.js";
import { validateOpenCodeConfig, isValidOpenCodeConfig } from "../types/schema.js";
import { readJSONC, updateJSONCPaths } from "../lib/jsonc-utils.js";
import { acquireLock } from "../lib/file-lock.js";
import {
  getConfigFilePath,
  getAuthFilePath,
  CACHE_TTL_MS,
  MIN_MANUAL_REFRESH_INTERVAL_MS,
} from "../lib/config-path.js";
import {
  NIM_REFRESH_COMMAND_DESCRIPTION,
  NIM_REFRESH_COMMAND_NAME,
  NIM_REFRESH_COMMAND_TEMPLATE,
} from "./nim-refresh-command.js";
import { hashModels } from "../lib/crypto-utils.js";
import { readCache, writeCache } from "../lib/nim-cache.js";
import { fetchModels, probeModels, NIM_BASE_URL } from "../lib/nim-api.js";

type RefreshSource = "background" | "manual";
export type NIMSyncRefreshResult =
  | "updated"
  | "unchanged"
  | "failed"
  | "missing-api-key"
  | "skipped"
  | "in-progress";
type RefreshCommandConfig = NonNullable<OpenCodeConfig["command"]>[string];

export interface NIMSyncServiceOptions {
  getConfigSnapshot?: () => Promise<OpenCodeConfig> | OpenCodeConfig;
  showToast?: (toast: NIMSyncToast) => void | Promise<void>;
}

export interface NIMSyncService {
  getAPIKey: () => Promise<string | null>;
  getNextRefreshDelay: () => Promise<number>;
  updateConfig: (models: NIMModel[]) => Promise<boolean>;
  refreshModels: (force?: boolean) => Promise<NIMSyncRefreshResult>;
  manualRefresh: () => Promise<void>;
  shouldRefresh: () => Promise<boolean>;
}

const getAuthPath = (): string => getAuthFilePath();

const defaultGetConfigSnapshot = async (): Promise<OpenCodeConfig> => {
  return readJSONC<OpenCodeConfig>(await getConfigFilePath(), isValidOpenCodeConfig);
};

const deepSortedStringify = (value: unknown): string => {
  if (value === null) return "__null__";
  if (value === undefined) return "__undefined__";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(deepSortedStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + deepSortedStringify(obj[k]))
      .join(",") +
    "}"
  );
};

const managedNIMConfigMatches = (
  currentConfig: NonNullable<OpenCodeConfig["provider"]>["nim"] | undefined,
  nextConfig: NonNullable<OpenCodeConfig["provider"]>["nim"],
): boolean => {
  return deepSortedStringify(currentConfig ?? null) === deepSortedStringify(nextConfig);
};

const managedRefreshCommandMatches = (
  currentConfig: RefreshCommandConfig | undefined,
  nextConfig: RefreshCommandConfig,
): boolean => {
  return deepSortedStringify(currentConfig ?? null) === deepSortedStringify(nextConfig);
};

const buildManagedRefreshCommand = (): NonNullable<
  OpenCodeConfig["command"]
>[typeof NIM_REFRESH_COMMAND_NAME] => ({
  description: NIM_REFRESH_COMMAND_DESCRIPTION,
  template: NIM_REFRESH_COMMAND_TEMPLATE,
  subtask: false,
});

const getManagedRefreshCommandCleanup = (
  config: OpenCodeConfig,
): {
  removed: boolean;
  command: OpenCodeConfig["command"] | undefined;
  updates: Array<{
    jsonPath: Array<string | number>;
    data: unknown;
  }>;
} => {
  const managedRefreshCommand = buildManagedRefreshCommand();
  const currentRefreshCommand = config.command?.[NIM_REFRESH_COMMAND_NAME];

  if (
    !managedRefreshCommandMatches(currentRefreshCommand, managedRefreshCommand)
  ) {
    return {
      removed: false,
      command: config.command,
      updates: [],
    };
  }

  const nextCommand = {
    ...(config.command ?? {}),
  };

  delete nextCommand[NIM_REFRESH_COMMAND_NAME];

  const updates = [
    {
      jsonPath: ["command", NIM_REFRESH_COMMAND_NAME] as Array<string | number>,
      data: undefined,
    },
  ];

  if (Object.keys(nextCommand).length === 0) {
    updates.push({
      jsonPath: ["command"],
      data: undefined,
    });
  }

  return {
    removed: true,
    command: Object.keys(nextCommand).length > 0 ? nextCommand : undefined,
    updates,
  };
};



const sanitizeErrorMessage = (msg: string, apiKey: string | null): string => {
  if (!apiKey) return msg;
  return msg.replace(apiKey, "[REDACTED]");
};

const persistManagedConfigUpdates = async (
  configPath: string,
  updatedConfig: OpenCodeConfig,
  updates: Array<{
    jsonPath: Array<string | number>;
    data: unknown;
  }>,
  showToast: (toast: NIMSyncToast) => void,
  options: {
    validate?: boolean;
    lockReleaseFn?: (() => Promise<void>) | null;
  } = {},
): Promise<void> => {
  let releaseLockFn: (() => Promise<void>) | null = null;
  if (!options.lockReleaseFn) {
    try {
      releaseLockFn = await acquireLock("nim-config-update");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown";
      console.error("[NIM-Sync] Config lock failed:", msg);
      showToast({
        title: "NVIDIA Config Lock Failed",
        message: msg,
        variant: "error",
      });
      throw e;
    }
  }

  try {
    if (options.validate !== false) {
      const validation = validateOpenCodeConfig(updatedConfig);
      if (!validation.valid) {
        throw new Error(
          "Config validation failed: " + (validation.errors ?? []).join("; "),
        );
      }
    }
    await updateJSONCPaths(configPath, updates, {
      backup: true,
      createBackupDir: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown";
    console.error("[NIM-Sync] Config update failed:", msg);
    showToast({
      title: "NVIDIA Config Update Failed",
      message: msg,
      variant: "error",
    });
    throw e;
  } finally {
    if (releaseLockFn) {
      try {
        await releaseLockFn();
      } catch (e) {
        console.error("[NIM-Sync] Failed to release config lock:", e);
      }
    }
  }
};

export const removeManagedRefreshCommand = async (
  showToast: (toast: NIMSyncToast) => void,
): Promise<boolean> => {
  let lockReleaseFn: (() => Promise<void>) | null = null;
  try {
    lockReleaseFn = await acquireLock("nim-config-update");
    const configPath = await getConfigFilePath();
    let config: OpenCodeConfig;
    try {
      config = await readJSONC<OpenCodeConfig>(configPath, isValidOpenCodeConfig);
    } catch (error) {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        config = {} as OpenCodeConfig;
      } else {
        throw error;
      }
    }
    const cleanup = getManagedRefreshCommandCleanup(config || {});

    if (!cleanup.removed) {
      return false;
    }

    const updatedConfig: OpenCodeConfig = {
      ...(config || {}),
    };

    if (cleanup.command) {
      updatedConfig.command = cleanup.command;
    } else {
      delete updatedConfig.command;
    }

    await persistManagedConfigUpdates(
      configPath,
      updatedConfig,
      cleanup.updates,
      showToast,
      { lockReleaseFn },
    );

    return true;
  } finally {
    if (lockReleaseFn) {
      try {
        await lockReleaseFn();
      } catch (e) {
        console.error("[NIM-Sync] Failed to release config lock:", e);
      }
    }
  }
};

const runRefreshModels = async (
  force: boolean,
  source: RefreshSource,
  showToast: (toast: NIMSyncToast) => void,
  getAPIKey: () => Promise<string | null>,
  shouldRefresh: () => Promise<boolean>,
  updateConfig: (
    models: NIMModel[],
    probeResults?: Record<string, ProbeResult>,
  ) => Promise<boolean>,
  refreshInProgressRef: { current: boolean },
): Promise<NIMSyncRefreshResult> => {
  if (refreshInProgressRef.current) {
    if (source === "manual") {
      showToast({
        title: "NVIDIA Refresh In Progress",
        message: "A model refresh is already running.",
        variant: "info",
      });
    }
    return "in-progress";
  }
  refreshInProgressRef.current = true;
  let apiKey: string | null = null;
  try {
    await removeManagedRefreshCommand(showToast);
    if (!force && !(await shouldRefresh())) return "skipped";
    apiKey = await getAPIKey();
    if (!apiKey) {
      showToast({
        title: "NVIDIA API Key Required",
        message: "Run /connect to add your NVIDIA API key",
        variant: "error",
      });
      return "missing-api-key";
    }
    const models = await fetchModels(apiKey);
    if (models.length === 0) {
      showToast({
        title: "No Models Available",
        message: "NVIDIA API returned no models.",
        variant: "error",
      });
      return "failed";
    }
    const existingProbeResults = (await readCache())?.probeResults;
    let probeResults: Record<string, ProbeResult> | undefined;
    try {
      probeResults = await probeModels(models, apiKey, existingProbeResults);
    } catch {
      // probe failures are non-fatal
    }
    const changed = await updateConfig(models, probeResults);
    if (changed) {
      showToast({
        title: "NVIDIA NIM Models Updated",
        message: models.length + " models synchronized",
        variant: "success",
      });
      return "updated";
    } else if (source === "manual") {
      showToast({
        title: "NVIDIA NIM Already Up To Date",
        message: "No model changes found.",
        variant: "info",
      });
    }
    return "unchanged";
  } catch (error) {
    const msg = sanitizeErrorMessage(
      error instanceof Error ? error.message : "Unknown error",
      apiKey,
    );
    console.error("[NIM-Sync] Model refresh failed:", msg);
    showToast({
      title: "NVIDIA Sync Failed",
      message: msg,
      variant: "error",
    });
    try {
      await writeCache(
        {
          modelsHash: "",
          lastRefresh: Date.now(),
          lastError: msg,
          baseURL: NIM_BASE_URL,
        },
        showToast,
      );
    } catch {
      /* non-fatal */
    }
    return "failed";
  } finally {
    refreshInProgressRef.current = false;
  }
};

export function createNIMSyncService(
  optionsRef: { current: NIMSyncServiceOptions },
): NIMSyncService {
  const refreshInProgressRef = { current: false };
  const lastManualRefreshRef = { current: 0 };

  const showToast = (toast: NIMSyncToast): void => {
    void Promise.resolve(optionsRef.current.showToast?.(toast)).catch(() => {});
  };

  const getAPIKey = async (): Promise<string | null> => {
    try {
      const auth = await readJSONC<AuthConfig>(getAuthPath());
      if (!auth || Object.keys(auth).length === 0) {
        return process.env.NVIDIA_API_KEY || null;
      }
      if (
        auth.credentials?.nim?.apiKey &&
        typeof auth.credentials.nim.apiKey === "string"
      ) {
        return auth.credentials.nim.apiKey;
      }
      return process.env.NVIDIA_API_KEY || null;
    } catch (error) {
      console.error(
        "[NIM-Sync] Failed to read auth:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return process.env.NVIDIA_API_KEY || null;
    }
  };

  const shouldRefresh = async (): Promise<boolean> => {
    try {
      const config = await (optionsRef.current.getConfigSnapshot?.() ??
        defaultGetConfigSnapshot());
      if (!config?.provider?.nim) return true;
      const cache = await readCache();
      if (!cache?.lastRefresh) return true;
      if (cache.lastError && cache.modelsHash === "") return true;
      return Date.now() - cache.lastRefresh > CACHE_TTL_MS;
    } catch {
      return true;
    }
  };

  const getNextRefreshDelay = async (): Promise<number> => {
    try {
      const config = await (optionsRef.current.getConfigSnapshot?.() ??
        defaultGetConfigSnapshot());
      if (!config?.provider?.nim) {
        return 0;
      }

      const cache = await readCache();
      if (!cache?.lastRefresh) {
        return 0;
      }

      return Math.max(0, CACHE_TTL_MS - (Date.now() - cache.lastRefresh));
    } catch {
      return 0;
    }
  };

  const updateConfig = async (
    models: NIMModel[],
    probeResults?: Record<string, ProbeResult>,
  ): Promise<boolean> => {
    let lockReleaseFn: (() => Promise<void>) | null = null;
    try {
      lockReleaseFn = await acquireLock("nim-config-update");
      const configPath = await getConfigFilePath();
      let config: OpenCodeConfig;
      try {
        config = await readJSONC<OpenCodeConfig>(configPath, isValidOpenCodeConfig);
      } catch (error) {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          config = {} as OpenCodeConfig;
        } else {
          throw error;
        }
      }

      const oldModels = config?.provider?.nim?.models;
      const fetchedIds = new Set(models.map((m) => m.id));

      if (oldModels) {
        for (const [id, entry] of Object.entries(oldModels)) {
          if (!fetchedIds.has(id) && entry?.options && Object.keys(entry.options).length > 0) {
            showToast({
              title: "Model Removed",
              message: `Model "${id}" was removed from NVIDIA API. Custom options for this model were discarded.`,
              variant: "info",
            });
          }
        }
      }

      const baseModels = models.reduce(
        (acc, m) => {
          acc[m.id] = {
            name: m.name,
            options: config?.provider?.nim?.models?.[m.id]?.options || {},
          };
          return acc;
        },
        {} as Record<string, { name: string; options: Record<string, unknown> }>,
      );
      const modelsHash = hashModels(models);
      const cache = await readCache();
      const refreshCommandCleanup = getManagedRefreshCommandCleanup(config || {});

      const noProbeModels = baseModels;
      const managedConfigChanged = !managedNIMConfigMatches(
        config?.provider?.nim,
        {
          ...config?.provider?.nim,
          npm: "@ai-sdk/openai-compatible",
          name: "NVIDIA NIM",
          options: {
            ...config?.provider?.nim?.options,
            baseURL: NIM_BASE_URL,
          },
          models: noProbeModels,
        },
      );
      const managedCommandChanged = refreshCommandCleanup.removed;

      if (
        cache?.modelsHash === modelsHash &&
        !managedConfigChanged &&
        !managedCommandChanged
      ) {
        try {
          await writeCache({
            ...cache,
            lastRefresh: Date.now(),
            modelsHash,
            baseURL: NIM_BASE_URL,
            probeResults: probeResults ?? cache?.probeResults,
          }, showToast);
        } catch {
          /* non-fatal */
        }
        return false;
      }

      const newModels = models.reduce(
        (acc, m) => {
          const existingOptions =
            config?.provider?.nim?.models?.[m.id]?.options || {};
          const probe = probeResults?.[m.id];
          acc[m.id] = {
            name: m.name,
            options: probe
              ? {
                  ...existingOptions,
                  nimProbeChatCapable: probe.chatCapable,
                  nimProbeReasoning: probe.reasoning,
                  nimProbeLatencyMs: probe.latencyMs,
                }
              : existingOptions,
          };
          return acc;
        },
        {} as Record<string, { name: string; options: Record<string, unknown> }>,
      );

      const updatedNIMConfig: NonNullable<OpenCodeConfig["provider"]>["nim"] = {
        ...config?.provider?.nim,
        npm: "@ai-sdk/openai-compatible",
        name: "NVIDIA NIM",
        options: {
          ...config?.provider?.nim?.options,
          baseURL: NIM_BASE_URL,
        },
        models: newModels,
      };

      const updatedConfig: OpenCodeConfig = {
        ...(config || {}),
        provider: { ...config?.provider, nim: updatedNIMConfig },
      };

      if (refreshCommandCleanup.command) {
        updatedConfig.command = refreshCommandCleanup.command;
      } else {
        delete updatedConfig.command;
      }

      await persistManagedConfigUpdates(
        configPath,
        updatedConfig,
        [
          { jsonPath: ["provider", "nim"], data: updatedNIMConfig },
          ...refreshCommandCleanup.updates,
        ],
        showToast,
        { lockReleaseFn },
      );
      try {
        await writeCache({
          lastRefresh: Date.now(),
          modelsHash,
          baseURL: NIM_BASE_URL,
          probeResults: probeResults ?? cache?.probeResults,
        }, showToast);
      } catch {
        /* non-fatal */
      }
      return true;
    } finally {
      if (lockReleaseFn) {
        try {
          await lockReleaseFn();
        } catch (e) {
          console.error("[NIM-Sync] Failed to release config lock:", e);
        }
      }
    }
  };

  const refreshModels = async (
    force = false,
  ): Promise<NIMSyncRefreshResult> => {
    return runRefreshModels(
      force,
      "background",
      showToast,
      getAPIKey,
      shouldRefresh,
      updateConfig,
      refreshInProgressRef,
    );
  };

  const manualRefresh = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastManualRefreshRef.current < MIN_MANUAL_REFRESH_INTERVAL_MS) {
      const remainingSeconds = Math.ceil(
        (MIN_MANUAL_REFRESH_INTERVAL_MS - (now - lastManualRefreshRef.current)) / 1000,
      );
      showToast({
        title: "Rate Limited",
        message:
          "Please wait " + remainingSeconds + "s before refreshing again",
        variant: "info",
      });
      return;
    }
    const result = await runRefreshModels(
      true,
      "manual",
      showToast,
      getAPIKey,
      shouldRefresh,
      updateConfig,
      refreshInProgressRef,
    );
    if (result === "updated" || result === "unchanged" || result === "failed") {
      lastManualRefreshRef.current = now;
    }
  };

  return {
    getAPIKey,
    getNextRefreshDelay,
    updateConfig,
    refreshModels,
    manualRefresh,
    shouldRefresh,
  };
}

let sharedService: NIMSyncService | null = null;
const mutableOptionsRef: { current: NIMSyncServiceOptions } = { current: {} };

export function getOrCreateNIMSyncService(
  options: NIMSyncServiceOptions = {},
): NIMSyncService {
  const currentOptions = mutableOptionsRef.current;
  
  let showToast = currentOptions.showToast;
  if (options.showToast) {
    if (showToast) {
      const prevShowToast = showToast;
      const nextShowToast = options.showToast;
      showToast = (toast) => {
        prevShowToast(toast);
        nextShowToast(toast);
      };
    } else {
      showToast = options.showToast;
    }
  }

  mutableOptionsRef.current = {
    getConfigSnapshot: options.getConfigSnapshot ?? currentOptions.getConfigSnapshot,
    showToast,
  };

  if (!sharedService) {
    sharedService = createNIMSyncService(mutableOptionsRef);
  }
  return sharedService;
}

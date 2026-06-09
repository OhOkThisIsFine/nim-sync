import path from "path";
import type {
  NIMModel,
  OpenCodeConfig,
  AuthConfig,
  ProbeResult,
  NIMSyncToast,
} from "../types/index.js";
import { NVIDIAApiError } from "../types/index.js";
import { validateOpenCodeConfig, isValidOpenCodeConfig } from "../types/schema.js";
import { withRetry, type RetryOptions } from "../lib/retry.js";
import { readJSONC, updateJSONCPaths } from "../lib/jsonc-utils.js";
import { acquireLock } from "../lib/file-lock.js";
import {
  getConfigFilePath,
  getDataDir,
  API_TIMEOUT_MS,
  CACHE_TTL_MS,
  MIN_MANUAL_REFRESH_INTERVAL_MS,
} from "../lib/config-path.js";
import {
  NIM_REFRESH_COMMAND_DESCRIPTION,
  NIM_REFRESH_COMMAND_NAME,
  NIM_REFRESH_COMMAND_TEMPLATE,
} from "./nim-refresh-command.js";
import { hashModels } from "../lib/crypto-utils.js";
import { validateAPIResponse } from "../lib/model-utils.js";
import { readCache, writeCache } from "../lib/nim-cache.js";

const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CONCURRENCY = 10;

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

const getAuthPath = (): string => path.join(getDataDir(), "auth.json");

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

export const fetchModels = async (
  apiKey: string,
  retryOptions?: RetryOptions,
): Promise<NIMModel[]> => {
  return withRetry(
    async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      try {
        const response = await fetch(NIM_BASE_URL + "/models", {
          headers: {
            Authorization: "Bearer " + apiKey,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!response.ok)
          throw new NVIDIAApiError(response.status, response.statusText);
        let data: unknown;
        try {
          data = await response.json();
        } catch (e) {
          throw new Error(
            "Failed to parse JSON: " +
              (e instanceof Error ? e.message : "Unknown"),
          );
        }
        return validateAPIResponse(data);
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === "AbortError")
          throw new Error(
            "NVIDIA API request timed out after " +
              API_TIMEOUT_MS / 1000 +
              " seconds",
          );
        throw error;
      }
    },
    {
      maxRetries: 3,
      initialDelay: 1000,
      maxDelay: 10000,
      retryStatusCodes: [429, 500, 502, 503, 504],
      ...retryOptions,
    },
  );
};

const probeModel = async (
  modelId: string,
  apiKey: string,
): Promise<ProbeResult | null> => {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(NIM_BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - start;
    if (response.status === 404 || response.status === 410) {
      return {
        chatCapable: false,
        reasoning: false,
        latencyMs,
        probedAt: Date.now(),
      };
    }
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const usage = body?.usage as Record<string, unknown> | undefined;
    const hasReasoning = usage?.reasoning_tokens !== undefined;
    return {
      chatCapable: true,
      reasoning: hasReasoning,
      latencyMs,
      probedAt: Date.now(),
    };
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
};

const probeModels = async (
  models: NIMModel[],
  apiKey: string,
  existingResults?: Record<string, ProbeResult>,
): Promise<Record<string, ProbeResult>> => {
  const results: Record<string, ProbeResult> = { ...existingResults };
  const toProbe = models.filter((m) => !results[m.id]);
  for (let i = 0; i < toProbe.length; i += PROBE_CONCURRENCY) {
    const batch = toProbe.slice(i, i + PROBE_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((m) => probeModel(m.id, apiKey)),
    );
    for (let j = 0; j < batch.length; j++) {
      if (batchResults[j]) {
        results[batch[j].id] = batchResults[j]!;
      }
    }
  }
  return results;
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
  } = {},
): Promise<void> => {
  let releaseLockFn: (() => Promise<void>) | null = null;
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

const removeManagedRefreshCommand = async (
  showToast: (toast: NIMSyncToast) => void,
): Promise<boolean> => {
  const configPath = await getConfigFilePath();
  const config = await readJSONC<OpenCodeConfig>(configPath, isValidOpenCodeConfig);
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
    { validate: false },
  );

  return true;
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
    const configPath = await getConfigFilePath();
    const config = await readJSONC<OpenCodeConfig>(configPath, isValidOpenCodeConfig);

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
  mutableOptionsRef.current = options;
  if (!sharedService) {
    sharedService = createNIMSyncService(mutableOptionsRef);
  }
  return sharedService;
}

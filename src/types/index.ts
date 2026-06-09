export interface NIMModel {
  id: string;
  name: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

export interface ProbeResult {
  chatCapable: boolean;
  reasoning: boolean;
  latencyMs: number;
  probedAt: number;
}

export interface NIMApiResponse {
  data: NIMModel[];
}

export interface AuthConfig {
  credentials?: {
    nim?: {
      apiKey?: string;
    };
  };
}

export interface LockMetadata {
  pid: number;
  timestamp: number;
}

export interface OpenCodeConfig {
  $schema?: string;
  command?: Record<
    string,
    {
      template: string;
      description?: string;
      agent?: string;
      model?: string;
      subtask?: boolean;
    }
  >;
  provider?: {
    nim?: {
      npm?: string;
      name?: string;
      options?: {
        baseURL?: string;
      };
      models?: Record<
        string,
        { name: string; options?: Record<string, unknown> }
      >;
    };
  };
  model?: string;
  small_model?: string;
  [key: string]: unknown;
}

export interface CacheData {
  lastRefresh?: number;
  modelsHash: string;
  lastError?: string;
  baseURL?: string;
  probeResults?: Record<string, ProbeResult>;
}

export interface PluginAPI {
  config: {
    get: <T = unknown>(key?: string) => T;
    set: (key: string, value: unknown) => Promise<void>;
  };
  tui: {
    toast: {
      show: (options: {
        title: string;
        description?: string;
        variant?: "default" | "destructive" | "success" | "error";
      }) => void;
    };
  };
  command: {
    register: (
      name: string,
      handler: () => Promise<void> | void,
      options?: { description: string },
    ) => void;
    execute: (name: string) => Promise<void>;
  };
  client?: {
    app: {
      log: (log: {
        body: {
          service: string;
          level: "debug" | "info" | "warn" | "error";
          message: string;
          extra?: Record<string, unknown>;
        };
      }) => Promise<void>;
    };
  };
}

export type Plugin = (api: PluginAPI) =>
  | Promise<{
      init?: () => Promise<void>;
      [key: string]: unknown;
    }>
  | {
      init?: () => Promise<void>;
      [key: string]: unknown;
    };

/**
 * Custom error for NVIDIA API failures.
 */
export class NVIDIAApiError extends Error {
  constructor(
    public statusCode: number,
    public statusText: string,
  ) {
    super(`NVIDIA API error: ${statusCode} ${statusText}`);
    this.name = "NVIDIAApiError";
  }
}

/**
 * Platform-specific directory paths for OpenCode.
 */
export interface NIMSyncToast {
  title: string;
  message: string;
  variant: "info" | "success" | "error";
}

export interface PlatformPaths {
  config: string;
  data: string;
  cache: string;
}

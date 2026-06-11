import type { NIMModel, ProbeResult } from "../types/index.js";
import { NVIDIAApiError } from "../types/index.js";
import { withRetry, type RetryOptions } from "./retry.js";
import { API_TIMEOUT_MS } from "./config-path.js";
import { validateAPIResponse } from "./model-utils.js";

export const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const PROBE_TIMEOUT_MS = 5_000;
export const PROBE_CONCURRENCY = 10;

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

export const probeModel = async (
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

export const probeModels = async (
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

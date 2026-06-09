import type { OpenCodeConfig } from "./index.js";

/**
 * Validates OpenCode configuration against schema.
 *
 * @param config - Configuration object to validate
 * @returns Validation result with errors if any
 */
export function validateOpenCodeConfig(config: unknown): {
  valid: boolean;
  errors?: string[];
} {
  if (typeof config !== "object" || config === null) {
    return { valid: false, errors: ["Configuration must be an object"] };
  }

  const typedConfig = config as Record<string, unknown>;
  const errors: string[] = [];

  // Validate provider structure if present
  if (typedConfig.provider && typeof typedConfig.provider === "object") {
    const provider = typedConfig.provider as Record<string, unknown>;

    if (provider.nim && typeof provider.nim === "object") {
      const nim = provider.nim as Record<string, unknown>;

        // Check required fields
        if (typeof nim.npm !== "string") {
          errors.push("provider.nim.npm must be a string");
        }
        if (typeof nim.name !== "string") {
          errors.push("provider.nim.name must be a string");
        }

        // Validate baseURL format if present
        if (nim.options && typeof nim.options === "object") {
          const nimOptions = nim.options as Record<string, unknown>;
          if (nimOptions.baseURL !== undefined) {
            if (typeof nimOptions.baseURL !== "string") {
              errors.push("provider.nim.options.baseURL must be a string");
            } else {
              try {
                const url = new URL(nimOptions.baseURL as string);
                if (url.protocol !== "https:" && url.protocol !== "http:") {
                  errors.push(
                    "provider.nim.options.baseURL must use http: or https: protocol",
                  );
                }
              } catch {
                errors.push(
                  "provider.nim.options.baseURL must be a valid URL",
                );
              }
            }
          }
        }

      // Validate models structure if present
      if (nim.models && typeof nim.models === "object") {
        const models = nim.models as Record<string, unknown>;
        for (const [modelId, modelData] of Object.entries(models)) {
          if (typeof modelData !== "object" || modelData === null) {
            errors.push(`provider.nim.models.${modelId} must be an object`);
          } else {
            const model = modelData as Record<string, unknown>;
            if (typeof model.name !== "string") {
              errors.push(
                `provider.nim.models.${modelId}.name must be a string`,
              );
            }
          }
        }
      }
    }
  }

  // Validate model fields
  if (
    typedConfig.model !== undefined &&
    typeof typedConfig.model !== "string"
  ) {
    errors.push("model must be a string if provided");
  }

  if (
    typedConfig.small_model !== undefined &&
    typeof typedConfig.small_model !== "string"
  ) {
    errors.push("small_model must be a string if provided");
  }

  // Validate command section structure
  if (typedConfig.command !== undefined) {
    if (typeof typedConfig.command !== "object" || typedConfig.command === null) {
      errors.push("command must be an object if provided");
    } else {
      const command = typedConfig.command as Record<string, unknown>;
      for (const [cmdName, cmdValue] of Object.entries(command)) {
        if (typeof cmdValue !== "object" || cmdValue === null) {
          errors.push(`command.${cmdName} must be an object`);
        } else {
          const cmdObj = cmdValue as Record<string, unknown>;
          if (typeof cmdObj.template !== "string") {
            errors.push(`command.${cmdName}.template must be a string`);
          }
          if (cmdObj.description !== undefined && typeof cmdObj.description !== "string") {
            errors.push(`command.${cmdName}.description must be a string if provided`);
          }
          if (cmdObj.agent !== undefined && typeof cmdObj.agent !== "string") {
            errors.push(`command.${cmdName}.agent must be a string if provided`);
          }
          if (cmdObj.model !== undefined && typeof cmdObj.model !== "string") {
            errors.push(`command.${cmdName}.model must be a string if provided`);
          }
          if (cmdObj.subtask !== undefined && typeof cmdObj.subtask !== "boolean") {
            errors.push(`command.${cmdName}.subtask must be a boolean if provided`);
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export function isValidOpenCodeConfig(data: unknown): data is OpenCodeConfig {
  return validateOpenCodeConfig(data).valid;
}

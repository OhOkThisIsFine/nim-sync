import { describe, it, expect } from "vitest";
import { validateOpenCodeConfig, isValidOpenCodeConfig } from "../types/schema.js";
import { readJSONC } from "../lib/jsonc-utils.js";
import fs from "fs/promises";
import path from "path";
import os from "os";

describe("validateOpenCodeConfig", () => {
  it("validates correct config structure", () => {
    const config = {
      provider: {
        nim: {
          npm: "@ai-sdk/openai-compatible",
          name: "NVIDIA NIM",
          options: { baseURL: "https://api.nvidia.com" },
          models: {
            "model-1": { name: "Model 1", options: {} },
          },
        },
      },
      model: "model-1",
      small_model: "model-2",
    };

    const result = validateOpenCodeConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("reports missing npm field", () => {
    const config = {
      provider: {
        nim: {
          name: "NVIDIA NIM",
        },
      },
    };

    const result = validateOpenCodeConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("provider.nim.npm must be a string");
  });

  it("reports missing name field", () => {
    const config = {
      provider: {
        nim: {
          npm: "@ai-sdk/openai-compatible",
        },
      },
    };

    const result = validateOpenCodeConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("provider.nim.name must be a string");
  });

  it("reports invalid model structure", () => {
    const config = {
      provider: {
        nim: {
          npm: "@ai-sdk/openai-compatible",
          name: "NVIDIA NIM",
          models: {
            "model-1": { options: {} }, // missing name
          },
        },
      },
    };

    const result = validateOpenCodeConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "provider.nim.models.model-1.name must be a string",
    );
  });

  it("accepts config without provider", () => {
    const config = {
      model: "model-1",
    };

    const result = validateOpenCodeConfig(config);
    expect(result.valid).toBe(true);
  });

  it("accepts config without nim provider", () => {
    const config = {
      provider: {
        other: { some: "value" },
      },
    };

    const result = validateOpenCodeConfig(config);
    expect(result.valid).toBe(true);
  });

  it("reports invalid model field type", () => {
    const config = {
      model: 123, // should be string
    };

    const result = validateOpenCodeConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("model must be a string if provided");
  });

  it("reports invalid small_model field type", () => {
    const config = {
      small_model: ["model-1"], // should be string
    };

    const result = validateOpenCodeConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("small_model must be a string if provided");
  });

  it("rejects non-object config", () => {
    expect(validateOpenCodeConfig(null).valid).toBe(false);
    expect(validateOpenCodeConfig("string").valid).toBe(false);
    expect(validateOpenCodeConfig(123).valid).toBe(false);
  });

  it("reports error for non-string baseURL", () => {
    const config = {
      provider: {
        nim: {
          npm: "@ai-sdk/openai-compatible",
          name: "NVIDIA NIM",
          options: {
            baseURL: 123,
          },
        },
      },
    };

    const result = validateOpenCodeConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "provider.nim.options.baseURL must be a string",
    );
  });

  it("reports error for malformed baseURL", () => {
    const config = {
      provider: {
        nim: {
          npm: "@ai-sdk/openai-compatible",
          name: "NVIDIA NIM",
          options: {
            baseURL: "not-a-valid-url",
          },
        },
      },
    };

    const result = validateOpenCodeConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "provider.nim.options.baseURL must be a valid URL",
    );
  });

  it("reports error for non-http baseURL protocol", () => {
    const config = {
      provider: {
        nim: {
          npm: "@ai-sdk/openai-compatible",
          name: "NVIDIA NIM",
          options: {
            baseURL: "ftp://malicious.example.com",
          },
        },
      },
    };

    const result = validateOpenCodeConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "provider.nim.options.baseURL must use http: or https: protocol",
    );
  });

  it("accepts valid https baseURL", () => {
    const config = {
      provider: {
        nim: {
          npm: "@ai-sdk/openai-compatible",
          name: "NVIDIA NIM",
          options: {
            baseURL: "https://integrate.api.nvidia.com/v1",
          },
        },
      },
    };

    const result = validateOpenCodeConfig(config);
    expect(result.valid).toBe(true);
  });

  it("reports error when model is null", () => {
    const config = {
      provider: {
        nim: {
          npm: "@ai-sdk/openai-compatible",
          name: "NVIDIA NIM",
          models: {
            "model-1": null, // model is null instead of object
          },
        },
      },
    };

    const result = validateOpenCodeConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "provider.nim.models.model-1 must be an object",
    );
  });

  it("reports error when model is a primitive value", () => {
    const config = {
      provider: {
        nim: {
          npm: "@ai-sdk/openai-compatible",
          name: "NVIDIA NIM",
          models: {
            "model-1": "just-a-string", // should be an object
          },
        },
      },
    };

    const result = validateOpenCodeConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "provider.nim.models.model-1 must be an object",
    );
  });

  describe("accepts extra top-level properties (COR-272b94bd)", () => {
    it("accepts config with extra top-level properties", () => {
      const result = validateOpenCodeConfig({ model: "m", agent: "a", subagent: "b", verbose: true });
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it("still validates provider structure even with extra properties", () => {
      const validResult = validateOpenCodeConfig({ agent: "a", provider: { nim: { npm: "@ai-sdk/openai-compatible", name: "NVIDIA NIM" } } });
      expect(validResult.valid).toBe(true);

      const invalidResult = validateOpenCodeConfig({ agent: "a", provider: { nim: { name: "NVIDIA NIM" } } });
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors).toContain("provider.nim.npm must be a string");
    });
  });

  describe("command section validation (DAT-20b948f7)", () => {
    it("validates well-formed command section", () => {
      const config = {
        command: {
          "my-cmd": { template: "do something" },
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(true);
    });

    it("rejects command entry missing template", () => {
      const config = {
        command: {
          "my-cmd": { description: "no template" },
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "command.my-cmd.template must be a string",
      );
    });

    it("rejects command entry with non-string template", () => {
      const config = {
        command: {
          "my-cmd": { template: 123 },
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "command.my-cmd.template must be a string",
      );
    });

    it("rejects command entry with non-string description", () => {
      const config = {
        command: {
          "my-cmd": { template: "do", description: 123 },
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "command.my-cmd.description must be a string if provided",
      );
    });

    it("rejects command entry with non-string agent", () => {
      const config = {
        command: {
          "my-cmd": { template: "do", agent: 123 },
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "command.my-cmd.agent must be a string if provided",
      );
    });

    it("rejects command entry with non-string model", () => {
      const config = {
        command: {
          "my-cmd": { template: "do", model: 123 },
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "command.my-cmd.model must be a string if provided",
      );
    });

    it("rejects command entry with non-boolean subtask", () => {
      const config = {
        command: {
          "my-cmd": { template: "do", subtask: "yes" },
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "command.my-cmd.subtask must be a boolean if provided",
      );
    });

    it("rejects non-object command entry", () => {
      const config = {
        command: {
          "my-cmd": null,
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("command.my-cmd must be an object");
    });

    it("rejects command entry that is a string", () => {
      const config = {
        command: {
          "my-cmd": "just-a-string",
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("command.my-cmd must be an object");
    });

    it("accepts command section with all optional fields omitted", () => {
      const config = {
        command: {
          "my-cmd": { template: "do" },
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(true);
    });

    it("accepts config without command section", () => {
      const config = { model: "model-1" };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(true);
    });
  });

  describe("isValidOpenCodeConfig (DAT-57c74c09)", () => {
    it("returns true for valid config", () => {
      const validConfig = {
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
          },
        },
        model: "model-1",
      };
      expect(isValidOpenCodeConfig(validConfig)).toBe(true);
    });

    it("returns false for invalid config", () => {
      const invalidConfig = {
        provider: {
          nim: {
            name: "NVIDIA NIM",
          },
        },
      };
      expect(isValidOpenCodeConfig(invalidConfig)).toBe(false);
    });

    it("returns false for non-object input", () => {
      expect(isValidOpenCodeConfig(null)).toBe(false);
      expect(isValidOpenCodeConfig("string")).toBe(false);
    });

    it("throws when used as readJSONC validator on corrupt data", async () => {
      const tmpDir = path.join(os.tmpdir(), "nim-sync-test-" + Date.now());
      const tmpFile = path.join(tmpDir, "corrupt-config.json");
      await fs.mkdir(tmpDir, { recursive: true });
      const corruptContent = '{ "provider": { "nim": { "name": "NVIDIA NIM" } } }';
      await fs.writeFile(tmpFile, corruptContent, "utf-8");
      try {
        await expect(
          readJSONC(tmpFile, isValidOpenCodeConfig),
        ).rejects.toThrow("Invalid data structure");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("passes readJSONC validation for valid config", async () => {
      const tmpDir = path.join(os.tmpdir(), "nim-sync-test-" + Date.now());
      const tmpFile = path.join(tmpDir, "valid-config.json");
      await fs.mkdir(tmpDir, { recursive: true });
      const validContent = '{ "model": "m" }';
      await fs.writeFile(tmpFile, validContent, "utf-8");
      try {
        const result = await readJSONC(tmpFile, isValidOpenCodeConfig);
        expect(result).toEqual({ model: "m" });
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns empty object for missing file (ENOENT)", async () => {
      const result = await readJSONC(
        path.join(os.tmpdir(), "nim-sync-nonexistent-" + Date.now(), "no-file.json"),
        isValidOpenCodeConfig,
      );
      expect(result).toEqual({});
    });
  });

  describe("edge case coverage (TST-f829936a)", () => {
    it("validates config with empty provider object", () => {
      const config = { provider: {} };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(true);
    });

    it("validates config with non-object models string", () => {
      const config = {
        provider: {
          nim: { npm: "a", name: "b", models: "not-an-object" },
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(true);
    });

    it("validates config with non-object models number", () => {
      const config = {
        provider: {
          nim: { npm: "a", name: "b", models: 42 },
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(true);
    });

    it("accepts baseURL with leading whitespace (runtime trims)", () => {
      // Node.js URL constructor normalizes leading whitespace, so this is accepted
      const config = {
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            options: { baseURL: " https://api.nvidia.com" },
          },
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(true);
    });

    it("rejects empty baseURL string", () => {
      const config = {
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            options: { baseURL: "" },
          },
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "provider.nim.options.baseURL must be a valid URL",
      );
    });

    it("validates provider structure without nim section", () => {
      const config = { provider: { otherField: "value" } };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(true);
    });

    it("validates config with deeply nested models", () => {
      const config = {
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            models: {
              "model-1": { name: "Model 1", extraNested: { foo: "bar" } },
            },
          },
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(true);
    });

    it("rejects model entry missing name string in deeply nested models", () => {
      const config = {
        provider: {
          nim: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            models: {
              "model-1": { extraNested: { foo: "bar" } },
            },
          },
        },
      };
      const result = validateOpenCodeConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "provider.nim.models.model-1.name must be a string",
      );
    });
  });
});

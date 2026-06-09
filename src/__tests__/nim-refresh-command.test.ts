import { describe, it, expect, vi } from "vitest";
import {
  isNIMRefreshSlashCommand,
  handlePromptSubmit,
} from "../plugin/nim-refresh-command.js";

describe("isNIMRefreshSlashCommand", () => {
  it("returns true for exact command", () => {
    expect(isNIMRefreshSlashCommand("/nim-refresh")).toBe(true);
  });

  it("returns true with leading whitespace", () => {
    expect(isNIMRefreshSlashCommand("  /nim-refresh")).toBe(true);
    expect(isNIMRefreshSlashCommand("\t/nim-refresh")).toBe(true);
  });

  it("returns true for command on first line of multiline input", () => {
    expect(isNIMRefreshSlashCommand("/nim-refresh\n/something-else")).toBe(true);
    expect(isNIMRefreshSlashCommand("/nim-refresh\r\nother stuff")).toBe(true);
  });

  it("returns true for command with trailing arguments", () => {
    expect(isNIMRefreshSlashCommand("/nim-refresh --force")).toBe(true);
  });

  it("returns false for command with extra prefix characters", () => {
    expect(isNIMRefreshSlashCommand("/nim-refresh-extra")).toBe(false);
  });

  it("returns false for unrelated commands", () => {
    expect(isNIMRefreshSlashCommand("/other-command")).toBe(false);
    expect(isNIMRefreshSlashCommand("ship it")).toBe(false);
    expect(isNIMRefreshSlashCommand("")).toBe(false);
  });

  it("returns false when command is not on first line", () => {
    expect(isNIMRefreshSlashCommand("some text\n/nim-refresh")).toBe(false);
  });

  it("returns false for plain text matching the command name", () => {
    expect(isNIMRefreshSlashCommand("nim-refresh")).toBe(false);
  });

  it("returns false for non-string input without throwing", () => {
    expect(isNIMRefreshSlashCommand(undefined as any)).toBe(false);
    expect(isNIMRefreshSlashCommand(null as any)).toBe(false);
    expect(isNIMRefreshSlashCommand(123 as any)).toBe(false);
  });
});

describe("handlePromptSubmit", () => {
  it("returns false when promptRef is undefined", async () => {
    const manualRefresh = vi.fn();
    const result = await handlePromptSubmit(undefined, manualRefresh);
    expect(result).toBe(false);
    expect(manualRefresh).not.toHaveBeenCalled();
  });

  it("returns false when promptRef.current is null", async () => {
    const manualRefresh = vi.fn();
    const promptRef = { current: null as any, reset: vi.fn(), submit: vi.fn() };
    const result = await handlePromptSubmit(promptRef as any, manualRefresh);
    expect(result).toBe(false);
    expect(manualRefresh).not.toHaveBeenCalled();
  });

  it("returns false when promptRef.current is undefined", async () => {
    const manualRefresh = vi.fn();
    const promptRef = { current: undefined, reset: vi.fn(), submit: vi.fn() };
    const result = await handlePromptSubmit(promptRef as any, manualRefresh);
    expect(result).toBe(false);
    expect(manualRefresh).not.toHaveBeenCalled();
  });

  it("calls submit and returns false for non-NIM slash command", async () => {
    const manualRefresh = vi.fn();
    const submit = vi.fn();
    const reset = vi.fn();
    const promptRef = {
      current: { input: "/help" },
      reset,
      submit,
    };
    const result = await handlePromptSubmit(promptRef as any, manualRefresh);
    expect(result).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    expect(manualRefresh).not.toHaveBeenCalled();
  });

  it("resets, calls manualRefresh, and returns true for NIM refresh command", async () => {
    const manualRefresh = vi.fn().mockResolvedValue(undefined);
    const submit = vi.fn();
    const reset = vi.fn();
    const promptRef = {
      current: { input: "/nim-refresh" },
      reset,
      submit,
    };
    const result = await handlePromptSubmit(promptRef as any, manualRefresh);
    expect(result).toBe(true);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(manualRefresh).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it("returns false for plain text input (not a slash command)", async () => {
    const manualRefresh = vi.fn();
    const submit = vi.fn();
    const reset = vi.fn();
    const promptRef = {
      current: { input: "hello" },
      reset,
      submit,
    };
    const result = await handlePromptSubmit(promptRef as any, manualRefresh);
    expect(result).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(manualRefresh).not.toHaveBeenCalled();
  });

  it("propagates error when manualRefresh rejects", async () => {
    const testError = new Error("Refresh failed");
    const manualRefresh = vi.fn().mockRejectedValue(testError);
    const submit = vi.fn();
    const reset = vi.fn();
    const promptRef = {
      current: { input: "/nim-refresh" },
      reset,
      submit,
    };
    await expect(
      handlePromptSubmit(promptRef as any, manualRefresh),
    ).rejects.toThrow(testError);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

import type { TuiPromptRef } from "@opencode-ai/plugin/tui";

export const NIM_REFRESH_COMMAND_NAME = "nim-refresh";
export const NIM_REFRESH_COMMAND_DESCRIPTION = "Refresh NVIDIA NIM models";
export const NIM_REFRESH_COMMAND_TEMPLATE =
  "The /nim-refresh command triggers the nim-sync plugin to refresh the NVIDIA NIM model catalog. After it runs, reply with a short confirmation only.";
export const NIM_REFRESH_TUI_COMMAND_VALUE = "nim.refresh";
export const PROMPT_SUBMIT_COMMAND_VALUE = "prompt.submit";

type PromptSubmitRef = Pick<TuiPromptRef, "current" | "reset" | "submit">;

export const isNIMRefreshSlashCommand = (input: string): boolean => {
  if (typeof input !== "string") return false;
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) {
    return false;
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0];
  const command = firstLine.split(" ")[0]?.slice(1);

  return command === NIM_REFRESH_COMMAND_NAME;
};

export const handlePromptSubmit = async (
  promptRef: PromptSubmitRef | undefined,
  manualRefresh: () => Promise<void>,
): Promise<boolean> => {
  if (!promptRef?.current) {
    return false;
  }

  if (!isNIMRefreshSlashCommand(promptRef.current.input)) {
    promptRef.submit();
    return false;
  }

  promptRef.reset();
  await manualRefresh();
  return true;
};

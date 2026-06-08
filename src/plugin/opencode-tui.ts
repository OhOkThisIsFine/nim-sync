import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiPromptRef,
  TuiDialogSelectOption,
} from "@opencode-ai/plugin/tui";
import type { Model } from "@opencode-ai/sdk/v2";
import {
  handlePromptSubmit,
  NIM_REFRESH_COMMAND_DESCRIPTION,
  NIM_REFRESH_COMMAND_NAME,
  NIM_REFRESH_TUI_COMMAND_VALUE,
  PROMPT_SUBMIT_COMMAND_VALUE,
} from "./nim-refresh-command.js";
import { getOrCreateNIMSyncService } from "./nim-sync-service.js";

type PromptRefHolder = {
  current: TuiPromptRef | undefined;
};

type HomePromptSlotProps = {
  workspace_id?: string;
  ref?: (ref: TuiPromptRef | undefined) => void;
};

type SessionPromptSlotProps = {
  session_id: string;
  visible?: boolean;
  disabled?: boolean;
  on_submit?: () => void;
  ref?: (ref: TuiPromptRef | undefined) => void;
};

type ProbeMeta = {
  latencyMs?: number;
  chatCapable?: boolean;
  reasoning?: boolean;
};

const getProbeMeta = (model: Model): ProbeMeta => {
  const opts = model.options as Record<string, unknown> | undefined;
  return {
    latencyMs: opts?.nimProbeLatencyMs as number | undefined,
    chatCapable: opts?.nimProbeChatCapable as boolean | undefined,
    reasoning: opts?.nimProbeReasoning as boolean | undefined,
  };
};

const formatFooter = (model: Model): string => {
  const { latencyMs, chatCapable, reasoning } = getProbeMeta(model);

  const badges: string[] = [];
  if (latencyMs !== undefined) {
    badges.push(`${latencyMs}ms`);
  }
  if (chatCapable !== undefined) {
    badges.push(chatCapable ? "chat" : "no-chat");
  }
  if (reasoning !== undefined) {
    badges.push(reasoning ? "reasoning" : "no-reasoning");
  }
  if (model.status !== "active") {
    badges.push(model.status);
  }
  if (badges.length === 0) {
    return "No probe data";
  }
  return badges.join(" | ");
};

const openModelList = (api: TuiPluginApi): void => {
  const nimProvider = api.state.provider.find((p) => p.id === "nim");
  if (!nimProvider || Object.keys(nimProvider.models).length === 0) {
    api.ui.toast({
      title: "NVIDIA NIM",
      message: "No NIM models configured. Run /nim-refresh first.",
      variant: "warning",
    });
    return;
  }

  const options: TuiDialogSelectOption<string>[] = Object.values(
    nimProvider.models,
  )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((model) => ({
      title: model.name,
      value: model.id,
      description: model.id,
      footer: formatFooter(model),
    }));

  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "NVIDIA NIM Models",
      options,
    }),
  );
};

const bindPromptRef = (
  holder: PromptRefHolder,
  forward?: (ref: TuiPromptRef | undefined) => void,
): ((ref: TuiPromptRef | undefined) => void) => {
  let captured: TuiPromptRef | undefined;

  return (ref) => {
    if (ref) {
      captured = ref;
      holder.current = ref;
    } else if (holder.current === captured) {
      holder.current = undefined;
      captured = undefined;
    }

    forward?.(ref);
  };
};

const tui: TuiPlugin = async (api) => {
  const promptRef: PromptRefHolder = { current: undefined };
  const service = getOrCreateNIMSyncService({
    showToast: ({ title, message, variant }) => {
      api.ui.toast({
        title,
        message,
        variant,
      });
    },
  });

  api.command.register(() => [
    {
      title: NIM_REFRESH_COMMAND_DESCRIPTION,
      value: NIM_REFRESH_TUI_COMMAND_VALUE,
      description: "Force a fresh NVIDIA model sync",
      category: "Plugin",
      slash: {
        name: NIM_REFRESH_COMMAND_NAME,
      },
      onSelect: () => {
        void service.manualRefresh();
      },
    },
    {
      title: "List NIM models with status",
      value: "nim.models",
      description: "View all NIM models with latency and capability info",
      category: "Plugin",
      onSelect: () => {
        openModelList(api);
      },
    },
    {
      title: "Submit prompt",
      value: PROMPT_SUBMIT_COMMAND_VALUE,
      keybind: "input_submit",
      category: "Prompt",
      hidden: true,
      onSelect: () => {
        void handlePromptSubmit(promptRef.current, service.manualRefresh);
      },
    },
  ]);

  api.slots.register({
    order: 1000,
    slots: {
      home_prompt: (_ctx: unknown, props: HomePromptSlotProps) =>
        api.ui.Prompt({
          ref: bindPromptRef(promptRef, props.ref),
          workspaceID: props.workspace_id,
          right: api.ui.Slot({
            name: "home_prompt_right",
            workspace_id: props.workspace_id,
          }),
        }),
      session_prompt: (_ctx: unknown, props: SessionPromptSlotProps) =>
        api.ui.Prompt({
          visible: props.visible,
          ref: bindPromptRef(promptRef, props.ref),
          disabled: props.disabled,
          onSubmit: props.on_submit,
          sessionID: props.session_id,
          right: api.ui.Slot({
            name: "session_prompt_right",
            session_id: props.session_id,
          }),
        }),
    },
  });
};

const plugin: TuiPluginModule = {
  id: "nim-sync",
  tui,
};

export default plugin;

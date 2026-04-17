# OpenCode Local Command Pattern

This plugin uses `/nim-refresh` as the reference implementation for commands that must run locally in the OpenCode desktop/TUI prompt instead of being turned into an LLM prompt.

## Why This Pattern Exists

OpenCode's server-side `command.execute.before` hook can modify prompt parts, but it does not stop the normal prompt submission flow. That means it is useful for prompt shaping, but not for quota-free local actions.

For commands that should execute entirely inside the plugin, we need to intercept prompt submission in the TUI layer.

## The Pattern

1. Register a normal slash command for autocomplete.
2. Register a hidden `prompt.submit` command bound to `input_submit`.
3. Replace the host `home_prompt` and `session_prompt` slots with wrapped `api.ui.Prompt(...)` instances.
4. Capture the prompt ref from those wrapped prompts.
5. On submit:
   - If the input is not the local slash command, call `promptRef.submit()` and let OpenCode continue normally.
   - If the input is the local slash command, call `promptRef.reset()` and run the plugin action directly.

This keeps the command discoverable in slash autocomplete while avoiding any LLM round-trip.

## Files In This Repo

- `src/plugin/opencode-tui.ts`
  Registers the visible slash command, the hidden submit override, and the wrapped prompt slots.
- `src/plugin/nim-refresh-command.ts`
  Holds the command constants plus the reusable prompt-submit interception helper.
- `src/__tests__/opencode-tui.test.ts`
  Regression tests for autocomplete, local handling, and normal prompt fallback.

## Reuse Checklist

For another local command later, follow this checklist:

1. Add a helper module beside `nim-refresh-command.ts` with:
   - the slash command name/value
   - a parser that identifies the slash command from prompt text
   - a submit handler that either runs locally or falls through to `promptRef.submit()`
2. Register the command in `opencode-tui.ts` so it still appears in slash suggestions.
3. Reuse the wrapped prompt approach instead of adding a server-side prompt rewrite.
4. Keep the local action idempotent and fast, because it runs on the input submit path.
5. Add tests for:
   - slash autocomplete visibility
   - local execution path
   - non-command fallback path

## Guardrails

- Do not rely on `command.execute.before` to suppress model usage for local actions.
- Always forward the host prompt props you receive when wrapping prompt slots.
- Keep a normal fallback to `promptRef.submit()` for non-command input.
- Prefer small helper modules so the prompt interception logic stays easy to reason about and reuse.

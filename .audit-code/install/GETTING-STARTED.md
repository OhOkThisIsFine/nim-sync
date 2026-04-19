# audit-code bootstrap guide

The canonical product route is `/audit-code` in conversation.

Canonical installed assets:
- prompt asset: `.audit-code/install/audit-code.import.md`
- skill asset: `.audit-code/install/SKILL.md`

Repo-local slash-command surfaces:
- `.github/prompts/audit-code.prompt.md`
- `.opencode/commands/audit-code.md`
- `.claude/commands/audit-code.md`

Compatibility instruction surfaces:
- `.github/copilot-instructions.md`
- `AGENTS.md`
- `CLAUDE.md`

Host-specific quick starts:
- VS Code: Use the generated VS Code / Copilot prompt surface, then invoke `/audit-code` in chat.
- OpenCode: Use the generated OpenCode command surface so `/audit-code` is available without extra provider flags.
- Claude Code: Use the generated Claude Code command surface so `/audit-code` is available inside the repository without extra provider wiring.
- Claude Desktop: No verified project-local slash-command surface is shipped for Claude Desktop, so use the installed prompt asset as the primary path.
- Antigravity: No verified repo-local slash-command surface is shipped for Antigravity, so start from the installed prompt asset or an Antigravity-managed terminal.

## VS Code

Support level: supported
Setup kind: repo-local-slash-command

Use the generated VS Code / Copilot prompt surface, then invoke `/audit-code` in chat.

Primary repo-local path:
- `.github/prompts/audit-code.prompt.md`

Supporting repo-local paths:
- `.github/copilot-instructions.md`
- `AGENTS.md`

Recommended steps:
- Open this repository in VS Code or GitHub Copilot Chat.
- Invoke `/audit-code` in chat.
- Use the integrated terminal and run `audit-code` only when you intentionally need the repo-local backend fallback.

## OpenCode

Support level: supported
Setup kind: repo-local-slash-command

Use the generated OpenCode command surface so `/audit-code` is available without extra provider flags.

Primary repo-local path:
- `.opencode/commands/audit-code.md`

Supporting repo-local paths:
- `AGENTS.md`

Recommended steps:
- Open this repository in OpenCode.
- Invoke `/audit-code` from the OpenCode command surface.
- Use the repo-local backend wrapper only when you intentionally need the fallback automation path.

## Claude Code

Support level: supported
Setup kind: repo-local-slash-command

Use the generated Claude Code command surface so `/audit-code` is available inside the repository without extra provider wiring.

Primary repo-local path:
- `.claude/commands/audit-code.md`

Supporting repo-local paths:
- `CLAUDE.md`

Recommended steps:
- Open this repository in Claude Code.
- Invoke `/audit-code` from the Claude Code project command surface.
- Use the terminal fallback and run `audit-code` only when you intentionally need the repo-local backend wrapper.

## Claude Desktop

Support level: manual-import
Setup kind: prompt-import

No verified project-local slash-command surface is shipped for Claude Desktop, so use the installed prompt asset as the primary path.

Primary repo-local path:
- `.audit-code/install/audit-code.import.md`

Supporting repo-local paths:
- `CLAUDE.md`

Recommended steps:
- Import the installed prompt asset into Claude Desktop's prompt or instruction surface.
- Invoke `/audit-code` conversationally inside Claude Desktop after the prompt is available.
- If you intentionally need the repo-local backend fallback instead, run `audit-code` from the repository root.

## Antigravity

Support level: manual-import
Setup kind: prompt-import-or-terminal

No verified repo-local slash-command surface is shipped for Antigravity, so start from the installed prompt asset or an Antigravity-managed terminal.

Primary repo-local path:
- `.audit-code/install/audit-code.import.md`

Supporting repo-local paths:
- `AGENTS.md`

Recommended steps:
- Import the installed prompt asset into Antigravity's prompt or instruction surface when that surface is available.
- Invoke `/audit-code` conversationally inside Antigravity.
- If you prefer the backend fallback, run `audit-code` from an Antigravity-managed terminal with `local-subprocess` first.

Backend fallback:
- from the repository root, run `audit-code` only when you intentionally need the repo-local backend wrapper

Hosts still requiring extra handling today:
- claude-desktop: No verified project-local slash-command installation surface is currently shipped for Claude Desktop.
- antigravity: No verified repo-local slash-command installation surface is currently shipped for Antigravity.

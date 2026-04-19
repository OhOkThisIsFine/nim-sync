---
name: audit-code
description: Conversation-first autonomous code auditing workflow for the /audit-code command.
---

# audit-code skill

The canonical entrypoint is `/audit-code` in conversation.

This skill should be treated as a conversational product surface first.

## Primary contract

Normal usage should:

- run from conversation, not from manual shell arguments
- avoid manual paths, provider flags, and model-selection arguments
- advance the audit automatically until it completes or no further automatic progress is possible

Bounded steps are a backend implementation detail, not the intended user experience.

## Embedded Prompt Payload

For IDE-based LLMs (Antigravity, Copilot, Cursor), you can initialize the skill natively by importing the prompt payload defined in `audit-code.prompt.md`.
This provides the LLM an exact instruction set required to natively intercept the state machine blocking phases securely and assume the responsibilities of the execution "worker".

## Repo-local fallback

The repository still exposes a backend CLI wrapper:

```bash
audit-code
```

from the target repository root.

Debug one-step mode:

```bash
audit-code --single-step
```

## Backend mode note

For repo-local backend usage:

- omitted provider remains `local-subprocess`
- `local-subprocess` should stop cleanly once only manual or provider-assisted review remains
- `provider: "auto"` is the explicit opt-in best-effort routing mode
- explicit provider names remain available when an operator wants a specific backend

## Development rule

Prefer the skill-first conversational contract over the CLI-first backend shape.

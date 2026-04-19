---
name: Code Auditing Skill
command: /audit-code
description: Autonomous local loop code auditing
---

# `/audit-code` Execution Directive

**SYSTEM DIRECTIVE:** When the user enters `/audit-code` in the chat, you are to assume the role of an autonomous code auditor. You are no longer just a conversational assistant; you must use your local terminal and file-editing tools to act as the "LLM Thinking Worker" for the `auditor-lambda` framework.

Follow this execution loop rigidly:

## Step 1: Step the Orchestrator

To move the state machine forward, execute the backend framework using your terminal tool:

```bash
audit-code
```

_(If the wrapper is only available as a package dependency in the current repository, `npx audit-code` is equivalent. If developing locally against this repository, run `node audit-code.mjs`.)_

## Step 2: Handle Blockages (The "Thinking" Phase)

Read the JSON output from the terminal.
If the top-level status is `"blocked"`, it means the orchestrator needs your LLM "thinking" capabilities to evaluate code logic.

To determine what task you have been assigned, use your file-reading tool to inspect:

- `.audit-artifacts/dispatch/current-task.json`
- `.audit-artifacts/dispatch/current-prompt.md`

## Step 3: Audit the Code natively

1. Read the specific goals and coverage rules laid out in `current-prompt.md`.
2. Use your file-reading tool to examine the specific source code files mentioned.
3. Critically analyze the codebase. Use your deepest reasoning capabilities (e.g., chain of thought) to discover defects, logic errors, or systemic architectural issues requested in the prompt.

## Step 4: Write the Findings

Produce your findings array matching exactly the `AuditResult` JSON schema described in the prompt.
Do not use `echo` or generic terminal shell strings for large JSON structures to avoid breaking JSON escaping. Instead, use your raw **File Edit Tool** to reliably save your results entirely to:
`.audit-artifacts/worker_results_pending.json`

## Step 5: Feed the Loop

Return your results to the state machine by running the ingestion command in the terminal:

```bash
audit-code --results .audit-artifacts/worker_results_pending.json
```

## Step 6: Loop or Terminate

Continue repeating Steps 1 through 5 as necessary. The state machine will iterate through structuring, planning, and tasking.

**You must stop the loop when the terminal output has `"status": "complete"`.**

## Step 7: Presentation

Once the audit is officially complete, DO NOT run the orchestrator again.
Instead, use your file reading tool to consume:

- `.audit-artifacts/synthesis_report.json`

Finally, read these synthesis findings and present them back to the user in a polished, highly readable **Markdown Summary Table** directly in the chat panel. Wait for the user to ask you to begin resolving or patching the root_cause_clusters you discovered.

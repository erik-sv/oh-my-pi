# Model-Selectable Subagents

Status: Implementation Complete - Full-Suite Verification Blocked

## Current Goal

Let a parent agent select any available model directly for each task subagent, using the same model selectors shown by the model picker.

## Overview

The task tool currently selects an agent type but does not expose its existing invocation-level model override. This forces users and agents to create or reconfigure agent definitions before using a newly available model. Add a per-task `model` selector and route it through the shared subagent policy.

## Objectives

- Accept model picker selectors in flat and batch task calls.
- Give the caller's explicit model precedence over agent and settings defaults.
- Preserve agent types as capability and prompt profiles.
- Surface model selection in the task tool contract.

## Tasks

- [x] 1.0 Define direct model selection - PASS focused task tests
  - [x] 1.1 Add task schema coverage for flat and batch model fields - PASS `bun test test/task`
  - [x] 1.2 Add execution coverage for invocation precedence - PASS `bun test test/task`
- [x] 2.0 Implement model routing - PASS live source smoke
  - [x] 2.1 Carry `model` through normalized spawn parameters - PASS focused task tests
  - [x] 2.2 Pass `model` into shared subagent preflight and execution - PASS Fable/Astra smoke
- [x] 3.0 Document and verify
  - [x] 3.1 Update task tool guidance and reference docs - PASS prompt contract test
  - [x] 3.2 Run focused tests, lint, and type checks - PASS 433 tests, `bun run check`, binary build
  - [x] 3.3 Smoke test Claude Fable 5.1 and GPT Astra - PASS provider logs

## Success Criteria

- A task item can specify `model: "anthropic/claude-fable-5-1"` or `model: "openai-codex/gpt-6-astra"` without a custom agent definition.
- Batch items can select different models while sharing one context.
- An explicit task model overrides settings and agent frontmatter for that invocation only.
- Existing calls without `model` retain current routing.

## Completion Notes

Implementation and scoped verification are complete. `model` is available in flat and batch task schemas, has invocation precedence, appears in approval details, and routes through the shared policy.

Verification evidence:

- `bun test test/task`: 433 passed, 0 failed.
- `bun run check`: lint, formatting, and TypeScript checks passed.
- `bun run build`: binary build passed.
- Live source CLI batch: Claude Fable 5.1 and GPT Astra both completed through direct per-item `model` selectors. Provider logs recorded `anthropic/claude-fable-5-1` and `openai-codex/gpt-6-astra`.

Archive and landing remain blocked by an unrelated full-suite hang. `bun run test` twice stalled in `autocomplete-max-visible.test.ts` only when run inside the 86-file singleton bucket, eventually hitting the 600-second and 1200-second chunk watchdogs. The same file passed alone, 5/5, and with its ten preceding bucket files, 145/145.

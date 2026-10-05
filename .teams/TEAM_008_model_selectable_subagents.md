# TEAM_008 - Model-Selectable Subagents

## Status

Implementation complete. Full-suite verification blocked by an unrelated singleton-bucket hang.

## Goal

Expose direct per-task model selection so agents can use newly available model-picker entries without creating custom agent definitions.

## Worktree

- Path: `/home/agentdesk/code/oh-my-pi-worktrees/model-selectable-subagents`
- Branch: `feat/model-selectable-subagents`
- Base: `185a5642e7`

## Verification

- Baseline: `bun test test/task/task-schema.test.ts test/task/task-preflight.test.ts test/task/task-batch.test.ts` - 33 passed.
- TDD red: 4 routing/schema failures before implementation.
- Focused suite: `bun test test/task` - 433 passed.
- Static checks: `bun run check` - lint, formatting, and TypeScript passed.
- Build: `bun run build` - passed.
- Live source smoke: direct batch selectors ran `anthropic/claude-fable-5-1:low` and `openai-codex/gpt-6-astra:low`; provider logs confirmed both concrete models.
- Full suite: blocked. The 86-file singleton bucket repeatedly hung in `autocomplete-max-visible.test.ts`, at both 30-second and 120-second per-test limits. That file passes alone, 5/5, and with the preceding ten bucket files, 145/145.

## Handoff

The feature is implemented in the worktree. Do not archive the PRD or land the branch until the unrelated full-suite singleton-bucket hang is resolved or the release owner explicitly accepts the scoped verification.

Changed behavior:

- Flat task calls accept `model`.
- Batch task items accept independent `model` selectors.
- Invocation model wins over task settings and agent frontmatter.
- Approval details show the requested model.
- The tool prompt tells agents to use `omp models find "<name>" --json` when the exact picker selector is unknown.

## Suggested Commit Message

```text
feat(task): allow per-spawn model selection

Expose an optional model selector on flat task calls and batch items.
Route the selector through task preflight and execution so invocation
choices override agent settings and frontmatter without custom agent
definitions.

Teach spawning agents to resolve unfamiliar picker names with `omp
models find`, surface the requested model in approval details, and
document the new precedence. Add schema, batch-routing, prompt, and
approval coverage for Claude Fable 5.1 and GPT Astra selectors.
```

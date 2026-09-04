---
name: deliver-prd
description: "Orchestrate end-to-end PRD implementation with parallel native-OMP sub-agents, anti-stub enforcement, and the review-loop gate engine (plan and completion gates at a 9.5/10 bar across correctness, simplification, and security). Use when the user says 'deliver this PRD', 'implement end to end', 'implement this PRD completely', 'full implementation', or provides a PRD path for autonomous completion."
argument-hint: "[PRD path or feature name]"
disable-model-invocation: true
allowed-tools: Read, Search, Bash, Write, Edit, Task, Skill
model: opus
effort: max
---

# Deliver PRD

Orchestrate complete PRD implementation: decompose the PRD into parallel work
packages, implement them with native OMP sub-agents under an anti-stub mandate,
and gate the result with the review-loop skill at a 9.5/10 bar across correctness,
simplification, and security. The plan is gated before implementation, the
completed state is gated before it lands.

This skill owns decomposition, parallel implementation, and PRD bookkeeping.
review-loop owns the gates. Keep that split: do not reimplement scoring or
reviewer dispatch here.

## Prerequisites

Verify before starting:

1. The target PRD exists and its status is not Complete or Archived.
2. Baseline tests pass (the repo's own gate, e.g. `npm test`, `uv run pytest`).
3. The git working tree is clean (commit or stash first).

If a prerequisite fails, stop and report. Do not proceed on a dirty tree or a red
baseline.

## Phase 1: Decompose

Read the PRD at `$ARGUMENTS` (or locate it in `PRDs/CURRENT/`). Extract every
unchecked task (`- [ ]`). For each, record:

| Field | Value |
|---|---|
| Task ID | WBS number |
| Summary | One sentence |
| Files touched | Absolute paths (read the code to determine) |
| Dependencies | Task IDs that must finish first |
| Test | What proves this task done |

Group tasks with no internal dependencies into work packages that can run in
parallel. Order the packages by their dependency chain. Output the decomposition
before implementing.

## Phase 2: Plan gate

Run the review-loop plan gate on the decomposition and approach before any code is
written:

```
/review-loop <PRD path> --bar 9.5 --max-cycles 5
```

This scores the plan on correctness, simplification, and security with cross-model
reviewers. Revise the decomposition with the findings until the plan gate clears.
Do not implement against a plan below the bar.

## Phase 3: Implement (parallel, native OMP)

For each work package, dispatch sub-agents in parallel with the native OMP `task`
tool, never the legacy `/subagent` HTTP route. One `task` batch per work package;
wait for the batch before starting the next package.

Each SOW must include:

1. Task scope: the task IDs and descriptions.
2. File context: absolute paths to read before editing.
3. TDD: write the test first, watch it fail, implement, watch it pass.
4. Anti-stub mandate (verbatim):

> No stubs, mocks, fakes, placeholders, or TODO-later patterns in production
> code. Every function contains real logic. Every test asserts real behavior, not
> a mocked return of the unit under test. Fixtures and mock boundaries (HTTP, DB)
> are fine; mocking the unit under test is not. If a dependency does not exist
> yet, say so and stop. Do not fake it.

5. Project conventions: inline the relevant AGENTS.md / CLAUDE.md rules; sub-agents
   do not inherit them.
6. Exit criteria: the specific test that passes, the behavior verified, the files
   that exist.

Choose the smallest model that fits each package (a Sonnet-class model for
standard work, Opus for architectural or security-sensitive work). Maximum 3
concurrent sub-agents per package. Re-dispatch incomplete work before moving on.

## Phase 4: Lead review (anti-stub)

The lead agent reads every changed file. Do not trust sub-agent claims. Verify:

- real logic, no `pass` / `NotImplementedError` / `TODO` / placeholder returns
- tests assert real behavior, not mocked returns of the unit under test
- no leftover `// TODO: implement` or hardcoded fake results
- the code matches the PRD task, not an adjacent thing
- conventions hold (ASCII only, no dead code, proper error handling)

Run the repo gate. All existing and new tests pass. Fix minor issues directly;
re-dispatch a targeted sub-agent for larger ones. Mark completed tasks `- [x]`.
Do not proceed until all tasks are done and tests pass.

## Phase 5: Completion gate

Run the review-loop completion gate on the full change:

```
/review-loop <PRD path> --bar 9.5 --max-cycles 5
```

This scores the diff on correctness, simplification, and security with cross-model
reviewers (GPT-5.5 + Opus), runs local CI and, for UI changes, puppeteer at
desktop and mobile, and iterates the work until every dimension clears the bar or
the cycle cap escalates to you. Address the loop's required fixes; do not hand-roll
a separate simplify or security pass, review-loop covers both as dimensions.

If review-loop escalates (cap reached, no progress, unresolved security), stop and
report the remaining findings. Do not mark the PRD complete.

## Phase 6: Completion

1. Update the PRD status to Complete.
2. Add completion notes: what was built per package, the test evidence observed,
   the review-loop result (cleared at which cycle, any deferred low-severity items).
3. Move the PRD from `PRDs/CURRENT/` to `PRDs/ARCHIVE/`.
4. Update the team file with a session summary and a suggested commit message.
5. Report: PRD path, summary, test results, deferred items.

## Failure modes

| Condition | Action |
|---|---|
| Baseline tests fail | Stop. Report. Do not proceed. |
| Sub-agent produces stubs | Reject, re-dispatch with the anti-stub block. If it stubs again, implement directly. |
| Sub-agent produces no changes | Re-read the SOW. If genuinely a no-op, mark N/A with justification. |
| Plan gate will not clear | Stop after the cycle cap. Report the plan findings; the approach needs a human decision. |
| Completion gate escalates | Stop. Report the unresolved dimension findings. Do not mark complete. |
| Tests break after a loop fix | The loop owns convergence; let it re-review. If it cannot, escalate. |
| Ambiguous PRD tasks | Create a `.questions/` file and ask before implementing. |
| Context running low | Commit completed work, update the PRD with progress, write handoff notes. |

## Constraints

- Never auto-commit. Stage and report; the user commits.
- Never modify test fixtures without user approval.
- Native OMP delegation only. No legacy `/subagent` route, no `curl` to AgentDesk
  session endpoints; this skill runs on any OMP or AgentDesk runtime.
- The lead reviews every sub-agent's output before incorporating it. No blind merges.
- Production code contains real logic; test code asserts real behavior. No exceptions.
- The gate is review-loop. Do not fork its scoring, dimensions, or thresholds here.

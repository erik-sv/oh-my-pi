# Upstream Review Brief — what to pull into our fork

## Your job
Produce a concrete, prioritized recommendation report (NOT a code change) on which of the
~280 upstream commits our fork is missing are worth pulling in, and HOW to take them safely
given our local divergence. Write the report to:
  /home/developer/src/oh-my-pi/.upstream-review/RECOMMENDATIONS.md

This is an ANALYSIS + REPORT task. Do NOT modify source code, do NOT rebase, do NOT merge,
do NOT push. Read-only investigation only. The only file you create/edit is RECOMMENDATIONS.md
(plus scratch notes under .upstream-review/ if useful).

## Repo facts (already gathered — verify with git as needed)
- Repo: /home/developer/src/oh-my-pi (Bun monorepo).
- Remotes: `origin` = our fork github.com/erik-sv/oh-my-pi ; `canonical` = upstream
  github.com/can1357/oh-my-pi. `canonical` is already fetched locally.
- Our branch: `main` @ 396a9bd7a. Upstream: `canonical/main` @ 7bb6fb20e.
- Divergence: we are **280 behind, 7 ahead**. Merge base = e707b906527e ("chore: bump
  version to 15.5.11", 2026-05-29). So the fork point is only ~2 days old but upstream moved
  fast: 109 fix, 74 feat, 17 test, 17 chore, 16 refactor, plus perf/refactor/breaking.
- Versions: ours 15.5.11, canonical & npm @latest = 15.7.3.
- NEW upstream package absent from our fork: `packages/mnemopi/` (appears to be a memory
  subsystem — heavy churn; evaluate as a pure addition).

## Our 7 local commits (MUST be preserved through any future integration — do NOT recommend
## anything that silently drops these; call out conflicts explicitly):
- 396a9bd7a perf(session): SQL transcripts as append-only chunk rows (O(1) per write)  ← NOT upstream
- 09638b673 fix(ai): drop historical thinking on resume; only latest assistant turn keeps it ← NOT upstream
- 51cb670ac Merge remote-tracking branch 'origin/main'
- ec17e694d fix(ai): prevent 'thinking blocks cannot be modified' 400 on Anthropic resume ← NOT upstream (verify)
- c8bf9df9d fix(coding-agent): backport canonical#1503 extension-flag parsing fixes
    ← ALREADY MERGED UPSTREAM as PR #1503 (from us). Redundant on a future rebase — flag it.
- 7e5a59033 / 71e5311d3 feat(coding-agent): add peer-coms agents (duplicated commit) ← NOT upstream

IMPORTANT nuance for the thinking-block fixes: upstream has its OWN thinking/resume work in
this 280-commit window (the original TEAM_027 investigation noted canonical already had
`41796589a fix(ai): stop rewriting thinking` and `f6bf17d8c fix(session): neutralized signed
thinking blocks ...`). So our two `fix(ai)` thinking commits may OVERLAP or CONFLICT with
upstream's version of the same fix. Determine: does upstream's thinking/resume handling now
supersede ours? If yes, recommend adopting upstream's and dropping ours. If ours is still
needed on top, say why.

## Pre-staged inputs (read these first)
- .upstream-review/upstream-commits.txt        — all 280 missing commits (hash|date|subject)
- .upstream-review/upstream-feats-perf-breaking.txt — feat/perf/breaking subset (high signal)
- .upstream-review/local-commits.txt           — our 7
- .upstream-review/upstream-dirstat.txt         — which dirs upstream changed most
- .upstream-review/upstream-diffstat-tail.txt

## How to work
1. Skim upstream-commits.txt and the feat/perf/breaking list. Cluster commits by theme
   (providers/ai, session/storage, tui, tools, mnemopi, hashline, prompts/rules, config, etc.).
2. For each meaningful cluster, use `git show <hash>` / `git log -p <hash> -- <path>` /
   `git diff main...canonical/main -- <path>` to understand WHAT changed and whether it
   touches code paths WE rely on (AgentDesk runs omp via `--mode rpc` with `--session-storage
   sql`; our SQL chunk storage lives in packages/coding-agent/src/session/sql-session-storage.ts;
   our Anthropic thinking fixes live in packages/ai/src/providers/anthropic.ts and
   transform-messages.ts). Prioritize anything that (a) fixes correctness bugs we likely hit,
   (b) touches the same files as our 7 commits (conflict risk), (c) improves the rpc/session/
   provider paths AgentDesk depends on.
3. Explicitly evaluate `packages/mnemopi` as a new addition: what is it, does anything we run
   depend on it, is it safe/worth adding, or is it inert unless enabled?
4. Note BREAKING changes (`!` commits or subjects mentioning breaking/rename/remove) and any
   that would collide with our local work.

## Deliverable: RECOMMENDATIONS.md must contain
- **Executive summary** (5-10 lines): overall recommendation — e.g. "rebase our 7 onto
  canonical/main and drop commits X,Y as redundant" vs "cherry-pick these N commits" vs "full
  catch-up merge". Pick ONE primary strategy and justify it.
- **Strategy & sequencing**: the exact recommended git approach (rebase vs merge vs
  cherry-pick), in what order, and how to preserve our 7 commits (which to keep, which to drop
  as already-upstream, which will conflict and how to resolve). Give concrete commands.
- **High-value pulls** — a table: cluster | example commit hashes | what it gives us | risk |
  priority (P0 must / P1 should / P2 nice). Cover at least: AI/provider fixes, session/storage,
  rpc/agent loop, tui, tools, mnemopi, anything touching our files.
- **Conflict map**: every upstream change that overlaps our 7 commits' files, and the
  resolution stance (take theirs / keep ours / merge-by-hand with rationale).
- **Do-NOT-pull / defer list**: noise, repo-specific chores, or things risky for our deployment.
- **Verification plan**: after integrating, which tests to run (bun test paths) and a smoke
  check that AgentDesk's rpc + SQL chunk storage still works.
- **Open questions** for the human, if any.

## Hard rules
- READ-ONLY. No source edits, no git rebase/merge/cherry-pick/commit/push. Report only.
- Ground every claim in `git show`/`git log`/file reads — do not speculate about commit
  contents. If you assert "commit X fixes Y", you must have looked at it.
- Be specific with commit hashes; a vague "pull the AI fixes" is not acceptable.
- You are unattended; do not ask questions mid-run — record uncertainties in Open Questions.

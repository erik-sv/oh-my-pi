# TEAM_005 OMP Fork Sync

## Status
Investigated local OMP checkout/install, fork remote, upstream canonical, and npm latest for `@oh-my-pi/pi-coding-agent`.

## Observed state
- Local repo: `/home/developer/src/oh-my-pi`
- Branch: `main`
- Local HEAD: `3cc670a19`
- Fork remote `origin/main`: `fd7f15d4a`
- Upstream `canonical/main`: `61f11a6ce`
- Installed `omp`: `omp/15.7.3`
- Local package version: `15.7.3`
- Fork package version: `15.7.6`
- Upstream/npm latest package version: `15.9.3`
- Local vs fork: local is `4` ahead / `102` behind after fork history rewrite.
- Fork vs upstream: fork is `8` ahead / `465` behind.

## Assessment
Local OMP session is not up to date with the fork. The fork itself is also behind upstream/npm latest. Update local from fork first via the existing reset-based fork update flow, but do not run it without user approval because it hard-aligns the checkout to `origin/main`.

Worth adding from upstream/npm latest: prefer rebasing fork-only commits onto upstream `canonical/main`/`v15.9.3` rather than cherry-picking individual fixes. The upstream delta includes many interconnected storage, TUI, ACP, session, auth, and provider changes; cherry-picking high-value fixes risks missing dependent API changes, especially the 15.9.0 `SessionStorage` breaking change.

High-priority upstream changes identified:
- `@` mention exact-only resolution to avoid wrong-file autoreads.
- async task/job manager fallback and singleton scoping fixes.
- `omp update` syncing native package versions.
- TTSR path privacy fix.
- stale MCP OAuth credential removal.
- ACP plan-mode resolve/local artifact fixes.
- `read` zip central-directory listing without eager inflation.
- URL selector/path normalization fixes.
- Kagi V1 and improved Perplexity search behavior.
- TUI scrollback/resize fixes for Ghostty/kitty/tmux/unknown viewport paths.

Fork-specific changes to preserve during rebase:
- peer-coms/peer-collab assets and agents.
- SQL transcript chunk storage.
- shell tab completion.
- terminal title spinner.
- project `.omp` workflow/tool settings.
- fork update script or replacement workflow.

## Verification performed
- `git fetch --prune origin main`
- `git fetch --prune canonical main --tags`
- version/branch comparison via `git rev-parse`, `git rev-list`, package JSON inspection, and `npm view @oh-my-pi/pi-coding-agent`.
- Changelog extraction from `canonical/main:packages/coding-agent/CHANGELOG.md` for 15.8.0 through 15.9.3 and Unreleased.

## Suggested commit message if user asks to implement the upstream sync
```text
chore(omp): rebase fork onto upstream 15.9.3

Rebase the fork-specific OMP changes onto canonical v15.9.3 while preserving
local peer-collab agents, SQL transcript chunk storage, shell completion,
terminal-title spinner, and project workflow settings.

Bring in upstream session-storage, TUI scrollback, ACP plan-mode, MCP OAuth,
web-search, update, archive-read, file-mention, and provider compatibility fixes.

Verify with package checks and focused tests for coding-agent session storage,
ACP plan mode, file mentions, archive reads, update CLI, and task async fallback.
```

## Completion update - 2026-06-05
- Local checkout aligned to fork and then rebased onto upstream/npm 15.9.3.
- Fork main updated with force-with-lease to cd03a5019.
- Active linked omp reports omp/15.9.3.
- Preserved fork commits: peer-coms, SQL chunk session storage, peer-collab skill, update script, shell tab completion, title spinner, project workflow settings, TEAM_001 log.
- Added integration fix commit cd03a5019 for SQL chunk storage on upstream IndexedSessionStorage plus formatting/import fixes.
- Verification: bun check passed; targeted bun tests passed for SQL session storage, file mentions, task async fallback, update CLI, and title generator.
- Remaining untracked local artifact: .upstream-review/ (left untouched).

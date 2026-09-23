# Upstream 18.2.9 AgentDesk Integration

Status: Integration verified; production activation blocked by the deployed AgentDesk launcher.
Current Goal: Commit the verified fork and stage its immutable artifact without restarting AgentDesk. Complete the separate hot-switch feature for a later authorized deployment.
Team: TEAM_001

## Overview

Merge upstream v18.2.9 into the maintained fork starting at origin/main 4d35ffbf3e. Preserve SQL transcript storage, RPC, account usage, browser subprocess isolation, process identity, and authorization behavior while adopting upstream model, caching, compaction, reliability, security, browser, semantic search, and judgment changes.

## Objectives

- Support Opus 5.5 including client fingerprint and version retry behavior.
- Integrate the full selected upstream release, reconciling local contracts rather than dropping fork functionality.
- Keep automatic reset-credit redemption disabled.
- Verify a real built runtime before committing and activation.
- Do not restart AgentDesk or disturb existing sessions.

## Tasks

### 1.0 Preparation
- [x] 1.1 Map deployed fork provenance and live session launch contract. Verified live config and deployed Rust source.
- [x] 1.2 Establish isolated worktree and baseline tests. RPC subprocess tests require clearing inherited PI_CONFIG_FILES: the parent overlay names /proc/self/fd/3, which child processes cannot read.

### 2.0 Integration
- [x] 2.1 Merge upstream v18.2.9 and reconcile all fork conflicts.
- [x] 2.2 Preserve SQL, RPC, account, browser, authorization and process contracts.
- [x] 2.3 Verify automated compatibility tests, lint, typecheck, build, and actual runtime smoke.
- [x] 2.4 Verify browser behavior through the actual runtime.
- [x] 2.5 Commit verified integration to the OMP fork on sync/upstream-v18.2.9-agentdesk.

### 3.0 Activation
- [ ] 3.1 Activate exact built artifact for new AgentDesk sessions only.
- [ ] 3.2 Verify new-session version and persistence without restarting AgentDesk.

## Success Criteria

All named upstream areas integrated; relevant regression checks and real runtime behavior pass. Commit and artifact identity recorded. A new AgentDesk session uses the new version and existing sessions remain undisturbed. Automatic credit redemption stays disabled.

## Completion Notes

Initial worktree: /home/agentdesk/code/oh-my-pi-worktrees/upstream-18-2-9-agentdesk.
Research session log: /home/agentdesk/tmp/.teams/TEAM_001_omp_upstream_research.md.

Activation blocker: deployed AgentDesk runtime stores one canonical ResolvedOmp at startup and has no hot-reload endpoint. A runtime restart shuts down its children; the database ownership fence excludes a second concurrent runtime. Do not replace the pinned executable in place: that bypasses startup validation and leaves in-memory version and manifest stale. Seven sessions were processing when inspected. Continue integration and verified commit, without restarting or modifying production.

Provenance correction: AgentDesk uses the browser-worker path in /etc/agentdesk/agentdesk.env, not the interactive CLI symlink. Its current bytes hash to 9b2aa608a9073a3aa377d88faa037396e43040068067c6b6ea2a12e8db613294, despite the older 3e2c098 path/manifest. Historical rollout receipt records that overlay; do not perpetuate the metadata mismatch.

Verification so far:
- Full check:ts passes, including lint, formatting, and every package's type checks.
- Anthropic/account compatibility: 185 passing tests; SQL integration: 38; RPC: 21.
- Cache refresh and private-skill bootstrap: 13; compaction, delivery, changelog, and task yield: 62.
- SQL parity smoke: 110 lines, 8917 characters, byte-identical reassembly from 110 chunks.
- Live provider and compiled CLI calls to claude-opus-5-5 returned the requested sentinel strings. The compiled CLI exited normally with status 0. Both used an existing unexpired access token without refresh or production credential-store writes; reset redemption was explicitly disabled.
- Removed the upstream MySQL test that emulated the obsolete single-row UPDATE protocol. Retained observable identical-rewrite, stale-byte precondition, same-path rename, and transaction rollback coverage against the real chunk backend.
- Safe hot switching is being implemented separately in AgentDesk's feat/omp-runtime-hot-switch worktree. It cannot be installed into the already-running Rust binary without a later authorized deployment.
- Source-matched native addon built with Bun 1.4.0 and nightly-2026-08-12; cargo fmt --all -- --check passes.
- Compiled omp reports 18.2.9 and passes --smoke-test.
- A compiled browser subprocess launched Chromium, navigated a local data page, clicked a button, returned COMPILED_BROWSER_OK, captured a screenshot, and acknowledged close. Screenshot: /home/agentdesk/tmp/omp-upstream-compiled-live/screenshot-2026-09-23T01-05-33-833.png.
- Final browser/process/job suites: 71 passes, one platform skip, zero failures. The browser-generation regression now supplies the required host-tool argument schema and proves host-work cancellation when its subprocess crashes.
- Compiled SQL-backed RPC published ready only after title/session/model/thinking rows were durable in an isolated SQLite database, then rejected an empty ephemeral_turn with the expected command-scoped response. The probe was stopped; production was untouched.
- Final standalone artifact SHA-256: 69632e6d0ae4abae8753c5c823e51d4e1a037948dac0d0d9cd6d4112bc546295.
- Native addon SHA-256: f66e5c2b4e2cdf7dc439b1752ba4831dc64506b1d083ab7237b3c55e2c99c03f.

# Upstream 18.12.6 AgentDesk Integration
Status: Integration built and scoped TypeScript/RPC/browser/cross-version checks passed. Native tests and coordinated AgentDesk deployment remain gates; not activated.
Current Goal: Land the deployed 18.12.3 fork and upstream's latest stable patches (v18.12.4 through v18.12.6) on fork `main` without changing AgentDesk's runtime contracts.

## Overview
Fork `main` (a33f36f8c8, PR #12) ends at the 18.10.2 integration. The 18.12.3 work that runs in production (selector generation 7, artifact `omp-v18.12.3-agentdesk-e6ea48733b-4361c33a1528`) was published as `sync/upstream-v18.12.3-agentdesk` at e6ea48733b but never merged to `main`. e6ea48733b already contains `main`, so this branch starts there and merges upstream v18.12.6. Landing it on `main` lands 18.12.3 and 18.12.6 together and keeps every main-only document.

Provenance:
- Base: e6ea48733bd00bdde20b19c553ebe0ebdbc7b069 (deployed 18.12.3 fork; build receipt beside the generation-7 artifact).
- Upstream: tag `v18.12.6` = 45c35e40c46166dc726ccc52f5d27f40f2449f99, "chore: bump version to 18.12.6", committed 2026-10-21. GitHub marks it Latest, not a draft or prerelease. No v18.13 or later tag exists upstream. The tag is lightweight, so there is no signature to verify.
- Delta: 657 upstream commits, 485 files, after v18.12.3.

Codex discovery: `CODEX_CLIENT_VERSION` stays at 0.159.0 (`packages/catalog/src/wire/codex.ts`), the version at which `/models` lists GPT-6.1 Sol. This merge does not change model defaults or allowlists.

## Conflict decisions
- `packages/coding-agent/src/usage-accounts.ts`. Git paired the fork's moved module with upstream's `slash-commands/helpers/usage-accounts.ts`. Upstream's identity-less OAuth rule (`!accountOrg && ids.length === 0` means "not missing") merged cleanly. Only the doc comment conflicted, and upstream's text was taken because it describes the new rule. Every importer still uses the fork path, and the fork names (`usageAccountLabel`, `collectStoredUsageAccounts`, `isActionableUsageDisable`) are unchanged.
- `packages/coding-agent/test/tools/browser-tab-worker-startup.test.ts`, renderer-crash continuation test. The fork version was kept unchanged, including the `requests` counter that replaces upstream's auto-merged `gateOpen` line. Upstream deflaked its inline-worker variant, which forces `Worker` failure and expects the tab to be closed. The fork has no inline worker. Its contract is that the crashed subprocess generation is terminated, the page reattaches in a new generation, and no request arrives after the gate opens.

## Auto-merged contract review
- **SQL chunks and direct resume.** Upstream added `activeLeafId` to off-branch message entries and generalized replay in `sessionEntryLeafId` (#16483). Leaf replay lives in shared session-entry code, and the fork's SQL storage and loader never read `activeLeafId`, so the field persists as additive entry JSON. `SessionManager` now applies `path.resolve` to `sessionDir`. That matches SQL storage, which already resolves `sessionRoot` and initial paths. No upstream source adds `FileSessionStorage` defaults or direct transcript file reads. Every `createBranchedSession` caller still awaits it.
- **RPC.** Upstream added `/mcp reauth` support and abort teardown for builtin commands (`mcpManager`, `abortBuiltinCommands`) and persists `set_todos` as a custom entry. The fork's `ephemeral_turn`, `prompt_error` ordering, opt-in `messageId` and `protocolValue: false` for `async.widgets` are unchanged. The scoped upstream diff contains 10 added lines in `rpc-client.ts` and 48 changed lines in `rpc-mode.ts`; wire schemas, `rpc-types.ts`, SDKs, process identity and seance files are unchanged. Regenerating the RPC schema and SDKs produced no diff. AgentDesk does not use `set_todos` or `PI_SESSION_FILE`.
- **Browser.** Upstream's close-confirmation budget (`closeOrphanTarget(tab, budgetMs)`) merged into the fork's subprocess supervisor. Every callsite passes a budget, and the inline fallback is still absent. `closeCdpTarget` now waits for `Target.targetDestroyed`, so the fork's fake CDP session in `browser-tab-worker-generation.test.ts` gained `on`/`off` and emits that event after an accepted close once discovery is on, as Chromium does. Its worker crash, reattach and release assertions are unchanged.
- **Usage and accounts.** `/account`, the per-account `/usage` and the `omp usage --json` shape are unchanged. Upstream's `reclaimAbovePct` label merged into the fork's `usage-cli.ts`.
- **Process identity.** Upstream did not touch `crates/pi-shell/src/process.rs` or `crates/pi-natives/src/ps.rs`.
- **Seance.** Upstream did not touch `task/seance.ts` or `slash-commands/seance.ts`. Its task changes (`executor.ts`, `index.ts`, `types.ts`) do not reach session storage.
- **Companion AgentDesk deployment.** Ordinary SQL transcripts preserve `activeLeafId`. Explicit branch materialization in `production.rs::branched_omp_transcript` must remove it from retained entries, matching upstream `createBranchedSession`, so a branch resumes at the endpoint the user selected. Deploy the companion AgentDesk correction before selecting 18.12.6.

## Behavior changes AgentDesk will see
- A rollback to 18.12.3 or earlier still reads transcripts written by 18.12.6. If an off-branch entry is last, the older runtime may resume on that entry instead of the active leaf.
- Bash tool commands now see `PI_SESSION_FILE`. For SQL sessions this is the storage pseudo-path, not a readable file.
- Idle compaction no longer runs on logged-in Codex accounts. Background completions no longer restart a run the user stopped.

## Verification commands
Run from the worktree with `env -u PI_CONFIG_FILES -u OMP_SESSION_DB_OPTIONS -u OMP_SESSION_DB_URL`:
1. `bun install --frozen-lockfile --ignore-scripts` (upstream changed only version pins in `bun.lock`).
2. Native addon: upstream changed Rust sources (`pi-natives` grep, crash handler and utok, `pi-builtins` ln/rg/rm, hashline in `pi-edit`, `pi-vcs` diff), so the 18.12.3 addon (`05d64fb9…`) cannot be reused. Rebuild with `OMP_NATIVE_CARGO_PROFILE=local bun --cwd=packages/natives run build:bindings`, then `strip --strip-unneeded`. To build incrementally, point `CARGO_TARGET_DIR` at a copy of the 18.12.3 worktree's `target/` (3.9 GB) or reuse it in place while nothing else builds there.
3. `bun run check:ts`, `cargo fmt --check`, `bun run gen:rpc` (expect no diff).
4. `cargo nextest run -p pi-shell` for process identity and namespace translation. `test:rs` passes no arguments through and skips locally when git shows no Rust changes, so run the full gate as `CI=1 bun run test:rs`.
5. Fork-focused suites in `packages/coding-agent`: `test/session-direct-sql-resume.test.ts test/session/sql-session-*.test.ts test/session/off-branch-leaf-replay.test.ts test/task/seance.test.ts test/config/settings-registry.test.ts test/rpc-ephemeral-turn.test.ts test/rpc-prompt-error.test.ts test/rpc-session-events.test.ts test/usage-cli.test.ts test/account-report.test.ts test/modes/controllers/usage-command.test.ts test/tools/browser-*.test.ts test/memory-recall-resume.test.ts test/session-manager/*.test.ts`.
6. Compile with the receipt's Bun 1.4.3 (`/home/agentdesk/tmp/omp-18123-toolchain/bun-linux-x64/bun`): `BUN_COMPILE_EXECUTABLE_PATH=<bun> <bun> packages/coding-agent/scripts/build-binary.ts`. Then smoke-test the exact artifact as in the 18.12.3 receipt: `--smoke-test`, RPC ready, chunk rows, prompt-error ordering, direct resume, and compiled browser navigation and close.
7. Before any selector publication, cross-version resume between 18.12.3 (generation 7) and the candidate, then production canaries per the 18.12.3 receipt's generation rule.

## Observed verification
- Locked dependencies installed with scripts disabled; `gen:tool-views` is required before direct coding-agent tests.
- Source-matched native addon built with the local profile and stripped before testing: SHA-256 `b50bc56aa81b6eaf9962b584348499bde8acb220a696c697db4b0d93c2db0fa2`.
- All workspace TypeScript checks and formatting pass (two existing lint warnings); Rust formatting passes. RPC regeneration produced no diff.
- Fork suite batches: 367 tests passed initially; missing generated HTML assets blocked ten files. After generation, 222 passed, one skipped and five browser fixture cases failed. Updating only the fake CDP event protocol resolved all five; its complete nine-test file then passed. Assertions were unchanged.
- Exact Bun 1.4.3 executable: SHA-256 `f724a0b48d758024be935aeea4185768a0f5ad4e8cb9c8845dee9ae528ce785a`; `--smoke-test` passed.
- Live Codex `gpt-6.1-sol` recalled the same seed through 18.12.3, 18.12.6 and rollback to 18.12.3 using one SQLite-backed transcript, with no physical JSONL file. Evidence: `/home/agentdesk/tmp/omp18126-cross-2u_n7h0y/`.
- Compiled RPC pre-agent failure order is response/failed response/prompt_error/prompt_result, with one prompt_error and agentInvoked false. Compiled browser navigation returned Example Domain and closed its tabs.
- `cargo-nextest` is unavailable. Ordinary `cargo test --profile local` covers pi-shell, pi-edit, pi-builtins, pi-vcs and pi-natives instead. The upstream native delta is confined to those five crates (28 files, 2296 insertions, 295 deletions); this is scoped verification, not a full-workspace test claim.

## Open items
- Fork `main` needs this branch landed through a PR. The parent owns commit, push, PR, build and activation.
- Fixed service `OMP_BIN` (18.2.9) and the interactive CLI are separate surfaces and remain unchanged.

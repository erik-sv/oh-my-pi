# TEAM_006 Upstream v16.0.1 Fold-in

## Status
COMPLETE on branch `rebase/upstream-16.0.1`. NOT pushed. `main` untouched — awaiting human review/promotion.

## Goal
Fold canonical `can1357/oh-my-pi` v15.12.3 → v16.0.1 (766 commits, a MAJOR bump) into the fork while preserving the AgentDesk integrations: RPC mode (`--mode rpc`) and SQL session storage (`--session-storage sql`, `omp_session_chunks`).

## Topology
- Fork base before: `main` @ v15.12.3 (10 fork commits ahead).
- Upstream: `canonical/main` @ v16.0.1.
- Merge base: `db421bb2e` (15.12.3 bump). Diverge: 10 ahead / 766 behind.
- Result: `git rebase --onto v16.0.1 db421bb2e` — all 10 fork commits replayed onto v16.0.1.

## v16 breaking changes vs AgentDesk coupling — NONE hit AgentDesk
AgentDesk drives omp via `--mode rpc` + `--session-dir`/`--session-storage sql`/`--model`/`--thinking`/`--resume`/`--peer-name`/`-e`/`--append-system-prompt`, the RPC host-tool channel (`set_host_tools`/`host_tool_call`/`host_tool_result`/`host_uri_*`/`extension_ui_*`), and reads `omp_session_chunks(path,seq,content,mtime_ms)` from Postgres.
- `hooks`+`customTools` → unified `extensions`; `--hook`/`--tool` → `--extension`/`-e`: AgentDesk uses `-e` (compatible), never `--hook`/`--tool`, sets no `hooks`/`customTools`.
- `ToolCallFormat`/`toolCallSyntax` → `DialectFormat`/`dialect`; pi-tui `isXxx()` → `matchesKey()`: not used by AgentDesk or our peer-coms extension.
- All RPC methods AgentDesk sends are still dispatched by v16's rpc-mode (verified) and the surface is expanded.

## Conflicts resolved during rebase
- **spinner** (`event-controller.ts`, `interactive-mode.ts`, `title-generator.test.ts`): re-placed `start/stopSessionTerminalTitleAnimation` at v16's turn lifecycle; kept v16's new title tests + our animation test.
- **SQL** (`e79045b38`): v16's `24c8bb24c` rewrote `session-manager.ts` and split it into `session-context/entries/listing/loader/migrations/paths/persistence`. Took v16's structure; re-applied the default-storage indirection (`new FileSessionStorage()` → `getDefaultSessionStorage()`) in `session-manager.ts`, `session-listing.ts`, `session-loader.ts`. Added `--session-storage` to v16's declarative `flag-tables.ts` `STRING_SETTERS` (the old else-if chain is gone). `sql-session-storage.ts` replayed clean (upstream untouched it).

## Post-rebase v16 API adaptations (this commit)
- `peer-coms.ts`: `const { z } = pi.zod` → `const z = pi.zod` (v16 `ExtensionAPI.zod` is now the `z` object, not `{ z }`).
- `sql-session-parity.ts`: `writer.writeLineSync(x)` → `await writer.append(x)` (v16 removed sync writer APIs).

## Verification (branch tip)
- `bun run check:types` — clean (EXIT 0).
- `bun test` — 69 preserved-feature tests + 236 flag/session tests = 305 pass / 0 fail.
- CLI: `omp/16.0.1`; `--mode rpc`, `--thinking minimal..xhigh`, `--session-storage` recognized; `--session-storage sql` without DB env fails loudly via `setupSessionStorageBackend` (wiring intact).
- SQL parity E2E: 110 lines reassembled byte-identically; 110 chunk rows.
- RPC handshake: `ready` frame + `get_state` → `{type:response,id:"1",success:true,...}` with full wire-schema tool payload.

## Handoff / next steps
- Promote: `git branch -f main rebase/upstream-16.0.1` then force-push (history rewrite — needs human approval; NOT done here).
- AgentDesk needs no changes for this fold-in.
- Optional follow-up: fold the two post-rebase API fixes into their source commits (`peer-coms` / SQL) via autosquash if a linear-per-commit-compiles history is desired; branch tip is correct either way.

## Suggested commit message
```
chore(fork): adapt fork patches to canonical v16.0.1 APIs

Post-rebase onto v16.0.1: migrate peer-coms to the v16 ExtensionAPI.zod
shape (pi.zod is now the z object) and the SQL parity script to the v16
async writer.append API (sync writer APIs removed upstream). Add a
consolidated fork CHANGELOG entry and TEAM_006 fold-in log.
```

## Upstream v16.2.5 review - 2026-06-29
- Current fork `origin/main` remains `b9a0817a5` at `omp/16.0.1`; canonical `upstream/main` is `ca9f2847e` at `omp/16.2.5`.
- Divergence after fetch: fork is 12 commits ahead and 2014 commits behind canonical.
- Diff size `origin/main..upstream/main`: 2733 files changed, 847 added, 1636 modified, 70 deleted, 180 renamed.
- Largest changed areas: `packages/coding-agent` 1245 files, `packages/ai` 402, `crates/vendor` 269, `packages/utils` 173, `packages/catalog` 87, `packages/tui` 70, `python/robomp` 66.
- Notable upstream additions: Ruby and Julia eval runtimes, `task/isolation-runner.ts`, typed yield assembly, provider concurrency management, `grep`/`glob` tool rename, `ssh://` file handling, ACP bridge tool, in-house document conversion under `src/markit`, DuckDuckGo/Firecrawl/TinyFish/xAI web search providers, Devin and GitLab Duo providers, WATCHDOG advisor configuration, remote compaction V2.
- Breaking upstream changes to account for: eval single-cell API and `agent_type` -> `agent` / `return_handle` -> `handle`; `search` -> `grep` and `find` -> `glob`; `history://` transcript reads removed; `readHashLines` removed; legacy `AgentSession.nextToolChoice()` removed.
- All 12 fork commits remain unique versus canonical. Preserve: peer-coms agents, peer-collab skill, update helper, shell tab completion, terminal title spinner, Bun-native extension asset loading, `.omp` workflow settings, SQL `omp_session_chunks`, last30days registration, team logs, v16.0.1 adaptation, native-addon install fallback.
- `git merge-tree --write-tree origin/main upstream/main` predicts content conflicts in: `packages/coding-agent/src/modes/interactive-mode.ts`, `packages/coding-agent/src/session/session-listing.ts`, `packages/coding-agent/src/session/session-loader.ts`, `packages/coding-agent/src/session/session-manager.ts`, `packages/coding-agent/src/session/sql-session-storage.ts`, `packages/coding-agent/src/utils/title-generator.ts`, `packages/coding-agent/test/session/sql-session-storage-manager.test.ts`, `packages/coding-agent/test/session/sql-session-storage.test.ts`.
- Highest preservation risk: upstream now has its own SQL storage shape (`omp_session_files`, title metadata, updated storage contract). Do not accept upstream `sql-session-storage.ts` wholesale. Reimplement the fork's append-only `omp_session_chunks(path, seq, content, mtime_ms)` contract against the new upstream `SessionStorage`/`IndexedSessionStorage` APIs.
- Medium preservation risk: terminal title spinner must be replayed over upstream title lifecycle, not kept by stale hunk. Upstream changed title generation, terminal-title test suppression, status line, and progress indicators.
- Medium preservation risk: peer-coms/peer-collab must adapt to upstream agent registry, IRC broadcast, advisor non-peer, cold subagent revival, isolated worktree, and removed `history://` transcript semantics.
- Medium preservation risk: fork `.omp` agent definitions, skills, settings, `scripts/update-fork-omp.sh`, and `.teams` logs appear as deletions in the direct upstream diff because they are fork-local. Keep them unless a file has an explicit upstream replacement.

## Suggested commit message if implementing v16.2.5 sync
```text
chore(fork): rebase OMP fork onto canonical v16.2.5

Replay the fork-specific peer-coms, peer-collab, shell completion,
terminal-title spinner, project .omp settings, update helper, last30days
registration, and AgentDesk SQL transcript-storage changes onto canonical
v16.2.5.

Adapt SQL session storage to upstream's current SessionStorage contract while
preserving the fork's append-only omp_session_chunks(path, seq, content,
mtime_ms) ingest contract. Reapply the title spinner on top of the current
interactive lifecycle and keep upstream provider-concurrency, typed-yield,
advisor, grep/glob, eval, and extension-loader changes intact.

Verify with typecheck plus focused tests for SQL session storage/list/load,
RPC startup with --session-storage sql, peer-coms extension loading, shell
completion, title-generator spinner lifecycle, update-fork-omp native-addon
fallback, and grep/glob renamed tool prompts.
```

## Upstream v16.2.5 sync execution - 2026-06-29
- Created branch `sync/upstream-v16.2.5` from `upstream/main` and replayed all 12 fork commits.
- Preserved fork artifacts: peer-coms extension/tests/docs, peer-collab skill, project `.omp` agents/settings/skills, update helper, shell completion, title spinner, Bun asset-loader intent, SQL chunk storage, last30days registration, team logs, and native-addon fallback docs.
- Adapted SQL storage to upstream title-slot APIs while keeping `omp_session_chunks`; title metadata now lives on `seq = 0` and updates without rewriting content chunks.
- Adapted peer-coms auth-broker import to upstream `@oh-my-pi/pi-ai/auth-broker`.
- Adapted title-spinner test to opt out of upstream headless-terminal suppression with `setTerminalHeadless(false)`.
- Installed dependencies with `bun install` after upstream dependency changes.
- Verification passed:
  - `bun test packages/coding-agent/test/session/sql-session-storage.test.ts packages/coding-agent/test/session/sql-session-storage-manager.test.ts`
  - `bun test packages/coding-agent/test/title-generator.test.ts packages/coding-agent/test/shell-cli.test.ts packages/coding-agent/test/extensibility/legacy-pi-inplace-load.test.ts packages/coding-agent/test/peer-coms.test.ts`
  - `bun run --cwd packages/coding-agent check`

## Suggested final commit message
```text
chore(fork): finish canonical v16.2.5 sync

Replay all fork-only OMP commits onto canonical upstream/main v16.2.5 and keep
the fork contracts intact.

Preserve peer-coms, peer-collab, shell completion, terminal-title spinner,
project .omp settings, update helper, last30days registration, Bun extension
asset loading, team logs, native-addon install fallback, and AgentDesk SQL
session ingest support.

Adapt SQL session storage to upstream title-slot APIs while retaining
omp_session_chunks as append-only rows keyed by path and seq. Store title
metadata on seq 0 and update it without rewriting transcript chunks. Adapt
peer-coms auth-broker imports and terminal-title tests to upstream API and
headless-terminal behavior.

Verification:
- bun test packages/coding-agent/test/session/sql-session-storage.test.ts packages/coding-agent/test/session/sql-session-storage-manager.test.ts
- bun test packages/coding-agent/test/title-generator.test.ts packages/coding-agent/test/shell-cli.test.ts packages/coding-agent/test/extensibility/legacy-pi-inplace-load.test.ts packages/coding-agent/test/peer-coms.test.ts
- bun run --cwd packages/coding-agent check
```

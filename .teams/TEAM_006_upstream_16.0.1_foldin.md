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

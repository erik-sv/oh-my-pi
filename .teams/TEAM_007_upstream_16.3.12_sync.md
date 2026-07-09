# TEAM_007 Upstream v16.3.12 Sync

## Status
COMPLETE and promoted to LOCAL `main` (@ 3ac71fd40). Native addon rebuilt for
v16.3.12 and the linked `omp` verified against it. Redundant sync branch deleted.
NOT force-pushed to origin: `origin/main` still holds the pre-sync fork state
(local main is ahead 1388 / behind 19), so a force-push is still pending a human
decision to make the sync durable across machines.

## Goal
Fold canonical `can1357/oh-my-pi` v16.2.5 to v16.3.12 into the fork while preserving
the AgentDesk integrations (RPC mode, SQL `omp_session_chunks` session storage) and
every other fork-local change, with no regression to AgentDesk performance.

## Topology
- Fork base before: `main` @ 21 fork commits on canonical v16.2.5 (`ca9f2847e`).
- Upstream target: tag `v16.3.12` (canonical/main was `v16.3.12-6`; pinned to the tag).
- Upstream delta v16.2.5..v16.3.12: 1192 files, +98750 / -17847.
- Method: captured one WIP feature as a commit, then
  `git rebase --onto v16.3.12 ca9f2847e sync/upstream-v16.3.12`. The old
  `Merge feat/rpc-ephemeral-turn` merge commit linearized; 21 linear fork commits
  replayed. rerere was on.

## WIP captured before the rebase
- Uncommitted `peer-coms.ts` + new `peer-coms.cap.test.ts` (an `OMP_PEER_COMS_MAX_PEERS`
  cap that bounds subnet fan-out, guarding the AgentDesk RSS ceiling since each peer is
  a full OMP process) committed as `feat(peer-coms): optional MAX_PEERS cap ...`.

## Breaking changes vs fork coupling: NONE hit AgentDesk
AgentDesk drives omp via `--mode rpc` + `--session-dir`/`--session-storage sql`/`--model`/
`--thinking`/`--resume`/`--peer-name`/`-e`/`--append-system-prompt`, the RPC host-tool
channel (`set_host_tools`/`set_host_uri_schemes`/`host_tool_call`/`host_tool_result`/
`host_uri_*`/`extension_ui_*`), the new `ephemeral_turn` command, and reads
`omp_session_chunks(path, seq, content, mtime_ms)` from Postgres.
- v16.3.12 kept every RPC command AgentDesk sends; the host-tool + host-uri + extension-ui
  surface is intact and expanded. `ephemeral_turn` still dispatched (rpc-mode.ts).
- `--session-storage` still parsed (flag-tables STRING setter, validates file|sql).
- `--peer-name` is the peer-coms extension flag (`pi.registerFlag`), unaffected by core.
- `sql-session-storage.ts` (the fork's append-only chunk store) replayed clean; upstream
  never touched it between v16.2.5 and v16.3.12. Byte-identical to old main.

## Conflicts resolved during rebase (4 commits)
- **title spinner** (`title-generator.ts`): v16.3.12 refactored title generation (raised
  `TITLE_MAX_TOKENS` to 1024, dropped `set_title` tool + `REASONING_SAFE_MAX_TOKENS` +
  `SET_TITLE_TOOL_NAME` + `TITLE_MARKER_SYSTEM_PROMPT`). Kept upstream's refactor and
  re-applied only the fork's 4 animation state vars; the spinner functions auto-merged at
  the relocated offsets using `DEFAULT_TERMINAL_TITLE_ICON`. Test auto-merged.
- **Bun asset loader** (`legacy-pi-compat.ts`): the fork fix (11e831e8c) is now fully
  subsumed. Upstream converged on the identical mechanism: `SOURCE_MODULE_EXTENSIONS`
  (byte-identical list) + `hasSourceModuleExtension` gate the graph walk so asset imports
  (peer-coms `import ... .md with { type: "text" }`) reach Bun's native loader. Took
  upstream for all 3 blocks; the fork commit reduced to its added test + CHANGELOG.
- **session picker delete** (`selector-controller.ts`): upstream relocated the picker
  `onDelete` out of the fork's edit range and restructured the overlay (fillHeight,
  fullscreen showOverlay). Took upstream's picker tail; re-applied the fork's
  `new FileSessionStorage()` -> `getDefaultSessionStorage()` on the relocated `onDelete`.
  Import + `handleSessionDeleteCommand` auto-merged to `getDefaultSessionStorage`.

## Post-rebase v16.3.12 API adaptation (1 commit)
- `session-loader.ts`: v16.3.12 added a streaming-load fast path gated on
  `storage instanceof FileSessionStorage`. The fork had narrowed that import to
  `getDefaultSessionStorage` only, leaving `FileSessionStorage` undefined. Re-imported it
  alongside. For SQL sessions the instanceof is false, so SqlSessionStorage keeps its
  chunk-row load path. Commit: `chore(fork): adapt SQL session loader to canonical v16.3.12 APIs`.

## Verification (branch tip)
- `bun run --cwd packages/coding-agent check` clean: biome (2058 files, 1 pre-existing
  warning on the untracked stale `docs-index.generated.ts` artifact), docs index fresh
  (122 docs), tsgo typecheck EXIT 0.
- `bun test` coupling suite: 89 pass / 0 fail (session storage, sql manager,
  rpc-ephemeral-turn, title-generator, shell-cli, legacy-pi-inplace-load, peer-coms).
- `bun test test/session test/rpc-ephemeral-turn.test.ts test/cli`: 460 pass / 0 fail (66 files).
- peer-coms cap test: 1 pass (with OMP_PEER_COMS_DIR scratch).
- SQL parity E2E (`scripts/sql-session-parity.ts`, in-memory sqlite): 110 lines / 8917 chars
  reassembled byte-identically, 110 chunk rows, writeText remainder verified.
- CLI: `omp/16.3.12`; `--mode rpc` boots and emits `{"type":"ready"}` plus
  `extension_ui_request`/`available_commands_update`; `--session-storage` validates values.
- Fork-only artifacts (peer-coms, sql-session-storage, sql-session-parity, update-fork-omp.sh,
  full `.omp` tree) byte-identical between old `main` and the sync branch.

## Local install (done this session)
- Promoted local `main` to the sync tip; deleted the redundant sync branch.
- Removed the stale untracked `docs-index.generated.ts` artifact.
- Rebuilt the native addon (`bun --cwd=packages/natives run build`, ~1m32s): the
  fresh `pi_natives.linux-x64-modern.node` embeds `__piNativesV16_3_12` (was 16_2_5).
- Relinked `omp` (already pointing at this checkout's `src/cli.ts`).
- Verified installed binary: `omp/16.3.12`; native-backed grep works; `--mode rpc
  --session-storage sql` fails loud without a DB url and emits `{"type":"ready"}`
  with `OMP_SESSION_DB_URL=sqlite::memory:` (AgentDesk's exact invocation).

## Handoff / next steps
- LOCAL install is live on `main`. To make the sync durable and propagate to other
  machines, force-push origin: `git push --force-with-lease origin main` (history
  rewrite, needs human approval), then run `scripts/update-fork-omp.sh` per machine.
  Until origin is updated, do NOT run `update-fork-omp.sh` on THIS machine: it does
  `git checkout -B main origin/main` and would reset local main back to the old state.
- AgentDesk needs no changes for this sync.
- Untracked `experiments/` (webchat experiments) and `.upstream-review/` (prior-sync
  scratch notes) left in place; not part of this sync.

## Suggested commit message (the trailing adaptation commit already applied)
```text
chore(fork): finish canonical v16.3.12 sync

Replay all fork-only OMP commits onto canonical v16.3.12 and keep the fork
contracts intact: peer-coms (+ MAX_PEERS subnet cap), peer-collab skill, shell
completion, terminal-title spinner, project .omp settings/skills/agents, update
helper, last30days registration, Bun extension asset loading, team logs,
native-addon install fallback, RPC ephemeral_turn, and AgentDesk SQL session
ingest (omp_session_chunks, append-only, keyed by path+seq).

Resolve title-generator against upstream's title refactor, drop the now-redundant
legacy-pi asset-loader fix (upstream converged on hasSourceModuleExtension), and
re-point the restructured session picker delete at getDefaultSessionStorage.
Adapt session-loader to v16.3.12's FileSessionStorage instanceof streaming gate.

Verification: bun run check (biome + docs + tsgo), coupling + session + rpc + cli
tests (549 pass), sql-session-parity E2E, and a live --mode rpc ready-frame check.
```

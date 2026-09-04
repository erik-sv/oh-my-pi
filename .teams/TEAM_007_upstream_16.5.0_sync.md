# TEAM_007 Upstream v16.5.0 Sync

## Status

COMPLETE in isolated worktree `/Users/eriks/code/oh-my-pi-worktrees/upstream-16.5.0` on branch `sync/upstream-v16.5.0`. Not promoted to local `main`, pushed, or committed beyond the rebased fork history.

## Goal

Rebase the complete local fork from canonical v16.3.12 onto canonical v16.5.0 while preserving AgentDesk RPC and SQL session contracts, peer-coms, title animation, shell completion, project `.omp` assets, and the source-install workflow.

## Integration

- Rebased all 23 fork commits with `git rebase --onto v16.5.0 v16.3.12 sync/upstream-v16.5.0`.
- Resolved the single textual conflict in `interactive-mode.ts` by retaining upstream `VibeSessionRegistry` and the fork's terminal-title animation shutdown import.
- Preserved AgentDesk `ephemeral_turn`, host tool/URI and extension UI RPC surfaces. Current v16.5.0 RPC queue, shutdown, prompt-result, and session-stat behavior required no additional edits.
- Preserved concrete SQL `omp_session_chunks` storage. Released three-column and title-bearing default tables migrate without data loss; custom old schemas convert in place. MySQL conversion reserves one physical connection, serializes with a per-target advisory lock, populates collision-resistant owned shadows before an atomic rename, and recovers pre/post-swap interruption without deleting unrelated tables. Backend-aware all-project listing finds SQL-only sessions on POSIX and Windows; deletion removes physical sibling artifacts; and multi-step mutations roll back atomically.
- Preserved peer-coms, `OMP_PEER_COMS_MAX_PEERS`, peer-collab skills, title animation over upstream title parsing, and both generated command completion and interactive `omp shell` completion.
- Hardened `scripts/update-fork-omp.sh`: same-version native addons must match a native-source git fingerprint and pass a fresh-process probe for the version sentinel and `snapcompactSupportedChars`. Rebuilt addons are probed before the fingerprint sidecar is recorded.

## Verification

- Fork feature suite: 82 pass, 0 fail across peer-coms, title generation/persistence, command completion, and shell completion.
- AgentDesk suite: 55 pass, 13 skip, 0 fail across SQL storage/manager and RPC ephemeral turn, input, prompt result, lifecycle, client start, and restart. SQL compatibility coverage passed 59/59 across legacy/default/custom migrations, global listing/resolution, Windows keys, artifact deletion, and Redis compatibility. Stateful MySQL recovery/ownership/pinning coverage passed 10/10; the final combined MySQL/SQL/listing suite passed 49/49.
- Updater regression suite: 3 pass, 0 fail. TDD red case reproduced a sentinel-bearing addon missing `snapcompactSupportedChars`; green verifies export probe and source fingerprint behavior.
- SQL parity: 110 lines / 8917 chars reconstructed byte-identically from 110 chunk rows; writeText remainder verified.
- Fresh native process: v16.5.0 sentinel and `snapcompactSupportedChars("5x8", "abc") === "abc"` verified.
- Source CLI: `omp/16.5.0`; `--smoke-test` returned `smoke-test: ok`.
- `bash -n scripts/update-fork-omp.sh` passed.

## Handoff

The original shared checkout remains untouched, including its pre-existing peer-coms deletions and untracked TEAM file. Promote only after reviewing this worktree and deciding whether to rewrite local `main`; pushing the rebased history requires explicit force-push approval.

## Suggested commit message

```text
chore(fork): sync canonical v16.5.0 and harden native/session durability

Replay the complete fork onto canonical v16.5.0 while preserving AgentDesk RPC
and append-only SQL sessions, peer-coms and its process cap, terminal-title
animation, shell completion, project skills and agents, and source installation.

SQL lifecycle operations are transactional, legacy rows migrate without data
loss, SQL-only sessions remain globally discoverable, and deletion removes
physical artifacts. Harden the source updater with
a native-source fingerprint and fresh-process required-export probe so a stale
same-version addon cannot defer a missing binding failure until compaction.

Verification: focused fork, AgentDesk, SQL lifecycle, Redis, and updater suites;
13 expected RPC skips; SQL chunk parity; native export probe; source CLI version;
updater syntax; package checks; and omp smoke test.
```

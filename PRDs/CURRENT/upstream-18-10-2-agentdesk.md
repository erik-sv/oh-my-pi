# Upstream 18.10.2 AgentDesk Integration
Status: Integrated and verified. Artifact published to the runtime root; selector activation recorded below.
Current Goal: Stop AgentDesk chats failing with `unsupported_native_inflight_message` when a user sends a message during a running Codex turn, and bring the fork current with upstream.

## Overview
Merged upstream v18.10.2 (18.6.3 through 18.10.2) on top of the 18.6.2 integration (`upstream-18-6-2-agentdesk.md`) and the direct SQL resume fix (ca531ac712). The merge commit is 67c3c3e724 on `sync/upstream-v18.10.2-agentdesk` (fork PR #11).

The trigger was a Codex error that appears when a user sends a second message while a Codex turn is running: "The experimental native turn lane cannot accept stateful WebSocket messages while a native turn is running" (`code=unsupported_native_inflight_message`). Upstream fixed it in 18.6.3 (#14242). The provider already stopped steering the session after this rejection. The fix makes the agent retry treat the rejection as temporary and keep the retry on the same model, so the turn replays with the new message instead of failing or switching models.

Every contract decision from the 18.4.10 and 18.6.2 integrations still holds. In addition:
- **CI.** Upstream removed the hosted `actions/cache` disk-cache backend and moved every Bazel job to omp-kata. The fork has no kata pool, so it keeps its hosted-runner `bazel-cache` action, the per-job scopes and the save steps. Upstream's `bazel-cache-warm` workflow is dropped.
- **Process identity (`crates/pi-shell/src/process.rs`).** Upstream refactored `/proc` access into `pi_builtins::proc_sys`, which addresses `/proc` by our own pid. The fork keeps its pidfd plus fdinfo translation, so supervised stops still work when procfs belongs to an ancestor PID namespace. It reuses `proc_sys::open_pidfd` and `pidfd_send_signal`.
- **RPC.** `ephemeral_turn` sits beside upstream's `open_session` `provider`/`modelId`. The wire schema and the Python, Rust and Go SDKs were regenerated with `gen:rpc`.
- **Direct resume.** `--resume <path>` checks existence through the session storage, then opens without `throwIfMissing`. That option re-reads the transcript as a freshness gate, which would double every SQL transcript read on an AgentDesk resume.
- **Browser.** Upstream's renderer-crash recovery, `recoverTab` results, reattach and navigation timeouts now run on the fork's subprocess tab-worker generations. Upstream's in-process (inline) worker fallback is not adopted, because subprocess isolation is the crash boundary.
- **Usage and accounts.** The `/account` dashboard, per-account usage and the `omp usage --json` shape are kept on top of upstream's reworked usage CLI (history, provider scope, reset expiry) and dashboard menus.
- **Tests adapted to fork contracts.**
  - The session archive test uses a decodable PNG, because the fork validates persisted image blobs.
  - The Mnemopi branch test awaits the fork's async `createBranchedSession`.
  - The silent Pinggy reconnect test uses upstream's restart listener.

## Verification
- `check:ts` passes across all packages. `check:tools` (oxlint, oxfmt) passes. `cargo fmt` passes.
- pi-shell process tests pass, 16 tests including the namespace translation cases.
- Fork-focused suites pass: 1349 tests across 127 files, plus the tui, agent, ai and scripts fork tests. The only failures (`session-loader-stream`, `session-storage-fd-inheritance`) fail the same way on pristine v18.10.2.
- `openai-codex-live-steering` (8 tests) and `agent-session-retry-recovery` pass. Together they cover the native-lane rejection replay and the same-model retry.
- SQL parity: 110 lines reassembled byte-identically.
- Full `ci:test:ts`: 179 of 204 chunks passed. Every failing test file was rerun alone on the merge and on a pristine v18.10.2 checkout with the npm 18.10.2 natives. The results match, or the merge does better. The one difference (`memory-recall-resume`) was a missing `await` in an upstream test, now fixed. Most baseline failures come from this host's Bun 1.3.14, while upstream requires Bun 1.4 or later.
- Compiled artifact, run in an isolated HOME with AgentDesk's argv and env:
  - `--smoke-test` passes.
  - RPC v2 negotiates.
  - `get_state` right after `ready` shows 4 `omp_session_chunks` rows.
  - A pre-agent failure emits `response`, a failed `response`, then `prompt_error`, then `prompt_result{status:error, agentInvoked:false}`.
  - Live Codex (gpt-5.6-sol) and Anthropic (claude-opus-5-5) prompts complete through the 18.6.2 broker.
  - Chromium navigation works through a tab subprocess.
  - Against the sandbox Postgres database, a session persists, the process exits, and a `--resume` of the same path recalls the earlier turn's content.
  - No `messageId` appears without `set_event_filter`.
  - A local slash command settles once without starting the agent. Its output matches 18.6.2.
  - Mid-turn steering on Codex works in 3 of 3 runs. The server did not engage the native turn lane in those runs, on 18.10.2 or on 18.6.2, so the rejection path itself is covered by the unit tests only.
- AgentDesk dev sandbox: prepared and booted from AgentDesk f30c771 with the production runtime binaries. New local launches were refused with "local memory capacity is unavailable". The reason: `/etc/agentdesk/memory-capacity.json` appears owned by uid 65534 inside this tool namespace (the same uid mapping that breaks sudo), and the admission probe requires a root-owned file. The sandbox was torn down.

## Artifact
`/home/agentdesk/code/omp-runtimes/omp-v18.10.2-agentdesk-67c3c3e724-27b0e5ea9116/omp`
- SHA-256 `27b0e5ea91166b8429c4966fe0c54f5d5ed52bf0ff31c765a197b59545cb90bb`.
- Native addon SHA-256 `19bbb65bb21a3641ef39a73eecbd515830ee887c5de08a6ff23b715f3c904d19`. It was built with the cargo `local` profile and then stripped (`strip --strip-unneeded`).
- Compiled with Bun 1.4.3. Bun 1.4.0 produced a binary that failed with `parseFromSourceCode failed`.
- The build receipt is stored next to the binary.

## Rollback
Republish the 18.6.2 direct-SQL-resume artifact, with the expected generation set to the generation this activation produced:

```bash
python3 /home/agentdesk/code/agentdesk/scripts/switch-omp-runtime.py \
  --root /home/agentdesk/code/omp-runtimes \
  --selector /home/agentdesk/data/omp-runtime.json \
  --artifact /home/agentdesk/code/omp-runtimes/omp-v18.6.2-agentdesk-direct-sql-resume-da56a46831f6/omp \
  --sha256 da56a46831f6e59288b49bfc5d5d7ddfdf427bbaa052388f4aad5fca513e791e \
  --version 18.6.2 --manifest-id omp-v18.6.2-agentdesk-direct-sql-resume-da56a46831f6 \
  --compatibility-generation 18 --capability rpc --capability sql-session-storage \
  --expected-generation <current>
```

## Open items
- The fixed `OMP_BIN` in `/etc/agentdesk/agentdesk.env` (remote placements and employee workers) is still 18.2.9. The auth broker and gateway units still run 18.6.2. Moving them needs root, and sudo is broken on this host.
- An 18.10.2 child running with `HOME=/home/agentdesk` prunes `~/.omp/natives/<ver>` directories that have been idle for more than 10 minutes. `provision-employee.sh` copies `natives/18.2.9`. That hazard is unchanged from 18.6.2.
- Pristine upstream `tab.text("h1")` returns null on example.com in a headless tab. The fork shows the same behavior, so it is not a merge regression.
- Test runs inherit the parent omp session's `PI_CONFIG_FILES=/proc/self/fd/3`. RPC children spawned by `bun test` then grew to about 8 GB and stalled the 10 GB container. Run suites with `env -u PI_CONFIG_FILES -u OMP_SESSION_DB_OPTIONS`.

# Upstream 18.4.10 AgentDesk Integration
Status: Integration committed and verified; artifact staged; production activation pending.
Current Goal: Activate the staged artifact together with the auth broker/gateway units without disturbing live sessions.

## Overview
Merge upstream v18.4.10 (18.2.10–18.4.10) into the fork at origin/main 6177510e2c. Merge commit 2d672622ed on sync/upstream-v18.4.10-agentdesk. Supersedes the abandoned, uncommitted 18.4.4 attempt (worktree upstream-18-4-4-agentdesk), whose test weakening and CI breakage were not carried over.

## Fork contracts preserved
- Chunked SQL sessions: `--session-storage sql`, `OMP_SESSION_DB_URL` / `OMP_SESSION_DB_OPTIONS`, one `omp_session_chunks` row per JSONL line; nothing written to upstream's `omp_session_files`. The SQL store has no `claimSessionFile`, so upstream's lease and sibling-move logic never renames SQL sessions.
- RPC: `ephemeral_turn`; the session is materialized before the first command is read. It now runs after the persistence surface is registered, so a store failure is reported as a notice instead of crashing startup. `prompt_error` is emitted ahead of every pre-agent `prompt_result{status:"error"}`. `messageId` is stamped only after `set_event_filter`, so AgentDesk keeps `responseId` message ids.
- Jobs: upstream's `startTime`/`endTime` model is adopted. Queue time is excluded and cancellation freezes `endTime`.
- Also preserved: account/usage breakdown and the `omp usage --json` shape, browser tab subprocesses, PID-namespace process identity, blob byte validation, and unavailable-image text degradation.
- CI is upstream's, with the fork's hosted-runner routing. The fork updater checks the `__piNativesBuildVersion()` stamp. Native builds now need cmake (opusic-sys).

## Verification
- `bun run check:ts` and `cargo fmt --check` pass.
- Full `ci:test:ts`: every remaining failure either reproduces on a pristine v18.4.10 checkout on this host (browser-attach, path-shortening render tests) or was a load timeout that passes when rerun alone. RPC suite: 208 pass.
- SQL parity: 110 lines byte-identical.
- Compiled artifact checks:
  - `--smoke-test` passes;
  - SQL-backed `get_state` right after `ready` returns 4 chunk rows;
  - live Anthropic and Codex prompts succeed through the 18.1.10 broker;
  - Chromium subprocess navigation works.
- AgentDesk dev sandbox with the artifact:
  - RPC v2 negotiated;
  - the pre-agent error surfaces as an SSE error and as `lastError`;
  - chunks persist and the session binding is set right after start;
  - a stopped child resumes the same path with history intact;
  - a local-only slash command settles once;
  - no `msg-N` ids appear.

## Artifact
`/home/agentdesk/code/omp-runtimes/omp-v18.4.10-agentdesk-2d672622ed-096e50329f4c/omp`
SHA-256 `096e50329f4cbc23422936dce9ecb73b01ca136563d81deb41788f4ad45f3e7d`. Native addon SHA-256 `a1e80d48650b97c0525fd087f6797af6e981f77acc6c589cd85fa5fb80152d54`. Build receipt is stored next to the binary.

## Activation hazards
- An omp process running with `HOME=/home/agentdesk` deletes older `~/.omp/natives/<ver>` directories that have been idle for more than 10 minutes. AgentDesk children inherit that HOME. The broker and gateway units run with `ProtectHome=read-only`, so they cannot re-extract their addon and crash on their next restart. Before activating:
  - move both units to this artifact, or add `/home/agentdesk/.omp/natives` to their `ReadWritePaths`;
  - give the AgentDesk sandbox its own HOME for OMP children.
- `providers.cacheWarming` now defaults to `idle`, which replays idle Anthropic sessions. Decide whether AgentDesk's config overlay should turn it off.

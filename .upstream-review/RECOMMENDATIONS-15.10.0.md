# Upstream Integration Plan — fork (v15.9.3 + fork commits) → omp v15.10.0

_Generated 2026-06-06. npm `@oh-my-pi/pi-coding-agent@latest` = **15.10.0** (published today). Our fork
`main` base = `e02ad166a` = exactly tag **v15.9.3** + **11 fork commits**. Gap = **190 upstream commits**
(`e02ad166a..canonical/main fe607cf22`). The `190-ahead` figure git reports is rebase-hash noise; the real
delta to pull is these 190._

## Executive summary
- **Strategy: cherry-pick our fork commits onto a fresh branch off `canonical/main` (v15.10.0)** — identical
  to the proven `rebase/upstream-15.7.3` flow. Do **not** merge upstream into main (190-commit merge = ugly).
- **One hard breaking change vs AgentDesk, and it is NOT in the RPC protocol — it is SQL session storage.**
  Upstream independently shipped its *own* `sql-session-storage.ts` (`omp_session_files`, single-row CONCAT)
  that is schema-incompatible with our fork's `omp_session_chunks` (seq-addressable chunk rows) which
  AgentDesk reads. **Resolution: keep ours; never let `--session-storage sql` route to upstream's design.**
- **Everything else is safe**: the RPC contract AgentDesk consumes is unchanged, core flags intact, the
  startup-gate and launch-shim changes are transparent to rpc spawns, removed tools aren't used by AgentDesk.
- High value to pull: AI/provider correctness, eval/subagent fixes (kernel + deadlock), coding-agent
  robustness, LSP, cold-start perf. The large TUI cluster is irrelevant to our headless rpc deployment.

---

## 1. Breaking-change assessment vs AgentDesk (the point of this exercise)

AgentDesk's integration surface with omp: (a) spawns `OMP_BIN --mode rpc --model --session-dir
--session-storage sql --thinking -e peer-coms.ts --peer-name --peer-project` with an explicit `cwd`;
(b) consumes the RPC event stream; (c) reads omp's SQL session storage directly.

| Area | Upstream change in range | Breaks AgentDesk? | Action |
|---|---|---|---|
| **SQL session storage** | `cacf996f9`, `b9c204c69` ("removed synchronous read APIs"), `5e17edf1e` added a NEW `sql-session-storage.ts` → table **`omp_session_files`** `(path PK, content LONGTEXT, mtime_ms)`, single-row CONCAT append, head/tail substring reads, **no `seq`** | **YES — hard break.** AgentDesk queries **`omp_session_chunks`** with `seq`/`max(seq)` watermark + `WHERE seq>priorSeq` incremental reads (`lib/omp-session-source.js`, `lib/session-ingestion.js`). Upstream's table name + columns don't exist → empty transcripts, broken incremental ingest. | **KEEP our fork's `omp_session_chunks` design.** Resolve the `sql-session-storage.ts` conflict in favor of ours; ensure `--session-storage sql` keeps routing to the chunk backend. Adapt our class to upstream's (possibly async) `SessionStorage` interface — our public API names already align (`loadIndex/readFull/readSlices/append/writeFull/truncate/remove/move`). |
| **RPC protocol** | `git log e02ad166a..canonical/main -- src/modes/rpc/` = **0 commits** | **No.** Frame types (`ready/turn_start/turn_end/session_init/*_delta/status_change/error/host_tool_call/host_uri_request`) and commands unchanged. | None. Safe. |
| **CLI flags** | `args.ts`: only `76f08dd7d` (import refactor) + `8a5b99a96` (perplexity) | **No.** `--mode/--model/--session-dir/--thinking` all present (args.ts:112/130/148/175). `--session-storage` is ours and stays. | None. |
| **`todo_write`→`todo`** (`dc4aeb7b8`) | Already an **ancestor of our v15.9.3 base** — NOT new in this range | No new break. Pre-existing mismatch: AgentDesk `OMP_TOOL_ALIASES` still maps `TodoWrite→todo_write` (`lib/routes/company-agents.js:34`, `lib/routes/projects.js:48`); omp already emits `todo`. Cosmetic (allow-list/alias). | **AgentDesk-side cleanup** (independent of upgrade): map alias to `todo`. Low priority. |
| **Setup-version startup gate** (`e5e93ff76`) | Setup wizard now lazy + version-gated; ACP/RPC/print runners dynamically imported | **No.** The setup-wizard gate lives only in `runInteractiveMode`; `mode === "rpc"` bypasses it entirely. `runRpcMode` behavior unchanged (just lazy-imported). | None. |
| **Launch shim** (`ead5cf687`) | `install:dev` symlinks `omp`→`scripts/dev-launch` (sh shim: sets `OMP_LAUNCH_CWD=$PWD`, cd's to bunfig-free dir, preload `chdir`s back) | **No.** AgentDesk spawns `OMP_BIN` with explicit `cwd` (`lib/omp-rpc-client.js:22`); shim captures that cwd and restores it before entrypoint. Also *fixes* foreign-`bunfig.toml` preload crashes. Opt-in (only via `install:dev`); inert otherwise. | Optional. If adopted, verify `lib/omp-bin-resolver.js` freshness/version detection still resolves a shim'd `~/.bun/bin/omp` (it `realpath`s the bin). |
| **Tool removals** `recipe` (`dfa6007f3`), `calc` | Removed | **No.** Neither in AgentDesk `DEFAULT_OMP_TOOLS`. | None. |
| **Marketplace auto-update** (in `e5e93ff76`) | Refactored to `scheduleMarketplaceAutoUpdate` | No (pre-existing; runs unless `marketplace.autoUpdate:"off"`, non-blocking). | Optional: set `marketplace.autoUpdate:"off"` for rpc spawns to avoid per-spawn background net calls. |
| **hashline header** `¶path#tag`→`[path#tag]` (`860eef3f2`) | Edit-tool patch header syntax | **No.** AgentDesk doesn't parse hashline. Internal to omp's edit tool. | None. |

**Bottom line: the only thing that breaks AgentDesk is letting upstream's SQL storage replace ours. Hold that line and the upgrade is safe.**

---

## 2. High-value pulls (prioritized)

| Pri | Cluster | Example commits | Why it helps our deployment |
|---|---|---|---|
| **P0** | eval / subagent / python kernel | `c057b0ef3` (subagent eval session deadlock), `5184b565e` (keep Python kernel alive when `parallel()` cell interrupted), `76ca917bf` (suspend idle timeout during delegated bridge calls), `133137c9a`/`bdbbfa977`/`cab465cba` (surface subagent abort reasons) | Directly hits the kernel/subagent reliability class we already hit. AgentDesk sessions lean on eval + subagents. |
| **P0** | AI / provider correctness | `ed55880f3` (orphaned tool-call handling, responses providers), `47e34f9ba` (Anthropic output-blocked stream errors), `699adfb38` (llama parallel tool args), `3b3bb696d` (ollama idle timeout), `0068918f4` (drop scope:global CC cache control) | Correctness on the model layer every omp session uses. |
| **P1** | Anthropic thinking/replay (continues the line we already deferred to upstream) | `5046f0f47` (missing baseUrl ⇒ official in thinking replay), `d08e4ebb1` (generalize unsigned thinking replay), `6dcbb0779` (xiaomi mimo unsigned) | We already dropped our thinking guard in favor of upstream; these extend that proven path. |
| **P1** | CCA combiner fixes | `f3210ab86`/`7c8fb4d8f`/`2623bd75a` (strip type-specific keys on mixed-type collapse) | Prevents malformed combined-content assembly. |
| **P1** | coding-agent robustness | `ce60b6626` (harden todo renderer vs malformed streaming args), `1ffa6dc6f` (guard task renderer vs non-array yield), `6efe86c07` (boolean env-flag overrides), `af71e91a1` (retry without model fallback), `fde55bf92` (model bracket-affix strip + resolution cache) | Defensive fixes against streaming/arg edge cases. |
| **P1** | LSP | `9c8a6d208` (workspace/workspaceFolders), `cdcf74bb0`/`17089d170`/`e3107fa7b` (rust-analyzer workspace/status), `d5c1f6e3a` (LSP frame parse perf) | Pull if Rust/LSP used by agents. |
| **P1** | cold-start perf | `f552ce4e6` (defer heavy imports), `e5e93ff76` (setup-version gate), `a3fb07428` (model-equivalence cache), `f4730a053`/`8b077cde5` | Faster omp cold start = faster AgentDesk session spawns. |
| **P2** | web/tools | `54776365c` (configurable fetch backend + fallback), `0bac7012c` (GitHub Actions run/job scraping), `8a5b99a96`/perplexity, `f5a938f85` (auto tool discovery) | Capability adds; not load-bearing. |
| **P2** | usage/antigravity | `c933d3439`/`ca24f3404`/`15c0dff28`/`60f79199c` | Only if antigravity usage display is surfaced. |
| **P3 / take-along** | TUI (scrollback/flicker/ScrollView/keybindings/gallery/screenshot) — ~40% of the range | `888e63bb2`, `2d0f62eb6`, `ecd80120a`, `22bb6b992`, … | Irrelevant to headless rpc; arrives free with the branch base. Don't gate on it. |

---

## 3. Our 11 fork commits — carry-forward disposition (`canonical/main..e02ad166a` + `d8ee640d4`)

| Commit | Keep? | Notes |
|---|---|---|
| `d50482cda` perf(session): SQL chunk storage | **KEEP (critical)** | AgentDesk depends on `omp_session_chunks`. **Conflict** with upstream's new `sql-session-storage.ts` — resolve to ours (see §1). |
| `40bd2843a` feat: peer-coms agents | **KEEP (critical)** | AgentDesk peer bus. Re-check `main.ts` conflicts (PR #1503 ordering already upstream, per prior rebase). |
| `593e6e159` feat: peer-collab skill | **KEEP** | New files, clean. |
| `d8ee640d4` fix: extension asset-import loader (peer-coms.md) | **KEEP** | `legacy-pi-compat.ts` untouched upstream in range ⇒ applies clean; upstream has no `isRewritableModule`, so still needed. Re-verify the `BuildMessage: Syntax Error` repro on v15.10.0 before carrying. |
| `193aec386` shell tab completion / `71596bea8` title spinner / `1f64b1556` project-config settings | KEEP | Fork QoL; check for collisions with upstream interactive/config churn. |
| `b7c3c9817` update-fork-omp.sh / `cd03a5019` fork integration | KEEP (infra) | Sync tooling. |
| `83a57265b`, `e02ad166a` TEAM logs | Optional/drop | Housekeeping. |

---

## 4. Recommended sequence

```sh
cd /home/developer/src/oh-my-pi
git fetch canonical --tags                          # done: canonical/main = fe607cf22 (v15.10.0)
git checkout -b rebase/upstream-15.10.0 canonical/main
# cherry-pick fork commits oldest→newest (skip TEAM-log chores if desired):
git cherry-pick 40bd2843a 593e6e159 d50482cda 1f64b1556 193aec386 71596bea8 b7c3c9817 cd03a5019 d8ee640d4
#   → expected conflicts: sql-session-storage.ts (resolve to OURS / chunk schema),
#     possibly main.ts (peer-coms) and selector-controller.ts / args.ts (session-storage wiring)
bun install                                          # picks up any new workspace deps
# resolve sql-session-storage.ts: keep omp_session_chunks schema; conform to v15.10.0 SessionStorage iface
```
Then verify (§5), and only after review fast-forward `main` and `git push origin main` (keep the
`backup/main-pre-*` safety branch, as the prior rebase did).

---

## 5. Verification plan (must pass before publishing)
- **omp**: `bun test packages/coding-agent/test/session/` + `sql-session-storage*.test.ts`; `packages/ai/test/`;
  `extension-flag-initial-message.test.ts`; `peer-coms.test.ts`; `legacy-pi-inplace-load.test.ts` (the loader fix);
  tsgo typecheck on `packages/coding-agent` + `packages/ai`.
- **SQL parity**: re-run the chunk-parity script (reassemble a transcript byte-identically from `omp_session_chunks`).
- **AgentDesk integration smoke** (the real contract):
  1. Spawn omp v15.10.0 `--mode rpc --session-storage sql` against a scratch session dir/db.
  2. Confirm rows land in **`omp_session_chunks`** (NOT `omp_session_files`) with monotonic `seq`.
  3. Run AgentDesk `npx vitest run test/lib/omp-ingestion.test.js test/lib/session-ingestion-sql.test.js` — incremental
     watermark (`max(seq)`, `WHERE seq>priorSeq`) still works.
  4. RPC smoke: one prompt round-trip; confirm `turn_start/*_delta/turn_end` normalize and the status badge updates.

## 6. AgentDesk-side follow-ups (independent of the omp upgrade)
- Map `OMP_TOOL_ALIASES`/`DEFAULT_OMP_TOOLS` to `todo` (currently `todo_write`) in `lib/routes/company-agents.js`
  and `lib/routes/projects.js`. Pre-existing cosmetic mismatch; not caused by this upgrade.

## 7. Open questions
- Long-term: upstream the chunk-storage design (or request seq-addressable read APIs on `omp_session_files`) so we
  stop carrying a divergent `sql-session-storage.ts` and AgentDesk gains a stable multi-consumer read contract.

---

## 8. SQL storage design — comparison + independent review (added 2026-06-06)

Reviewer: harness `slow` tier (most-capable, OpenAI-family; self-IDs as "o3"). NOT a confirmed
"GPT-5.5" SKU — the review helpers expose only `smol|default|slow` tiers, so no literal GPT-5.5 was
reachable; this is the closest independent cross-family reviewer. Findings adjudicated against code.

### Genuine improvements in upstream's single-row design worth adopting
- **SQL-side bounded `readSlices`** (head/tail via `substring`/`substr` on bytea/blob): transfers only the
  requested bytes. Ours pulls the WHOLE transcript into JS then slices — large transfer/RAM on big sessions.
- **Atomic single-statement `append`/`writeFull`** (upsert + `||`/CONCAT): 1 round-trip, no read-before-write,
  no seq race. Ours does read-probe + JS seq calc + insert (2-3 RTT) and the seq calc races without a lock.
- **O(files) `loadIndex`** (`octet_length` per row). Ours is `SUM()...GROUP BY path` over ALL chunk rows — a
  table-scale scan that grows with transcript volume.
- **Smaller schema**: no `path` repeated in every row / `(path,seq)` index entry.

### Where our design must stay (upstream's is incompatible/worse here)
- **Append cost**: upstream `content = content || excluded.content` rewrites the whole TEXT/LOB value per line
  (PG/MySQL/SQLite have no true in-place append) -> O(n^2) per transcript; their async write-queue only lowers
  the constant (worst-case still O(n^2)). Our chunk INSERT is ~O(1) amortized (reviewer's correction: not
  truly O(1) end-to-end due to the read-probe + index maintenance + RTT, but far better asymptotically).
- **Incremental reads**: only the chunk/`seq` schema supports AgentDesk's `WHERE seq>priorSeq` + `max(seq)`
  watermark. Upstream single-row has no per-line addressing.

### P0 (LIVE bug, verified in code) — rewrite resets `seq`, breaks AgentDesk watermark
- omp `session-manager.#rewriteFile()` (called on compaction/edit/branch, ~10 sites) ->
  `#writeEntriesAtomically` writes a temp path then `storage.rename(temp, target)`. In our chunk storage
  `move`=`DELETE target; UPDATE path=target`, and the temp was written from `seq 0`. **Every rewrite resets
  the session's chunk `seq` to 0..N.**
- AgentDesk (`lib/session-ingestion.js:106-123`) skips when `currentMaxSeq <= priorSeq` (`seqUnchanged`) and
  otherwise reads only `seq>priorSeq`. After an in-place rewrite (same path, same external id => 
  `sameExternalSession=true`): shrinking compaction => **SKIP => stale UI**; growing => **misses the rewritten
  head (compaction summary + early msgs), appends tail => corruption/duplication.** The author's comment
  ("seq advances on rewrite") is wrong — `writeFull` resets it.
- **Fix**: add a `generation` (or never-reset monotonic append id); AgentDesk watermark becomes
  `(generation, seq)`; a rewrite bumps generation so a reset `seq` can't be mistaken for "unchanged".

### Other confirmed findings
- **P0** `writeFull` = `DELETE` + batched `INSERT` is NOT wrapped in a transaction => a concurrent AgentDesk
  read can see empty/torn state. Wrap rewrite in one txn (or copy-on-write by generation + atomic pointer flip).
- **P0** my proposed "atomic seq via `INSERT...SELECT MAX(seq)+1`" is NOT concurrency-safe (turns races into PK
  errors). Use a parent-row `next_seq` counter updated in-txn / `FOR UPDATE` / advisory lock — or enforce (not
  assume) single-writer.
- **P1** `readSlices` windowing needs per-chunk `byte_len`/`start_byte` metadata + a single snapshot, else
  variable chunk sizes make exact bounded slicing overfetch-prone and head/tail can mix versions under append.
- **P1** treat the SQL schema as a VERSIONED public API (AgentDesk reads it directly) — expose a compat view.

### Recommended target design (reviewer-endorsed hybrid; dominates both)
- Parent `session_files(file_id PK, path UNIQUE, generation, next_seq, byte_len, mtime_ms)` +
  `session_chunks(file_id, generation, seq, start_byte, byte_len, content, PK(file_id,generation,seq))`.
- Gives: atomic seq (parent counter in txn), O(files) loadIndex, bounded SQL slices, no repeated path,
  generation-correct rewrite/compaction, and preserves AgentDesk's incremental contract.
- Priority: (1) generation column + AgentDesk `(generation,seq)` watermark, (2) transactional `writeFull`,
  (3) atomic seq allocation, then (4) chunk byte-offset metadata + SQL-side slices. Items 1-2 are correctness
  fixes worth doing on our CURRENT fork now, independent of the v15.10.0 upgrade.

### STATUS (2026-06-07): hotfix A′ implemented in AgentDesk
gpt-5.5 + o3 review converged on shipping an AgentDesk-only **prefix hash-chain continuity
detector** now (no omp schema migration, no coordinated deploy); defer the omp `generation`
column / hybrid to the storage rework. Implemented in AgentDesk:
- `lib/session-ingestion.js`: `importOmpSessionFile` now cheap-skips only when seq+count+size
  are all unchanged; otherwise reads the chunk rows and verifies the prefix (seq ≤ priorSeq) via a
  SHA-256 hash chain (`ompChunkChainHash`). Match ⇒ append (incremental); mismatch/shrink/seq-reset
  ⇒ in-place rewrite ⇒ full REPLACE. Adds a transient-empty guard (don't wipe on mid-rename) and a
  v2 watermark `{lastSeq,rowCount,prefixHash}`; v1 watermarks force one healing full re-import.
- `lib/chat-store.js`: `importNormalizedMessages({replace})` DELETEs prior messages in-txn before
  re-insert (kills the renumbered-rewrite duplication); incremental watermark mirror now carries
  `prefixHash`+`rowCount`.
- Tests: `test/lib/session-ingestion-sql.test.js` (compaction seq-reset → replace, mid-prefix edit
  +grow → replace, transient-empty → no wipe; all prior append/skip/legacy/resume cases preserved).
  Full AgentDesk suite green (1456).
- STILL DEFERRED (omp side, storage rework): generation column, `(generation,seq)` watermark,
  transactional/atomic omp `writeFull`+`move`, byte-offset metadata + SQL-side slices. The residual
  A′ limitation (a rewrite with identical seq+count+size but changed bytes is cheap-skipped) is
  not produced by omp's rewrites and is fully closed only by the generation column.

# Upstream Integration Recommendations
_Fork: `erik-sv/oh-my-pi main` @ `396a9bd7a` — 280 behind / 7 ahead of `canonical/main` @ `7bb6fb20e`_
_Merge base: `e707b906527e` ("chore: bump version to 15.5.11", 2026-05-29)_
_Analysis date: 2026-05-31_

---

## Executive Summary

**Recommended strategy: rebase our 7 commits onto `canonical/main`.**

The 280 upstream commits span 2 days and cover a wide functional range: Anthropic/thinking correctness fixes, agent loop correctness, `hashline` v4 breaking syntax, `mnemopi` new package, major TUI scrollback overhaul, eval improvements, session perf improvements, recipe tool deletion, and a large number of feature additions (setup wizard, shake compaction, auto-thinking, etc.). These changes collectively improve the reliability and correctness of exactly the paths AgentDesk depends on.

A merge is not recommended: the thinking/session-manager files have significant independent upstream history and a merge commit on top of 280 commits will create a confusing, non-bisectable history. Rebase is cleaner.

Of our 7 commits:
- `c8bf9df9d` (backport of PR #1503) **must be dropped** — it is already upstream as `7ad52b25f`.
- `ec17e694d` (first thinking fix) **must be dropped** — upstream's `684af3321` + `f6bf17d8c` implement the same session-manager fix (and more) and will conflict byte-for-byte.
- `09638b673` (second, superseding thinking fix) **keep but resolve conflicts**: our `latestAssistantIndex` guard in `convertAnthropicMessages` is a valid protection orthogonal to upstream's approach. However the `BROKEN_THINKING_MARKER` re-introduction conflicts with upstream's deliberate removal (`41796589a`) and should be dropped during conflict resolution.
- `51cb670ac` (merge commit) **drop** — it is a bare merge with no content, meaningless after rebase.
- `396a9bd7a` (SQL chunk storage) **keep** — upstream has not touched `sql-session-storage.ts` at all; there are textual conflicts in `session-storage.ts` and `session-manager.ts` that are resolvable.
- `7e5a59033` / `71e5311d3` (peer-coms, duplicated) **keep one, drop the duplicate** — upstream does not have peer-coms; the main.ts changes overlap with PR #1503's refactor and need manual merge.

---

## Strategy & Sequencing

### Chosen approach: interactive rebase

```bash
# Ensure canonical is fetched
git fetch canonical

# Start interactive rebase
git rebase -i canonical/main
```

In the interactive rebase editor, mark commits as follows:

| Our commit | Action | Reason |
|---|---|---|
| `71e5311d3` feat(coding-agent): add peer-coms agents | `drop` | Duplicate of 7e5a59033 (same content, older timestamp) |
| `7e5a59033` feat(coding-agent): add peer-coms agents | `pick` | Keep; provides peer-coms |
| `c8bf9df9d` fix(coding-agent): backport canonical#1503 | `drop` | Already merged upstream as PR #1503 (`7ad52b25f`) |
| `ec17e694d` fix(ai): prevent thinking blocks 400 | `drop` | Superseded by upstream `684af3321` + `f6bf17d8c` |
| `51cb670ac` Merge remote-tracking branch 'origin/main' | `drop` | Bare merge commit, empty after rebase |
| `09638b673` fix(ai): drop historical thinking on resume | `pick` | Keep; resolve conflicts (see Conflict Map) |
| `396a9bd7a` perf(session): SQL transcripts as chunk rows | `pick` | Keep; upstream never touched sql-session-storage.ts |

### Rebase command sequence

```bash
# Step 1: start the rebase
git rebase -i canonical/main

# Step 2: edit the todo list as above (drop c8, ec1, 51c, 71e; pick 7e5, 09638, 396)
# Save and close editor

# Step 3: conflicts will appear on 7e5a59033 (peer-coms main.ts)
# Resolution: see peer-coms conflict section below
git add packages/coding-agent/src/main.ts
git rebase --continue

# Step 4: conflicts will appear on 09638b673 (thinking fix)
# Resolution: see thinking-fix conflict section below
git add packages/ai/src/providers/anthropic.ts \
         packages/ai/src/providers/transform-messages.ts \
         packages/coding-agent/src/session/session-manager.ts
git rebase --continue

# Step 5: conflicts on 396a9bd7a (SQL storage)
# Resolution: see SQL storage conflict section below
git add packages/coding-agent/src/session/session-storage.ts \
         packages/coding-agent/src/session/session-manager.ts \
         packages/coding-agent/src/main.ts
git rebase --continue

# Step 6: verify
bun check
bun test packages/coding-agent/test/session/
bun test packages/ai/test/
```

---

## High-Value Pulls Table

All of these are brought in automatically by the rebase. The table identifies clusters, benefit, and risk for awareness.

| Cluster | Key Commit(s) | What it gives us | Risk | Priority |
|---|---|---|---|---|
| **Agent loop correctness** | `1fe843de2`, `445fe99fb` | Gates tool execution on stopReason properly; handles abandoned tool-use turns with placeholder results; both commits together yield the correct final behavior (run on `stop` AND `toolUse`, skip on `length`) | Low — well-tested | P0 |
| **Anthropic thinking correctness** | `684af3321`, `f6bf17d8c`, `420429df9`, `80a7def19`, `41796589a` | Strips dangling tool-use from ALL mid-path turns (not just trailing); neutralizes signed thinking on rewritten turns; removes broken-thinking-marker suppression; preserves latest abandoned-turn signatures | **Medium** — conflicts with our `09638b673`; see Conflict Map | P0 |
| **Anthropic streaming fixes** | `7bb6fb20e`, `d016150d0` | Fixes idle-timeout abort incorrectly triggering provider retries; prevents provider retry after streaming unsafe content | Low — targeted guards in retry logic | P0 |
| **OpenAI streaming fixes** | `3a733c480`, `0a099af4a`, `bc7afc143`, `e1d2dfeff` | Per-delta JSON-parse throttle (O(N) not O(N²)); persists final tool-call args on `output_item.done`; drops streaming internals before persistence; fixes first-delta parse | Low — performance + correctness fix | P0 |
| **Agent: skipped tool call pairing** | `1fe843de2`, `5db3bcaba` | Snapshots initial mutable state; skips tool execution on non-toolUse turns but creates placeholder results for replay validity | Low | P0 |
| **Session correctness** | `346ae48b0`, `1f82d0eed`, `5344bcbc6` | Prevents runtime model switches persisting default role; excludes aborted/error messages from last usage lookup; persists resolved auto thinking level on resume | Low — targeted fixes | P0 |
| **MemorySessionStorage O(N²) fix** | `21d152c70` | Rewrites MemorySessionStorage internals to use chunked append (O(1) per write); same approach as our SQL chunk storage but for in-memory backend used by tests | **Medium** — same file (`session-storage.ts`) as our `396a9bd7a`; non-overlapping sections | P0 |
| **File-lock race + render sanitization** | `cd578a86d` | Fixes mkdir-vs-writeLockInfo race in `withFileLock`; sanitizes tabs in formatErrorMessage; adds Google named-tool routing | Low | P1 |
| **Hashline v4 (BREAKING)** | `2d7cd6d2d`, `32f07833f`, `cb00a0720`, `01c34db45` | Migrates hashline to verb-based v4 syntax (`replace N..M:`, `delete N..M`, etc.); mandatory snapshot tags; block replace syntax; full-file hash snapshots | **High** — breaking syntax change; all hashline consumers (tests, prompt, docs) already updated in upstream | P0 (mandatory if we ever use upstream hashline package) |
| **Anthropic Opus 4.8 parallel tool-use** | `b4466b027` | Injects `disable_parallel_tool_use: true` for Opus 4.8; avoids multi-call turns that could trigger thinking signature issues | Low | P1 |
| **Extension-flag fixes (PR #1503)** | `7ad52b25f`, `b48b82534`, `38d234130` etc. | Full extension-flag parsing cleanup (already in our backport, now upstream-official) | None — our backport drops | P0 (already done) |
| **Session: excluded aborted from usage** | `1f82d0eed` | Skips assistant messages with stopReason `aborted`/`error` in last-usage lookup | Low | P1 |
| **Recipe tool removal** | `dfa6007f3` | Deletes RecipeTool, all runner backends; removes recipe from BUILTIN_TOOLS | **Medium** — if any deployment uses recipe tool, it breaks silently | P1 |
| **mnemopi package** | `3ecc48fdf`–`68430dee5` | New SQLite memory engine for agents (renamed from mnemosyne); retain/recall/reflect tools; local embeddings; session-scoped visibility | Low (additive package; see mnemopi evaluation) | P2 |
| **TUI scrollback overhaul** | `730e59878`, `0bb04ba52`, `957b6b753`, `39c4762b7` etc. | Extensive scrollback rebuild fixes for tmux/Ghostty/WSL/POSIX viewports; eager native scrollback; 2700-line stress test suite | Low (well-tested; does not affect rpc/headless mode) | P1 |
| **Per-turn token budget** | `2ddc9c5bc` | Parses `+Nk` token-budget directives from user turns; hard/soft caps; turn-budget window tracking in SessionManager | Medium — adds fields to SessionManager; touches same file as our SQL commit | P2 |
| **Shake compaction** | `417a1a1d3`, `ae5139358`, `19be67921` | New compaction strategy (shake); workflow keyword detection | Low (additive) | P2 |
| **Auto-thinking per-turn** | `7f866a48a`, `5344bcbc6` | `AUTO_THINKING` in session; resolves and persists thinking level on first real user turn | Low | P2 |
| **Setup wizard** | `5f6316563` | Interactive onboarding on first launch | Low (additive) | P2 |

---

## Conflict Map

### 1. `09638b673` — fix(ai): drop historical thinking on resume

**Files touched by our commit:**
- `packages/ai/src/providers/anthropic.ts`
- `packages/ai/src/providers/transform-messages.ts`
- `packages/ai/test/anthropic-thinking-immutability.test.ts` + others
- `packages/coding-agent/src/session/session-manager.ts` (reverts ec17e694d additions)

**Upstream commits that touch the same files:**
- `41796589a` — removes `BROKEN_THINKING_MARKER`/`suppressedThinkingBlocks` from `anthropic.ts`
- `b4466b027` — adds `disablesParallelToolUse` import + tool_choice injection in `anthropic.ts`
- `3a733c480` — adds `parseStreamingJsonThrottled` wiring in `anthropic.ts`; adds `lastParseLen` to ToolCall type
- `7bb6fb20e` — adds `isLocalIdleTimeout` guard in `anthropic.ts`
- `80a7def19` / `5cd88b7ab` — modifies `transform-messages.ts` for `lastSurvivingAssistantIndex` / abandonment exemption
- `684af3321`, `f6bf17d8c`, `420429df9` — session-manager: adds then extends dangling tool-use stripping + thinking neutralization

**Conflicts and resolution stances:**

| File | Our change | Upstream change | Resolution |
|---|---|---|---|
| `anthropic.ts` — `BROKEN_THINKING_MARKER` | We re-add it (suppresses hallucinatd "rewritten thinking" blocks) | `41796589a` removes it entirely | **Take upstream's removal.** Rationale: our `latestAssistantIndex` guard in `convertAnthropicMessages` already prevents historical thinking from reaching the encoder. Streaming suppression of "rewritten thinking" is a heuristic; upstream removed it deliberately. Keeping it risks re-introducing the problem upstream diagnosed. |
| `anthropic.ts` — streaming tool-arg handling | Minor delta (removes `if (block.thinking.trim() === "Thinking...") continue` in a couple places) | `3a733c480` adds `parseStreamingJsonThrottled` + `lastParseLen`; `7bb6fb20e` adds idle-timeout guard | **Merge both.** Our streaming changes and theirs are in non-overlapping hunks. |
| `anthropic.ts` — `convertAnthropicMessages` | We add `latestAssistantIndex` + `if (i !== latestAssistantIndex) continue` guards for thinking blocks | Upstream has NO `latestAssistantIndex` in `convertAnthropicMessages` | **Keep ours.** Upstream handles this layer in `transformMessages` (`80a7def19`); our guard in `convertAnthropicMessages` provides an additional defense-in-depth layer with zero cost. The two approaches are complementary. |
| `transform-messages.ts` | Our `09638b673` reverts `ec17e694d`'s `mustNeutralizeLatestAnthropicThinking` — returning file to pre-ec17e694d state | `80a7def19` / `5cd88b7ab` add `abandonedToolUse` latest-turn exemption + `invalidStopReason` split | **Take upstream's version** for the transform-messages layer. Upstream's `80a7def19` is the authoritative fix for the same bug class. Our `latestAssistantIndex` in `convertAnthropicMessages` handles the encoder-layer concern separately. |
| `session-manager.ts` | Our `09638b673` reverts `ec17e694d`'s session-manager additions (the revert leaves the file as upstream's `684af3321` would have it) | Upstream `420429df9` extends `684af3321` to strip ALL mid-path dangling turns (not just trailing) | **Take upstream's `420429df9` state.** After dropping `ec17e694d` from the rebase, our `09638b673` revert of session-manager is a no-op (the file is already at the state we reverted to). Accept upstream's extended stripping with no change needed from our side. |

### 2. `396a9bd7a` — perf(session): SQL transcripts as chunk rows

**Files touched by our commit:**
- `session-storage.ts` (adds `getDefaultSessionStorage`/`setDefaultSessionStorage` after `FileSessionStorage`)
- `session-manager.ts` (switches ~8 factory defaults to `getDefaultSessionStorage()`)
- `sql-session-storage.ts` (major rewrite — upstream untouched)
- `main.ts`, `args.ts` (CLI wiring — overlap with PR #1503 refactor)
- `cli/session-picker.ts`, `modes/controllers/selector-controller.ts`

**Upstream commits that touch the same files:**
- `21d152c70` — rewrites `MemorySessionStorage` internals in `session-storage.ts`; does NOT add `getDefaultSessionStorage`
- `cd578a86d` — modifies `session-storage.ts` (render-utils sanitization touches `src/tools/render-utils.ts`, not session-storage — confirmed)
- `session-manager.ts` is touched by: `2ddc9c5bc` (turn-budget), `ae5139358` (shake), `420429df9` (dangling tool-use), `f6bf17d8c` (thinking neutralization), `684af3321`, `346ae48b0`, `1f82d0eed`, `5344bcbc6`, etc.
- `main.ts` is touched by: `b48b82534` (PR #1503 merge), `d1bd14f02`, `5f6316563`, `9d6058154`, `db525316a`, and multiple others in the 280-commit window.

**Conflicts and resolution stances:**

| File | Conflict | Resolution |
|---|---|---|
| `session-storage.ts` | `21d152c70` rewrites `MemorySessionStorage` (lines ~300–420); our `396a9bd7a` adds `getDefaultSessionStorage` block after line ~233. Textual overlap unlikely but both change the same file. | **Keep both changes.** Our registry is after `FileSessionStorage`; upstream's changes are in `MemorySessionStorage`. Merge by accepting upstream's MemorySessionStorage rewrite AND keeping our `getDefaultSessionStorage`/`setDefaultSessionStorage` block. |
| `session-manager.ts` | Upstream adds turn-budget fields, `beginTurnBudget()`, extended dangling-tool-use scanning, shake integration; our commit switches ~8 default storage parameters. These touch different function signatures but the same file. | **Merge by function.** Our changes are surgical substitutions of `new FileSessionStorage()` → `getDefaultSessionStorage()` at call sites. Accept upstream's structural additions; re-apply our substitutions where upstream hasn't changed the default parameter. High mechanical conflict count but low semantic risk. |
| `main.ts` | Upstream PR #1503 refactored `main.ts` substantially (introduced `applyExtensionFlags`, `ExtensionRunner`, setup wizard, etc.). Our `396a9bd7a` adds `setDefaultSessionStorage` wiring for `OMP_SESSION_DB_URL`. | **Keep our wiring.** Find the `OMP_SESSION_DB_URL` block in upstream's `main.ts` and verify it's absent (confirmed absent via `git show canonical/main:packages/coding-agent/src/main.ts | grep -i SESSION_DB` — no output). Re-apply our ~15 lines of SQL wiring on top of upstream's refactored `main.ts`. |
| `args.ts` | Our `396a9bd7a` adds `--session-storage` flag. Upstream's PR #1503 refactored `parseArgs` (non-mutating copy, `flagIndex` tracking, extension-flag handling). | **Keep both.** Our `--session-storage` block is in a separate `else if` branch. Upstream's changes restructure the loop internals. The conflict will be a textual merge; accept upstream's loop structure and re-apply our `--session-storage` branch within it. |

### 3. `7e5a59033` — feat(coding-agent): add peer-coms agents

**Files touched:** `main.ts`, `test/peer-coms.test.ts`, `.omp/` files, `docs/`, `examples/extensions/peer-coms.ts`

**Upstream conflicts:**
- `main.ts`: upstream PR #1503 and subsequent commits refactored the exact `applyExtensionFlagValues` / `buildInitialMessage` section our peer-coms commit patched. Our peer-coms delta moved `buildInitialMessage` to AFTER `applyExtensionFlagValues` — that intent is now realized differently in upstream's refactored `main.ts` (the `applyExtensionFlags` helper + the re-parse gate already does it). **Resolution: verify that upstream's PR #1503 code already moves `buildInitialMessage` post-extension-flag-parse. If yes, our main.ts delta in 7e5a59033 is a no-op and can be dropped from that file's rebase conflict; keep the peer-coms.ts extension file itself.**
- `.omp/` files, `docs/peer-coms.md`, `examples/`: upstream does NOT touch these — no conflict.
- `test/peer-coms.test.ts`: upstream does NOT have this file — no conflict.

**Concrete resolution:** During rebase conflict on `main.ts`, accept upstream's version of main.ts (which has PR #1503 already applied), then check whether our `peer-coms.ts` extension's flag-stripping still works under the new `applyExtensionFlags` path. The extension flags are now processed via `applyExtensionFlags(session.extensionRunner, rawArgs)` which routes through `parseArgs` — this is the same behavior our peer-coms main.ts patch was trying to achieve.

---

## Do-NOT-Pull / Defer List

These are brought in by the rebase but warrant awareness:

| Item | Why to be aware |
|---|---|
| `dfa6007f3` recipe tool removal | If any AgentDesk task used `recipe` tool as an explicit tool call, those sessions will 400 on the next run. Verify AgentDesk's `BUILTIN_TOOLS` config doesn't specify `recipe`. |
| `2d7cd6d2d` hashline v4 BREAKING syntax | Breaking change to hashline edit format. All internal consumers (prompt, tests) are updated in upstream, but any external tooling or session transcripts that contain hashline edit blocks in old syntax will fail to parse. A session transcript is not replayed so this is only a risk if you have automation that generates hashline patches. |
| `68430dee5` mnemosyne→mnemopi rename | The `@oh-my-pi/pi-mnemosyne` npm package is renamed `@oh-my-pi/pi-mnemopi`. If any external code imports `pi-mnemosyne`, it breaks. |
| mnemopi package (all ~35 commits) | Large new package; adds `fastembed` + `onnxruntime-node` dependencies (native binaries, 100+ MB). If you are not using the memory/recall/retain tools, the package is dead weight but harmless. Evaluate whether to include it in the binary build. |
| `caeaf4e4d` builtin default rules | Adds a `discovery/builtin-rules/` directory with embedded rules loaded automatically. These rules become part of every session's system context. Review them to ensure they don't conflict with your project-specific prompting. |
| `5f6316563` setup wizard | Launches an interactive setup flow on first run if no config exists. Safe for existing installations (config file already present), but could disrupt a containerized/non-interactive deployment if the home dir is fresh. |

Items to explicitly NOT pull (or drop if they appear as cherry-picks):
- All `chore: bump version` commits (they conflict with our own version state and are meaningless mid-rebase — rebase will apply them and create conflicts; accept canonical/main's final version state).
- `a8d50879d` / `e831c2c75` / `d0e3a4c36` / `570b439b3` (pure reformats/chore) — applied automatically by rebase, no risk.

---

## mnemopi Package Evaluation

**What it is:** A full local SQLite memory engine (`@oh-my-pi/pi-mnemopi`, renamed from `packages/mnemosyne`). Provides `retain`, `recall`, `reflect` tools backed by a local SQLite database with optional vector embedding (fastembed/onnxruntime). Organized around episodic memory, temporal queries, polyphonic recall, and session-scoped visibility.

**Does anything we run depend on it?** Confirmed: `packages/coding-agent/package.json` lists `@oh-my-pi/pi-mnemopi: catalog:` as a dependency in upstream. The memory tools (`retain`/`recall`/`reflect`) are wired to it via `89b33823f` and `6b4accd05`. However: the tools only activate if `memory.backend` is enabled in the session config (`settings-schema.ts` line 114: _"memory should opt in explicitly"_). In `--mode rpc` without a `memory.backend` setting, the package is imported but the tools are not injected. **Safe to include; inert unless enabled.**

**Recommendation:** Include `packages/mnemopi/` as part of the rebase — it is additive, not required to activate. The `fastembed`/`onnxruntime-node` dependencies add bulk but Bun's `--compile` with the `process.platform === "win32"` guard (from `7bb6fb20e`) handles the darwin/Linux native load correctly. Add a note to evaluate build size impact before enabling in production.

---

## Verification Plan

After completing the rebase, run the following in order:

### 1. Type-check
```bash
bun check
```
Expected: zero errors. Hashline v4, thinking changes, and session-storage refactor are the most likely sources of type errors.

### 2. Core unit tests
```bash
# Thinking/provider layer
bun test packages/ai/test/anthropic-thinking-immutability.test.ts
bun test packages/ai/test/anthropic-abandoned-tooluse-replay.test.ts
bun test packages/ai/test/parse-streaming-json-throttled.test.ts
bun test packages/ai/test/

# Session layer
bun test packages/coding-agent/test/session/sql-session-storage.test.ts
bun test packages/coding-agent/test/session/sql-session-storage-manager.test.ts
bun test packages/coding-agent/test/session-manager/build-context.test.ts

# Extension flag / peer-coms
bun test packages/coding-agent/test/extension-flag-initial-message.test.ts
bun test packages/coding-agent/test/peer-coms.test.ts

# Agent loop
bun test packages/agent/test/

# Hashline
bun test packages/hashline/test/
```

### 3. AgentDesk RPC + SQL chunk storage smoke check
```bash
# Verify --mode rpc + --session-storage sql still starts and writes chunks
export OMP_SESSION_DB_URL=<test-postgres-url>
omp --mode rpc --session-storage sql --print "hello" 2>/dev/null | head -5
# Expect: JSON-encoded response (no 400, no thinking-block errors)

# Verify O(1) chunk writes: start a session, run a few turns, check omp_session_chunks
# In psql: SELECT count(*), max(seq) FROM omp_session_chunks WHERE path LIKE '%test%';
# Expect: seq increments monotonically; row count matches line count in the transcript
```

### 4. Thinking-block regression (most critical for Anthropic Opus sessions)
```bash
# Attempt to resume a previously-poisoned Anthropic Opus session that had
# a dangling tool-use assistant turn. With upstream's 420429df9 + our
# latestAssistantIndex guard both active, resume should reply normally (stopReason=stop)
# without a 400.
omp --session <opus-session-with-dangling-tooluse> --continue "continue"
# Expect: model responds with stopReason=stop and no 400 error in logs.
```

### 5. Full suite (optional, before ship)
```bash
bun test
```

---

## Open Questions

1. **BROKEN_THINKING_MARKER in streaming**: Our `09638b673` re-added `BROKEN_THINKING_MARKER` suppression in the _streaming_ path to prevent Claude's "I don't see any current rewritten thinking..." meta-prompt from appearing in the TUI. Upstream's `41796589a` removed this as a misdiagnosis. Our `latestAssistantIndex` guard in `convertAnthropicMessages` prevents the _replay_ hazard, but the _streaming UI_ issue (garbled thinking text appearing in the panel) is independent. If you observe garbled "rewritten thinking" text in Opus streaming sessions after the rebase, re-evaluate whether to restore the streaming suppressor in `streamAnthropic`. The suppressor itself (`suppressedThinkingBlocks` WeakSet) is low-cost.

2. **peer-coms main.ts delta coverage**: Our `7e5a59033` moved `buildInitialMessage` to after `applyExtensionFlagValues` in `main.ts`. Upstream's PR #1503 restructured this section completely. Confirm on rebase that the resulting `main.ts` correctly strips peer-coms extension flags before building the initial message. Run `bun test packages/coding-agent/test/peer-coms.test.ts` and `bun test packages/coding-agent/test/extension-flag-initial-message.test.ts` as a joint smoke.

3. **`getDefaultSessionStorage` in upstream**: Upstream's `21d152c70` did NOT add a `getDefaultSessionStorage` registry. This means our entire `--session-storage sql` CLI path and the `OMP_SESSION_DB_URL` wiring in `main.ts` are fork-only. There is no upstream issue tracking this feature. Consider opening a PR to upstream if the feature is worth sharing.

4. **mnemopi binary size**: `onnxruntime-node` + `fastembed` add significant native binary overhead. The `bun build --compile` build may grow by 50–200 MB depending on platform ORT bundles. Evaluate whether to exclude mnemopi from the binary or keep it and rely on the `process.platform === "win32"` dead-code-elimination for macOS/Linux builds.

5. **`dfa6007f3` recipe tool removal timing**: The upstream recipe tool removal is permanent. If any AgentDesk session logs reference `recipe` tool calls, those entries remain in the transcript but the tool no longer exists in `BUILTIN_TOOLS`. Verify that old sessions with recipe entries can still be resumed without errors (the tool-call cleanup in `buildSessionContext` should handle dangling tool_use blocks from deleted tools via the `pairedToolResultIds` logic).

6. **Duplicate peer-coms commit (`71e5311d3` vs `7e5a59033`)**: Both contain the same change per the commit messages, with different timestamps. Confirm via `git diff 71e5311d3 7e5a59033` before rebase that they are byte-identical (the brief says "duplicated commit") and safely drop the older `71e5311d3`.

---

## Final Summary

The recommended path is a clean rebase of 4 surviving commits (`7e5a59033`, `09638b673`, `396a9bd7a`, plus the merge commit dropped) onto `canonical/main` (`7bb6fb20e`). Drop `c8bf9df9d` (merged upstream), `ec17e694d` (superseded by upstream's session-manager thinking handling), `51cb670ac` (merge no-op), and `71e5311d3` (duplicate peer-coms). The three keeps all have non-overlapping upstream footprints: peer-coms adds new files; the thinking fix's `latestAssistantIndex` guard in `convertAnthropicMessages` is additive to upstream's `transformMessages`-layer approach; SQL chunk storage owns `sql-session-storage.ts` exclusively. The main conflict surface is `session-manager.ts` (many concurrent upstream additions) and `session-storage.ts`/`main.ts` (structural refactors), all mechanically resolvable. The 280-commit catch-up brings critical correctness fixes for Anthropic thinking replay, agent loop tool-execution gating, OpenAI streaming args, file-lock races, and a major hashline syntax upgrade.

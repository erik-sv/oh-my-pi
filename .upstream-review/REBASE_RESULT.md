# Upstream Rebase Result — fork onto canonical 15.7.3

**Status: COMPLETE on branch `rebase/upstream-15.7.3`. NOT pushed. `main` untouched. Awaiting human review.**

## What was done
Rebased our fork's unique work onto `canonical/main` @ `7bb6fb20e` (v15.7.3), pulling in
280 upstream commits (Anthropic thinking/streaming correctness, agent-loop stopReason
gating, OpenAI streaming O(N) fix, session correctness, MemorySessionStorage O(1) rewrite,
hashline v4, mnemopi package, TUI scrollback overhaul, etc.).

Executed as cherry-picks onto a fresh branch off `canonical/main` (cleaner than a 280-deep
interactive rebase; identical result, easier conflict isolation). `main` was never touched.

## Final branch shape (3 commits on top of canonical/main, 0 behind)
```
0abbaf64b feat(peer-coms): ship peer-collab skill with isolated-subnet helper
72ab985c1 perf(session): store SQL transcripts as append-only chunk rows (O(1) per write)
9f3b721af feat(coding-agent): add peer-coms agents
```
Net diff vs canonical: +3988 / -149 across 28 files — exactly our fork value
(peer-coms extension + agents + docs, peer-collab skill, SQL chunk storage), no
thinking-fix divergence.

## Disposition of our 7 original commits
| Commit | Action | Why |
|---|---|---|
| `71e5311d3` peer-coms (older base) | **dropped** | Duplicate of 7e5a59033 — same 3,180-line change at an older parent (verified via per-parent diffstat, NOT the misleading `git diff A B` the review report suggested). |
| `7e5a59033` peer-coms | **kept** → `9f3b721af` | 3 main.ts conflicts, all resolved to upstream HEAD: PR #1503's `applyExtensionFlags` already implements the post-flag `buildInitialMessage` ordering our patch did manually. Extension files applied clean. |
| `c8bf9df9d` extension-flag backport | **dropped** | Already upstream as PR #1503 (`7ad52b25f`). |
| `ec17e694d` first thinking fix | **dropped** | Superseded by upstream session-manager handling (`684af3321`/`f6bf17d8c`/`420429df9`). |
| `51cb670ac` merge commit | **dropped** | Empty after rebase. |
| `09638b673` thinking guard | **DROPPED after testing** | See "Key decision" below. |
| `396a9bd7a` SQL chunk storage | **kept** → `72ab985c1` | 2 conflicts (args.ts, selector-controller.ts), resolved (see below). Owns sql-session-storage.ts exclusively. |
| `59c1e4ea4` peer-collab skill | **kept** → `0abbaf64b` | New files only, clean. |

## Key decision: dropped the thinking guard (`09638b673`)
The review report said to keep `09638b673`'s `latestAssistantIndex` guard as "defense-in-depth."
I ported just that guard onto upstream's anthropic.ts (omitting the BROKEN_THINKING streaming
suppressor, which upstream removed in `41796589a`). It **failed an upstream test**:
`anthropic-abandoned-tooluse-replay > downgrades historical end_turn(stop) tool-use thinking to text`.

Root cause: our guard DROPS historical thinking entirely; upstream's handling (verified
end-to-end against the live Anthropic API per the test's header comment) instead strips
untrustworthy signatures and **downgrades the block to text**, preserving the reasoning content
while staying wire-valid, and replays signed historical thinking **byte-for-byte**. Upstream's
approach is strictly more complete than our fork patch AND preserves context our guard discarded.

Decision: **drop `09638b673` entirely** and rely on upstream. This does not reintroduce the
original 400 (upstream owns that path now via 4+ targeted commits, including `420429df9` which
strips dangling tool-use from ALL mid-path turns). Result: less divergence, more context
preserved, and the API-verified contract intact. After dropping: ai suite 1373/0.

## Conflicts resolved
- **main.ts** (peer-coms, 3 conflicts) → upstream HEAD; PR #1503 supersedes our manual reorder.
- **args.ts** (SQL, 1 conflict) → upstream HEAD; upstream REMOVED `BUILTIN_FLAG_NAMES` entirely
  (0 refs codebase-wide), so our `"session-storage"` addition to it was dead. The functional
  `--session-storage` parse branch + `sessionStorage` type field survived the auto-merge.
- **selector-controller.ts** (SQL, 1 conflict) → merged BOTH: upstream's `AUTO_THINKING` import
  AND our `FileSessionStorage`→`getDefaultSessionStorage` swap (body already used the latter).
- session-manager.ts / session-storage.ts / main.ts (SQL) auto-merged cleanly: all 11 factory
  defaults route through `getDefaultSessionStorage()`; our registry coexists with upstream's
  rewritten `MemorySessionStorage`.

## Workspace note
`bun install` was run (lockfile updated, docs-index regenerated) because upstream 15.7.3 adds
the `@oh-my-pi/pi-mnemopi` workspace package. The lockfile/generated-docs changes are NOT part
of the 3 feature commits — decide separately whether to commit the lockfile update.

## Verification (all green on the branch)
- Typecheck: `packages/ai` tsgo → 0 errors; `packages/coding-agent` tsgo → 0 errors.
- `bun test packages/ai/test/` → **1373 pass / 0 fail** / 337 skip.
- `bun test packages/coding-agent/test/session/ + peer-coms.test.ts` → **65 pass / 0 fail**.
- `bun test packages/coding-agent/test/session/sql-session-storage*.test.ts` → **23 pass / 0 fail**.
- `bun test extension-flag-initial-message.test.ts` → **26 pass / 0 fail**.
- `bun test anthropic-abandoned-tooluse-replay + thinking-immutability` → **6 pass / 0 fail**.
- SQL chunk parity script → "PARITY OK — 110 lines reassembled byte-identically".

## NOT yet done (human decisions required before publishing)
1. **No push.** Branch `rebase/upstream-15.7.3` is local only. `main` still at `59c1e4ea4`.
2. **Recommended publish path** (after you review):
   ```
   # fast-forward main to the rebased branch
   git checkout main && git merge --ff-only rebase/upstream-15.7.3
   # OR if you want to keep main's reflog distinct:
   git branch -f main rebase/upstream-15.7.3
   git push origin main          # this REWRITES fork main history (was 59c1e4ea4)
   ```
   Because this rewrites fork `main`, anyone tracking it must re-clone/reset. Backup branch
   `backup/main-pre-upstream-rebase-20260531` is pushed to the fork as the safety net.
3. **Full suite** (`bun test`) and **`bun check:rs`** (Rust) not run — only the affected JS/TS
   surfaces. Run the full suite before publishing if you want belt-and-suspenders.
4. **mnemopi binary size**: if you build with `bun --compile`, evaluate the onnxruntime/fastembed
   bulk (report estimated +50–200 MB) before shipping a binary.
5. **Recipe tool removal** (`dfa6007f3`) is now in: confirm no AgentDesk flow names the `recipe` tool.

## Safety state
- `main` @ `59c1e4ea4` — untouched.
- `backup/main-pre-upstream-rebase-20260531` — pushed to fork (pre-rebase main).
- `rebase/upstream-15.7.3` — the completed work, local only.

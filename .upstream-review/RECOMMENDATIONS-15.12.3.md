# Upstream fold-in review — v15.11.3 → v15.12.3

Date: 2026-06-13. Reviewer: automated.
Fork base: `v15.11.3` (branch `rebase/upstream-15.11.3`). Latest canonical release: **`v15.12.3`** (2026-06-12, `can1357/oh-my-pi`).
Delta: **329 commits** (292 non-merge: 121 fix / 91 feat / 12 perf / 11 refactor / …). **No breaking changes** (`!:`/`BREAKING` absent). Every fact below is grounded in `git show`/`git log`/file reads at the named hash.

---

## 1. Executive summary

The whole window is non-breaking and the conflict surface against our fork is tiny: only **6 source files** are touched by both our 8 local commits and upstream, at shallow depth (≤2 commits each on the critical ones). Our core perf commit's storage files (`sql-session-storage.ts`, `session-storage.ts`) are **untouched upstream** — they rebase clean.

Recommendation: **full rebase onto `v15.12.3`** (replay our 8 commits), not surgical cherry-pick. It is the lowest-drift path given no breaking changes, lands every P0/P1 cluster at once, and keeps the fork on a clean tag boundary. The marquee upstream feature of this window — **collaborative sessions / collab-web / my.omp.sh relay** — is the one thing to deliberately *exclude* from active use (it overlaps our peer-coms and AgentDesk's own sharing); it rides along as inert code after a rebase, which is fine.

---

## 2. Preserve-set — our 8 local commits (`v15.11.3..HEAD`)

| hash | commit | conflict risk |
|---|---|---|
| `a13449670` | perf(session): SQL transcripts as append-only chunk rows (omp_session_chunks) | **medium** — `session-manager.ts` (2 upstream commits); storage files clean |
| `52ed4f9c0` | chore(omp): share workflow/tool settings via project config | low — `.omp/settings.json` |
| `3c096dd2c` | fix(coding-agent): load extension asset imports via Bun's native loader | low — verify vs `51add68c8` (bun asset module decls moved to shared types) |
| `ffa7867d0` | feat(coding-agent): animated terminal title spinner while generating | low — `title-generator.ts` (1), `main.ts` |
| `a93e68309` | feat(coding-agent): tab completion in omp shell | low — `shell-cli.ts` (clean), `main.ts` |
| `6f3f18998` | chore: add update-fork-omp.sh | none |
| `c4281331f` | feat(peer-coms): ship peer-collab skill with isolated-subnet helper | none (skill/script files clean) |
| `ffccaa31b` | feat(coding-agent): add peer-coms agents | low — `main.ts`, `event-controller.ts`, `selector-controller.ts` |

Note: the May-31 review's two Anthropic thinking-block fixes (`ec17e694d`, `09638b673`) are **already gone** from the preserve-set — they were dropped at the 15.11.3 rebase because upstream superseded them. No action needed.

### Conflict map (our edits ∩ upstream edits, computed `v15.11.3..v15.12.3`)

| file | upstream commits | resolution |
|---|---|---|
| `src/session/session-manager.ts` | 2 | take upstream structure, re-apply our chunk-append hook |
| `src/main.ts` | 8 | replay our spinner + tab-completion + peer-coms init atop upstream entry |
| `src/modes/controllers/selector-controller.ts` | 9 | reconcile our session-picker tweaks vs upstream focus-mode/collab selector |
| `src/modes/controllers/event-controller.ts` | 2 | reconcile peer-coms event hooks |
| `src/cli/args.ts` | 1 | trivial |
| `src/utils/title-generator.ts` | 1 | trivial |
| `CHANGELOG.md` | (many) | keep our appended fork entries |

Storage core (`sql-session-storage.ts`, `session-storage.ts`): **0 upstream commits — clean replay.**

---

## 3. High-value pulls (acquired automatically by the rebase)

### P0 — correctness / stability, directly on AgentDesk hot paths

| cluster | hashes | benefit | risk |
|---|---|---|---|
| **AI provider resilience** (Anthropic + Codex/Responses) | `5fa3ae398` toWellFormed payload sanitize, `4e144be48` tool-use arg sanitize, `e28ae2fd8` hoist images out of error tool results, `711915307` drop Codex SSE stateful chaining (turn-scoped), `49ad75709` reset Responses session on stale replay, `25967db97` classify OpenAI ZDR 400 as chain-disable, `e31927eae` typed `ProviderHttpError` | AgentDesk runs long `--mode rpc` turns on Anthropic/Codex; these kill the 400s and stale-`previous_response_id` failures that strand a turn | low — internal to `packages/ai` |
| **RPC `get_state` schema fix** | `7c3407ac6` convert Zod tool-params → wire schema in 5 consumers (incl. RPC `get_state` `dumpTools`) | AgentDesk reads `get_state`; previously leaked Zod internals / `undefined` in the tools payload | low |
| **Catalog effort/thinking correctness** | `89059951e` regen models.json, `176157055` `thinking.requiresEffort` baking, `392a83403` OpenAI effort maps into thinking metadata, `2d44d7ff7` overlay `compat.reasoningEffortMap`, `9ff4e8c36`+`fe49e66a6` MiniMax/GPT-OSS clamp, `7aaec90ba`+`048aef12a` effort-tier variant collapsing, `efd081279` normalize cached restricted efforts, `e78e936fb` keep retired variant-id selectors resolving, `f30ec6e08` strip gateway/promo tags from display names, `a094b794b` OpenAI defaults + grouping | reinforces the AgentDesk **`max→xhigh`** thinking-routing fix: per-provider effort clamp/route now correct upstream. **`THINKING_EFFORTS` stays `[minimal,low,medium,high,xhigh]`** (verified `catalog/src/effort.ts@v15.12.3`) so the AgentDesk `omp --help` parser is future-proof | low–moderate — **verify** `omp --list-models` row content vs AgentDesk `parseOmpListModels`/`isSelectableOmpModel` (collapsing renames variant ids) |

### P1 — perf / QoL, fork-relevant

| cluster | hashes | benefit | risk |
|---|---|---|---|
| **pi-shell output minimizers** | `1f8bf8521` docker, `8ee000a0f` pip, `530e58839` go test, `3b9fd420a`+`dc701a76e` cargo, `95e3e9b11` jest, `d61cfe92f` git log, `0c799f663` gt | cleaner/cheaper bash tool output for every AgentDesk agent | very low — isolated Rust crate, no integration surface |
| **streaming / boot perf** | `a3e3a905a` defer boot + cut streaming/read CPU, `31f6afa52` incremental markdown lex, plus cold-boot lazy canonical index + content-hash `read`-summary memo (15.11.8) | per-process spawn latency + RPC streaming CPU; AgentDesk spawns one OMP process per session | low–moderate — touches boot/session path adjacent to our chunk integration; covered by smoke test |
| **`compaction.dropUseless`** (default on) | `15.12.1` | elides contextually-useless tool results (`[Uneventful result elided]`) → token savings on long sessions | low |
| **LSP formatOnWrite editorconfig** | `8b0ac67f4` | fixes hardcoded `tabSize:3` silently reindenting 2-space files on every edit | low |
| **MCP deferred connect** (15.11.8) + `d66cdfbf2` keep MCP instructions in deferred UI sessions | | non-blocking MCP discovery at boot | low (mostly UI-session scoped) |

---

## 4. Do NOT pull / defer (exclude from active use; inert after rebase is acceptable)

- **Collaborative sessions / collab-web / relay** — `3e90371f5`, `09aa87103`, `8fa1f6c25`, `b16bfbe0f`, `162c9ca42` (+ `packages/collab-web`, `packages/wire` collab contracts, `my.omp.sh`). Large parallel feature that overlaps our **peer-coms** and AgentDesk's own session sharing. Do not build/expose; pulls in relay + wire + web client. Evaluate separately if ever wanted.
- **`/share` encrypted-link rework** (`162c9ca42`) — AgentDesk has its own sharing path; not needed.
- **TUI-only**: `/settings` mouse + full-screen reorg (15.11.4 cluster), setup-wizard mouse, Agent Hub focus mode / subagent session navigation, HTML-export React tool renderers, theme palette cycling, snapcompact shape selection. AgentDesk drives `--mode rpc`, not the TUI — zero runtime benefit. Harmless after rebase; just don't chase them.
- **Platform-specific (we're Linux)**: Homebrew formula fix (`#2398`), Windows CodeGraph `.cmd`/clipboard bridges. Skip.
- **mnemopi** enhancements (`12bbefd48`, `e183efbc8`, etc.) — only relevant if AgentDesk uses local memory embeddings. Defer until confirmed; note fastembed/onnxruntime are now **optional on-demand peers** (no 270 MB eager download), so carrying mnemopi is cheaper than before.

---

## 5. Integration strategy & commands

Full rebase onto the new tag, replaying our 8 commits (same workflow as prior reviews):

```bash
cd /home/developer/src/oh-my-pi
git fetch canonical --tags                 # already done; v15.12.3 present
git checkout -b rebase/upstream-15.12.3 HEAD
git rebase --onto v15.12.3 v15.11.3        # replay our 8 local commits onto v15.12.3
# resolve the 6 files in §2 conflict map (storage core replays clean)
# after each resolve: git add -A && git rebase --continue
```

If a conflict file is dominated by upstream churn (e.g. `selector-controller.ts`, 9 commits), prefer **`--theirs` then re-apply our delta** over manual hunk surgery:

```bash
git checkout --theirs <file> && git add <file>   # take upstream, then re-introduce our peer-coms/picker hook by hand
```

Bump `package.json` version + append a fork CHANGELOG entry after the rebase lands.

---

## 6. Verification plan

1. **OMP unit tests** (the suites covering our preserved commits):
   ```bash
   cd /home/developer/src/oh-my-pi/packages/coding-agent
   bun test test/session/sql-session-storage.test.ts test/session/sql-session-storage-manager.test.ts \
            test/peer-coms.test.ts test/title-generator.test.ts test/shell-cli.test.ts \
            test/extensibility/legacy-pi-inplace-load.test.ts
   ```
2. **Build + catalog parser**: build omp, run `omp --list-models`; confirm `Canonical models` / `Provider models` headers still present (`cli/list-models.ts@v15.12.3` emits them) and that AgentDesk `lib/model-catalog.js` `parseOmpListModels`/`parseOmpProviderModels`/`isSelectableOmpModel` still resolve the collapsed ids.
3. **Thinking-level guard**: confirm `omp --help` still prints `Set thinking level: minimal, low, medium, high, xhigh`; re-run AgentDesk `node test/test-model-catalog.js` (the `max→xhigh` fix) — must stay green.
4. **AgentDesk RPC smoke**: spawn `omp --mode rpc --session-storage sql`; verify `omp_session_chunks` append (O(1) chunk rows), `get_state` returns well-formed tool schemas (post-`7c3407ac6`), `set_thinking_level('xhigh')` accepted, peer-coms spawn works.

---

## 7. Open questions

- Does AgentDesk consume **mnemopi** or **collab** at all? If not, exclude those package builds from the fork's install/bundle to keep it lean.
- **Catalog collapsing** (`7aaec90ba`) renames retired variant ids — does any AgentDesk-pinned model id (e.g. a `*-thinking` variant) need the alias table? Verify in step 2; `e78e936fb` keeps retired selectors resolving, so likely fine.
- Confirm the extension-asset Bun-loader fix (`3c096dd2c`) still composes with `51add68c8` (bun asset module decls moved to shared types) — both touch asset import resolution.

---

### Summary (3-5 lines)
Latest upstream release is **v15.12.3**, 329 non-breaking commits ahead of our v15.11.3 base. Recommend a **full rebase onto v15.12.3** — only 6 files conflict (shallow), and our SQL-chunk storage core replays clean. The valuable, fork-relevant gains are the **AI provider resilience** (Anthropic/Codex 400 + stale-replay fixes), the **RPC `get_state` Zod→wire-schema fix**, the **catalog reasoning-effort correctness** cluster (which reinforces our AgentDesk `max→xhigh` thinking fix — `THINKING_EFFORTS` is unchanged), plus **pi-shell output minimizers** and **streaming/boot perf**. Deliberately **exclude collab-sessions/collab-web** (overlaps peer-coms) and all **TUI-only** churn from active use; they ride along inert. Verify the `omp --list-models` parser and the AgentDesk SQL/RPC smoke path after the rebase.

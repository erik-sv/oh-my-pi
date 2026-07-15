---
name: spawn-detached-agent
description: Launch a detached OMP agent that survives SSH/orchestrator disconnect and signals completion back (live ping if the host is alive, or auto-resume the host if it is offline). Use when the user says "spawn a detached agent", "run this in the background so it survives disconnect", "have an agent continue while I'm offline", "kick off a long-running OMP job", "fork a worker session", or asks to ping/resume the orchestrator when a worker finishes. Complements the native task/subagent tools — use this for long jobs that must outlive the current process; use native subagents for in-process bounded work.
argument-hint: "[job-name] [what the detached agent should do]"
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash
---

# Spawn Detached Agent

Launch a long-running OMP agent in a detached tmux session that **outlives the
current SSH connection and orchestrator process**, then signals completion — a
live ping if the orchestrator is still running, or by **resuming the orchestrator
session** if it went offline. State lives on disk so a returning orchestrator can
discover results with no in-memory handle.

Helper: `${CLAUDE_SKILL_DIR}/scripts/spawn-detached.sh` (parameterized, tested).

## When to use this vs alternatives

- **This skill** — work must survive disconnect / run for a long time / report back
  asynchronously. Each job is a full separate OMP process (`omp -p`).
- **Native `task` subagents** — bounded, in-process parallel work the current agent
  waits on. Cheaper (no extra process), but dies with the parent.

## Process

1. **Resolve the model.** Default `anthropic/claude-sonnet-4-6`. Always use a
   **provider-qualified id** (`anthropic/...`, `openai/...`) — bare `claude-*` can
   fuzzy-resolve onto an unauthenticated Bedrock path. Verify with
   `omp --list-models <id>` if unsure. opus-4-8 works for detached jobs (the prior
   "opus hangs" reports were an AgentDesk-side bug, not the model).

2. **Write a SELF-CONTAINED prompt file.** This is the highest-leverage step. The
   detached agent has only this prompt as context. It MUST contain:
   - the full task + the path to any brief/spec file it should read first,
   - explicit acceptance criteria and "done" definition,
   - hard rules (read-only? no commits? don't touch unrelated files?),
   - "You are UNATTENDED — do not ask questions; record uncertainties and finish."
   - "You are STARTING FRESH" when NOT forking (see step 3).
   Keep the prompt in the repo or a job-adjacent path; the launcher copies it into
   the job dir.

3. **Fresh session vs `--fork`.** Default to a **fresh** session with a
   self-contained prompt. Only `--fork <session.jsonl>` when the worker genuinely
   needs the prior transcript. CAUTION: forking a session whose recent turns were
   "the assistant is wrapping up / handing off" makes the worker inherit that
   persona and **parrot a summary instead of doing the work** — observed failure.
   If you must fork, override hard in the prompt: "You are STARTING this task now;
   do NOT summarize or hand off; do the work."

4. **Launch** via the helper (see Invocation). Pick the completion-signal options
   that match whether the orchestrator will still be alive.

5. **Verify it actually started** (the helper does a 1s liveness check) and that it
   *implements* rather than summarizes: after ~60s, confirm the job session shows
   edit/write/bash tool calls, not just one assistant message then exit.

6. **On return, discover + VERIFY.** Read `status.json` and `worker.log`. NEVER
   trust an unattended agent's self-report — independently re-run its gates (tests,
   diffs, parity checks) before acting on its output.

## Invocation

```bash
SKILL="${CLAUDE_SKILL_DIR}/scripts/spawn-detached.sh"

# Fire-and-forget long job, fresh session:
bash "$SKILL" --job migrate-storage \
  --prompt /path/to/PROMPT.md \
  --model anthropic/claude-sonnet-4-6 --thinking high \
  --cwd /home/developer/code/myrepo

# Live ping back to my tmux session when done (orchestrator stays running):
bash "$SKILL" --job audit-deps --prompt /path/PROMPT.md \
  --notify-tmux "$(tmux display-message -p '#S' 2>/dev/null)"

# Survive my disconnect AND resume me if I'm gone when it finishes:
bash "$SKILL" --job big-refactor --prompt /path/PROMPT.md \
  --resume-orchestrator /home/developer/.omp/agent/sessions/.../<my-session>.jsonl \
  --orchestrator-pid $PPID \
  --orchestrator-model anthropic/claude-opus-4-8

# Custom completion hook (env: JOB EXIT STATUS LOG JOBDIR SENTINEL):
bash "$SKILL" --job nightly --prompt /path/PROMPT.md \
  --on-done 'echo "$JOB=$STATUS" >> ~/jobs.log'
```

### Key flags

| Flag | Purpose |
|---|---|
| `--job NAME` | kebab id → tmux session name + job dir (required) |
| `--prompt FILE` | self-contained prompt, passed as `@FILE` (required) |
| `--model ID` | provider-qualified model (default sonnet-4-6) |
| `--thinking LVL` | minimal\|low\|medium\|high\|xhigh (default high) |
| `--cwd DIR` | agent working dir (default `$PWD`) |
| `--fork FILE` | fork a session .jsonl (inherit transcript on a private copy) |
| `--notify-tmux S` | live: paste a status line into tmux session S on done |
| `--resume-orchestrator FILE` | if host offline on done, resume this session with a "worker done" prompt |
| `--orchestrator-pid PID` | liveness probe for resume (alive ⇒ skip resume) |
| `--orchestrator-model ID` | model for the resumed orchestrator |
| `--on-done "CMD"` | arbitrary shell on completion |

## How completion signalling works (and why)

The job pane runs `omp -p ... | tee log`, captures the **true omp exit via
`PIPESTATUS[0]`** (tee would otherwise mask it), then calls the script's own
`--complete` handler. That handler always runs — success, error, or crash —
because it is wired after the pipeline in the same shell, unlike the in-session
`agent_end` hook which only fires on clean agent completion.

The handler, in order:
1. writes `status.json` → `{state:done, status:ok|fail, exit, pid, ended_at}`,
2. live-pings `--notify-tmux` if that session is alive,
3. runs `--on-done`,
4. if `--resume-orchestrator` is set AND `--orchestrator-pid` is NOT alive, spawns
   a fresh detached `omp --resume <orchestrator>` with a prompt telling it a worker
   finished and to verify + continue.

**Why filesystem state, not an in-memory callback:** the whole point is surviving a
dead orchestrator. A returning host (or a brand-new one) discovers everything from
`~/.omp/detached/<job>-<ts>/` with no live handle required.

### In-session hook alternative (advanced)
For signalling from *inside* a running agent (e.g. notify on every turn), an OMP
extension can `pi.on("agent_end", …)` and `pi.exec(...)` to run a shell notifier.
Events available: `session_start/shutdown`, `agent_start/end`, `turn_start/end`,
`tool_call/result`, compaction/retry events. Load with `-e <ext>.ts`. Prefer the
trailing-shell handler above for "job finished" — it also fires on crash/non-zero
exit, which `agent_end` does not.

## Discovery (returning orchestrator)

```bash
ls -t ~/.omp/detached/                         # recent jobs (newest first)
cat ~/.omp/detached/<job>-<ts>/status.json     # done? ok/fail? exit code?
tail -n 100 ~/.omp/detached/<job>-<ts>/worker.log
tmux attach -t <job>                           # if still within the post-exit keepalive
```

`status.json` schema: `{job, state:running|done, status:ok|fail|null, exit, pid,
started_at, ended_at, log, cwd}`.

## Constraints

- **Self-contained prompts only.** The worker shares no memory with you; a vague
  one-line prompt produces vague work. Front-load every fact, path, and acceptance
  criterion. This is the #1 determinant of success.
- **Provider-qualified models.** Bare names risk silent Bedrock misresolution and
  hangs. Verify with `omp --list-models`.
- **Verify, don't trust.** Re-run the worker's gates yourself before acting on
  results — unattended agents misreport. (A real worker once claimed "DONE" while a
  forked sibling had only parroted a summary.)
- **Resource cost.** Each job is a full OMP process (~hundreds of MiB RSS + provider
  load). Don't fan out dozens. Shut down stale jobs: `tmux kill-session -t <job>`.
- **Default to file session storage** for workers (the launcher does not pass
  `--session-storage sql`), so a worker fixing the SQL path doesn't depend on it.
- **`--read-only` is a documentation hint only** — enforce read-only by saying so in
  the prompt; the launcher does not sandbox tools.
- **Auth is inherited** from the same Unix user + `$HOME` (`~/.omp` credential
  vault). A detached job as the same user authenticates exactly like an interactive
  one; no secrets are passed on the command line.
```

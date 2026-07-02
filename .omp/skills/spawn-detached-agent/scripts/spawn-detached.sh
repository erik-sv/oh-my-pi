#!/usr/bin/env bash
# spawn-detached.sh — launch a detached, disconnect-surviving OMP agent and
# signal completion back to an orchestrator (live ping if it's alive, or resume
# it if it's offline).
#
# Two modes:
#   (default)    launch a job
#   --complete   internal completion handler (invoked by the job's own shell on exit)
#
# A "job" is a fresh (or forked) `omp -p` run inside a detached tmux session.
# tmux's server reparents to init, so the job outlives the SSH/orchestrator that
# started it. All state lives under a per-job dir so a returning orchestrator can
# discover results without any in-memory handle.
#
# LAUNCH USAGE
#   spawn-detached.sh --job NAME --prompt FILE [options]
#
#   Required:
#     --job NAME            short kebab id (tmux session + job dir name)
#     --prompt FILE         path to a self-contained prompt (passed to omp as @FILE)
#
#   Common:
#     --model MODEL         default: anthropic/claude-sonnet-4-6  (use a provider-
#                           qualified id to avoid fuzzy->Bedrock misresolution)
#     --thinking LEVEL      minimal|low|medium|high|xhigh  (default: high)
#     --cwd DIR             working dir for the agent (default: $PWD)
#     --fork SESSION_FILE   fork this .jsonl (inherit transcript on a private copy).
#                           Omit for a fresh session (recommended for self-contained
#                           briefs — forking can leak the parent's persona).
#     --read-only           hint only; document tool limits in the prompt itself.
#
#   Completion signalling (all optional):
#     --notify-tmux SESSION       on done, paste a one-line status into this tmux
#                                 session's pane (live orchestrator ping).
#     --resume-orchestrator FILE  on done, if the orchestrator is NOT alive, spawn
#                                 a fresh detached omp that resumes/forks this
#                                 session .jsonl with a "worker done" prompt.
#     --orchestrator-pid PID      liveness probe for --resume-orchestrator (alive =
#                                 kill -0 PID). If alive, resume is skipped (the
#                                 live orchestrator is expected to read the sentinel).
#     --orchestrator-model MODEL  model for the resumed orchestrator (default: --model)
#     --on-done "CMD"             arbitrary shell run on completion with env:
#                                 JOB, EXIT, STATUS(ok|fail), LOG, JOBDIR, SENTINEL.
#
# DISCOVERY (for a returning orchestrator)
#   Job dir:   ~/.omp/detached/<job>-<timestamp>/
#     status.json   running|done sentinel (job, pid, exit, status, started/ended)
#     worker.log    full stdout/stderr
#     prompt.md     copy of the prompt
#   List jobs:        ls -t ~/.omp/detached/
#   Tail a job:       tail -f ~/.omp/detached/<dir>/worker.log
#   Is it done?       cat  ~/.omp/detached/<dir>/status.json
set -uo pipefail

OMP_BIN="${OMP_BIN:-/home/developer/.bun/bin/omp}"   # overridable for tests
DETACHED_ROOT="${OMP_DETACHED_ROOT:-$HOME/.omp/detached}"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

die() { echo "spawn-detached: $*" >&2; exit 1; }

# ── completion handler (runs inside the job's own shell after omp exits) ───────
if [ "${1:-}" = "--complete" ]; then
  shift
  JOBDIR=""; EXIT="1"
  while [ $# -gt 0 ]; do case "$1" in
    --job-dir) JOBDIR="$2"; shift 2;;
    --exit) EXIT="$2"; shift 2;;
    *) shift;;
  esac; done
  [ -n "$JOBDIR" ] || die "--complete requires --job-dir"
  # shellcheck disable=SC1091
  . "$JOBDIR/job.env" 2>/dev/null || true
  STATUS="ok"; [ "$EXIT" = "0" ] || STATUS="fail"
  ENDED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  SENTINEL="$JOBDIR/status.json"
  cat > "$SENTINEL" <<JSON
{"job":"${JOB:-?}","state":"done","status":"$STATUS","exit":$EXIT,"pid":${WORKER_PID:-null},"started_at":"${STARTED:-}","ended_at":"$ENDED","log":"$JOBDIR/worker.log","cwd":"${CWD:-}"}
JSON
  echo "=== job '${JOB:-?}' done: status=$STATUS exit=$EXIT at $ENDED ===" | tee -a "$JOBDIR/worker.log"

  # 1) live ping
  if [ -n "${NOTIFY_TMUX:-}" ] && tmux has-session -t "$NOTIFY_TMUX" 2>/dev/null; then
    tmux send-keys -t "$NOTIFY_TMUX" \
      "# [detached:${JOB}] finished status=$STATUS exit=$EXIT — see $SENTINEL" 2>/dev/null || true
  fi

  # 2) custom hook
  if [ -n "${ON_DONE:-}" ]; then
    JOB="$JOB" EXIT="$EXIT" STATUS="$STATUS" LOG="$JOBDIR/worker.log" JOBDIR="$JOBDIR" SENTINEL="$SENTINEL" \
      bash -c "$ON_DONE" || true
  fi

  # 3) resume orchestrator if it's offline
  if [ -n "${RESUME_ORCH:-}" ]; then
    orch_alive=1
    if [ -n "${ORCH_PID:-}" ]; then kill -0 "$ORCH_PID" 2>/dev/null || orch_alive=0; else orch_alive=0; fi
    if [ "$orch_alive" = "0" ]; then
      RPROMPT="$JOBDIR/resume-prompt.md"
      cat > "$RPROMPT" <<MD
A detached worker you dispatched has finished.

- job: ${JOB}
- status: $STATUS (exit $EXIT)
- log: $JOBDIR/worker.log
- result sentinel: $SENTINEL

Read the worker's log/output, verify its work against your acceptance criteria
(do not trust its self-report), and continue the task from where you left off.
MD
      RSESSION="orch-resume-${JOB}"
      tmux has-session -t "$RSESSION" 2>/dev/null && tmux kill-session -t "$RSESSION"
      tmux new-session -d -s "$RSESSION" -x 220 -y 50 -c "${CWD:-$HOME}" \
        "'$OMP_BIN' -p --resume '$RESUME_ORCH' --model '${ORCH_MODEL:-anthropic/claude-sonnet-4-6}' --thinking high --auto-approve '@$RPROMPT' 2>&1 | tee '$JOBDIR/orchestrator-resume.log'; sleep 86400" \
        2>/dev/null \
        && echo "=== orchestrator offline; resumed in tmux '$RSESSION' ===" | tee -a "$JOBDIR/worker.log" \
        || echo "=== WARN: failed to resume orchestrator ===" | tee -a "$JOBDIR/worker.log"
    fi
  fi
  exit 0
fi

# ── launch ─────────────────────────────────────────────────────────────────
JOB=""; PROMPT=""; MODEL="anthropic/claude-sonnet-4-6"; THINKING="high"
CWD="$PWD"; FORK=""; NOTIFY_TMUX=""; RESUME_ORCH=""; ORCH_PID=""; ORCH_MODEL=""; ON_DONE=""
while [ $# -gt 0 ]; do case "$1" in
  --job) JOB="$2"; shift 2;;
  --prompt) PROMPT="$2"; shift 2;;
  --model) MODEL="$2"; shift 2;;
  --thinking) THINKING="$2"; shift 2;;
  --cwd) CWD="$2"; shift 2;;
  --fork) FORK="$2"; shift 2;;
  --read-only) shift;;  # documentation hint only
  --notify-tmux) NOTIFY_TMUX="$2"; shift 2;;
  --resume-orchestrator) RESUME_ORCH="$2"; shift 2;;
  --orchestrator-pid) ORCH_PID="$2"; shift 2;;
  --orchestrator-model) ORCH_MODEL="$2"; shift 2;;
  --on-done) ON_DONE="$2"; shift 2;;
  *) die "unknown arg: $1";;
esac; done

[ -n "$JOB" ]    || die "--job is required"
[ -n "$PROMPT" ] || die "--prompt is required"
[ -f "$PROMPT" ] || die "prompt file not found: $PROMPT"
command -v tmux >/dev/null || die "tmux not found"
[ -x "$OMP_BIN" ] || die "omp binary not found/executable: $OMP_BIN"
[ -z "$FORK" ] || [ -f "$FORK" ] || die "--fork session file not found: $FORK"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
JOBDIR="$DETACHED_ROOT/${JOB}-${TS}"
mkdir -p "$JOBDIR" || die "cannot create job dir: $JOBDIR"
cp "$PROMPT" "$JOBDIR/prompt.md"
PROMPT="$JOBDIR/prompt.md"
LOG="$JOBDIR/worker.log"
SESSION="$JOB"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# persist job context for the completion handler
cat > "$JOBDIR/job.env" <<ENV
JOB="$JOB"
CWD="$CWD"
STARTED="$STARTED"
NOTIFY_TMUX="$NOTIFY_TMUX"
RESUME_ORCH="$RESUME_ORCH"
ORCH_PID="$ORCH_PID"
ORCH_MODEL="$ORCH_MODEL"
ON_DONE=$(printf '%q' "$ON_DONE")
ENV

# running sentinel
cat > "$JOBDIR/status.json" <<JSON
{"job":"$JOB","state":"running","status":null,"exit":null,"pid":null,"started_at":"$STARTED","ended_at":null,"log":"$LOG","cwd":"$CWD"}
JSON

FORK_ARG=""; [ -n "$FORK" ] && FORK_ARG="--fork '$FORK'"

tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION"

# The pane: run omp, capture true omp exit via PIPESTATUS (tee would mask it),
# record the worker pid, then invoke the completion handler. `sleep 86400` keeps
# the pane attachable briefly after exit for inspection.
tmux new-session -d -s "$SESSION" -x 220 -y 50 -c "$CWD" \
  "bash -c \"echo \\\$\\\$ > '$JOBDIR/worker.pid'; '$OMP_BIN' -p $FORK_ARG --model '$MODEL' --thinking '$THINKING' --auto-approve '@$PROMPT' 2>&1 | tee '$LOG'; ec=\\\${PIPESTATUS[0]}; sed -i \\\"s/\\\\\\\"pid\\\\\\\":null/\\\\\\\"pid\\\\\\\":\\\$(cat '$JOBDIR/worker.pid')/\\\" '$JOBDIR/status.json' 2>/dev/null; WORKER_PID=\\\$(cat '$JOBDIR/worker.pid') '$SELF' --complete --job-dir '$JOBDIR' --exit \\\$ec; sleep 86400\""

sleep 1
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "launched detached job '$JOB'"
  echo "  tmux:     tmux attach -t $SESSION"
  echo "  job dir:  $JOBDIR"
  echo "  log:      $LOG"
  echo "  status:   $JOBDIR/status.json"
else
  die "tmux session '$SESSION' failed to start (see $LOG)"
fi

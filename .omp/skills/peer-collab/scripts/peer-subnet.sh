#!/usr/bin/env bash
# peer-subnet.sh — manage an ISOLATED peer-coms subnet owned by a host agent.
#
# Canonical, version-controlled home: <oh-my-pi>/.omp/skills/peer-collab/scripts/.
# Ships with OMP so peer collaboration is a stable, first-class capability.
#
# Why this exists: peer-coms discovers peers through a shared registry dir
# (OMP_PEER_COMS_DIR, default ~/.omp/agent/peer-coms) and a --peer-project
# namespace. Loading the extension on the default network makes EVERY omp session
# (incl. unrelated tasks and AgentDesk backends) a visible, interruptible peer.
# This script instead gives the host a PRIVATE registry dir (a "subnet") no other
# session can see, then spawns peers into it. Peers inherit the subnet dir +
# project + a parent-process lease, so they self-terminate when the host exits.
#
# SUBCOMMANDS
#   new      --task ID [--project P]                          create subnet, print host env
#   host-env --task ID                                        eval-able exports to join ONLY this subnet
#   spawn    --task ID --name N --purpose P [--model M] [--agent A] [--prompt FILE] [--project P]
#   list     --task ID [--project P]                          show registered peers
#   shutdown --task ID                                        kill all peers + remove the subnet
#
# Subnet layout: ${OMP_PEER_SUBNET_ROOT:-~/.omp/agent/peer-subnets}/<task>/
#   registry/   <- OMP_PEER_COMS_DIR for every member
#   peers/      <- per-peer logs
#   subnet.env  <- sourced by members
set -uo pipefail

# ── robust path resolution (no hardcoded worktree) ───────────────────────────
# Extension lives at <repo>/packages/coding-agent/examples/extensions/peer-coms.ts.
# Resolve order: explicit override -> derive repo root from the installed `omp`
# binary realpath (.../packages/coding-agent/src/cli.ts) -> this script's own
# location (…/.omp/skills/peer-collab/scripts) -> give up with a clear error.
resolve_ext() {
  if [ -n "${PEER_COMS_EXT:-}" ] && [ -f "${PEER_COMS_EXT}" ]; then echo "$PEER_COMS_EXT"; return 0; fi
  local cli root cand
  cli="$(command -v omp 2>/dev/null)" && cli="$(readlink -f "$cli" 2>/dev/null)"
  if [ -n "${cli:-}" ]; then
    root="${cli%/packages/coding-agent/src/cli.ts}"
    cand="$root/packages/coding-agent/examples/extensions/peer-coms.ts"
    [ -f "$cand" ] && { echo "$cand"; return 0; }
  fi
  # script is at <repo>/.omp/skills/peer-collab/scripts/peer-subnet.sh
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root="${here%/.omp/skills/peer-collab/scripts}"
  cand="$root/packages/coding-agent/examples/extensions/peer-coms.ts"
  [ -f "$cand" ] && { echo "$cand"; return 0; }
  return 1
}

OMP_BIN="${OMP_BIN:-$(command -v omp || echo /home/developer/.bun/bin/omp)}"
SUBNET_ROOT="${OMP_PEER_SUBNET_ROOT:-$HOME/.omp/agent/peer-subnets}"
DEFAULT_PROJECT="collab"

die() { echo "peer-subnet: $*" >&2; exit 1; }
subnet_dir() { echo "$SUBNET_ROOT/$1"; }
registry_dir() { echo "$SUBNET_ROOT/$1/registry"; }

cmd="${1:-}"; shift || true
TASK=""; NAME=""; PURPOSE=""; MODEL="anthropic/claude-sonnet-4-6"; AGENT=""; PROMPT=""; PROJECT="$DEFAULT_PROJECT"
while [ $# -gt 0 ]; do case "$1" in
  --task) TASK="$2"; shift 2;;
  --name) NAME="$2"; shift 2;;
  --purpose) PURPOSE="$2"; shift 2;;
  --model) MODEL="$2"; shift 2;;
  --agent) AGENT="$2"; shift 2;;
  --prompt) PROMPT="$2"; shift 2;;
  --project) PROJECT="$2"; shift 2;;
  *) die "unknown arg: $1";;
esac; done

[ -n "$TASK" ] || die "--task ID is required"
case "$TASK" in *[!a-zA-Z0-9_-]*) die "--task must be kebab/alnum (no slashes/spaces)";; esac
SDIR="$(subnet_dir "$TASK")"; REG="$(registry_dir "$TASK")"

case "$cmd" in
  new)
    [ -x "$OMP_BIN" ] || command -v "$OMP_BIN" >/dev/null || die "omp not found: $OMP_BIN"
    command -v tmux >/dev/null || die "tmux not found"
    EXT="$(resolve_ext)" || die "peer-coms extension not found (set PEER_COMS_EXT or ensure omp is installed from the oh-my-pi repo)"
    mkdir -p "$REG" "$SDIR/peers" || die "cannot create subnet $SDIR"
    cat > "$SDIR/subnet.env" <<ENV
# Isolated peer-coms subnet for task '$TASK'. Source before running any member.
export OMP_PEER_COMS_DIR="$REG"
export PEER_COMS_EXT="$EXT"
export PEER_COMS_TASK="$TASK"
export PEER_COMS_PROJECT="$PROJECT"
ENV
    echo "subnet created: $SDIR"
    echo "  registry (OMP_PEER_COMS_DIR): $REG"
    echo "  extension: $EXT"
    echo "  project: $PROJECT"
    echo
    echo "Run the HOST agent bound to ONLY this subnet:"
    echo "  OMP_PEER_COMS_DIR='$REG' omp -e '$EXT' --peer-project '$PROJECT' --peer-name host ..."
    ;;

  host-env)
    [ -d "$REG" ] || die "subnet '$TASK' not found — run: peer-subnet.sh new --task $TASK"
    # shellcheck disable=SC1090
    . "$SDIR/subnet.env"
    echo "export OMP_PEER_COMS_DIR='$REG'"
    echo "export PEER_COMS_EXT='${PEER_COMS_EXT}'"
    echo "export PEER_COMS_PROJECT='${PEER_COMS_PROJECT:-$PROJECT}'"
    echo "# host flags: -e \"\$PEER_COMS_EXT\" --peer-project \"\$PEER_COMS_PROJECT\" --peer-name host"
    ;;

  spawn)
    [ -d "$REG" ] || die "subnet '$TASK' not found — run: peer-subnet.sh new --task $TASK"
    [ -n "$NAME" ] || die "spawn requires --name"
    [ -n "$PURPOSE" ] || die "spawn requires --purpose (peers act on their purpose)"
    case "$NAME" in *[!a-zA-Z0-9_-]*) die "--name must be kebab/alnum";; esac
    # shellcheck disable=SC1090
    . "$SDIR/subnet.env"
    EXT="${PEER_COMS_EXT}"
    [ -f "$EXT" ] || EXT="$(resolve_ext)" || die "peer-coms extension not found"
    [ -z "$PROMPT" ] || [ -f "$PROMPT" ] || die "--prompt file not found: $PROMPT"
    AGENT_ARG=""; [ -n "$AGENT" ] && AGENT_ARG="--peer-agent '$AGENT'"
    PROMPT_ARG=""; [ -n "$PROMPT" ] && PROMPT_ARG="--append-system-prompt '@$PROMPT'"
    SESSION="peer-${TASK}-${NAME}"
    LOG="$SDIR/peers/${NAME}.log"
    PARENT_PID="${OMP_PEER_HOST_PID:-$PPID}"
    tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION"
    tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "${PWD}" \
      "OMP_PEER_COMS_DIR='$REG' OMP_PEER_COMS_PARENT_PID='$PARENT_PID' '$OMP_BIN' -e '$EXT' $AGENT_ARG --peer-name '$NAME' --peer-purpose '$PURPOSE' --peer-project '$PROJECT' --model '$MODEL' --thinking high $PROMPT_ARG 'You are peer \"$NAME\" in an isolated collaboration subnet. Purpose: $PURPOSE. Stay idle until you receive a peer message, then answer it directly and concisely as a normal assistant reply (do NOT call peer_send merely to answer). You may consult other named peers in this subnet if it helps.' 2>&1 | tee '$LOG'; sleep 86400"
    sleep 2
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "spawned peer '$NAME' (model $MODEL) into subnet '$TASK' (project $PROJECT)"
      echo "  tmux: tmux attach -t $SESSION   log: $LOG"
      echo "  reach it from a host with peer_send({target:'$NAME', prompt:'...'})"
    else
      die "peer '$NAME' failed to start (see $LOG)"
    fi
    ;;

  list)
    [ -d "$REG" ] || die "subnet '$TASK' not found"
    echo "subnet '$TASK' registry: $REG (project filter: $PROJECT)"
    found=0
    for f in "$REG/projects/$PROJECT/agents/"*.json; do
      [ -f "$f" ] || continue
      found=1
      python3 -c "import json; d=json.load(open('$f')); print(' \u25cf', d.get('name'), '('+str(d.get('model'))+')', '-', d.get('purpose',''))" 2>/dev/null \
        || echo " - $(basename "$f" .json)"
    done
    [ "$found" = "1" ] || echo " (no live peers registered)"
    ;;

  shutdown)
    [ -d "$SDIR" ] || die "subnet '$TASK' not found"
    echo "shutting down subnet '$TASK'..."
    for s in $(tmux ls -F '#S' 2>/dev/null | grep -E "^peer-${TASK}-"); do
      tmux kill-session -t "$s" 2>/dev/null && echo "  killed $s"
    done
    pkill -f "OMP_PEER_COMS_DIR=$REG" 2>/dev/null || true
    sleep 1
    rm -rf "$SDIR" && echo "  removed $SDIR"
    ;;

  *) die "usage: peer-subnet.sh {new|host-env|spawn|list|shutdown} --task ID [...]";;
esac

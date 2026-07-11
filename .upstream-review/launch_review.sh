#!/usr/bin/env bash
# Detached sonnet-4-6 OMP agent that produces an upstream-review recommendation
# report (READ-ONLY analysis). Fresh session (self-contained prompt+brief).
# Survives SSH disconnect via tmux (server reparents to init).
#   attach:  tmux attach -t upreview
#   log:     tail -f /home/developer/src/oh-my-pi/.upstream-review/worker.log
set -uo pipefail

OMP=/home/developer/.bun/bin/omp
PROMPT_FILE="/home/developer/src/oh-my-pi/.upstream-review/PROMPT.md"
LOG="/home/developer/src/oh-my-pi/.upstream-review/worker.log"
WORKDIR="/home/developer/src/oh-my-pi"
SESSION=upreview

[ -f "$PROMPT_FILE" ] || { echo "FATAL: prompt missing: $PROMPT_FILE"; exit 1; }
tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION"

tmux new-session -d -s "$SESSION" -x 220 -y 50 -c "$WORKDIR" \
  "'$OMP' -p --model anthropic/claude-sonnet-4-6 --thinking high --auto-approve '@$PROMPT_FILE' 2>&1 | tee '$LOG'; echo; echo '=== REVIEW AGENT EXITED (code '\$?') ==='; sleep 86400"

sleep 1
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "launched tmux session '$SESSION' (sonnet-4-6 review agent running)"
  echo "  attach: tmux attach -t $SESSION"
  echo "  log:    $LOG"
  echo "  report will appear at: $WORKDIR/.upstream-review/RECOMMENDATIONS.md"
else
  echo "FAILED to launch '$SESSION'"; exit 1
fi

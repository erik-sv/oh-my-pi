#!/usr/bin/env bash
# update-fork-omp.sh — update an OMP install to the latest erik-sv/oh-my-pi fork main.
#
# Run on any machine that should track OUR fork (not canonical npm). Idempotent.
# Handles the force-pushed history rewrite (uses reset --hard, not pull) and
# (re)links the `omp` binary to the source checkout.
#
# Usage:
#   scripts/update-fork-omp.sh                 # update the checkout this script lives in
#   FORK_DIR=/path/to/oh-my-pi update-fork-omp.sh   # update a specific checkout
#   FORK_DIR=/path/to/clone FORK_CLONE=1 update-fork-omp.sh   # clone fresh if missing
set -euo pipefail

FORK_URL="${FORK_URL:-https://github.com/erik-sv/oh-my-pi.git}"
# Default to the repo this script ships in; override with FORK_DIR on fresh machines.
FORK_DIR="${FORK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mupdate-fork-omp: %s\033[0m\n' "$*" >&2; exit 1; }

command -v git  >/dev/null || die "git not found"
command -v bun  >/dev/null || die "bun not found (install from https://bun.sh)"

# 1) Ensure the checkout exists (optionally clone).
if [ ! -d "$FORK_DIR/.git" ]; then
  if [ "${FORK_CLONE:-0}" = "1" ]; then
    say "cloning $FORK_URL -> $FORK_DIR"
    git clone "$FORK_URL" "$FORK_DIR"
  else
    die "no git checkout at $FORK_DIR (set FORK_CLONE=1 to clone, or FORK_DIR to point at your checkout)"
  fi
fi

cd "$FORK_DIR"

# 2) Point 'origin' at our fork (don't disturb a 'canonical' remote if present).
if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "$FORK_URL"
elif [ "$(git remote get-url origin)" != "$FORK_URL" ]; then
  say "note: origin is $(git remote get-url origin) (expected $FORK_URL) — leaving as-is; fetching it"
fi

# 3) Guard local work: refuse to clobber uncommitted changes unless FORCE=1.
if ! git diff --quiet || ! git diff --cached --quiet; then
  if [ "${FORCE:-0}" = "1" ]; then
    say "FORCE=1: stashing local changes to wip-$(date +%s)"
    git stash push -u -m "update-fork-omp autostash $(date -u +%FT%TZ)" || true
  else
    die "uncommitted changes in $FORK_DIR. Commit/stash them, or re-run with FORCE=1 to autostash."
  fi
fi

# 4) Fetch and hard-align to fork main. Fork main is force-pushed (history
#    rewrite on each upstream rebase), so a fast-forward pull would refuse —
#    reset --hard is the correct, intended operation here.
say "fetching origin"
git fetch origin --prune
say "aligning local main to origin/main (history may have been rewritten)"
git checkout -B main origin/main

# 5) Install workspace deps (new packages like pi-mnemopi, native bits).
say "bun install"
bun install

# 5.5) Ensure the host's native addon exists. `*.node` is gitignored and the
#      workspace ships no prebuilt, so a fresh checkout on ANY OS must compile
#      crates/pi-natives once (needs a Rust toolchain; rust-toolchain.toml pins
#      the nightly, which rustup auto-installs). Idempotent: skip when a matching
#      .node is already built.
NATIVE_DIR="$FORK_DIR/packages/natives/native"
HOST_TAG="$(bun -e 'process.stdout.write(process.platform + "-" + process.arch)')"
if compgen -G "$NATIVE_DIR/pi_natives.${HOST_TAG}"'*.node' >/dev/null; then
  say "native addon for $HOST_TAG already present"
else
  command -v cargo >/dev/null \
    || die "native addon for $HOST_TAG is missing and no Rust toolchain found. Install rustup (https://rustup.rs), then re-run."
  say "building native addon for $HOST_TAG (one-time; requires Rust)"
  bun --cwd=packages/natives run build
fi

# 6) (Re)link the omp binary to this checkout's source, so `omp` runs the fork.
#    Safe to re-run; bun link is idempotent.
say "linking omp -> $FORK_DIR/packages/coding-agent"
( cd packages/coding-agent && bun link >/dev/null 2>&1 || true )
bun link @oh-my-pi/pi-coding-agent >/dev/null 2>&1 || true

# 6.5) Register the last30days research skill via OMP's marketplace (idempotent,
#      best-effort). Lightweight reference: NO third-party code is vendored into
#      this fork — `omp plugin` fetches it into ~/.omp/plugins on each machine and
#      `marketplace.autoUpdate` keeps it current. Runtime needs Python 3.12+ on PATH;
#      key-free sources (reddit/hackernews/polymarket/github) work out of the box,
#      while X/YouTube/TikTok/etc. need their own API keys. The skill is third-party
#      and flagged High-Risk by its own installer scan (reads browser cookies, hits
#      many external APIs) — prefer running it sandboxed with explicit env.
if command -v omp >/dev/null; then
  say "registering last30days skill marketplace (mvanhorn/last30days-skill)"
  omp plugin marketplace list 2>/dev/null | grep -q 'last30days-skill' \
    || omp plugin marketplace add mvanhorn/last30days-skill || true
  omp plugin list 2>/dev/null | grep -q 'last30days@last30days-skill' \
    || omp plugin install last30days@last30days-skill || true
fi

# 7) Report.
HEAD_SHA="$(git rev-parse --short HEAD)"
VER="$(grep -m1 '"version"' packages/coding-agent/package.json | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo '?')"
say "done: $FORK_DIR @ $HEAD_SHA (pi-coding-agent $VER)"
if command -v omp >/dev/null; then
  say "omp resolves to: $(readlink -f "$(command -v omp)" 2>/dev/null || command -v omp)"
  say "omp --version: $(omp --version 2>/dev/null || echo '(run omp --version manually)')"
else
  say "NOTE: 'omp' not on PATH. Add bun's global bin to PATH (e.g. ~/.bun/bin) or create a symlink."
fi

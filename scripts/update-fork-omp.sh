#!/usr/bin/env bash
# update-fork-omp.sh — update an OMP install to the latest erik-sv/oh-my-pi fork main.
#
# Run on any machine that should track OUR fork (not canonical npm). Idempotent.
# Handles the force-pushed history rewrite (uses reset --hard, not pull) and
# (re)links the `omp` binary to the source checkout.
#
# Usage:
#   scripts/update-fork-omp.sh                          # update this checkout
#   FORK_DIR=/path/to/oh-my-pi update-fork-omp.sh      # update another checkout
#   FORK_DIR=/path/to/clone FORK_CLONE=1 update-fork-omp.sh
#   OMP_PRIVATE_SKILLS=1 update-fork-omp.sh             # bootstrap private skills too
set -euo pipefail

FORK_URL="${FORK_URL:-https://github.com/erik-sv/oh-my-pi.git}"
FORK_REMOTE="omp-fork"
# Default to the repo this script ships in; override with FORK_DIR on fresh machines.
FORK_DIR="${FORK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PRIVATE_SKILLS_MODE="${OMP_PRIVATE_SKILLS:-auto}"
PRIVATE_SKILLS_DIR="${OMP_SKILLS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/omp/omp-skills}"

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

# 2) Maintain a dedicated remote for the hosted fork. Existing checkouts may use
#    origin for an internal mirror or another upstream; never fetch the update
#    source through that unrelated remote.
if git remote get-url "$FORK_REMOTE" >/dev/null 2>&1; then
  if [ "$(git remote get-url "$FORK_REMOTE")" != "$FORK_URL" ]; then
    say "updating $FORK_REMOTE remote -> $FORK_URL"
    git remote set-url "$FORK_REMOTE" "$FORK_URL"
  fi
else
  say "adding $FORK_REMOTE remote -> $FORK_URL"
  git remote add "$FORK_REMOTE" "$FORK_URL"
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
say "fetching $FORK_REMOTE"
git fetch "$FORK_REMOTE" --prune
say "aligning local main to $FORK_REMOTE/main (history may have been rewritten)"
git checkout -B main "$FORK_REMOTE/main"

# 5) Install workspace deps (new packages like pi-mnemopi, native bits).
say "bun install"
bun install

# 5.5) Ensure the host's native addon is present AND matches this release.
#      `*.node` is gitignored and the workspace ships no prebuilt, so a fresh
#      checkout on ANY OS must compile crates/pi-natives once (needs a Rust
#      toolchain; rust-toolchain.toml pins the nightly, which rustup
#      auto-installs). The addon is rebuilt in lock-step with the package
#      version: napi-rs emits a `__piNativesV{major}_{minor}_{patch}` sentinel
#      symbol whose name encodes the version (packages/natives loader-state.js).
#      A `.node` left from a previous release lacks the current sentinel and
#      MUST be rebuilt — a host-tag match ALONE is not enough, or a post-upgrade
#      dev tree silently runs a stale addon missing the new native exports
#      (workspace loads skip the loader's version validation). The sentinel name
#      is embedded as a string in the compiled .node, so a crash-free `grep`
#      (no dlopen, so no SIGILL on a CPU-variant mismatch) settles freshness.
#      Idempotent: skip only when a host-tag .node embeds the current sentinel.
NATIVE_DIR="$FORK_DIR/packages/natives/native"
HOST_TAG="$(bun -e 'process.stdout.write(process.platform + "-" + process.arch)')"
NATIVE_VER="$(grep -m1 '"version"' packages/natives/package.json | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo '0.0.0')"
SENTINEL="__piNativesV$(printf '%s' "$NATIVE_VER" | tr -c 'A-Za-z0-9' '_')"
native_addon_current() {
  local f
  for f in "$NATIVE_DIR/pi_natives.${HOST_TAG}"*.node; do
    [ -e "$f" ] || continue
    grep -qa "$SENTINEL" "$f" && return 0
  done
  return 1
}
if native_addon_current; then
  say "native addon for $HOST_TAG matches pi-natives@$NATIVE_VER ($SENTINEL present)"
else
  command -v cargo >/dev/null \
    || die "native addon for $HOST_TAG is missing or stale (need sentinel $SENTINEL) and no Rust toolchain found. Install rustup (https://rustup.rs), then re-run."
  say "building native addon for $HOST_TAG @ $NATIVE_VER (compiles crates/pi-natives; requires Rust)"
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

# 6.6) Sync Encypher's private skill library when explicitly enabled on a new
#      machine, or automatically after the checkout has been bootstrapped once.
#      Private skills remain outside this public fork. The helper refuses dirty
#      or divergent skill checkouts, validates frontmatter before linking, and
#      installs into OMP's native user skill root.
case "$PRIVATE_SKILLS_MODE" in
  1|true|yes)
    SYNC_PRIVATE_SKILLS=true
    ;;
  0|false|no)
    SYNC_PRIVATE_SKILLS=false
    ;;
  auto)
    if [ -d "$PRIVATE_SKILLS_DIR/.git" ]; then
      SYNC_PRIVATE_SKILLS=true
    else
      SYNC_PRIVATE_SKILLS=false
    fi
    ;;
  *)
    die "OMP_PRIVATE_SKILLS must be auto, 1, or 0"
    ;;
esac

if [ "$SYNC_PRIVATE_SKILLS" = true ]; then
  say "syncing private OMP skills"
  OMP_SKILLS_DIR="$PRIVATE_SKILLS_DIR" "$FORK_DIR/scripts/sync-private-skills.sh"
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

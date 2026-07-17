#!/bin/sh
set -eu

REPOSITORY="${OMP_SKILLS_REPO:-git@github.com:erik-sv/omp-skills.git}"
CHECKOUT="${OMP_SKILLS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/omp/omp-skills}"
TARGET="${OMP_SKILLS_HOME:-${PI_CONFIG_DIR:-$HOME/.omp}/agent/skills}"
OFFLINE=false

usage() {
  cat <<'EOF'
Usage: sync-private-skills.sh [--repo URL] [--dir DIR] [--target DIR] [--offline]

Clone or update the private OMP skill library, validate it, and link its skills.

  --repo URL    Private Git repository (default: erik-sv/omp-skills)
  --dir DIR     Local checkout (default: $XDG_DATA_HOME/omp/omp-skills)
  --target DIR  Native OMP skill root (default: ~/.omp/agent/skills)
  --offline     Use an existing checkout without fetching
EOF
}

die() {
  printf 'sync-private-skills: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      [ "$#" -ge 2 ] || die "--repo requires a URL"
      REPOSITORY="$2"
      shift 2
      ;;
    --dir)
      [ "$#" -ge 2 ] || die "--dir requires a directory"
      CHECKOUT="$2"
      shift 2
      ;;
    --target)
      [ "$#" -ge 2 ] || die "--target requires a directory"
      TARGET="$2"
      shift 2
      ;;
    --offline)
      OFFLINE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'sync-private-skills: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v git >/dev/null 2>&1 || die "git not found"

if [ -d "$CHECKOUT/.git" ]; then
  ACTUAL_REPOSITORY="$(git -C "$CHECKOUT" remote get-url origin 2>/dev/null)" \
    || die "existing checkout has no origin remote: $CHECKOUT"
  [ "$ACTUAL_REPOSITORY" = "$REPOSITORY" ] \
    || die "origin mismatch: expected $REPOSITORY, found $ACTUAL_REPOSITORY"
elif [ -e "$CHECKOUT" ]; then
  die "checkout path exists but is not a Git repository: $CHECKOUT"
else
  [ "$OFFLINE" = false ] || die "offline mode requires an existing checkout: $CHECKOUT"
  mkdir -p "$(dirname "$CHECKOUT")"
  git clone "$REPOSITORY" "$CHECKOUT"
fi

SYNC_SCRIPT="$CHECKOUT/scripts/sync-skills.sh"
[ -x "$SYNC_SCRIPT" ] || die "private checkout lacks executable scripts/sync-skills.sh"

if [ "$OFFLINE" = true ]; then
  exec "$SYNC_SCRIPT" --target "$TARGET" --prune --no-pull
fi
exec "$SYNC_SCRIPT" --target "$TARGET" --prune

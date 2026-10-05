#!/usr/bin/env bash
# Commit working changes, rebase onto the tracked remote branch, and push.
# Stashes leftover dirty files (common: cinny submodule pointer, gradlew +x)
# around the pull/push so they don't block rebase.
#
# Usage:
#   scripts/push.sh -m "commit message" [path ...]
#   scripts/push.sh "commit message" [path ...]
#
# If no paths are given:
#   - uses already-staged files, or
#   - auto-stages modified tracked files + overlay/android/scripts/config changes
#     (skips cinny submodule + android/gradlew unless -a)
#
# Flags:
#   -m MSG     Commit message
#   -a         Include noisy paths (cinny, android/gradlew) when auto-staging
#   -n         Dry run: show what would be committed, then exit
#   -h         Help

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MSG=""
INCLUDE_NOISE=0
DRY_RUN=0
PATHS=()
STAGED_PATHS=()

NOISE_PATHS=(
  "cinny"
  "android/gradlew"
)

usage() {
  awk '
    NR == 1 { next }
    /^#/ { sub(/^# ?/, ""); print; next }
    { exit }
  ' "$0"
  exit "${1:-0}"
}

is_noise() {
  local p="$1"
  for n in "${NOISE_PATHS[@]}"; do
    [[ "$p" == "$n" || "$p" == "./$n" ]] && return 0
  done
  return 1
}

should_autostage() {
  local p="$1"
  case "$p" in
    overlay/*|android/*|scripts/*|package.json|package-lock.json|.gitea/*|config.json|capacitor.config.json)
      return 0
      ;;
  esac
  # Modified tracked files outside those dirs are fine; skip random untracked junk.
  git ls-files --error-unmatch -- "$p" >/dev/null 2>&1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m)
      [[ $# -ge 2 ]] || { echo "error: -m needs a message" >&2; exit 1; }
      MSG="$2"
      shift 2
      ;;
    -a)
      INCLUDE_NOISE=1
      shift
      ;;
    -n)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage 0
      ;;
    --)
      shift
      PATHS+=("$@")
      break
      ;;
    -*)
      echo "error: unknown flag: $1" >&2
      usage 1
      ;;
    *)
      if [[ -z "$MSG" ]]; then
        MSG="$1"
      else
        PATHS+=("$1")
      fi
      shift
      ;;
  esac
done

if [[ -z "$MSG" ]]; then
  echo "error: commit message required" >&2
  usage 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not a git repo" >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" == "HEAD" ]]; then
  echo "error: detached HEAD — check out a branch first" >&2
  exit 1
fi

REMOTE="$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true)"
if [[ -n "$REMOTE" ]]; then
  REMOTE_NAME="${REMOTE%%/*}"
  REMOTE_BRANCH="${REMOTE#*/}"
else
  REMOTE_NAME="origin"
  REMOTE_BRANCH="$BRANCH"
fi

if [[ ${#PATHS[@]} -gt 0 ]]; then
  STAGED_PATHS=("${PATHS[@]}")
  git add -- "${STAGED_PATHS[@]}"
elif git diff --cached --quiet; then
  mapfile -t candidates < <({
    git diff --name-only --diff-filter=ACMRD
    git ls-files --others --exclude-standard
  } | awk 'NF && !seen[$0]++')

  for p in "${candidates[@]}"; do
    [[ -z "$p" ]] && continue
    if [[ "$INCLUDE_NOISE" -eq 0 ]] && is_noise "$p"; then
      continue
    fi
    if should_autostage "$p"; then
      STAGED_PATHS+=("$p")
    fi
  done

  if [[ ${#STAGED_PATHS[@]} -eq 0 ]]; then
    echo "error: nothing to commit (pass paths, or stage files first)" >&2
    git status -sb
    exit 1
  fi

  git add -- "${STAGED_PATHS[@]}"
fi

if git diff --cached --quiet; then
  echo "error: nothing staged to commit" >&2
  git status -sb
  exit 1
fi

echo "==> branch $BRANCH (tracking ${REMOTE_NAME}/${REMOTE_BRANCH})"
echo "==> staged:"
git diff --cached --stat

if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ ${#STAGED_PATHS[@]} -gt 0 ]]; then
    git reset -q HEAD -- "${STAGED_PATHS[@]}"
  fi
  echo "==> dry run; not committing or pushing"
  exit 0
fi

STASHED=0
if [[ -n "$(git diff --name-only)" || -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "==> stashing leftover dirty files"
  git stash push --keep-index -u -m "push.sh leftover before ${BRANCH} push"
  STASHED=1
fi

echo "==> commit"
git commit -m "$MSG"

echo "==> pull --rebase ${REMOTE_NAME}/${REMOTE_BRANCH}"
git pull --rebase "$REMOTE_NAME" "$REMOTE_BRANCH"

echo "==> push ${REMOTE_NAME} HEAD"
git push "$REMOTE_NAME" HEAD

if [[ "$STASHED" -eq 1 ]]; then
  echo "==> restoring stash"
  git stash pop
fi

echo "==> done"
git status -sb
git log -1 --oneline

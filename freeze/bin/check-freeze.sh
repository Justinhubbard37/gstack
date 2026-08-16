#!/usr/bin/env bash
# check-freeze.sh — PreToolUse hook for /freeze skill
# Reads JSON from stdin, checks if file_path is within the freeze boundary.
# Returns a PreToolUse hookSpecificOutput with permissionDecision "deny" to block,
# or {} to allow. The decision MUST be nested under hookSpecificOutput — Claude
# Code ignores a top-level permissionDecision, which silently no-ops the block.
#
# Polarity: freeze is a DENY-tier hook, so an unreadable payload DENIES
# (fail closed). A payload that parses but has no file_path is a non-file
# tool — allow. This is the opposite edge-handling from careful's ask-tier
# and intentionally so: /guard runs both, and a boundary that fails open is
# not a boundary.
set -euo pipefail

# Read stdin
INPUT=$(cat)

# Shared JSON helpers (extractor + encoder) — one copy for careful AND freeze.
# freeze previously carried its own grep-first extractor which truncated at
# escaped quotes and failed OPEN; the shared file kills that drift class.
_HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=careful/bin/hook-extract.sh
. "$_HOOK_DIR/../../careful/bin/hook-extract.sh"

# Locate the freeze directory state file
STATE_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.gstack}"
FREEZE_FILE="$STATE_DIR/freeze-dir.txt"

# If no freeze file exists, allow everything (not yet configured)
if [ ! -f "$FREEZE_FILE" ]; then
  echo '{}'
  exit 0
fi

# First line, trimmed of LEADING/TRAILING whitespace only. The previous
# `tr -d '[:space:]'` deleted INTERNAL spaces too, so a boundary like
# "~/My Project/src" could never match anything — every edit denied (or the
# mangled path accidentally allowed the wrong tree).
FREEZE_DIR=$(head -n 1 "$FREEZE_FILE" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

# If freeze dir is empty, allow
if [ -z "$FREEZE_DIR" ]; then
  echo '{}'
  exit 0
fi

# Extract file_path from tool_input with the shared real-JSON parser.
set +e
FILE_PATH=$(gstack_hook_extract_field "$INPUT" file_path)
EXTRACT_RC=$?
set -e

# Unparseable payload (or no parser available): DENY. A boundary hook that
# allows what it cannot read is not a boundary.
if [ "$EXTRACT_RC" -ne 0 ] && [ -n "$INPUT" ]; then
  gstack_hook_decision deny "[freeze] Could not parse the tool payload to check the freeze boundary. Blocked (fail closed). Freeze boundary: $FREEZE_DIR"
  exit 0
fi

# Parsed fine but no file_path field: a non-file tool payload — allow.
if [ -z "$FILE_PATH" ]; then
  echo '{}'
  exit 0
fi

# Resolve file_path to absolute if it isn't already
case "$FILE_PATH" in
  /*) ;; # already absolute
  *)
    FILE_PATH="$(pwd)/$FILE_PATH"
    ;;
esac

# Normalize: remove double slashes and trailing slash
FILE_PATH=$(printf '%s' "$FILE_PATH" | sed 's|/\+|/|g;s|/$||')

# Resolve symlinks and .. sequences (POSIX-portable, works on macOS).
# The FULL path is resolved, including the FINAL component: the previous
# version resolved only the parent directory, so an in-boundary symlink
# pointing at an out-of-boundary target sailed through the check while the
# actual write landed outside the boundary. A final component that is a
# symlink is followed (bounded, cycle-safe) so the TARGET gets checked; a
# final component that does not exist yet (new file) has nothing to follow
# and parent resolution is the correct behavior.
_resolve_path() {
  local _p="$1" _dir _base _tgt _i=0
  while [ -L "$_p" ] && [ "$_i" -lt 40 ]; do
    _tgt=$(readlink "$_p" 2>/dev/null) || break
    case "$_tgt" in
      /*) _p="$_tgt" ;;
      *) _p="$(dirname "$_p")/$_tgt" ;;
    esac
    _i=$((_i + 1))
  done
  _dir="$(dirname "$_p")"
  _base="$(basename "$_p")"
  _dir="$(cd "$_dir" 2>/dev/null && pwd -P || printf '%s' "$_dir")"
  printf '%s/%s' "$_dir" "$_base"
}
FILE_PATH=$(_resolve_path "$FILE_PATH")
FREEZE_DIR=$(_resolve_path "$FREEZE_DIR")

# Check: does the file path start with the freeze directory?
case "$FILE_PATH" in
  "${FREEZE_DIR}/"*|"${FREEZE_DIR}")
    # Inside freeze boundary — allow
    echo '{}'
    ;;
  *)
    # Outside freeze boundary — deny
    # Log hook fire event
    mkdir -p ~/.gstack/analytics 2>/dev/null || true
    echo '{"event":"hook_fire","skill":"freeze","pattern":"boundary_deny","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}' >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true

    # The reason is JSON-encoded by the shared helper. Never interpolate paths
    # into hand-built JSON: a path containing a quote or newline produced
    # malformed JSON here, and the deny silently no-oped.
    gstack_hook_decision deny "[freeze] Blocked: $FILE_PATH is outside the freeze boundary ($FREEZE_DIR). Only edits within the frozen directory are allowed."
    ;;
esac

#!/usr/bin/env bash
# Migration: v1.64.0.0 — repair Chrome-for-Testing bundles poisoned by the
# old in-place rebrand (#2242).
#
# Why a migration: pre-v1.64 launchHeaded() rewrote the Chromium .app's
# Info.plist ("Google Chrome for Testing" → "GStack Browser") and overwrote
# its Resources/*.icns — inside the SHARED Playwright cache. That broke the
# codesign seal (GPU process exit_code=5; headed mode dead on macOS 26) and
# poisoned the cache for the user's OTHER Playwright projects too. Deleting
# the rebrand code fixes fresh installs only; every existing macOS install
# still has the mutated bundle on disk. This migration removes poisoned
# bundles and re-fetches a clean one so the upgrade doesn't leave the user
# with zero working browser (the browse launch path also self-heals, as the
# belt to this suspenders, for installs that never run migrations).
#
# Affected: macOS installs that ever ran headed mode before v1.64.
#
# Idempotent: detection is content-based (plist contains "GStack Browser");
# a clean cache is a no-op, and the .done touchfile gates re-runs. The
# re-fetch is best-effort and non-fatal per the migration contract.

set -u

GSTACK_HOME="${GSTACK_HOME:-${HOME}/.gstack}"
MIGRATION_DIR="${GSTACK_HOME}/.migrations"
DONE="${MIGRATION_DIR}/v1.64.0.0.done"
mkdir -p "${MIGRATION_DIR}" 2>/dev/null || true
[ -f "${DONE}" ] && exit 0

# macOS only: the mutation targeted .app bundle plists.
if [ "$(uname -s 2>/dev/null)" != "Darwin" ]; then
  touch "${DONE}"
  exit 0
fi

PW_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-${HOME}/Library/Caches/ms-playwright}"
REMOVED=0

if [ -d "${PW_CACHE}" ]; then
  # Every Chrome-for-Testing bundle in the cache (one per pinned chromium build).
  while IFS= read -r plist; do
    if grep -q "GStack Browser" "${plist}" 2>/dev/null; then
      app_dir="$(dirname "$(dirname "${plist}")")"
      case "${app_dir}" in
        "${PW_CACHE}"/*.app|"${PW_CACHE}"/*/*.app|"${PW_CACHE}"/*/*/*.app)
          echo "  [v1.64.0.0] removing rebrand-poisoned bundle: ${app_dir}" >&2
          rm -rf "${app_dir}"
          REMOVED=1
          ;;
        *)
          echo "  [v1.64.0.0] WARNING: poisoned plist outside the Playwright cache shape, skipping: ${plist}" >&2
          ;;
      esac
    fi
  done < <(find "${PW_CACHE}" -maxdepth 5 -name "Info.plist" -path "*.app/Contents/Info.plist" 2>/dev/null)
fi

if [ "${REMOVED}" = "1" ]; then
  # Re-fetch immediately: migrations run AFTER ./setup, so without this the
  # user finishes the upgrade with no working browser at all (headless AND
  # headed use the same bundle). Best-effort — a failed download leaves the
  # actionable command printed and the launch-time self-heal message covers
  # the rest.
  echo "  [v1.64.0.0] re-fetching a clean Chromium (bunx playwright install chromium)..." >&2
  if command -v bunx >/dev/null 2>&1 && bunx playwright install chromium >&2; then
    echo "  [v1.64.0.0] clean Chromium installed." >&2
  else
    echo "  [v1.64.0.0] WARNING: automatic re-fetch failed. Run manually: bunx playwright install chromium" >&2
  fi
else
  echo "  [v1.64.0.0] no rebrand-poisoned bundles found — no-op." >&2
fi

touch "${DONE}"
exit 0

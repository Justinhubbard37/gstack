#!/bin/sh
# sandbox-doctor — make a syscall-supervised cloud sandbox (Vercel sandbox /
# Conductor cloud workspace) able to run `bun run test` green.
#
# Root causes this script treats (all measured on a live Vercel sandbox,
# Amazon Linux 2023, PID 1 = sandbox-init with a seccomp filter):
#
#   1. /dev/fd is missing on fresh boots — every bash process substitution
#      `<(...)` fails with "/dev/fd/63: No such file or directory".
#   2. /dev/shm is 64M — concurrent Chromium instances crash.
#   3. The seccomp supervisor spuriously fails access(2)-family syscalls for
#      BUSY processes: `git init` dies with "Cannot access work tree:
#      Permission denied", bun's existsSync returns false for files written
#      microseconds earlier (statx succeeds while access fails on the same
#      path). Per-process pressure matters: 1 serial mega-shard and 6-way
#      sharding both fail hard; 2 shards is the sweet spot. Under blanket
#      denial the whole /tmp subtree is denied while $HOME stays clean, so
#      tests run with TMPDIR under HOME.
#   4. Every process runs with FULL capabilities (CapEff=1ffffffffff) despite
#      uid 1000 — CAP_DAC_OVERRIDE makes chmod-denial tests unfailable.
#      Tests must run under `setpriv --ambient-caps=-all --bounding-set=-all`.
#   5. No X server — headed-browser tests (browse handoff) need Xvfb.
#   6. No git identity — fixtures that rely on ambient user.name/email fail.
#   7. Conductor's /conductor/bin/git shim captures $? AFTER its `if`
#      construct (POSIX resets it to 0 on a false condition with no else), so
#      every push/pull/fetch/clone/ls-remote FAILURE exits 0. Tests that
#      inject remote failures (pre-receive hooks) see phantom successes.
#      Report upstream via Conductor Help -> Send Feedback; patched locally.
#
# Idempotent. Run once per sandbox boot (or source ~/.bashrc, which this
# script also seeds). Then:
#
#   DISPLAY=:99 TMPDIR=$HOME/tmp GSTACK_FREE_JOBS=2 GSTACK_FREE_RETRY_FLAKY=1 \
#     setpriv --ambient-caps=-all --bounding-set=-all bun run test
set -eu

say() { printf 'sandbox-doctor: %s\n' "$1"; }

# 1. /dev/fd
if [ ! -e /dev/fd ]; then
  sudo ln -sfn /proc/self/fd /dev/fd
  say 'restored /dev/fd -> /proc/self/fd'
fi

# 2. /dev/shm size
if [ "$(df -k /dev/shm 2>/dev/null | awk 'NR==2 {print $2}')" -lt 1048576 ]; then
  sudo mount -o remount,size=4G /dev/shm
  say 'remounted /dev/shm at 4G'
fi

# 3. TMPDIR under HOME (persisted via bashrc below; created here)
mkdir -p "$HOME/tmp"

# 5. Xvfb for headed-browser tests
command -v Xvfb >/dev/null 2>&1 || sudo dnf install -y xorg-x11-server-Xvfb >/dev/null
pgrep -x Xvfb >/dev/null 2>&1 || { Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 & say 'started Xvfb on :99'; }

# 6. git identity (only if absent — never clobber a configured one)
git config --global user.name >/dev/null 2>&1 || {
  git config --global user.name "$(whoami)"
  git config --global user.email "$(whoami)@localhost"
  say 'seeded global git identity'
}

# 7. Conductor git-shim exit-code bug
if [ -f /conductor/bin/git ] && grep -q '^status=\$?' /conductor/bin/git 2>/dev/null; then
  sudo python3 - <<'EOF'
src = open('/conductor/bin/git').read()
old = 'exit 0\nfi\nstatus=$?'
new = 'exit 0\nelse\n\tstatus=$?\nfi'
if old in src:
    open('/conductor/bin/git', 'w').write(src.replace(old, new))
    print('sandbox-doctor: patched /conductor/bin/git exit-code laundering')
EOF
fi

# Persist the env recipe for interactive shells.
if ! grep -q 'GSTACK sandbox test env' "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" <<'EOF'

# GSTACK sandbox test env (written by scripts/sandbox-doctor.sh)
export TMPDIR="$HOME/tmp"
export GSTACK_FREE_JOBS=2
export GSTACK_FREE_RETRY_FLAKY=1
export DISPLAY=:99
[ -e /dev/fd ] || sudo ln -sfn /proc/self/fd /dev/fd 2>/dev/null
pgrep -x Xvfb >/dev/null 2>&1 || (Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &)
EOF
  say 'seeded ~/.bashrc test env'
fi

say 'done. run tests with:'
say '  setpriv --ambient-caps=-all --bounding-set=-all bun run test'

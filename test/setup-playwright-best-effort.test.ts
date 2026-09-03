/**
 * setup: Chromium bootstrap is best-effort and bounded (#1900, #1901, #1902,
 * #913, #2233).
 *
 * Before: `set -e` plus a bare `bunx playwright install chromium` (and an
 * explicit `exit 1` after the post-install probe) sat in section "# 2", ahead
 * of "# 4. Install for Claude". An offline, proxied, or AppArmor-restricted
 * box ended with ZERO skills registered, and a wedged download hung setup
 * forever. Now every failure records a reason code in _PW_FAIL_REASON, the
 * install is deadline-bounded, lock contention is a reason (not a fatal), and
 * skill registration always runs.
 *
 * Two layers, following test/setup-emoji-font.test.ts's convention:
 *   1. static invariants over the anchor-sliced block (line-number agnostic);
 *   2. an integration harness that executes the REAL block with stubbed
 *      probe/installer so the exit path and reason codes are exercised.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

const BLOCK_START = "# 2. Ensure Playwright's Chromium is available";
const BLOCK_END = '# 2b. Ensure a color-emoji font';

function slice(startAnchor: string, endAnchor: string): string {
  const start = SETUP_SRC.indexOf(startAnchor);
  const end = SETUP_SRC.indexOf(endAnchor, start);
  if (start < 0 || end < 0) throw new Error(`anchor not found: ${startAnchor} .. ${endAnchor}`);
  return SETUP_SRC.slice(start, end);
}

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`function not found: ${name}`);
  return SETUP_SRC.slice(start, end + 2);
}

const block = slice(BLOCK_START, BLOCK_END);
const codeLines = block.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

describe('setup: Chromium bootstrap static invariants', () => {
  test('no exit inside the bootstrap block (skills must always register)', () => {
    expect(codeLines).not.toMatch(/\bexit 1\b/);
    expect(codeLines).not.toMatch(/\bexit\b/);
  });

  test('every failure arm records a reason code', () => {
    for (const code of [
      'skipped', 'chromium-install', 'chromium-install-timeout', 'chromium-install-locked',
      'windows-no-node', 'windows-node-modules', 'post-install-launch',
    ]) {
      expect(codeLines).toContain(`_pw_fail ${code} `);
    }
  });

  test('the download is deadline-bounded through the shared helper and env knob', () => {
    expect(codeLines).toContain('_wait_with_deadline $! "$_PW_INSTALL_TIMEOUT"');
    expect(codeLines).toContain('GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT');
    // Non-numeric knob falls back to the default instead of breaking arithmetic.
    expect(codeLines).toMatch(/case "\$_PW_INSTALL_TIMEOUT" in ''\|\*\[!0-9\]\*\)/);
  });

  test('lock contention is a reason code, not a fatal', () => {
    const lockElse = codeLines.slice(codeLines.indexOf('else\n    _pw_fail chromium-install-locked'));
    expect(lockElse.length).toBeGreaterThan(0);
    expect(block).toContain('GSTACK_SKIP_PLAYWRIGHT');
  });

  test('the lock EXIT trap still chains cleanup_copied_bun and is restored', () => {
    expect(codeLines).toContain("trap 'rm -rf \"$_PW_LOCK\" 2>/dev/null || true; cleanup_copied_bun' EXIT");
    expect(codeLines).toContain('trap cleanup_copied_bun EXIT');
  });

  test('the daemon font refresh is skipped when Chromium is unavailable', () => {
    const emoji = slice(BLOCK_END, '# 3. Ensure ~/.gstack global state directory exists');
    expect(emoji).toContain('elif [ -z "$_PW_FAIL_REASON" ]; then');
    expect(emoji).toContain('refresh_browse_daemon_for_fonts');
  });

  test('the final summary names the affected skills and the reason', () => {
    const tail = SETUP_SRC.slice(SETUP_SRC.indexOf('Chromium bootstrap summary'));
    expect(tail).toContain('Browser unavailable');
    for (const skill of ['/qa', '/design-review', '/browse', 'make-pdf', '/pair-agent']) {
      expect(tail).toContain(skill);
    }
    expect(tail).toContain('$_PW_FAIL_REASON');
    expect(tail).toContain('GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT=1800');
    expect(tail).toContain('GSTACK_CHROMIUM_NO_SANDBOX=1');
  });
});

/**
 * Integration harness: the real block + the real deadline helpers, with the
 * probe and installer stubbed. `bunx` is a shell function, so the block's
 * subshell inherits the stub. Emits REASON=... and REACHED_END=1 so the test
 * can prove setup continued past the block.
 */
function runBlock(opts: {
  probe: 'ok' | 'fail';
  bunx: string;             // body of the bunx stub
  env?: Record<string, string>;
  preLockPid?: string;      // pre-create the install lock held by this pid
  markKill?: boolean;       // record _kill_tree invocations to $MARK
}): { stdout: string; stderr: string; status: number; elapsedMs: number; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pw-block-'));
  const mark = path.join(tmp, 'mark');
  const killTree = opts.markKill
    ? extractFn('_kill_tree').replace('_kill_tree() {', '_kill_tree_orig() {') +
      `\n_kill_tree() { echo killed >> "${mark}"; _kill_tree_orig "$1"; }\n`
    : extractFn('_kill_tree');
  if (opts.preLockPid) {
    const lock = path.join(tmp, 'gstack-playwright-install.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), opts.preLockPid);
  }
  const script = [
    'set -e',
    'IS_WINDOWS=0',
    `SOURCE_GSTACK_DIR="${tmp}"`,
    `TMPDIR="${tmp}"`,
    `MARK="${mark}"`,
    '_PLAYWRIGHT_PLATFORM_OVERRIDE=""',
    'cleanup_copied_bun() { :; }',
    'trap cleanup_copied_bun EXIT',
    '_clear_playwright_quarantine() { :; }',
    `ensure_playwright_browser() { ${opts.probe === 'ok' ? 'return 0' : 'return 1'}; }`,
    `bunx() { echo bunx-called >> "$MARK"; ${opts.bunx}; }`,
    killTree,
    extractFn('_wait_with_deadline'),
    block,
    'echo "REASON=$_PW_FAIL_REASON"',
    'echo "REACHED_END=1"',
  ].join('\n');
  const scriptPath = path.join(tmp, 'block.sh');
  fs.writeFileSync(scriptPath, script);
  const t0 = Date.now();
  const r = spawnSync('bash', [scriptPath], {
    encoding: 'utf-8',
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? '', HOME: tmp, ...(opts.env ?? {}) },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1, elapsedMs: Date.now() - t0, tmp };
}

describe('setup: Chromium bootstrap block executes best-effort', () => {
  test('probe ok: no reason recorded, no install attempted', () => {
    const r = runBlock({ probe: 'ok', bunx: 'exit 0' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=\n');
    expect(r.stdout).toContain('REACHED_END=1');
    expect(fs.existsSync(path.join(r.tmp, 'mark'))).toBe(false);
  });

  test('install exits non-zero: reason chromium-install, setup continues (was: exit 1 before any skill registered)', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 7' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=chromium-install\n');
    expect(r.stdout).toContain('REACHED_END=1');
    expect(r.stderr).toContain('chromium-install');
    expect(r.stderr).toContain('exited 7');
  });

  test('install hangs: killed at the deadline with reason chromium-install-timeout, tree kill recorded', () => {
    const r = runBlock({
      probe: 'fail', bunx: 'sleep 30', markKill: true,
      env: { GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT: '1' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=chromium-install-timeout\n');
    expect(r.stdout).toContain('REACHED_END=1');
    expect(r.elapsedMs).toBeLessThan(20_000);
    expect(fs.readFileSync(path.join(r.tmp, 'mark'), 'utf-8')).toContain('killed');
  });

  test('non-numeric timeout knob falls back to the default instead of erroring', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 3', env: { GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT: 'soon' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=chromium-install\n');
  });

  test('lock held by a live process: reason chromium-install-locked, setup continues (was: exit 1)', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 0', preLockPid: String(process.pid) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=chromium-install-locked\n');
    expect(r.stdout).toContain('REACHED_END=1');
    // The installer must not have run under a foreign lock.
    expect(fs.existsSync(path.join(r.tmp, 'mark'))).toBe(false);
    // And the foreign lock is left for its owner.
    expect(fs.existsSync(path.join(r.tmp, 'gstack-playwright-install.lock'))).toBe(true);
  });

  test('stale lock (dead pid) is reclaimed and the install proceeds', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 0', preLockPid: '999999' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('reclaiming stale Chromium-install lock');
    expect(fs.readFileSync(path.join(r.tmp, 'mark'), 'utf-8')).toContain('bunx-called');
  });

  test('install succeeds but the post-install probe fails: reason post-install-launch with the userns hint', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 0' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=post-install-launch\n');
    expect(r.stderr).toContain('GSTACK_CHROMIUM_NO_SANDBOX=1');
  });

  test('GSTACK_SKIP_PLAYWRIGHT=1: reason skipped, installer never invoked (#913)', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 0', env: { GSTACK_SKIP_PLAYWRIGHT: '1' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=skipped\n');
    expect(fs.existsSync(path.join(r.tmp, 'mark'))).toBe(false);
  });
});

/**
 * #2709 — two defects, one issue:
 *
 * 1. headlessGpuArgs: on macOS 26 / Apple Silicon the headless GPU process
 *    pegs ~800% CPU after real page work; --disable-gpu alone is not enough.
 *    The flag block is a pure platform-parameterized function so the darwin
 *    behavior (and the GSTACK_DISABLE_GPU=off escape) is testable on any host.
 *
 * 2. reapRecordedChromium: the headless launch has no SingletonLock, so
 *    killOrphanChromium was a structural no-op for it and `browse stop`
 *    reported success while the child spun on. The reap verifies identity two
 *    ways (recorded start time AND a Chromium-looking cmdline) before any
 *    signal — a recycled PID is never killed.
 */
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { headlessGpuArgs } from '../src/browser-manager';
import { reapRecordedChromium } from '../src/cli';
import { readPidStartTime } from '../src/xvfb';
import { isProcessAlive } from '../src/error-handling';

describe('headlessGpuArgs (#2709)', () => {
  test('darwin gets the validated four-flag set', () => {
    expect(headlessGpuArgs('darwin', {})).toEqual([
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-gpu-compositing',
      '--disable-gpu-watchdog',
    ]);
  });

  test('GSTACK_DISABLE_GPU=off opts out (case-insensitive)', () => {
    expect(headlessGpuArgs('darwin', { GSTACK_DISABLE_GPU: 'off' })).toEqual([]);
    expect(headlessGpuArgs('darwin', { GSTACK_DISABLE_GPU: 'OFF' })).toEqual([]);
  });

  test('non-darwin platforms are untouched', () => {
    expect(headlessGpuArgs('linux', {})).toEqual([]);
    expect(headlessGpuArgs('win32', {})).toEqual([]);
  });
});

// /proc-based identity — Linux-only (CI + this repo's dev boxes); the
// darwin-side behavior is identical code over the same ps/proc helpers.
describe.skipIf(process.platform !== 'linux')('reapRecordedChromium identity gate (#2709)', () => {
  // A script whose PATH carries the chromium shape — `exec -a` renames don't
  // survive this distro's coreutils shebang re-exec, but the interpreter line
  // in /proc/<pid>/cmdline always includes the script path.
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');

  function spawnFakeChromium(): Promise<number> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-test-'));
    const script = path.join(dir, 'headless_shell');
    fs.writeFileSync(script, '#!/bin/bash\nsleep 30 &\nwait\n', { mode: 0o755 });
    return new Promise((resolve, reject) => {
      const child = spawn(script, [], { detached: true, stdio: 'ignore' });
      child.unref();
      child.once('spawn', () => resolve(child.pid!));
      child.once('error', reject);
    });
  }

  test('kills the child when pid + start time + cmdline all match', async () => {
    const pid = await spawnFakeChromium();
    await new Promise(r => setTimeout(r, 100));
    const startTime = readPidStartTime(pid);
    expect(startTime).not.toBe('');
    await reapRecordedChromium({ chromiumPid: pid, chromiumStartTime: startTime });
    expect(isProcessAlive(pid)).toBe(false);
  }, 15_000);

  test('never kills when the recorded start time mismatches (PID reuse)', async () => {
    const pid = await spawnFakeChromium();
    await new Promise(r => setTimeout(r, 100));
    try {
      await reapRecordedChromium({
        chromiumPid: pid,
        chromiumStartTime: 'Mon Jan  1 00:00:00 1990',
      });
      expect(isProcessAlive(pid)).toBe(true);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 15_000);

  test('never kills a non-Chromium process even with a matching start time', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    child.unref();
    await new Promise(r => setTimeout(r, 100));
    const pid = child.pid!;
    try {
      const startTime = readPidStartTime(pid);
      await reapRecordedChromium({ chromiumPid: pid, chromiumStartTime: startTime });
      expect(isProcessAlive(pid)).toBe(true);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 15_000);

  test('absent or dead pid is a quiet no-op', async () => {
    await reapRecordedChromium({});
    await reapRecordedChromium({ chromiumPid: 999999999, chromiumStartTime: 'x' });
  });
});

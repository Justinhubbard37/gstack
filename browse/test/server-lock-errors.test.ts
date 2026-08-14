/**
 * acquireServerLock error honesty (#1084 regression).
 *
 * The old code wrapped fs.openSync(lockPath, 'wx') in a bare `catch {}` —
 * EVERY errno (EACCES, EIO, ENOSPC, ENOENT) fell into the "lock already
 * held" path and surfaced as "another instance is starting the server",
 * a phantom 15s contention timeout that masked the real filesystem error.
 *
 * New contract:
 *   - EEXIST + live holder  → null (real contention)
 *   - EEXIST + dead holder  → stale lock removed, acquired
 *   - ENOENT (dir missing)  → create dir, retry once, acquired
 *   - anything else         → ServerLockError with the real errno
 */

import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireServerLock, ServerLockError } from '../src/cli';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-lock-'));
afterAll(() => {
  // Restore write perm so cleanup can delete the read-only dir.
  try { fs.chmodSync(path.join(tmpRoot, 'rodir'), 0o700); } catch {}
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('acquireServerLock (#1084 error honesty)', () => {
  test('happy path: acquires and releases', () => {
    const lockPath = path.join(tmpRoot, 'happy.lock');
    const release = acquireServerLock(lockPath);
    expect(release).not.toBeNull();
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
    release!();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('EACCES throws ServerLockError with the real errno — NOT phantom contention', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // chmod semantics differ
    const rodir = path.join(tmpRoot, 'rodir');
    fs.mkdirSync(rodir, { recursive: true });
    fs.chmodSync(rodir, 0o500); // r-x: open('wx') inside fails EACCES
    const lockPath = path.join(rodir, 'browse.json.lock');
    let thrown: any = null;
    try {
      acquireServerLock(lockPath); // old code: returned null (phantom contention)
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ServerLockError);
    expect(thrown.code).toBe('EACCES');
    expect(thrown.message).toContain('E_SERVER_LOCK (EACCES)');
    expect(thrown.message).toContain(lockPath);
  });

  test('ENOENT (missing lock dir) creates the dir and acquires', () => {
    const lockPath = path.join(tmpRoot, 'newdir', 'browse.json.lock');
    // old code: openSync ENOENT → bare catch → readFileSync ENOENT → null
    const release = acquireServerLock(lockPath);
    expect(release).not.toBeNull();
    expect(fs.existsSync(lockPath)).toBe(true);
    release!();
  });

  test('EEXIST + dead holder: removes stale lock and acquires', () => {
    const lockPath = path.join(tmpRoot, 'stale.lock');
    fs.writeFileSync(lockPath, '999999999\n'); // PID that cannot be alive
    const release = acquireServerLock(lockPath);
    expect(release).not.toBeNull();
    release!();
  });

  test('EEXIST + live holder: returns null (real contention, no throw)', () => {
    const lockPath = path.join(tmpRoot, 'live.lock');
    fs.writeFileSync(lockPath, `${process.pid}\n`); // this test process is alive
    expect(acquireServerLock(lockPath)).toBeNull();
    fs.unlinkSync(lockPath);
  });
});

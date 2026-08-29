/**
 * TEMP_DIRS portability allowlist (platform.ts) and its path-security wiring.
 *
 * TEMP_DIRS widens LOCAL path validation to include os.tmpdir() — on macOS
 * that is the per-user /var/folders dir, and TMPDIR-honoring CI/sandbox
 * environments point it elsewhere entirely. The load-bearing SECURITY
 * invariant is asymmetry: SAFE_DIRECTORIES (local read/write) gains
 * os.tmpdir(), while validateTempPath (REMOTE file serving, GET /file) stays
 * pinned to classic TEMP_DIR alone — widening that one would let a tunnel
 * client fetch files from an arbitrary TMPDIR (e.g. $HOME/tmp).
 */
import { describe, it, expect } from 'bun:test';
import { TEMP_DIR, TEMP_DIRS } from '../src/platform';
import { SAFE_DIRECTORIES, validateOutputPath, validateReadPath, validateTempPath } from '../src/path-security';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
const tmpdirIsDistinct = real(os.tmpdir()) !== real(TEMP_DIR);

describe('TEMP_DIRS allowlist shape', () => {
  it('contains exactly TEMP_DIR + os.tmpdir() deduped, and SAFE_DIRECTORIES wires them realpathed alongside cwd', () => {
    expect(TEMP_DIRS).toContain(TEMP_DIR);
    expect(TEMP_DIRS).toContain(os.tmpdir());
    expect(new Set(TEMP_DIRS).size).toBe(TEMP_DIRS.length);
    // Nothing else sneaks into the allowlist.
    for (const d of TEMP_DIRS) {
      expect([TEMP_DIR, os.tmpdir()]).toContain(d);
    }
    expect(SAFE_DIRECTORIES).toContain(real(os.tmpdir()));
    expect(SAFE_DIRECTORIES).toContain(real(process.cwd()));
  });
});

describe('local commands accept os.tmpdir() paths (TMPDIR-honoring environments)', () => {
  it('validateReadPath allows an existing file under os.tmpdir()', () => {
    const f = path.join(os.tmpdir(), `browse-tempdirs-read-${Date.now()}.js`);
    fs.writeFileSync(f, 'document.title');
    try {
      expect(() => validateReadPath(f)).not.toThrow();
    } finally {
      fs.unlinkSync(f);
    }
  });

  it('validateOutputPath allows a new (not-yet-existing) file under os.tmpdir()', () => {
    const f = path.join(os.tmpdir(), `browse-tempdirs-out-${Date.now()}.png`);
    expect(() => validateOutputPath(f)).not.toThrow();
    expect(fs.existsSync(f)).toBe(false); // validation never creates the file
  });
});

describe('remote file serving stays pinned to TEMP_DIR alone (no exfil widening)', () => {
  it('validateTempPath REJECTS a file under a distinct os.tmpdir() — local-only allowlist never reaches the remote surface', () => {
    if (!tmpdirIsDistinct) {
      // On hosts where os.tmpdir() IS /tmp the asymmetry is untestable this
      // way — but then the allowlist must have collapsed to the single dir.
      expect(TEMP_DIRS).toEqual([TEMP_DIR]);
      return;
    }
    const f = path.join(os.tmpdir(), `browse-tempdirs-remote-${Date.now()}.txt`);
    fs.writeFileSync(f, 'served?');
    try {
      // Same file: fine for local commands, forbidden for remote serving.
      expect(() => validateReadPath(f)).not.toThrow();
      expect(() => validateTempPath(f)).toThrow(/temp directory/i);
    } finally {
      fs.unlinkSync(f);
    }
  });
});

/**
 * Tests for the gstack-version-bump CLI (v2 plan T9 hybrid extraction). Covers
 * the idempotency classifier (pure) + the write/repair mutations (temp fs).
 * The classifier is the one that prevents re-bumping an already-shipped branch —
 * the worst /ship footgun — so it gets exhaustive state coverage.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { classifyState, VERSION_RE } from '../bin/gstack-version-bump';

const BIN = path.join(import.meta.dir, '..', 'bin', 'gstack-version-bump');

describe('classifyState (idempotency)', () => {
  test('FRESH when VERSION matches base and pkg agrees', () => {
    expect(classifyState('1.1.0.0', '1.1.0.0', true, '1.1.0.0')).toBe('FRESH');
  });
  test('FRESH when VERSION matches base and no package.json', () => {
    expect(classifyState('1.1.0.0', '1.1.0.0', false, '')).toBe('FRESH');
  });
  test('ALREADY_BUMPED when VERSION moved past base and pkg agrees (re-run)', () => {
    expect(classifyState('1.2.0.0', '1.1.0.0', true, '1.2.0.0')).toBe('ALREADY_BUMPED');
  });
  test('ALREADY_BUMPED when VERSION moved past base, no package.json', () => {
    expect(classifyState('1.2.0.0', '1.1.0.0', false, '')).toBe('ALREADY_BUMPED');
  });
  test('DRIFT_STALE_PKG when VERSION bumped but pkg lagging', () => {
    expect(classifyState('1.2.0.0', '1.1.0.0', true, '1.1.0.0')).toBe('DRIFT_STALE_PKG');
  });
  test('DRIFT_UNEXPECTED when VERSION matches base but pkg diverges (manual edit)', () => {
    expect(classifyState('1.1.0.0', '1.1.0.0', true, '1.2.0.0')).toBe('DRIFT_UNEXPECTED');
  });
});

describe('VERSION_RE', () => {
  test('accepts 4-digit semver', () => {
    expect(VERSION_RE.test('1.2.3.4')).toBe(true);
  });
  test('accepts 3-digit semver too (#2501)', () => {
    // A repo whose pinned version source is a package.json holds plain
    // 3-digit semver. Rejecting it meant /ship could not write a version in
    // such a repo at all.
    expect(VERSION_RE.test('1.2.3')).toBe(true);
    expect(VERSION_RE.test('0.99.2')).toBe(true);
  });
  test('rejects garbage', () => {
    expect(VERSION_RE.test('1.2')).toBe(false);
    expect(VERSION_RE.test('v1.2.3.4')).toBe(false);
    expect(VERSION_RE.test('1.2.3.4-rc')).toBe(false);
    expect(VERSION_RE.test('1.2.3.4.5')).toBe(false);
  });
});

describe('write (FRESH bump)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-write-'));
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  test('writes VERSION + package.json.version, preserving other pkg fields', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0', scripts: { t: 'y' } }, null, 2) + '\n');
    const out = execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: dir }).toString();
    expect(JSON.parse(out)).toEqual({ wrote: '1.1.0.0', packageJson: true, packageLock: false });
    expect(fs.readFileSync(path.join(dir, 'VERSION'), 'utf-8').trim()).toBe('1.1.0.0');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    expect(pkg.version).toBe('1.1.0.0');
    expect(pkg.scripts).toEqual({ t: 'y' }); // untouched
  });

  test('rejects a malformed version with exit 2', () => {
    let code = 0;
    try { execFileSync('bun', [BIN, 'write', '--version', '1.2.3.4.5'], { cwd: dir, stdio: 'pipe' }); }
    catch (e: any) { code = e.status; }
    expect(code).toBe(2);
  });

  test('VERSION-only repo (no package.json) writes just VERSION', () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-noPkg-'));
    fs.writeFileSync(path.join(d2, 'VERSION'), '0.1.0.0\n');
    const out = execFileSync('bun', [BIN, 'write', '--version', '0.2.0.0'], { cwd: d2 }).toString();
    expect(JSON.parse(out)).toEqual({ wrote: '0.2.0.0', packageJson: false, packageLock: false });
    expect(fs.readFileSync(path.join(d2, 'VERSION'), 'utf-8').trim()).toBe('0.2.0.0');
    fs.rmSync(d2, { recursive: true, force: true });
  });
});

describe('repair (DRIFT_STALE_PKG)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-repair-'));
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  test('syncs package.json.version up to VERSION, no re-bump', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), '2.0.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.9.0.0' }, null, 2) + '\n');
    const out = execFileSync('bun', [BIN, 'repair'], { cwd: dir }).toString();
    expect(JSON.parse(out)).toEqual({ repaired: '2.0.0.0' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).version).toBe('2.0.0.0');
    expect(fs.readFileSync(path.join(dir, 'VERSION'), 'utf-8').trim()).toBe('2.0.0.0'); // unchanged
  });

  test('refuses to propagate an invalid VERSION (exit 2)', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), 'not-a-version\n');
    let code = 0;
    try { execFileSync('bun', [BIN, 'repair'], { cwd: dir, stdio: 'pipe' }); }
    catch (e: any) { code = e.status; }
    expect(code).toBe(2);
  });
});

describe('write/repair sync npm lockfiles (both version fields, #2567)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-lock-'));
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  const lock = (v: string) => JSON.stringify({
    name: 'x', version: v, lockfileVersion: 3,
    packages: { '': { name: 'x', version: v }, 'node_modules/a': { version: '9.9.9' } },
  }, null, 2) + '\n';

  test('write updates top-level version and packages[""].version, leaves deps alone', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), lock('1.0.0.0'));
    const out = execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: dir }).toString();
    expect(JSON.parse(out)).toEqual({ wrote: '1.1.0.0', packageJson: true, packageLock: true });
    const l = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf-8'));
    expect(l.version).toBe('1.1.0.0');
    expect(l.packages[''].version).toBe('1.1.0.0');
    expect(l.packages['node_modules/a'].version).toBe('9.9.9'); // untouched
  });

  test('repair heals a stale lockfile alongside package.json', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), '2.0.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.9.0.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), lock('1.9.0.0'));
    execFileSync('bun', [BIN, 'repair'], { cwd: dir });
    const l = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf-8'));
    expect(l.version).toBe('2.0.0.0');
    expect(l.packages[''].version).toBe('2.0.0.0');
  });

  test('lockfileVersion 1 (no packages map) syncs top-level only, no crash', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), '3.0.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '2.9.0.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', version: '2.9.0.0', lockfileVersion: 1 }, null, 2) + '\n');
    execFileSync('bun', [BIN, 'repair'], { cwd: dir });
    const l = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf-8'));
    expect(l.version).toBe('3.0.0.0');
    expect(l.packages).toBeUndefined();
  });

  test('npm-shrinkwrap.json is synced too when present (never created)', () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-shrink-'));
    fs.writeFileSync(path.join(d2, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(d2, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(d2, 'npm-shrinkwrap.json'), lock('1.0.0.0').replace('package-lock', 'npm-shrinkwrap'));
    const out = execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: d2 }).toString();
    expect(JSON.parse(out).packageLock).toBe(true);
    const l = JSON.parse(fs.readFileSync(path.join(d2, 'npm-shrinkwrap.json'), 'utf-8'));
    expect(l.version).toBe('1.1.0.0');
    expect(l.packages[''].version).toBe('1.1.0.0');
    // No package-lock.json invented alongside it.
    expect(fs.existsSync(path.join(d2, 'package-lock.json'))).toBe(false);
    fs.rmSync(d2, { recursive: true, force: true });
  });

  test('malformed lockfile fails the write with exit 3 (half-write is loud, not silent)', () => {
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-badlock-'));
    fs.writeFileSync(path.join(d3, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(d3, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(d3, 'package-lock.json'), '{ not json');
    let code = 0;
    try { execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: d3, stdio: 'pipe' }); }
    catch (e: any) { code = e.status; }
    expect(code).toBe(3);
    // VERSION was written before the failure — exactly the half-write the
    // exit-3 contract exists to surface.
    expect(fs.readFileSync(path.join(d3, 'VERSION'), 'utf-8').trim()).toBe('1.1.0.0');
    fs.rmSync(d3, { recursive: true, force: true });
  });
});

describe('classify (idempotency over a real git base)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-classify-'));
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  // Build a tiny repo with an "origin/main" carrying VERSION=1.0.0.0.
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0.0\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0' }, null, 2) + '\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  // Fake an "origin/main" remote-tracking ref pointing at this commit.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  fs.mkdirSync(path.join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'refs', 'remotes', 'origin', 'main'), head + '\n');

  test('reports FRESH before any bump', () => {
    const out = execFileSync('bun', [BIN, 'classify', '--base', 'main'], { cwd: dir }).toString();
    expect(JSON.parse(out).state).toBe('FRESH');
  });

  test('reports ALREADY_BUMPED after VERSION+pkg move together', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), '1.1.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.1.0.0' }, null, 2) + '\n');
    const out = execFileSync('bun', [BIN, 'classify', '--base', 'main'], { cwd: dir }).toString();
    const parsed = JSON.parse(out);
    expect(parsed.state).toBe('ALREADY_BUMPED');
    expect(parsed.baseVersion).toBe('1.0.0.0');
    expect(parsed.currentVersion).toBe('1.1.0.0');
  });
});

/**
 * A repo whose single source of truth is a package.json at a non-root path,
 * holding plain 3-digit semver — the shape gstack's native VERSION-file
 * assumption failed closed on (#2501). Before this, classify reported
 * {state: FRESH, baseVersion: "0.0.0.0", pkgExists: false} no matter what the
 * repo's real version was: it looked for a root VERSION file and a root
 * package.json, found neither, and reported a pristine repo at version zero.
 *
 * These cases pass --version-path explicitly; the .gstack/version-path pin
 * flows through the same reader once classify/write/repair resolve the pin's
 * repo-relative form (#2462, covered in its own suite below the pin fix).
 */
describe('package.json as the version source (monorepo, 3-digit, #2501)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-pkgsrc-'));
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  const pkgRel = 'frontend/package.json';
  const pkgAbs = path.join(dir, pkgRel);
  fs.mkdirSync(path.join(dir, 'frontend'), { recursive: true });
  fs.writeFileSync(pkgAbs, JSON.stringify({ name: 'frontend', version: '0.99.2', private: true, scripts: { dev: 'next dev' } }, null, 2) + '\n');

  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'v0.99.2 base'], { cwd: dir });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  fs.mkdirSync(path.join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'refs', 'remotes', 'origin', 'main'), head + '\n');

  test('classify reads the real version from the package.json version-path', () => {
    const out = execFileSync('bun', [BIN, 'classify', '--base', 'main', '--version-path', pkgRel], { cwd: dir }).toString();
    const parsed = JSON.parse(out);
    expect(parsed.state).toBe('FRESH');
    expect(parsed.baseVersion).toBe('0.99.2');    // was "0.0.0.0"
    expect(parsed.currentVersion).toBe('0.99.2'); // was "0.0.0.0"
    expect(parsed.pkgExists).toBe(true);          // was false
  });

  test('write updates the package.json in place and creates no VERSION file', () => {
    const out = execFileSync('bun', [BIN, 'write', '--version', '0.99.3', '--version-path', pkgRel], { cwd: dir }).toString();
    expect(JSON.parse(out)).toEqual({ wrote: '0.99.3', versionPath: pkgRel, packageJson: true });
    const pkg = JSON.parse(fs.readFileSync(pkgAbs, 'utf-8'));
    expect(pkg.version).toBe('0.99.3');
    expect(pkg.scripts).toEqual({ dev: 'next dev' }); // rest of the file untouched
    expect(pkg.name).toBe('frontend');
    expect(fs.existsSync(path.join(dir, 'VERSION'))).toBe(false);
  });

  test('classify reports ALREADY_BUMPED after that write, not a drift state', () => {
    const out = execFileSync('bun', [BIN, 'classify', '--base', 'main', '--version-path', pkgRel], { cwd: dir }).toString();
    const parsed = JSON.parse(out);
    expect(parsed.state).toBe('ALREADY_BUMPED');
    expect(parsed.baseVersion).toBe('0.99.2');
    expect(parsed.currentVersion).toBe('0.99.3');
  });

  test('repair is a no-op: there is no second file to drift from', () => {
    const out = execFileSync('bun', [BIN, 'repair', '--version-path', pkgRel], { cwd: dir }).toString();
    expect(JSON.parse(out).repaired).toBeNull();
  });

  test('write refuses a version-path that does not exist', () => {
    let code = 0;
    try {
      execFileSync('bun', [BIN, 'write', '--version', '1.0.0', '--version-path', 'nope/package.json'], { cwd: dir, stdio: 'pipe' });
    } catch (e: any) { code = e.status; }
    expect(code).toBe(2);
  });
});

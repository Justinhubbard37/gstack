/**
 * Windows re-run refresh (#2444).
 *
 * On Windows, _link_or_copy installs REAL directory copies (no Developer
 * Mode symlinks). The skill-linking guards `[ -L "$target" ] || [ ! -e
 * "$target" ]` in link_codex_skill_dirs / link_factory_skill_dirs /
 * link_opencode_skill_dirs / create_agents_sidecar therefore skipped every
 * re-run: `./setup --host codex` reported "gstack ready" but never refreshed
 * an already-installed SKILL.md after `git pull`. The fix bypasses the guard
 * when IS_WINDOWS=1 — _link_or_copy rm -rf's the destination first, so the
 * copy refreshes in place.
 *
 * The behavior fixture drives the REAL link_codex_skill_dirs /
 * create_agents_sidecar functions (extracted from setup) against a fake
 * install tree; the static block pins the bypass at all five guard sites so
 * factory/opencode can't silently regress.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 2);
}

const WINDOWS_BYPASS = '[ "$IS_WINDOWS" -eq 1 ] || [ -L ';

describe('setup: Windows re-run refresh — static guard sites (#2444)', () => {
  test('no install guard is missing the IS_WINDOWS bypass', () => {
    // Every `[ -L ...] || [ ! -e ...]` refresh guard in setup must carry the
    // bypass — a bare guard is a Windows re-run no-op waiting to happen.
    const bareGuards = SETUP_SRC
      .split('\n')
      .filter((l) => /\[ -L "\$[A-Za-z_/${}.]+" \] \|\| \[ ! -e /.test(l) && !l.includes('IS_WINDOWS'));
    expect(bareGuards).toEqual([]);
    expect(SETUP_SRC.split(WINDOWS_BYPASS).length - 1).toBeGreaterThanOrEqual(5);
  });

  test.each([
    'link_codex_skill_dirs',
    'link_factory_skill_dirs',
    'link_opencode_skill_dirs',
    'link_cursor_skill_dirs',
    'create_agents_sidecar',
    'create_cursor_sidecar',
  ])('%s bypasses the symlink-or-missing guard on Windows', (fn) => {
    expect(extractFn(fn)).toContain(WINDOWS_BYPASS);
  });
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the extracted installer functions against a fake tree. */
function runInstaller(
  isWindows: '0' | '1',
  fns: string[],
  invocation: string,
  extraVars = '',
): RunResult {
  const script = [
    'set -e',
    `IS_WINDOWS=${isWindows}`,
    extraVars,
    extractFn('_link_or_copy'),
    ...fns.map(extractFn),
    invocation,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 15_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('setup: Windows re-run refresh — behavior fixture (#2444)', () => {
  test('IS_WINDOWS=1: link_codex_skill_dirs refreshes an already-installed skill', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rerun-'));
    try {
      const fake = path.join(tmp, 'gstack');
      const skills = path.join(tmp, 'skills');
      const demo = path.join(fake, '.agents', 'skills', 'gstack-demo');
      fs.mkdirSync(demo, { recursive: true });
      fs.mkdirSync(skills, { recursive: true });
      fs.writeFileSync(path.join(demo, 'SKILL.md'), 'v1-original\n');

      // First run: installs the copy.
      let r = runInstaller('1', ['link_codex_skill_dirs'], `link_codex_skill_dirs "${fake}" "${skills}"`);
      expect(r.status).toBe(0);
      const installed = path.join(skills, 'gstack-demo', 'SKILL.md');
      expect(fs.readFileSync(installed, 'utf-8')).toBe('v1-original\n');
      expect(fs.lstatSync(path.join(skills, 'gstack-demo')).isSymbolicLink()).toBe(false);

      // Upstream ships a change (the git pull).
      fs.writeFileSync(path.join(demo, 'SKILL.md'), 'v2-UPDATED\n');

      // Second run: pre-#2444 this was a silent no-op on Windows.
      r = runInstaller('1', ['link_codex_skill_dirs'], `link_codex_skill_dirs "${fake}" "${skills}"`);
      expect(r.status).toBe(0);
      expect(fs.readFileSync(installed, 'utf-8')).toBe('v2-UPDATED\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('IS_WINDOWS=1: create_agents_sidecar refreshes copied runtime assets', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rerun-sidecar-'));
    try {
      const fake = path.join(tmp, 'gstack');
      fs.mkdirSync(path.join(fake, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(fake, 'bin', 'tool.sh'), 'v1\n');
      fs.writeFileSync(path.join(fake, 'ETHOS.md'), 'ethos-v1\n');

      const vars = `SOURCE_GSTACK_DIR="${fake}"`;
      let r = runInstaller('1', ['create_agents_sidecar'], `create_agents_sidecar "${fake}"`, vars);
      expect(r.status).toBe(0);
      const sidecarBin = path.join(fake, '.agents', 'skills', 'gstack', 'bin', 'tool.sh');
      const sidecarEthos = path.join(fake, '.agents', 'skills', 'gstack', 'ETHOS.md');
      expect(fs.readFileSync(sidecarBin, 'utf-8')).toBe('v1\n');
      expect(fs.readFileSync(sidecarEthos, 'utf-8')).toBe('ethos-v1\n');

      fs.writeFileSync(path.join(fake, 'bin', 'tool.sh'), 'v2\n');
      fs.writeFileSync(path.join(fake, 'ETHOS.md'), 'ethos-v2\n');

      r = runInstaller('1', ['create_agents_sidecar'], `create_agents_sidecar "${fake}"`, vars);
      expect(r.status).toBe(0);
      expect(fs.readFileSync(sidecarBin, 'utf-8')).toBe('v2\n');
      expect(fs.readFileSync(sidecarEthos, 'utf-8')).toBe('ethos-v2\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('IS_WINDOWS=1: the gstack sidecar dir is still skipped by the skill loop', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rerun-skip-'));
    try {
      const fake = path.join(tmp, 'gstack');
      const skills = path.join(tmp, 'skills');
      const sidecar = path.join(fake, '.agents', 'skills', 'gstack');
      fs.mkdirSync(sidecar, { recursive: true });
      fs.mkdirSync(skills, { recursive: true });
      fs.writeFileSync(path.join(sidecar, 'SKILL.md'), 'sidecar\n');

      const r = runInstaller('1', ['link_codex_skill_dirs'], `link_codex_skill_dirs "${fake}" "${skills}"`);
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(skills, 'gstack'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// On real Windows, `ln -snf` under Git Bash silently produces copies, so the
// Unix-mode symlink assertions are meaningless there — the same skip the
// _link_or_copy behavior matrix uses (test/setup-windows-fallback.test.ts).
describe.skipIf(process.platform === 'win32')(
  'setup: Unix path unchanged by the #2444 bypass',
  () => {
    test('IS_WINDOWS=0: installs a symlink and re-runs still refresh through it', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rerun-unix-'));
      try {
        const fake = path.join(tmp, 'gstack');
        const skills = path.join(tmp, 'skills');
        const demo = path.join(fake, '.agents', 'skills', 'gstack-demo');
        fs.mkdirSync(demo, { recursive: true });
        fs.mkdirSync(skills, { recursive: true });
        fs.writeFileSync(path.join(demo, 'SKILL.md'), 'v1-original\n');

        let r = runInstaller('0', ['link_codex_skill_dirs'], `link_codex_skill_dirs "${fake}" "${skills}"`);
        expect(r.status).toBe(0);
        const target = path.join(skills, 'gstack-demo');
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);

        // A symlink serves updates without any re-run at all…
        fs.writeFileSync(path.join(demo, 'SKILL.md'), 'v2-UPDATED\n');
        expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf-8')).toBe('v2-UPDATED\n');

        // …and the re-run keeps it a symlink (guard still passes via -L).
        r = runInstaller('0', ['link_codex_skill_dirs'], `link_codex_skill_dirs "${fake}" "${skills}"`);
        expect(r.status).toBe(0);
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  },
);

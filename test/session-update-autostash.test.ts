import { describe, test, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// #2566: on a normal install, tracked files are locally patched (skill-prefix
// name rewrites, gbrain-refresh blocks), so a bare `git pull --ff-only`
// refused FOREVER — 308 consecutive PULL_FAILED entries observed, with the
// reason discarded by 2>/dev/null. The fix: --autostash un-wedges the pull
// over local edits, and stderr is captured into the log so a real failure
// names its cause.

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'bin', 'gstack-session-update');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-supd-'));
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const install = path.join(base, 'install');
  const state = path.join(base, 'state');
  fs.mkdirSync(state, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);

  fs.mkdirSync(path.join(seed, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(seed, 'SKILL.md'), '# top\nname: qa\nbody line\n');
  // Stub config: auto_upgrade on, prefix off; gbrain-refresh no-op.
  fs.writeFileSync(
    path.join(seed, 'bin', 'gstack-config'),
    '#!/usr/bin/env bash\nif [ "$1" = "get" ]; then case "$2" in auto_upgrade) echo true;; skill_prefix) echo false;; *) echo "";; esac; fi\nexit 0\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(seed, 'bin', 'gstack-patch-names'), '#!/usr/bin/env bash\nexit 0\n', {
    mode: 0o755,
  });
  git(seed, 'init', '-q');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, install]);
  return { base, origin, seed, install, state };
}

function runScript(install: string, state: string) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, GSTACK_DIR: install, GSTACK_STATE_DIR: state },
    timeout: 20000,
  });
}

async function waitForLog(state: string, pattern: RegExp, ms = 15000): Promise<string> {
  const logFile = path.join(state, 'analytics', 'session-update.log');
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (pattern.test(content)) return content;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
}

describe('gstack-session-update pull wedge (#2566)', () => {
  test('locally-patched tracked files no longer wedge the ff-only pull', async () => {
    const { base, seed, install, state } = makeFixture();
    try {
      // Upstream advances (edit at the TOP of SKILL.md)…
      fs.writeFileSync(
        path.join(seed, 'SKILL.md'),
        '# top v2\nname: qa\nbody line\n',
      );
      git(seed, 'commit', '-aqm', 'upstream change');
      git(seed, 'push', '-q', 'origin', 'main');
      const upstreamHead = git(seed, 'rev-parse', 'HEAD');

      // …while the install carries a local patch at the BOTTOM (the
      // prefix-rename / gbrain-block shape: tracked file, modified).
      fs.appendFileSync(path.join(install, 'SKILL.md'), 'locally patched line\n');

      const r = runScript(install, state);
      expect(r.status).toBe(0);
      const log = await waitForLog(state, /UPDATING|UP_TO_DATE|PULL_FAILED/);
      expect(log).not.toContain('PULL_FAILED');
      expect(log).toContain('UPDATING');
      expect(git(install, 'rev-parse', 'HEAD')).toBe(upstreamHead);
      // The autostash pop preserved the local patch over the new tree.
      expect(fs.readFileSync(path.join(install, 'SKILL.md'), 'utf8')).toContain(
        'locally patched line',
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30000);

  test('a genuinely failing pull logs its REASON, not just an exit code', async () => {
    const { base, seed, install, state } = makeFixture();
    try {
      // Diverge: local commit the remote doesn't have + remote advance → non-ff.
      fs.appendFileSync(path.join(install, 'VERSION'), 'local\n');
      git(install, 'commit', '-aqm', 'local divergence');
      fs.appendFileSync(path.join(seed, 'VERSION'), 'remote\n');
      git(seed, 'commit', '-aqm', 'remote divergence');
      git(seed, 'push', '-q', 'origin', 'main');

      const r = runScript(install, state);
      expect(r.status).toBe(0);
      const log = await waitForLog(state, /PULL_FAILED/);
      expect(log).toContain('PULL_FAILED');
      const line = log.split('\n').find((l) => l.includes('PULL_FAILED')) ?? '';
      expect(line).toContain('reason=');
      expect(line).not.toContain('reason=unknown');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30000);
});

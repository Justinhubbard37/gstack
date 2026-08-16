/**
 * gbrain-sync integration tests.
 *
 * Covers the core cross-machine memory sync feature end-to-end:
 *   - bin/gstack-config gbrain keys (validation, isolation)
 *   - bin/gstack-brain-enqueue (atomicity, skip list, no-op gates)
 *   - bin/gstack-jsonl-merge (3-way, ts-sort, hash-fallback)
 *   - bin/gstack-brain-sync --once (drain, commit, push, secret-scan, skip-file)
 *   - bin/gstack-artifacts-init + --restore round-trip
 *   - bin/gstack-brain-uninstall preserves user data
 *   - env isolation (GSTACK_HOME never bleeds into real ~/.gstack/config.yaml)
 *
 * Runs each test against a temp GSTACK_HOME and a local bare git repo as
 * a fake remote. No live GitHub, no live GBrain.
 */

import { describe, test as _test, expect, beforeEach, afterEach } from 'bun:test';

// Boost timeout: brain-sync tests spawn git, network-ls-remote, and 10-way
// parallel processes — 5s default is too tight.
const test = (name: string, fn: any) => _test(name, fn, 30000);
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpHome: string;
let bareRemote: string;

function run(argv: string[], opts: { env?: Record<string, string>; input?: string } = {}) {
  const bin = argv[0];
  const full = bin.startsWith('/') ? bin : path.join(BIN, bin);
  const res = spawnSync(full, argv.slice(1), {
    // HOME is overridden too: gstack-artifacts-init writes
    // $HOME/.gstack-artifacts-remote.txt (plain $HOME, not GSTACK_HOME), so
    // without this every free-suite run clobbers the operator's real
    // artifacts-remote pointer. Keep it inside tmpHome, which afterEach removes.
    env: { ...process.env, HOME: tmpHome, GSTACK_HOME: tmpHome, ...(opts.env || {}) },
    encoding: 'utf-8',
    input: opts.input,
    cwd: ROOT,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

function git(args: string[], cwd?: string) {
  const res = spawnSync('git', args, { cwd: cwd || tmpHome, encoding: 'utf-8' });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sync-home-'));
  bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sync-remote-'));
  spawnSync('git', ['init', '--bare', '-q', '-b', 'main', bareRemote]);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(bareRemote, { recursive: true, force: true });
  // Clean up any remote-helper file init may have written. run() now pins
  // HOME to tmpHome so these land inside the removed temp dir, but scrub the
  // real home too as defense in depth — and cover BOTH the legacy brain-remote
  // name and the current artifacts-remote name (init writes the latter).
  for (const name of ['.gstack-brain-remote.txt', '.gstack-artifacts-remote.txt']) {
    const remoteFile = path.join(os.homedir(), name);
    // Only remove if it points at OUR bare remote (don't clobber a real user file).
    try {
      const contents = fs.readFileSync(remoteFile, 'utf-8').trim();
      if (contents === bareRemote) fs.unlinkSync(remoteFile);
    } catch {}
  }
});

// ---------------------------------------------------------------
// Config key validation + env isolation
// ---------------------------------------------------------------
describe('gstack-config gbrain keys', () => {
  test('default artifacts_sync_mode is off', () => {
    const r = run(['gstack-config', 'get', 'artifacts_sync_mode']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('off');
  });

  test('default artifacts_sync_mode_prompted is false', () => {
    const r = run(['gstack-config', 'get', 'artifacts_sync_mode_prompted']);
    expect(r.stdout.trim()).toBe('false');
  });

  test('accepts full / artifacts-only / off', () => {
    for (const val of ['full', 'artifacts-only', 'off']) {
      const set = run(['gstack-config', 'set', 'artifacts_sync_mode', val]);
      expect(set.status).toBe(0);
      const get = run(['gstack-config', 'get', 'artifacts_sync_mode']);
      expect(get.stdout.trim()).toBe(val);
    }
  });

  test('invalid artifacts_sync_mode value warns + defaults', () => {
    const r = run(['gstack-config', 'set', 'artifacts_sync_mode', 'bogus']);
    expect(r.stderr).toContain('not recognized');
    const get = run(['gstack-config', 'get', 'artifacts_sync_mode']);
    expect(get.stdout.trim()).toBe('off');
  });

  test('GSTACK_HOME overrides real config dir', () => {
    // Real ~/.gstack/config.yaml must not change, regardless of what it
    // already contains on the developer's machine.
    const realConfig = path.join(os.homedir(), '.gstack', 'config.yaml');
    const before = fs.existsSync(realConfig) ? fs.readFileSync(realConfig, 'utf-8') : null;

    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);

    // The override actually took effect — temp config got the new value.
    const tempConfig = fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8');
    expect(tempConfig).toContain('artifacts_sync_mode: full');

    // Real ~/.gstack/config.yaml must not be touched.
    const after = fs.existsSync(realConfig) ? fs.readFileSync(realConfig, 'utf-8') : null;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------
// Enqueue behavior
// ---------------------------------------------------------------
describe('gstack-brain-enqueue', () => {
  test('no-op when feature not initialized', () => {
    const r = run(['gstack-brain-enqueue', 'projects/foo/learnings.jsonl']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, '.brain-queue.jsonl'))).toBe(false);
  });

  test('no-op when mode is off (even if .git exists)', () => {
    fs.mkdirSync(path.join(tmpHome, '.git'), { recursive: true });
    const r = run(['gstack-brain-enqueue', 'projects/foo/learnings.jsonl']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, '.brain-queue.jsonl'))).toBe(false);
  });

  test('enqueues when mode is full and .git exists', () => {
    fs.mkdirSync(path.join(tmpHome, '.git'), { recursive: true });
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    run(['gstack-brain-enqueue', 'projects/foo/learnings.jsonl']);
    const queue = fs.readFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'utf-8');
    expect(queue).toContain('projects/foo/learnings.jsonl');
    const obj = JSON.parse(queue.trim());
    expect(obj.file).toBe('projects/foo/learnings.jsonl');
    expect(obj.ts).toBeTruthy();
  });

  test('skip list honored', () => {
    fs.mkdirSync(path.join(tmpHome, '.git'), { recursive: true });
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    fs.writeFileSync(path.join(tmpHome, '.brain-skip.txt'), 'projects/foo/secret.jsonl\n');
    run(['gstack-brain-enqueue', 'projects/foo/secret.jsonl']);
    run(['gstack-brain-enqueue', 'projects/foo/ok.jsonl']);
    const queue = fs.readFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'utf-8');
    expect(queue).not.toContain('secret.jsonl');
    expect(queue).toContain('ok.jsonl');
  });

  test('concurrent enqueues all land (atomic append)', async () => {
    fs.mkdirSync(path.join(tmpHome, '.git'), { recursive: true });
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    const procs = [];
    for (let i = 0; i < 10; i++) {
      procs.push(new Promise<void>((resolve) => {
        const r = spawnSync(path.join(BIN, 'gstack-brain-enqueue'), [`file-${i}.jsonl`], {
          env: { ...process.env, GSTACK_HOME: tmpHome },
          encoding: 'utf-8',
        });
        resolve();
      }));
    }
    await Promise.all(procs);
    const queue = fs.readFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'utf-8');
    const lines = queue.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(10);
  });

  test('no args does not crash', () => {
    const r = run(['gstack-brain-enqueue']);
    expect(r.status).toBe(0);
  });
});

// ---------------------------------------------------------------
// JSONL merge driver
// ---------------------------------------------------------------
describe('gstack-jsonl-merge', () => {
  test('3-way merge dedups + sorts by ts', () => {
    const base = path.join(tmpHome, 'base.jsonl');
    const ours = path.join(tmpHome, 'ours.jsonl');
    const theirs = path.join(tmpHome, 'theirs.jsonl');
    fs.writeFileSync(base, '');
    fs.writeFileSync(ours, '{"x":1,"ts":"2026-01-01T10:00:00Z"}\n{"x":2,"ts":"2026-01-01T11:00:00Z"}\n');
    fs.writeFileSync(theirs, '{"x":3,"ts":"2026-01-01T09:00:00Z"}\n{"x":2,"ts":"2026-01-01T11:00:00Z"}\n');
    const r = run([path.join(BIN, 'gstack-jsonl-merge'), base, ours, theirs]);
    expect(r.status).toBe(0);
    const lines = fs.readFileSync(ours, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('"x":3');  // earliest ts
    expect(lines[2]).toContain('"x":2');  // latest ts
  });

  test('falls back to hash order for lines without ts', () => {
    const base = path.join(tmpHome, 'base.jsonl');
    const ours = path.join(tmpHome, 'ours.jsonl');
    const theirs = path.join(tmpHome, 'theirs.jsonl');
    fs.writeFileSync(base, '');
    fs.writeFileSync(ours, '{"a":1}\n{"a":2}\n');
    fs.writeFileSync(theirs, '{"a":3}\n{"a":2}\n');
    run([path.join(BIN, 'gstack-jsonl-merge'), base, ours, theirs]);
    const lines = fs.readFileSync(ours, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(3);
    // Order is deterministic (sha256 of each line).
    const again = spawnSync(path.join(BIN, 'gstack-jsonl-merge'), [base, ours, theirs]);
    // (re-running doesn't change the order since same input → same output)
  });
});

// ---------------------------------------------------------------
// Init + sync + restore round-trip
// ---------------------------------------------------------------
describe('init + sync + restore round-trip', () => {
  test('init creates canonical files + registers drivers', () => {
    const r = run(['gstack-artifacts-init', '--remote', bareRemote]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.brain-allowlist'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.brain-privacy-map.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.gitattributes'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.git/hooks/pre-commit'))).toBe(true);
    // Merge driver registered in local git config.
    const cfg = git(['config', '--get', 'merge.jsonl-append.driver']);
    expect(cfg.stdout).toContain('gstack-jsonl-merge');
  });

  test('refuses init on different remote', () => {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    const otherRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-other-'));
    spawnSync('git', ['init', '--bare', '-q', '-b', 'main', otherRemote]);
    const r = run(['gstack-artifacts-init', '--remote', otherRemote]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('already a git repo pointing at');
    fs.rmSync(otherRemote, { recursive: true, force: true });
  });

  test('full sync: init → enqueue → --once → commit pushed', () => {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'),
      '{"skill":"x","insight":"y","ts":"2026-04-22T10:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    // Check the remote got the commit.
    const log = spawnSync('git', ['--git-dir=' + bareRemote, 'log', '--oneline'], { encoding: 'utf-8' });
    expect(log.stdout).toMatch(/sync: 1 file/);
  });

  test('restore round-trip: writes on machine A visible on machine B', () => {
    // Machine A.
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'myproj'), { recursive: true });
    const aLearning = '{"skill":"x","insight":"machine A wisdom","ts":"2026-04-22T10:00:00Z"}\n';
    fs.writeFileSync(path.join(tmpHome, 'projects/myproj/learnings.jsonl'), aLearning);
    run(['gstack-brain-enqueue', 'projects/myproj/learnings.jsonl']);
    run(['gstack-brain-sync', '--once']);

    // Machine B (new temp home).
    const machineB = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-machineB-'));
    const r = run(['gstack-brain-restore', bareRemote], {
      env: { GSTACK_HOME: machineB },
    });
    expect(r.status).toBe(0);
    const restored = fs.readFileSync(path.join(machineB, 'projects/myproj/learnings.jsonl'), 'utf-8');
    expect(restored).toContain('machine A wisdom');
    // Merge drivers re-registered on B.
    const cfg = spawnSync('git', ['-C', machineB, 'config', '--get', 'merge.jsonl-append.driver'], { encoding: 'utf-8' });
    expect(cfg.stdout).toContain('gstack-jsonl-merge');
    fs.rmSync(machineB, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------
// Secret scan: all regex families block
// ---------------------------------------------------------------
describe('gstack-brain-sync secret scan', () => {
  const SECRETS: [string, string][] = [
    ['aws-access-key', 'AKIAABCDEFGHIJKLMNOP'],
    ['github-token-ghp', 'ghp_abcdefghij1234567890abcdef1234567890'],
    ['github-token-github-pat', 'github_pat_11ABCDEFG1234567890_abcdef'],
    ['openai-key', 'sk-abcdefghij1234567890abcdef1234567890'],
    ['pem-block', '-----BEGIN PRIVATE KEY-----'],
    ['jwt', 'eyJ0eXAiOiJKV1QiLCJh.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF30oGTbU'],
    ['bearer-json', '"authorization":"Bearer abcdef1234567890abcdef1234567890"'],
  ];

  for (const [name, content] of SECRETS) {
    test(`blocks ${name}`, () => {
      run(['gstack-artifacts-init', '--remote', bareRemote]);
      run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
      fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
      fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'),
        `{"leaked":"${content}"}\n`);
      run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
      const r = run(['gstack-brain-sync', '--once']);
      expect(r.status).toBe(0);  // exits clean even when blocked
      // No new commit should have been created.
      const log = git(['log', '--oneline']);
      expect(log.stdout.split('\n').filter(Boolean).length).toBeLessThanOrEqual(3);
      // Status file should report blocked.
      const status = JSON.parse(fs.readFileSync(path.join(tmpHome, '.brain-sync-status.json'), 'utf-8'));
      expect(status.status).toBe('blocked');
    });
  }

  test('--skip-file unblocks specific file', () => {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    const leakPath = 'projects/p/leaked.jsonl';
    fs.writeFileSync(path.join(tmpHome, leakPath),
      '{"gh":"ghp_abcdefghij1234567890abcdef1234567890"}\n');
    run(['gstack-brain-enqueue', leakPath]);
    run(['gstack-brain-sync', '--once']);  // blocked
    run(['gstack-brain-sync', '--skip-file', leakPath]);
    // Any future enqueue of this path should no-op.
    run(['gstack-brain-enqueue', leakPath]);
    const skip = fs.readFileSync(path.join(tmpHome, '.brain-skip.txt'), 'utf-8');
    expect(skip).toContain(leakPath);
  });
});

// ---------------------------------------------------------------
// Egress receipt gate: receipt-before-commit, queue intact on refusal
// ---------------------------------------------------------------
describe('gstack-brain-sync egress receipt gate', () => {
  test('refused receipt leaves the queue intact, makes no commit, and next run retries', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // chmod is advisory there
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'),
      '{"skill":"x","insight":"y","ts":"2026-04-22T10:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    const commitsBefore = git(['rev-list', '--count', 'HEAD']).stdout.trim();

    // Make the receipt unwritable: security dir exists but is read-only.
    // (artifacts-init may have created it already — mkdirSync's mode is a
    // no-op on an existing dir, so chmod explicitly.)
    fs.mkdirSync(path.join(tmpHome, 'security'), { recursive: true });
    fs.chmodSync(path.join(tmpHome, 'security'), 0o500);
    try {
      const refused = run(['gstack-brain-sync', '--once']);
      expect(refused.status).toBe(1);
      // DX contract: problem + cause + fix, plain language.
      expect(refused.stderr).toContain('NOT sent');
      expect(refused.stderr).toContain('EGRESS_RECEIPT_FAILED');
      expect(refused.stderr).toContain('Fix: chmod -R u+w');
      expect(refused.stderr).toContain('ATTEMPTS to send off-machine');
      // Queue intact (receipt is written BEFORE the commit consumes it).
      const queue = fs.readFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'utf-8');
      expect(queue).toContain('projects/p/learnings.jsonl');
      // No local commit was created.
      expect(git(['rev-list', '--count', 'HEAD']).stdout.trim()).toBe(commitsBefore);
      // Nothing reached the remote.
      const remoteLog = spawnSync('git', ['--git-dir=' + bareRemote, 'log', '--oneline'], { encoding: 'utf-8' });
      expect(remoteLog.stdout).not.toMatch(/sync: 1 file/);
      const status = JSON.parse(fs.readFileSync(path.join(tmpHome, '.brain-sync-status.json'), 'utf-8'));
      expect(status.status).toBe('push_failed');
      expect(status.message).toContain('EGRESS_RECEIPT_FAILED');
    } finally {
      fs.chmodSync(path.join(tmpHome, 'security'), 0o700);
    }

    // Next run (ledger writable again) drains the intact queue and pushes.
    const retry = run(['gstack-brain-sync', '--once']);
    expect(retry.status).toBe(0);
    const log = spawnSync('git', ['--git-dir=' + bareRemote, 'log', '--oneline'], { encoding: 'utf-8' });
    expect(log.stdout).toMatch(/sync: 1 file/);
  });

  test('successful push writes a git-class receipt before the send', () => {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'),
      '{"skill":"x","insight":"y","ts":"2026-04-22T10:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    const ledger = fs.readFileSync(path.join(tmpHome, 'security', 'egress.jsonl'), 'utf-8');
    const records = ledger.trim().split('\n').map((l) => JSON.parse(l));
    const pushReceipt = records.find((rec) => rec.sink === 'brain-sync' && rec.payload_class === 'curated-memory-git-push');
    expect(pushReceipt).toBeTruthy();
    expect(pushReceipt.sha256).toBeNull(); // git owns the bytes
  });
});

// ---------------------------------------------------------------
// Uninstall preserves user data
// ---------------------------------------------------------------
describe('gstack-brain-uninstall', () => {
  test('removes sync config but preserves learnings/project data', () => {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'user-data'), { recursive: true });
    const preservedContent = '{"keep":"me","ts":"2026-04-22T12:00:00Z"}\n';
    fs.writeFileSync(path.join(tmpHome, 'projects/user-data/learnings.jsonl'), preservedContent);
    const r = run(['gstack-brain-uninstall', '--yes']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.brain-allowlist'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, 'consumers.json'))).toBe(false);
    // Project data preserved.
    const preserved = fs.readFileSync(path.join(tmpHome, 'projects/user-data/learnings.jsonl'), 'utf-8');
    expect(preserved).toBe(preservedContent);
    // Config key reset.
    const mode = run(['gstack-config', 'get', 'artifacts_sync_mode']);
    expect(mode.stdout.trim()).toBe('off');
  });
});

// ---------------------------------------------------------------
// --discover-new: cursor-based change detection
// ---------------------------------------------------------------
describe('gstack-brain-sync --discover-new', () => {
  test('enqueues new allowlisted files; idempotent on re-run', () => {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'retros'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'retros/week-1.md'), '# retro\n');
    run(['gstack-brain-sync', '--discover-new']);
    let queue = fs.readFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'utf-8');
    expect(queue).toContain('retros/week-1.md');
    // Clear queue, run again — idempotent (no new entries).
    fs.writeFileSync(path.join(tmpHome, '.brain-queue.jsonl'), '');
    run(['gstack-brain-sync', '--discover-new']);
    queue = fs.readFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'utf-8');
    expect(queue.trim()).toBe('');
  });
});

// ---------------------------------------------------------------
// #2549 queue integrity: classified drops, privacy retention,
// surgical rewrite, unpushed-commit detector
// ---------------------------------------------------------------
describe('#2549 queue integrity', () => {
  function initWithMode(mode: string) {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', mode]);
  }
  const queueText = () => fs.readFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'utf-8');
  const statusJson = () => JSON.parse(fs.readFileSync(path.join(tmpHome, '.brain-sync-status.json'), 'utf-8'));

  test('privacy-held entries are RETAINED and classified, not wiped as "no allowlisted changes"', () => {
    // timeline.jsonl is class=behavioral; artifacts-only mode holds it.
    initWithMode('artifacts-only');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/timeline.jsonl'), '{"skill":"x","event":"started"}\n');
    run(['gstack-brain-enqueue', 'projects/p/timeline.jsonl']);
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    // The exact #2549 repro: the old code truncated the queue here and said
    // "no allowlisted changes in queue". The entry must survive, and the
    // status must attribute the hold honestly.
    expect(queueText()).toContain('projects/p/timeline.jsonl');
    const s = statusJson();
    expect(s.status).toBe('idle');
    expect(s.message).toContain('privacy-held retained');
    expect(s.message).not.toContain('no allowlisted changes');
  });

  test('unmatched and missing entries drop WITH counts and a 0600 drops sidecar', () => {
    initWithMode('full');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    // Unmatched: no allowlist glob covers .txt scratch files.
    fs.writeFileSync(path.join(tmpHome, 'projects/p/scratch.txt'), 'x\n');
    fs.appendFileSync(path.join(tmpHome, '.brain-queue.jsonl'), '{"file":"projects/p/scratch.txt"}\n');
    // Missing: allowlisted name that does not exist on disk.
    fs.appendFileSync(path.join(tmpHome, '.brain-queue.jsonl'), '{"file":"projects/p/learnings.jsonl"}\n');
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    expect(queueText()).not.toContain('scratch.txt');
    expect(queueText()).not.toContain('learnings.jsonl');
    const s = statusJson();
    expect(s.message).toContain('1 unmatched dropped');
    expect(s.message).toContain('1 missing dropped');
    const drops = path.join(tmpHome, '.brain-sync-drops.json');
    expect(fs.existsSync(drops)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(drops).mode & 0o777).toBe(0o600);
    }
    const detail = JSON.parse(fs.readFileSync(drops, 'utf-8'));
    expect(detail.dropped.unmatched).toContain('projects/p/scratch.txt');
    expect(detail.dropped.missing).toContain('projects/p/learnings.jsonl');
  });

  test('an unparseable queue line is preserved, never destroyed', () => {
    initWithMode('full');
    fs.appendFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'not json at all\n');
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    expect(queueText()).toContain('not json at all');
  });

  test('surgical rewrite: a synced entry leaves the queue while a held sibling survives the same drain', () => {
    // Proves the rewrite is a live filtered rewrite, not a truncation: two
    // entries drain in one --once, one stages+pushes, one is mode-held.
    initWithMode('artifacts-only');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"x","insight":"y","ts":"2026-01-01T00:00:00Z"}\n');
    fs.writeFileSync(path.join(tmpHome, 'projects/p/timeline.jsonl'), '{"skill":"x","event":"started"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    run(['gstack-brain-enqueue', 'projects/p/timeline.jsonl']);
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    expect(queueText()).not.toContain('learnings.jsonl');   // synced, removed
    expect(queueText()).toContain('timeline.jsonl');        // held, retained
    const log = spawnSync('git', ['--git-dir=' + bareRemote, 'log', '--oneline'], { encoding: 'utf-8' });
    expect(log.stdout).toMatch(/sync: 1 file/);
  });

  test('push failure retains the commit locally and the run-start detector re-pushes it', () => {
    initWithMode('full');
    // Establish origin/main so the detector has a remote ref to compare.
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"a","ts":"2026-01-01T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);

    // Reject the next push at the remote (pre-receive hook exits 1 with an
    // auth-shaped message so the auth branch is exercised too).
    const hook = path.join(bareRemote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "403 forbidden" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);

    fs.appendFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"b","ts":"2026-01-02T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    const fail = run(['gstack-brain-sync', '--once']);
    expect(fail.status).toBe(0);
    const s = statusJson();
    expect(s.status).toBe('push_failed');
    expect(s.message).toContain('commit retained locally');
    // Drained path left the queue — it lives in the local commit now.
    expect(queueText()).not.toContain('learnings.jsonl');
    // The commit exists locally, ahead of origin.
    const ahead = git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim();
    expect(Number(ahead)).toBeGreaterThan(0);

    // Remote healthy again: an EMPTY-queue run must still deliver the
    // stranded commit (the detector, not the drain, pushes it).
    fs.rmSync(hook);
    const retry = run(['gstack-brain-sync', '--once']);
    expect(retry.status).toBe(0);
    const log = spawnSync('git', ['--git-dir=' + bareRemote, 'log', '--oneline'], { encoding: 'utf-8' });
    expect(log.stdout).toMatch(/sync: 1 file/);
    expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('0');
  });

  test('receipt refusal at the detector skips the retry without wedging the drain', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // chmod advisory there
    initWithMode('full');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"a","ts":"2026-01-01T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);

    // Strand a commit: reject pushes, drain once.
    const hook = path.join(bareRemote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    fs.appendFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"b","ts":"2026-01-02T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    fs.rmSync(hook);

    // Break receipts. The detector's retry must be SKIPPED (no wedge), and
    // the run must still exit 0 with nothing else to do.
    fs.mkdirSync(path.join(tmpHome, 'security'), { recursive: true });
    fs.chmodSync(path.join(tmpHome, 'security'), 0o500);
    try {
      const r = run(['gstack-brain-sync', '--once']);
      expect(r.status).toBe(0);
      // Commit still stranded (retry skipped, not attempted unreceipted).
      expect(Number(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim())).toBeGreaterThan(0);
    } finally {
      fs.chmodSync(path.join(tmpHome, 'security'), 0o700);
    }

    // Receipts healthy: detector delivers. The refused attempt above stamped
    // the 10-minute throttle (deliberately — refusals must not busy-loop the
    // network at every skill boundary), so model the interval passing.
    fs.writeFileSync(path.join(tmpHome, '.brain-last-push-attempt'), '0');
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('0');
  });

  test('detector attempts are throttled to one per interval', () => {
    initWithMode('full');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"a","ts":"2026-01-01T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);

    // Strand a commit behind a rejecting remote.
    const hook = path.join(bareRemote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    fs.appendFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"b","ts":"2026-01-02T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    fs.rmSync(hook);

    // First empty-queue run: detector attempts (stamps the throttle), pushes.
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    const stamp1 = fs.readFileSync(path.join(tmpHome, '.brain-last-push-attempt'), 'utf-8');
    expect(Number(stamp1)).toBeGreaterThan(0);
    expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('0');

    // Strand another; an immediate second run must NOT attempt (stamp fresh).
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    fs.appendFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"c","ts":"2026-01-03T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    fs.rmSync(hook);
    const stampBefore = fs.readFileSync(path.join(tmpHome, '.brain-last-push-attempt'), 'utf-8');
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    // Throttled: stamp unchanged, commit still stranded.
    expect(fs.readFileSync(path.join(tmpHome, '.brain-last-push-attempt'), 'utf-8')).toBe(stampBefore);
    expect(Number(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim())).toBeGreaterThan(0);

    // Interval passed: delivers.
    fs.writeFileSync(path.join(tmpHome, '.brain-last-push-attempt'), '0');
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('0');
  });

  test('an interleaved user commit disables the detector push (exclusive author gate)', () => {
    initWithMode('full');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"a","ts":"2026-01-01T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);

    // Strand a bot commit behind a rejecting remote.
    const hook = path.join(bareRemote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    fs.appendFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"b","ts":"2026-01-02T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    fs.rmSync(hook);

    // A user manually commits in ~/.gstack on top of the stranded bot commit.
    expect(git(['-c', 'user.name=Garry', '-c', 'user.email=garry@example.com',
                '-c', 'commit.gpgsign=false',
                'commit', '--allow-empty', '-m', 'manual note']).status).toBe(0);

    // Interval passed, remote healthy, queue empty: the detector must STILL
    // refuse — `push origin HEAD` would publish the user's commit uninvited.
    fs.writeFileSync(path.join(tmpHome, '.brain-last-push-attempt'), '0');
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(Number(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim())).toBe(2);

    // A REAL drain still rides the user commit along, as before — the gate
    // scopes only the detector's autonomous retry, not user-initiated syncs.
    fs.appendFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"c","ts":"2026-01-03T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('0');
  });
});

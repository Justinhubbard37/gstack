/**
 * Timeline Stop hook (#2553) — fail-open contract (F5).
 *
 * The preamble writes event:"started" at every skill start; the completion
 * write is end-of-workflow prose and unenforceable, so interrupted sessions
 * leaked started > completed forever. The Stop hook closes dangling entries.
 *
 * Contract under test: ALWAYS exits 0 (corrupt timeline, missing timeline,
 * garbage stdin), append-only, and the normal path appends event:"completed"
 * with outcome "unknown" + source "stop-hook" for every un-closed "started".
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK = path.join(ROOT, 'hosts', 'claude', 'hooks', 'timeline-stop-hook');

const SLUG = 'stop-hook-test-project';

let tmpHome: string;
let projectDir: string;
let timelinePath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-stop-hook-home-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-stop-hook-proj-'));
  fs.mkdirSync(path.join(tmpHome, 'projects', SLUG), { recursive: true });
  timelinePath = path.join(tmpHome, 'projects', SLUG, 'timeline.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function runHook(stdin: string): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [HOOK], {
    input: stdin,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GSTACK_HOME: tmpHome,
      GSTACK_PROJECT_SLUG: SLUG, // deterministic slug, no git required
    },
    timeout: 15_000,
  });
  return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function stopPayload(): string {
  return JSON.stringify({
    session_id: 'sess-abc',
    hook_event_name: 'Stop',
    cwd: projectDir,
  });
}

function timelineEntries(): any[] {
  if (!fs.existsSync(timelinePath)) return [];
  return fs
    .readFileSync(timelinePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { __corrupt: l };
      }
    });
}

describe('timeline-stop-hook (#2553, F5 fail-open)', () => {
  test('normal path: closes dangling started entries, leaves closed pairs alone', () => {
    fs.writeFileSync(
      timelinePath,
      [
        JSON.stringify({ skill: 'review', event: 'started', branch: 'main', session: '11-1' }),
        JSON.stringify({ skill: 'ship', event: 'started', session: '22-2' }),
        JSON.stringify({ skill: 'ship', event: 'completed', session: '22-2', outcome: 'success' }),
      ].join('\n') + '\n',
    );

    const r = runHook(stopPayload());
    expect(r.exitCode).toBe(0);

    const entries = timelineEntries();
    // Append-only: the three originals survive verbatim in order.
    expect(entries[0]).toMatchObject({ skill: 'review', event: 'started' });
    expect(entries[2]).toMatchObject({ skill: 'ship', event: 'completed', outcome: 'success' });

    const repairs = entries.filter((e) => e.source === 'stop-hook');
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({
      skill: 'review',
      event: 'completed',
      outcome: 'unknown',
      branch: 'main',
      session: '11-1',
    });
    expect(typeof repairs[0].ts).toBe('string');
  });

  test('idempotent: a second Stop appends nothing new', () => {
    fs.writeFileSync(
      timelinePath,
      JSON.stringify({ skill: 'qa', event: 'started', session: '33-3' }) + '\n',
    );
    expect(runHook(stopPayload()).exitCode).toBe(0);
    const afterFirst = timelineEntries().length;
    expect(runHook(stopPayload()).exitCode).toBe(0);
    expect(timelineEntries().length).toBe(afterFirst);
  });

  test('count semantics: two runs under one key, one completed — the dangler is still repaired', () => {
    // Legacy entries carry no session field, so both runs share the same
    // skill+session key (same-second "$$-epoch" ids collide the same way).
    // With set semantics the first run's completion masked the second run's
    // dangler forever; counting closes the difference.
    fs.writeFileSync(
      timelinePath,
      [
        JSON.stringify({ skill: 'review', event: 'started' }),
        JSON.stringify({ skill: 'review', event: 'completed', outcome: 'success' }),
        JSON.stringify({ skill: 'review', event: 'started' }),
      ].join('\n') + '\n',
    );

    expect(runHook(stopPayload()).exitCode).toBe(0);
    const repairs = timelineEntries().filter((e) => e.source === 'stop-hook');
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ skill: 'review', event: 'completed', outcome: 'unknown' });

    // Idempotent under count semantics too: started=2, completed=2 → no-op.
    expect(runHook(stopPayload()).exitCode).toBe(0);
    expect(timelineEntries().filter((e) => e.source === 'stop-hook')).toHaveLength(1);
  });

  test('exit 0 on missing timeline (nothing written, nothing created)', () => {
    const r = runHook(stopPayload());
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(timelinePath)).toBe(false);
  });

  test('exit 0 on a corrupt timeline; corrupt lines are skipped, valid ones still repaired', () => {
    fs.writeFileSync(
      timelinePath,
      [
        'this is not json at all {{{',
        JSON.stringify({ skill: 'qa', event: 'started', session: '44-4' }),
        '{"half": "an object"',
      ].join('\n') + '\n',
    );
    const r = runHook(stopPayload());
    expect(r.exitCode).toBe(0);
    const repairs = timelineEntries().filter((e) => e.source === 'stop-hook');
    expect(repairs).toHaveLength(1);
    expect(repairs[0].skill).toBe('qa');
  });

  test('exit 0 on a FULLY corrupt timeline (no valid entries → no write)', () => {
    const garbage = 'garbage\n{{{\n';
    fs.writeFileSync(timelinePath, garbage);
    const r = runHook(stopPayload());
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(timelinePath, 'utf-8')).toBe(garbage);
  });

  test('exit 0 on garbage stdin', () => {
    fs.writeFileSync(
      timelinePath,
      JSON.stringify({ skill: 'qa', event: 'started', session: '55-5' }) + '\n',
    );
    const r = runHook('not json');
    expect(r.exitCode).toBe(0);
  });

  test('exit 0 on empty stdin', () => {
    expect(runHook('').exitCode).toBe(0);
  });

  test('tail window (P3): a recent dangling entry in a >256KB timeline is still repaired', () => {
    const lines: string[] = [];
    // An old dangling entry that falls OUTSIDE the 256KB tail window —
    // beyond repair interest by design (its session is long gone).
    lines.push(JSON.stringify({ skill: 'review', event: 'started', session: 'old-1' }));
    // >512KB of closed pairs pushes the old entry well past the window while
    // proving windowed parsing still walks real entries.
    let n = 0;
    while (lines.length * 100 < 512 * 1024) {
      lines.push(
        JSON.stringify({ skill: 'qa', event: 'started', session: `pad-${n}`, pad: '#'.repeat(40) }),
      );
      lines.push(JSON.stringify({ skill: 'qa', event: 'completed', session: `pad-${n}`, outcome: 'success' }));
      n++;
    }
    lines.push(JSON.stringify({ skill: 'ship', event: 'started', session: 'recent-9' }));
    fs.writeFileSync(timelinePath, lines.join('\n') + '\n');
    expect(fs.statSync(timelinePath).size).toBeGreaterThan(256 * 1024);

    const r = runHook(stopPayload());
    expect(r.exitCode).toBe(0);
    const repairs = timelineEntries().filter((e) => e.source === 'stop-hook');
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({
      skill: 'ship',
      event: 'completed',
      outcome: 'unknown',
      session: 'recent-9',
    });
  });

  test('oversized timeline is skipped, untouched, and still exits 0 (fail-open size cap)', () => {
    const line = JSON.stringify({ skill: 'qa', event: 'started', session: '66-6' }) + '\n';
    const filler = '#'.repeat(1024 * 1024);
    fs.writeFileSync(timelinePath, line + filler.repeat(11));
    const sizeBefore = fs.statSync(timelinePath).size;
    const r = runHook(stopPayload());
    expect(r.exitCode).toBe(0);
    expect(fs.statSync(timelinePath).size).toBe(sizeBefore);
  });
});

describe('timeline-stop-hook wiring', () => {
  test('setup registers the Stop hook with its own source tag and tears it down on --no-team', () => {
    const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
    expect(setup).toContain('--event Stop');
    expect(setup).toContain('--source gstack-timeline-stop');
    expect(setup).toContain('hosts/claude/hooks/timeline-stop-hook');
    // --no-team teardown removes it alongside the plan-tune hooks.
    const teardown = setup.slice(setup.indexOf('# Also tear down plan-tune'));
    expect(teardown).toContain('remove-source --source gstack-timeline-stop');
  });

  test('gstack-uninstall removes the Stop hook registration', () => {
    const uninstall = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-uninstall'), 'utf-8');
    expect(uninstall).toContain('remove-source --source gstack-timeline-stop');
  });

  test('the bash shim is fail-open: exits 0 even when bun is unavailable', () => {
    const r = spawnSync('bash', [HOOK], {
      input: '{}',
      encoding: 'utf-8',
      env: { HOME: tmpHome, PATH: '/usr/bin:/bin', GSTACK_HOME: tmpHome },
      timeout: 15_000,
    });
    expect(r.status).toBe(0);
  });
});

/**
 * gstack-settings-hook schema-aware surface (T3 plan-tune cathedral).
 *
 * Verifies add-event / remove-source / diff-event / rollback / list-sources
 * for PreToolUse + PostToolUse registration. Existing team-mode.test.ts
 * covers the legacy `add <cmd>` / `remove <cmd>` shape; this file only
 * covers the new surface introduced for the plan-tune cathedral.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const SETTINGS_HOOK = path.join(ROOT, 'bin', 'gstack-settings-hook');

let tmpDir: string;
let settingsFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-shsa-'));
  settingsFile = path.join(tmpDir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync([SETTINGS_HOOK, ...args].map((s) => `'${s}'`).join(' '), {
      env: { ...process.env, GSTACK_SETTINGS_FILE: settingsFile },
      encoding: 'utf-8',
      timeout: 10000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status ?? 1 };
  }
}

function settings(): any {
  return JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
}

// ----------------------------------------------------------------------
// add-event
// ----------------------------------------------------------------------

describe('add-event', () => {
  test('registers a PreToolUse hook with matcher + source tag', () => {
    const r = run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', '(AskUserQuestion|mcp__.*__AskUserQuestion)',
      '--command', '/abs/path/to/question-preference-hook',
      '--source', 'plan-tune-cathedral',
      '--timeout', '5',
    ]);
    expect(r.exitCode).toBe(0);
    const s = settings();
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].matcher).toBe('(AskUserQuestion|mcp__.*__AskUserQuestion)');
    expect(s.hooks.PreToolUse[0]._gstack_source).toBe('plan-tune-cathedral');
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('/abs/path/to/question-preference-hook');
    expect(s.hooks.PreToolUse[0].hooks[0].timeout).toBe(5);
  });

  test('registers a PostToolUse hook independently of PreToolUse', () => {
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/pre',
      '--source', 'plan-tune-cathedral',
    ]);
    const r = run([
      'add-event',
      '--event', 'PostToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/post',
      '--source', 'plan-tune-cathedral',
    ]);
    expect(r.exitCode).toBe(0);
    const s = settings();
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('/pre');
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe('/post');
  });

  test('idempotent: re-adding same (event, matcher, source) updates in place', () => {
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/v1',
      '--source', 'plan-tune-cathedral',
    ]);
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/v2',
      '--source', 'plan-tune-cathedral',
    ]);
    const s = settings();
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('/v2');
  });

  test('dedup includes command: same (event, matcher, command) with different source updates in place', () => {
    run([
      'add-event',
      '--event', 'PostToolUse',
      '--matcher', '(AskUserQuestion|mcp__.*__AskUserQuestion)',
      '--command', '/abs/path/to/question-log-hook',
      '--source', 'source-A',
      '--timeout', '5',
    ]);
    run([
      'add-event',
      '--event', 'PostToolUse',
      '--matcher', '(AskUserQuestion|mcp__.*__AskUserQuestion)',
      '--command', '/abs/path/to/question-log-hook',
      '--source', 'source-B',
      '--timeout', '5',
    ]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0]._gstack_source).toBe('source-B');
  });

  test('dedup includes command: untagged entry with same command is updated not duplicated', () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: '(AskUserQuestion|mcp__.*__AskUserQuestion)',
              hooks: [{ type: 'command', command: '/abs/path/to/question-log-hook', timeout: 5 }],
            },
          ],
        },
      }, null, 2),
    );
    run([
      'add-event',
      '--event', 'PostToolUse',
      '--matcher', '(AskUserQuestion|mcp__.*__AskUserQuestion)',
      '--command', '/abs/path/to/question-log-hook',
      '--source', 'plan-tune-cathedral',
      '--timeout', '5',
    ]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0]._gstack_source).toBe('plan-tune-cathedral');
  });

  test('preserves unrelated existing hooks', () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: '/user-own-hook' }],
            },
          ],
        },
      }, null, 2),
    );
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/gstack-hook',
      '--source', 'plan-tune-cathedral',
    ]);
    const s = settings();
    expect(s.hooks.PreToolUse).toHaveLength(2);
    // User's Bash hook still present
    const bash = s.hooks.PreToolUse.find((e: any) => e.matcher === 'Bash');
    expect(bash).toBeDefined();
    expect(bash.hooks[0].command).toBe('/user-own-hook');
  });

  test('writes a timestamped backup before mutating', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ existing: 'value' }));
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/gstack',
      '--source', 'plan-tune-cathedral',
    ]);
    const backups = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith('settings.json.bak.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const backupContent = JSON.parse(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf-8'));
    expect(backupContent.existing).toBe('value');
    expect(backupContent.hooks).toBeUndefined();
  });

  test('rejects invalid --event', () => {
    const r = run([
      'add-event',
      '--event', 'NotAnEvent',
      '--command', '/x',
      '--source', 'plan-tune',
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/invalid --event/);
  });
});

// ----------------------------------------------------------------------
// remove-source
// ----------------------------------------------------------------------

describe('remove-source', () => {
  test('removes all entries with a given source tag, leaves others alone', () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ command: '/keep-me' }] },
          ],
        },
      }),
    );
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/a',
      '--source', 'plan-tune-cathedral',
    ]);
    run([
      'add-event',
      '--event', 'PostToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/b',
      '--source', 'plan-tune-cathedral',
    ]);
    const r = run(['remove-source', '--source', 'plan-tune-cathedral']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/removed 2 hook/);
    const s = settings();
    expect(s.hooks.PostToolUse).toBeUndefined();
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('/keep-me');
  });

  test('safely no-ops when settings.json missing', () => {
    const r = run(['remove-source', '--source', 'plan-tune-cathedral']);
    expect(r.exitCode).toBe(0);
  });
});

// ----------------------------------------------------------------------
// diff-event
// ----------------------------------------------------------------------

describe('diff-event', () => {
  test('emits BEFORE + AFTER without mutating settings.json', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ existing: 'value' }));
    const r = run([
      'diff-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/gstack',
      '--source', 'plan-tune-cathedral',
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('--- BEFORE');
    expect(r.stdout).toContain('--- AFTER');
    expect(r.stdout).toContain('plan-tune-cathedral');
    // Settings file unchanged.
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).toEqual({ existing: 'value' });
  });
});

// ----------------------------------------------------------------------
// rollback
// ----------------------------------------------------------------------

describe('rollback', () => {
  test('restores latest backup', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ original: true }));
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/gstack',
      '--source', 'plan-tune-cathedral',
    ]);
    expect(settings().hooks).toBeDefined();
    const r = run(['rollback']);
    expect(r.exitCode).toBe(0);
    const s = settings();
    expect(s.original).toBe(true);
    expect(s.hooks).toBeUndefined();
  });

  test('fails clearly when no backup pointer exists', () => {
    const r = run(['rollback']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/no backup pointer/);
  });
});

// ----------------------------------------------------------------------
// list-sources
// ----------------------------------------------------------------------

describe('list-sources', () => {
  test('shows source-tagged hooks across all events', () => {
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/pre',
      '--source', 'plan-tune-cathedral',
    ]);
    run([
      'add-event',
      '--event', 'PostToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/post',
      '--source', 'plan-tune-cathedral',
    ]);
    const r = run(['list-sources']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('PreToolUse');
    expect(r.stdout).toContain('PostToolUse');
    expect(r.stdout).toContain('plan-tune-cathedral');
  });

  test('empty when no settings file', () => {
    const r = run(['list-sources']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/no settings file/);
  });
});

// ----------------------------------------------------------------------
// Phantom-hooks heal surface (v1.67.2): KNOWN_HOOKS identity table,
// per-item mutation, prune-stale, mutation lock, fail-closed parse.
//
// Ownership is intrinsic (basename + relpath suffix + event/matcher against
// the fixed table) because Claude Code strips the _gstack_source key when it
// rewrites settings.json — tag-only dedupe is what let every Conductor
// worktree append a fresh dead entry.
// ----------------------------------------------------------------------

const AUQ_MATCHER = '(AskUserQuestion|mcp__.*__AskUserQuestion)';
const HOOK_NAMES = [
  'question-log-hook',
  'question-preference-hook',
  'auq-error-fallback-hook',
  'timeline-stop-hook',
];

/** run() with hermetic gstack-config state (prune-stale consults plan_tune_hooks). */
function runIso(args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const stdout = execSync([SETTINGS_HOOK, ...args].map((s) => `'${s}'`).join(' '), {
      env: {
        ...process.env,
        GSTACK_SETTINGS_FILE: settingsFile,
        GSTACK_STATE_ROOT: tmpDir,
        ...extraEnv,
      },
      encoding: 'utf-8',
      timeout: 15000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status ?? 1 };
  }
}

/** A fake stable install with executable hooks, under `base`. */
function mkCanon(base: string, name = 'canon'): string {
  const canon = path.join(base, name);
  fs.mkdirSync(path.join(canon, 'hosts', 'claude', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(canon, 'bin'), { recursive: true });
  for (const h of HOOK_NAMES) {
    const p = path.join(canon, 'hosts', 'claude', 'hooks', h);
    fs.writeFileSync(p, '#!/bin/sh\n');
    fs.chmodSync(p, 0o755);
  }
  const su = path.join(canon, 'bin', 'gstack-session-update');
  fs.writeFileSync(su, '#!/bin/sh\n');
  fs.chmodSync(su, 0o755);
  return canon;
}

function hookEntry(cmd: string, matcher?: string, src?: string, extraItems: any[] = []) {
  const e: any = { hooks: [...extraItems, { type: 'command', command: cmd, timeout: 5 }] };
  if (matcher) e.matcher = matcher;
  if (src) e._gstack_source = src;
  return e;
}

function backups(): string[] {
  return fs.readdirSync(tmpDir).filter((f) => f.startsWith('settings.json.bak.'));
}

describe('add-event: per-item identity re-point', () => {
  test('tag-stripped stale worktree path is re-pointed in place, tag restored', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: { PostToolUse: [hookEntry('/dead/wt/hosts/claude/hooks/question-log-hook', AUQ_MATCHER)] },
    }, null, 2));
    runIso([
      'add-event', '--event', 'PostToolUse', '--matcher', AUQ_MATCHER,
      '--command', `${canon}/hosts/claude/hooks/question-log-hook`,
      '--source', 'plan-tune-cathedral', '--timeout', '5',
    ]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe(`${canon}/hosts/claude/hooks/question-log-hook`);
    expect(s.hooks.PostToolUse[0]._gstack_source).toBe('plan-tune-cathedral');
  });

  test('foreign path with a gstack basename is NOT claimed (wrong relpath suffix)', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: { PostToolUse: [hookEntry('/home/u/myhooks/question-log-hook', AUQ_MATCHER)] },
    }, null, 2));
    runIso([
      'add-event', '--event', 'PostToolUse', '--matcher', AUQ_MATCHER,
      '--command', `${canon}/hosts/claude/hooks/question-log-hook`,
      '--source', 'plan-tune-cathedral',
    ]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(2);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe('/home/u/myhooks/question-log-hook');
  });

  test('mixed entry: only the gstack item (index > 0) is replaced; the user item survives', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [hookEntry(
          '/dead/wt/hosts/claude/hooks/question-log-hook', AUQ_MATCHER, undefined,
          [{ type: 'command', command: '/Users/me/my-own-hook' }],
        )],
      },
    }, null, 2));
    runIso([
      'add-event', '--event', 'PostToolUse', '--matcher', AUQ_MATCHER,
      '--command', `${canon}/hosts/claude/hooks/question-log-hook`,
      '--source', 'plan-tune-cathedral',
    ]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    const items = s.hooks.PostToolUse[0].hooks;
    expect(items).toHaveLength(2);
    expect(items[0].command).toBe('/Users/me/my-own-hook');
    expect(items[1].command).toBe(`${canon}/hosts/claude/hooks/question-log-hook`);
  });
});

describe('legacy remove: per-item (regression)', () => {
  test('mixed SessionStart entry: user item survives in place, gstack item removed', () => {
    // REGRESSION pin: the pre-v1.67.2 legacy `remove` dropped the ENTIRE
    // entry when any item matched gstack-session-update, destroying a user's
    // co-located hook. The rewrite filters per-item; this is the only test of
    // that branch (team-mode.test.ts covers single-item entries only).
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [
            { type: 'command', command: '/Users/me/my-own-session-hook' },
            { type: 'command', command: '/old/install/bin/gstack-session-update' },
          ],
        }],
      },
    }, null, 2));
    const r = runIso(['remove', '/old/install/bin/gstack-session-update']);
    expect(r.exitCode).toBe(0);
    const s = settings();
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe('/Users/me/my-own-session-hook');
  });
});

describe('ownership negatives', () => {
  test('owned basename+relpath under the WRONG matcher stays foreign (not re-pointed)', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [hookEntry('/dead/wt/hosts/claude/hooks/question-log-hook', 'Bash')],
      },
    }, null, 2));
    const before = fs.readFileSync(settingsFile, 'utf-8');
    const r = runIso(['prune-stale', '--repoint', canon]);
    expect(r.stdout).toMatch(/removed 0 gstack hook entries \(repointed 0\)/);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
  });

  test('prune-stale on an absent settings file exits 0 with removed 0', () => {
    const r = runIso(['prune-stale', '--repoint', '/nonexistent-root']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/removed 0 gstack hook entries \(repointed 0\)/);
    expect(fs.existsSync(settingsFile)).toBe(false);
  });
});

describe('remove-source: per-item', () => {
  test('mixed tagged entry: gstack item removed, user item survives, tag dropped', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [hookEntry(
          '/x/hosts/claude/hooks/question-log-hook', AUQ_MATCHER, 'plan-tune-cathedral',
          [{ type: 'command', command: '/Users/me/my-own-hook' }],
        )],
      },
    }, null, 2));
    const r = runIso(['remove-source', '--source', 'plan-tune-cathedral']);
    expect(r.stdout).toMatch(/removed 1 hook/);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0].hooks).toHaveLength(1);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe('/Users/me/my-own-hook');
    expect(s.hooks.PostToolUse[0]._gstack_source).toBeUndefined();
  });
});

describe('prune-stale', () => {
  test('prunes dead gstack items; keeps live gstack and dead non-gstack', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [
          hookEntry(`${canon}/hosts/claude/hooks/question-log-hook`, AUQ_MATCHER),   // live gstack
          hookEntry('/dead/wt/hosts/claude/hooks/auq-error-fallback-hook', AUQ_MATCHER), // dead gstack
          hookEntry('/dead/user/own-hook', AUQ_MATCHER),                              // dead NON-gstack
        ],
      },
    }, null, 2));
    const r = runIso(['prune-stale']);
    expect(r.stdout).toMatch(/removed 1 gstack hook entries/);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(2);
    const cmds = s.hooks.PostToolUse.map((e: any) => e.hooks[0].command);
    expect(cmds).toContain(`${canon}/hosts/claude/hooks/question-log-hook`);
    expect(cmds).toContain('/dead/user/own-hook');
  });

  test('no-op run writes no backup and leaves the file byte-identical', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: { PreToolUse: [hookEntry('/Users/me/my-own-hook', 'Bash')] },
    }, null, 2) + '\n');
    const before = fs.readFileSync(settingsFile, 'utf-8');
    const r = runIso(['prune-stale']);
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
    expect(backups()).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir, 'settings.json.bak-latest'))).toBe(false);
  });

  test('--repoint re-points dead AND live items, preserves bash prefix, restores tags', () => {
    const canon = mkCanon(tmpDir);
    const live = mkCanon(tmpDir, 'live-worktree');
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        Stop: [hookEntry(`${live}/hosts/claude/hooks/timeline-stop-hook`)],           // LIVE but ephemeral
        PostToolUse: [hookEntry('bash /dead/wt/hosts/claude/hooks/question-log-hook', AUQ_MATCHER)],
      },
    }, null, 2));
    const r = runIso(['prune-stale', '--repoint', canon]);
    expect(r.stdout).toMatch(/repointed 2/);
    const s = settings();
    expect(s.hooks.Stop[0].hooks[0].command).toBe(`${canon}/hosts/claude/hooks/timeline-stop-hook`);
    expect(s.hooks.Stop[0]._gstack_source).toBe('gstack-timeline-stop');
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe(`bash ${canon}/hosts/claude/hooks/question-log-hook`);
    expect(s.hooks.PostToolUse[0]._gstack_source).toBe('plan-tune-cathedral');
  });

  test('--repoint collapses exact duplicates preferring the tagged twin', () => {
    const canon = mkCanon(tmpDir);
    const cmd = `${canon}/hosts/claude/hooks/question-log-hook`;
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [
          hookEntry('/dead/a/hosts/claude/hooks/question-log-hook', AUQ_MATCHER),
          hookEntry(cmd, AUQ_MATCHER, 'plan-tune-cathedral'),
        ],
      },
    }, null, 2));
    runIso(['prune-stale', '--repoint', canon]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe(cmd);
    expect(s.hooks.PostToolUse[0]._gstack_source).toBe('plan-tune-cathedral');
  });

  test('--repoint never ADDS entries (repair, not registration)', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }, null, 2) + '\n');
    const before = fs.readFileSync(settingsFile, 'utf-8');
    runIso(['prune-stale', '--repoint', canon]);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
  });

  test('Windows backslash path is classified as gstack-owned and pruned when dead', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [hookEntry('C:\\dead\\wt\\hosts\\claude\\hooks\\question-log-hook', AUQ_MATCHER)],
      },
    }, null, 2));
    const r = runIso(['prune-stale']);
    expect(r.stdout).toMatch(/removed 1/);
    expect(settings().hooks).toBeUndefined();
  });

  test('spaced canonical root produces a quoted command that stays owned (idempotent)', () => {
    const spacedBase = path.join(tmpDir, 'My Claude');
    fs.mkdirSync(spacedBase, { recursive: true });
    const canon = mkCanon(spacedBase);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: { Stop: [hookEntry('/dead/wt/hosts/claude/hooks/timeline-stop-hook')] },
    }, null, 2));
    runIso(['prune-stale', '--repoint', canon]);
    const s = settings();
    expect(s.hooks.Stop[0].hooks[0].command).toBe(`"${canon}/hosts/claude/hooks/timeline-stop-hook"`);
    // Second run: the quoted command is still recognized as ours — no churn.
    const before = fs.readFileSync(settingsFile, 'utf-8');
    const r2 = runIso(['prune-stale', '--repoint', canon]);
    expect(r2.stdout).toMatch(/removed 0 gstack hook entries \(repointed 0\)/);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
  });

  test('--all removes live untagged gstack items, spares user hooks and mixed-entry user items', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [hookEntry(`${canon}/hosts/claude/hooks/question-log-hook`, AUQ_MATCHER)],
        Stop: [hookEntry(
          `${canon}/hosts/claude/hooks/timeline-stop-hook`, undefined, 'gstack-timeline-stop',
          [{ type: 'command', command: '/Users/me/custom-stop-hook' }],
        )],
        PreCompact: [hookEntry('/Users/me/my-own-hook')],
      },
    }, null, 2));
    const r = runIso(['prune-stale', '--all']);
    expect(r.stdout).toMatch(/removed 2/);
    const s = settings();
    expect(s.hooks.PostToolUse).toBeUndefined();
    expect(s.hooks.Stop[0].hooks).toHaveLength(1);
    expect(s.hooks.Stop[0].hooks[0].command).toBe('/Users/me/custom-stop-hook');
    expect(s.hooks.Stop[0]._gstack_source).toBeUndefined();
    expect(s.hooks.PreCompact[0].hooks[0].command).toBe('/Users/me/my-own-hook');
  });

  test('--all removes tagged single-item legacy strays (no table match)', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: { Stop: [hookEntry('/old/install/bin/gstack-verify-gate', undefined, 'gstack-verify-gate')] },
    }, null, 2));
    const r = runIso(['prune-stale', '--all']);
    expect(r.stdout).toMatch(/removed 1/);
    expect(settings().hooks).toBeUndefined();
  });

  test('--all and --repoint are mutually exclusive', () => {
    const r = runIso(['prune-stale', '--all', '--repoint', '/x']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/mutually exclusive/);
  });

  test('explicit plan_tune_hooks:no — dead plan-tune pruned, live plan-tune NOT re-pointed, Stop still re-pointed', () => {
    const canon = mkCanon(tmpDir);
    const live = mkCanon(tmpDir, 'live-worktree');
    execSync(`'${path.join(ROOT, 'bin', 'gstack-config')}' set plan_tune_hooks no`, {
      env: { ...process.env, GSTACK_STATE_ROOT: tmpDir },
    });
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [
          hookEntry('/dead/wt/hosts/claude/hooks/question-log-hook', AUQ_MATCHER),        // dead plan-tune
          hookEntry(`${live}/hosts/claude/hooks/auq-error-fallback-hook`, AUQ_MATCHER),   // LIVE plan-tune
        ],
        Stop: [hookEntry('/dead/wt/hosts/claude/hooks/timeline-stop-hook')],
      },
    }, null, 2));
    runIso(['prune-stale', '--repoint', canon]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    // Live plan-tune hook left exactly where it was (no re-activation without consent).
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe(`${live}/hosts/claude/hooks/auq-error-fallback-hook`);
    // Stop hook is not part of the opt-out — re-pointed to canonical.
    expect(s.hooks.Stop[0].hooks[0].command).toBe(`${canon}/hosts/claude/hooks/timeline-stop-hook`);
  });

  test('incident facsimile: the exact live-damage shape heals to canonical', () => {
    // Replays the 2026-08-17 production state: 6 PostToolUse / 3 PreToolUse /
    // 2 Stop entries; 6 dead (deleted worktrees), tags stripped on some, one
    // live-but-ephemeral Stop hook, plus a user hook that must survive.
    const canon = mkCanon(tmpDir);
    const cebu = mkCanon(tmpDir, 'cebu-v4');
    const dead = (n: string) => `/dead/biarritz-v3/hosts/claude/hooks/${n}`;
    const dead2 = (n: string) => `/dead/taipei-v2/hosts/claude/hooks/${n}`;
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        SessionStart: [hookEntry(`${canon}/bin/gstack-session-update`)],
        PostToolUse: [
          hookEntry(`${canon}/hosts/claude/hooks/auq-error-fallback-hook`, AUQ_MATCHER),
          hookEntry(`${canon}/hosts/claude/hooks/question-log-hook`, AUQ_MATCHER),
          hookEntry(dead('question-log-hook'), AUQ_MATCHER),
          hookEntry(dead('auq-error-fallback-hook'), AUQ_MATCHER),
          hookEntry(dead2('question-log-hook'), AUQ_MATCHER, 'plan-tune-cathedral'),
          hookEntry(dead2('auq-error-fallback-hook'), AUQ_MATCHER, 'auq-error-fallback'),
        ],
        PreToolUse: [
          hookEntry(`${canon}/hosts/claude/hooks/question-preference-hook`, AUQ_MATCHER),
          hookEntry(dead('question-preference-hook'), AUQ_MATCHER),
          hookEntry(dead2('question-preference-hook'), AUQ_MATCHER, 'plan-tune-cathedral'),
        ],
        Stop: [
          hookEntry(`${cebu}/hosts/claude/hooks/timeline-stop-hook`),
          hookEntry(dead2('timeline-stop-hook'), undefined, 'gstack-timeline-stop'),
        ],
        PreCompact: [hookEntry('/Users/me/my-own-hook')],
      },
    }, null, 2));
    const r = runIso(['prune-stale', '--repoint', canon]);
    expect(r.exitCode).toBe(0);
    const s = settings();
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.PostToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.PreCompact[0].hooks[0].command).toBe('/Users/me/my-own-hook');
    for (const ev of ['SessionStart', 'PostToolUse', 'PreToolUse', 'Stop']) {
      for (const e of s.hooks[ev]) {
        expect(e._gstack_source).toBeDefined();
        for (const it of e.hooks) expect(it.command.startsWith(canon)).toBe(true);
      }
    }
    const postSources = s.hooks.PostToolUse.map((e: any) => e._gstack_source).sort();
    expect(postSources).toEqual(['auq-error-fallback', 'plan-tune-cathedral']);
  });
});

describe('fail-closed parse (pre-existing data-loss fix)', () => {
  const MUTATORS: string[][] = [
    ['add', '/x/bin/gstack-session-update'],
    ['remove', '/x/bin/gstack-session-update'],
    ['add-event', '--event', 'Stop', '--command', '/x', '--source', 's'],
    ['remove-source', '--source', 'plan-tune-cathedral'],
    ['prune-stale'],
  ];
  test('every mutator refuses to touch a corrupt settings.json', () => {
    for (const args of MUTATORS) {
      fs.writeFileSync(settingsFile, '{definitely not json');
      const r = runIso(args);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toMatch(/refusing to mutate/);
      expect(fs.readFileSync(settingsFile, 'utf-8')).toBe('{definitely not json');
    }
  });
});

describe('mutation lock', () => {
  test('stale lock (old mtime) is taken over; mutation proceeds', () => {
    const lockDir = `${settingsFile}.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), 'dead-process');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, old, old);
    const r = runIso(['add-event', '--event', 'Stop', '--command', '/x/hosts/claude/hooks/timeline-stop-hook', '--source', 'gstack-timeline-stop']);
    expect(r.exitCode).toBe(0);
    expect(settings().hooks.Stop).toHaveLength(1);
    expect(fs.existsSync(lockDir)).toBe(false);   // released after the mutation
  });

  test('fresh foreign lock: mutation skipped with a warning, file untouched', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }, null, 2) + '\n');
    const before = fs.readFileSync(settingsFile, 'utf-8');
    const lockDir = `${settingsFile}.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), 'another-live-process');
    // Capture stderr explicitly: on a zero exit, execSync passes stderr
    // through to the parent instead of returning it.
    const cmd = [SETTINGS_HOOK, 'add-event', '--event', 'Stop', '--command', '/x', '--source', 's']
      .map((s) => `'${s}'`).join(' ');
    const out = execSync(`${cmd} 2>&1`, {
      env: {
        ...process.env,
        GSTACK_SETTINGS_FILE: settingsFile,
        GSTACK_STATE_ROOT: tmpDir,
        GSTACK_SETTINGS_LOCK_TIMEOUT_MS: '300',
      },
      encoding: 'utf-8',
      timeout: 15000,
    });
    expect(out).toMatch(/could not acquire lock/);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
    expect(fs.existsSync(lockDir)).toBe(true);    // foreign lock NOT stolen
  });

  test('two concurrent add-events both land (lock serializes; file stays valid JSON)', () => {
    const q = (args: string[]) =>
      [SETTINGS_HOOK, ...args].map((s) => `'${s}'`).join(' ');
    const a = q(['add-event', '--event', 'PreToolUse', '--matcher', AUQ_MATCHER, '--command', '/pre-hook', '--source', 'src-a']);
    const b = q(['add-event', '--event', 'PostToolUse', '--matcher', AUQ_MATCHER, '--command', '/post-hook', '--source', 'src-b']);
    execSync(`sh -c "${a} & ${b} & wait"`, {
      env: { ...process.env, GSTACK_SETTINGS_FILE: settingsFile, GSTACK_STATE_ROOT: tmpDir },
      encoding: 'utf-8',
      timeout: 20000,
    });
    const s = settings();   // throws if the file is corrupt
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse).toHaveLength(1);
  });
});

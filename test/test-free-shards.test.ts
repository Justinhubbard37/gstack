import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  isFreeTestFile,
  collectFreeTestFiles,
  detectWindowsFragility,
  curateWindowsSafe,
  stableHash,
  assignFilesToShards,
  buildShardArgs,
  normalizeRelativePath,
  runFreeShard,
  FREE_TEST_TIMEOUT_MS,
} from '../scripts/test-free-shards';

const ROOT = path.resolve(import.meta.dir, '..');

describe('test-free-shards: enumeration', () => {
  test('isFreeTestFile rejects non-test files', () => {
    expect(isFreeTestFile('test/foo.ts')).toBe(false);
    expect(isFreeTestFile('test/foo.test.ts')).toBe(true);
    expect(isFreeTestFile('test/foo.test.tsx')).toBe(true);
    expect(isFreeTestFile('test/foo.test.mjs')).toBe(true);
  });

  test('isFreeTestFile rejects paid eval tests', () => {
    expect(isFreeTestFile('test/skill-e2e-foo.test.ts')).toBe(false);
    expect(isFreeTestFile('test/skill-llm-eval.test.ts')).toBe(false);
    expect(isFreeTestFile('test/codex-e2e.test.ts')).toBe(false);
    expect(isFreeTestFile('test/gemini-e2e.test.ts')).toBe(false);
  });

  test('collectFreeTestFiles returns sorted, deduped, only-free list', () => {
    const files = collectFreeTestFiles(ROOT);
    expect(files.length).toBeGreaterThan(10);
    expect(files).toEqual([...files].sort());
    expect(new Set(files).size).toBe(files.length);
    for (const f of files) {
      expect(isFreeTestFile(f)).toBe(true);
    }
  });

  test('normalizeRelativePath converts Windows backslashes to forward slashes', () => {
    expect(normalizeRelativePath('test\\foo\\bar.test.ts')).toBe('test/foo/bar.test.ts');
    expect(normalizeRelativePath('test/foo/bar.test.ts')).toBe('test/foo/bar.test.ts');
  });
});

describe('test-free-shards: Windows curation', () => {
  function withTempFile(content: string, fn: (filePath: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curation-test-'));
    const file = path.join(dir, 'sample.test.ts');
    fs.writeFileSync(file, content);
    try {
      fn(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('detects /bin/bash hardcode', () => {
    withTempFile(`spawn('/bin/bash', ['-c', 'echo hi']);`, (f) => {
      expect(detectWindowsFragility(f)?.reason).toBe('hardcoded /bin/sh or /bin/bash');
    });
  });

  test('detects spawn("sh", ...)', () => {
    withTempFile(`spawnSync('sh', ['-c', 'command -v claude']);`, (f) => {
      expect(detectWindowsFragility(f)?.reason).toBe('spawn("sh", ...)');
    });
  });

  test('detects raw /tmp/ paths', () => {
    withTempFile(`const TMPERR = '/tmp/codex-err.txt';`, (f) => {
      expect(detectWindowsFragility(f)?.reason).toBe('raw /tmp/ path (use os.tmpdir())');
    });
  });

  test('detects which claude shell command', () => {
    withTempFile(`execSync('which claude').trim();`, (f) => {
      expect(detectWindowsFragility(f)?.reason).toBe('which claude (use Bun.which)');
    });
  });

  test('Windows-safe code passes the filter', () => {
    withTempFile(`import { spawn } from 'child_process'; spawn(claude.command, args);`, (f) => {
      expect(detectWindowsFragility(f)).toBeNull();
    });
  });

  test('curateWindowsSafe partitions files into safe + excluded', () => {
    const files = collectFreeTestFiles(ROOT);
    const result = curateWindowsSafe(files, ROOT);
    expect(result.safe.length + result.excluded.length).toBe(files.length);
    // Sanity: at least one excluded entry, since we know test/ship-version-sync.test.ts uses /bin/bash
    expect(result.excluded.length).toBeGreaterThan(0);
    // Every excluded entry has a non-empty reason
    for (const { reason } of result.excluded) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});

describe('test-free-shards: sharding', () => {
  test('stableHash is deterministic', () => {
    expect(stableHash('foo.test.ts')).toBe(stableHash('foo.test.ts'));
    expect(stableHash('foo.test.ts')).not.toBe(stableHash('bar.test.ts'));
  });

  test('assignFilesToShards partitions every file across exactly shardCount shards', () => {
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts'];
    const shards = assignFilesToShards(files, 3);
    expect(shards.length).toBe(3);
    expect(shards.flat().sort()).toEqual([...files].sort());
  });

  test('empty shards are preserved so indices stay stable for a CI matrix', () => {
    // 2 files can never occupy 10 shards — the rest MUST be present and empty,
    // not filtered out (filtering renumbered every later shard by occupancy).
    const files = ['a.test.ts', 'b.test.ts'];
    const shards = assignFilesToShards(files, 10);
    expect(shards.length).toBe(10);
    expect(shards.flat().sort()).toEqual([...files].sort());
    expect(shards.some((s) => s.length === 0)).toBe(true);
  });

  test("a file's shard index depends only on its own path — other files never renumber it", () => {
    const target = 'test/target.test.ts';
    const expected = stableHash(target) % 7;
    const alone = assignFilesToShards([target], 7);
    const crowded = assignFilesToShards(
      [target, 'test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/d.test.ts', 'browse/test/e.test.ts'],
      7,
    );
    expect(alone.findIndex((s) => s.includes(target))).toBe(expected);
    expect(crowded.findIndex((s) => s.includes(target))).toBe(expected);
  });

  test('assignFilesToShards rejects invalid shard counts', () => {
    expect(() => assignFilesToShards(['a.test.ts'], 0)).toThrow();
    expect(() => assignFilesToShards(['a.test.ts'], -1)).toThrow();
  });

  test('shards are stable across runs (same files always land in same shard)', () => {
    const files = ['x.test.ts', 'y.test.ts', 'z.test.ts'];
    const a = assignFilesToShards(files, 5);
    const b = assignFilesToShards(files, 5);
    expect(a).toEqual(b);
  });
});

describe('test-free-shards: shard args', () => {
  test('resolves exact absolute selectors (no substring shard bleed) and pins the per-test timeout', () => {
    const args = buildShardArgs(['test/foo.test.ts'], { rootDir: ROOT });
    expect(args[0]).toBe('test');
    expect(args[1]).toBe(path.resolve(ROOT, 'test/foo.test.ts'));
    expect(args).toContain(`--timeout=${FREE_TEST_TIMEOUT_MS}`);
    expect(args).toContain('--max-concurrency=1');
    expect(args).not.toContain('--parallel');
  });

  test('parallel mode swaps serial max-concurrency for --parallel', () => {
    const args = buildShardArgs(['test/foo.test.ts'], { rootDir: ROOT, parallel: true });
    expect(args).toContain('--parallel');
    expect(args).not.toContain('--max-concurrency=1');
  });

  test('per-test timeout matches the 30s the package.json test script used before the repoint', () => {
    expect(FREE_TEST_TIMEOUT_MS).toBe(30_000);
  });
});

describe('test-free-shards: strict shard execution', () => {
  // Fake command seam, same pattern as test/paid-shards.test.ts: each "file"
  // label selects a child command. Unlike the paid runner, runFreeShard
  // enforces the terminal-summary file count on injected commands too, so
  // fake PASSING commands must print a synthetic bun summary line.
  const SUMMARY_1 = 'Ran 3 tests across 1 files. [12.00ms]';
  const BUSY_LOOP = 'const end = Date.now() + 600000; while (Date.now() < end) {}';
  const FAIL_LINE = '(fa' + 'il) planted failure [0.10ms]'; // split so this source file never contains a raw bun fail line

  const commandFor = (files: string[]) => {
    const mode = files[0];
    if (mode === 'spin') return { command: process.execPath, args: ['-e', BUSY_LOOP] };
    if (mode === 'no-summary') return { command: process.execPath, args: ['-e', 'console.log("ok")'] };
    if (mode === 'fail-exit') {
      return { command: process.execPath, args: ['-e', `console.log(${JSON.stringify(SUMMARY_1)}); process.exit(3)`] };
    }
    if (mode === 'fail-line-exit-zero') {
      return { command: process.execPath, args: ['-e', `console.log(${JSON.stringify(FAIL_LINE)}); console.log(${JSON.stringify(SUMMARY_1)})`] };
    }
    if (mode === 'wrong-file-count') {
      return { command: process.execPath, args: ['-e', 'console.log("Ran 3 tests across 4 files. [12.00ms]")'] };
    }
    return { command: process.execPath, args: ['-e', `console.log(${JSON.stringify(SUMMARY_1)})`] };
  };

  test('exit 0 WITHOUT bun\'s terminal summary is a FAILURE (anti-truncation backstop)', async () => {
    const outcome = await runFreeShard(['no-summary'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(0);
  });

  test('exit 0 WITH the terminal summary passes, and the per-shard epilogue line is printed', async () => {
    const lines: string[] = [];
    const outcome = await runFreeShard(['pass'], 1, 1, { commandFor, quiet: true, log: (l) => lines.push(l) });
    expect(outcome.status).toBe('passed');
    expect(lines.some((l) => /^\[test:free\] shard 1\/1: 1 files, \d+s, pass$/.test(l))).toBe(true);
  });

  test('a non-zero exit stays a failure even when the summary is present', async () => {
    const outcome = await runFreeShard(['fail-exit'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(3);
  });

  test('a printed (fail) result line is a failure even on exit 0 (bun exit-code bug class)', async () => {
    const outcome = await runFreeShard(['fail-line-exit-zero'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(0);
  });

  test('a summary reporting the wrong file count is a failure (partial execution)', async () => {
    const outcome = await runFreeShard(['wrong-file-count'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('failed');
  });

  test('a spinning shard is killed at the wall-clock deadline and reported timed-out, distinct from failed', async () => {
    const lines: string[] = [];
    const outcome = await runFreeShard(['spin'], 1, 1, {
      commandFor, quiet: true, wallTimeoutMs: 1_200, log: (l) => lines.push(l),
    });
    expect(outcome.status).toBe('timed-out');
    expect(outcome.status).not.toBe('failed');
    // Killed at the deadline, not left to burn the full 600s busy loop.
    expect(outcome.elapsedMs).toBeLessThan(30_000);
    expect(outcome.groupPid).toBeGreaterThan(0);
    if (process.platform !== 'win32') {
      expect(() => process.kill(outcome.groupPid as number, 0)).toThrow();
    }
    expect(lines.some((l) => /^\[test:free\] shard 1\/1: 1 files, \d+s, timed-out$/.test(l))).toBe(true);
  }, 30_000);

  test('an empty shard is a fast no-op success and never spawns (stable CI-matrix indices)', async () => {
    const lines: string[] = [];
    const outcome = await runFreeShard([], 7, 20, {
      commandFor: () => { throw new Error('an empty shard must not spawn a child'); },
      log: (l) => lines.push(l),
    });
    expect(outcome.status).toBe('passed');
    expect(lines.some((l) => /^\[test:free\] shard 7\/20: 0 files, 0s, pass$/.test(l))).toBe(true);
  });

  test('spawned shard gets throwaway TMPDIR but NEVER an injected GSTACK_HOME', async () => {
    // GSTACK_HOME injection was tried and reverted: one shared scratch home
    // per invocation made 6,900 tests share MUTABLE state — config tests
    // wrote keys that relink/update-check tests then read (12 measured
    // cross-contamination failures). This pin keeps the regression out.
    const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-shard-env-'));
    const dump = path.join(captureDir, 'env.json');
    try {
      const script =
        `const fs = require("fs");`
        + `fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify({`
        + `  home: process.env.GSTACK_HOME ?? null, tmp: process.env.TMPDIR,`
        + `  tmpExists: fs.existsSync(process.env.TMPDIR || "") }));`
        + `console.log(${JSON.stringify(SUMMARY_1)});`;
      const outcome = await runFreeShard(['env-dump'], 1, 1, {
        commandFor: () => ({ command: process.execPath, args: ['-e', script] }),
        quiet: true,
        log: () => {},
      });
      expect(outcome.status).toBe('passed');
      const seen = JSON.parse(fs.readFileSync(dump, 'utf8'));
      // GSTACK_HOME passes through untouched (whatever the parent had, incl. unset).
      expect(seen.home).toBe(process.env.GSTACK_HOME ?? null);
      // TMPDIR is a per-shard throwaway, cleaned up once the shard finishes.
      expect(seen.tmp).toContain('gstack-free-shard-');
      expect(seen.tmpExists).toBe(true);
      expect(seen.tmp).not.toBe(process.env.TMPDIR ?? '');
      expect(fs.existsSync(seen.tmp)).toBe(false);
    } finally {
      fs.rmSync(captureDir, { recursive: true, force: true });
    }
  });
});

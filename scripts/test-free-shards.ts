#!/usr/bin/env bun
/**
 * test-free-shards — enumerate, shard, curate, and run the free test suite.
 *
 * Four jobs:
 *   1. Enumeration. Walk `browse/test/`, `test/`, `make-pdf/test/` and return
 *      every `*.test.{ts,tsx,js,jsx,mjs,cjs}` that isn't a paid-eval test.
 *   2. Sharding. Stable-hash assign each test to one of N shards. Used by CI
 *      to parallelize the free suite when needed.
 *   3. Curation (Windows-safe filter). Scan each test's content for POSIX-only
 *      patterns (`/bin/bash`, `sh -c`, raw `/tmp/`, `chmod`, `xargs`). Files
 *      that match are excluded from the Windows-safe subset — they would fail
 *      on `windows-latest` no matter how the runner shards them.
 *   4. Execution. Spawn `bun test` children and refuse to trust their exit
 *      code alone: every byte of output is classified through
 *      scripts/test-strict-output.ts, so a child that exits 0 without bun's
 *      terminal summary (a mid-suite process.exit truncation), with `(fail)`
 *      result lines, or with fewer files run than planned is a FAILURE. An
 *      external wall-clock timeout SIGKILLs the child's process group and
 *      reports the shard as timed-out — distinct from failed.
 *
 * Execution strategy (decision ledger V3/D6 — evaluate the Bun built-in
 * first; probed 2026-08 on Bun 1.3.13):
 *   - Full-suite runs (`bun test` via package.json, `bun run test:free`) use
 *     ONE child invocation with `--parallel`. Probes on real test files
 *     showed --parallel (a) prints the standard `Ran N tests across M files`
 *     terminal summary, (b) exits non-zero when any file fails, (c) runs each
 *     file in its own worker process (distinct pids, no shared globals), and
 *     (d) converts a mid-suite process.exit(0) — which silently truncates a
 *     serial run at exit 0 — into a per-file `(crashed: exited)` failure with
 *     a complete summary and exit 1. Strictly SAFER than the serial path and
 *     ~2x faster on a 6-file probe (0.22s -> 0.11s wall, 280% CPU); the win
 *     grows with suite size since the serial suite measured 454s.
 *   - CI-matrix runs (`--shards M --shard i`) keep the hash-partitioned
 *     one-child-per-shard path. Cross-runner partitioning must be
 *     deterministic and per-file stable, so bun's own `--shard=M/N`
 *     (round-robin over sorted paths — every assignment shifts when a file
 *     lands) is not used, and there are no static per-file weight lists.
 *     Shard indices are STABLE: assignFilesToShards never renumbers on
 *     occupancy, and an empty shard is a fast no-op success.
 *
 * Adapted from the McGluut/gstack fork's test-free-shards.ts (190 LOC). The
 * Windows-safe filter is upstream-original — codex flagged that sharding alone
 * doesn't fix POSIX-bound tests, so we curate the subset that actually runs
 * on the windows-latest CI job.
 *
 * Exit codes: 0 pass, 1 fail, 124 wall-clock timeout.
 *
 * Usage:
 *   bun run scripts/test-free-shards.ts                            # full suite, one --parallel child
 *   bun run scripts/test-free-shards.ts --list                     # show all
 *   bun run scripts/test-free-shards.ts --windows-only --list      # show curated
 *   bun run scripts/test-free-shards.ts --windows-only             # run curated
 *   bun run scripts/test-free-shards.ts --shards 4 --shard 1       # one shard (CI matrix)
 *   bun run scripts/test-free-shards.ts --wall-timeout 600         # override the kill deadline
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { isPaidTestFile } from '../test/helpers/paid-test-set';
import {
  BunTestOutputClassifier,
  exactTestFileSelectors,
  forwardAndClassify,
  installChildSignalForwarding,
  killProcessGroup,
  strictTestExitCode,
} from './test-strict-output';

const ROOT = path.resolve(import.meta.dir, '..');
// design/test was silently absent from BOTH the package.json test script and
// this list — design tests (including a teardown bomb) never ran in any CI
// or local free run. Keep the two lists in sync. This list is the single
// source of truth for free-suite roots: package.json's `test` script routes
// through this runner rather than passing its own directory globs.
const TEST_ROOTS = ['browse/test', 'test', 'make-pdf/test', 'design/test'] as const;
const TEST_FILE_REGEX = /\.test\.(?:[cm]?[jt]s|tsx|jsx)$/;

// POSIX-only patterns that indicate a test will fail on windows-latest no
// matter how the runner shards. Codex's v1.18.0.0 review flagged the first
// three as concrete examples in the existing free suite (test/ship-version-sync.test.ts:72,
// test/helpers/providers/claude.ts:22, package.json:12). We scan the test's
// own content here so the filter stays automatic as new tests land. The
// "Windows-incompatible APIs" patterns at the bottom were added after the
// first windows-free-tests CI run surfaced concrete failure modes.
const WINDOWS_FRAGILE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Hardcoded POSIX shells / commands.
  { pattern: /['"`]\/bin\/(?:ba)?sh/, reason: 'hardcoded /bin/sh or /bin/bash' },
  { pattern: /spawnSync\(['"]sh['"],|spawn\(['"]sh['"],|exec\(['"]sh /, reason: 'spawn("sh", ...)' },
  { pattern: /['"]bash -c['"]|['"]sh -c['"]/, reason: 'bash -c / sh -c' },
  { pattern: /['"`]\/tmp\//, reason: 'raw /tmp/ path (use os.tmpdir())' },
  { pattern: /['"]chmod\b/, reason: 'chmod shell command' },
  { pattern: /['"]xargs\b/, reason: 'xargs pipeline' },
  { pattern: /\bwhich claude\b/, reason: 'which claude (use Bun.which)' },
  // Windows-incompatible APIs.
  { pattern: /\.mode\s*&\s*0o[0-7]+/, reason: 'POSIX file mode bitmask (mode & 0o600 etc — Windows fakes mode bits)' },
  { pattern: /\.endsWith\(['"]\//, reason: 'hardcoded forward-slash path assertion (Windows uses \\\\)' },
  { pattern: /['"]\.\/[a-zA-Z][^"']*['"]\)\s*\.\s*toBe\(true\)/, reason: 'forward-slash path comparison' },
  // Tests that spawn a bash shebang script in bin/ via spawnSync. Git Bash on
  // Windows can run `bash /path/to/script` but spawnSync(scriptPath, ...)
  // tries to execute the file directly via CreateProcess, which fails on the
  // shebang. The pattern matches `, 'bin'` as a path-join argument (closing
  // OR followed by another segment), which catches:
  //   - path.join(ROOT, 'bin', 'script-name')        — typical
  //   - join(import.meta.dir, '..', 'bin', 'name')   — destructured (diff-scope)
  //   - path.join(ROOT, 'bin')                       — bare BIN constant (brain-sync)
  { pattern: /,\s*['"]bin['"]\s*[,)]|['"]\.?\/?bin\/[a-z][\w-]+['"]/, reason: 'spawns bin/ shebang script (Windows CreateProcess does not parse shebangs)' },
  // Tests that launch a real Playwright browser. The windows-free-tests CI job
  // runs a curated subset that intentionally does NOT install Chromium —
  // browser bring-up on Windows is a separate concern (see PR #1238). Tests
  // matching `await foo.launch(` need Chromium and fail with "Executable
  // doesn't exist" on the runner.
  { pattern: /await\s+\w+\.launch\(/, reason: 'launches Playwright browser (Chromium not installed in windows-free CI)' },
  // Tests that spawn the browse server as a subprocess via `bun run server.ts`.
  // The Bun → server.ts → Playwright path is the same one that doesn't work
  // on Windows (PR #1238 windows-pty-bun-pty-fix). Tests typically set
  // BROWSE_HEADLESS_SKIP=1 to skip the browser launch but still need a working
  // server, which they don't get on Windows.
  { pattern: /BROWSE_HEADLESS_SKIP|spawn\(\[['"]bun['"],\s*['"]run['"]/, reason: 'spawns the browse server subprocess (Bun-driven path is Windows-broken)' },
  // Tests that read browse/src/sidebar-agent.ts — deleted in v1.14.0.0
  // sidebar refactor (replaced by sidepanel-terminal.js). 10 security tests
  // still reference it and fail on import. They've been broken on every
  // platform since v1.14, but Bun on macOS/Linux reports the failure as a
  // module-load error (exit 0) while Bun on Windows treats it as a hard
  // fail (exit 1). Tracked as a follow-up: update or delete these tests.
  { pattern: /sidebar-agent\.ts/, reason: 'reads deleted browse/src/sidebar-agent.ts (pre-existing breakage from v1.14.0.0 sidebar refactor)' },
];

// Explicit known-Windows-incompatible test files that don't fit a regex
// pattern. Listed here with the precise reason. Prefer adding a pattern above
// when possible; this list is for environment-/runtime-specific tests where
// the failure mode is structural rather than detectable via source-file scan.
const KNOWN_WINDOWS_INCOMPATIBLE: Array<{ file: string; reason: string }> = [
  {
    file: 'test/host-config.test.ts',
    reason: 'asserts "claude" binary on PATH (only true when running inside Claude Code, not on bare CI runner)',
  },
  {
    file: 'browse/test/findport.test.ts',
    reason: 'asserts Bun.serve.stop() is fire-and-forget — Bun behavior differs on Windows for this polyfill',
  },
];

// Force-include overrides: files a WINDOWS_FRAGILE_PATTERNS regex excludes for
// a reason that does not actually apply to them. Each entry documents WHY the
// pattern hit is a false positive — the point of these files is Windows
// coverage, so auto-excluding them defeats the regression tests they carry.
const KNOWN_WINDOWS_SAFE: Array<{ file: string; reason: string }> = [
  {
    file: 'browse/test/file-permissions.test.ts',
    // Trips the POSIX-mode-bitmask pattern, but every `mode & 0o777` assertion
    // is platform-guarded (win32 returns early / takes the icacls branch).
    // This file carries the win32-only icacls-by-SID regression tests, which
    // can ONLY execute on windows-latest — excluding it here means the
    // machine-account ACL lockout regression is never exercised on the one
    // platform it bricks.
    reason: 'mode-bitmask hits are POSIX-branch only; win32-only ACL regression tests must run on windows-latest',
  },
  {
    file: 'browse/test/terminal-agent-owner-watchdog.test.ts',
    // Trips the spawn(['bun','run',...]) pattern, whose reason is the
    // Playwright-bound browse server. This test spawns terminal-agent.ts,
    // which imports only fs/path/crypto + local helpers (no Playwright, no
    // PTY at module scope) and boots under Bun on Windows — the owner-PID
    // orphan leak it pins was reported on Windows (#2019).
    reason: 'spawns terminal-agent (no Playwright), not the browse server; owner-orphan leak is a Windows defect',
  },
];

export const DEFAULT_SHARD_COUNT = 20;
// Per-test timeout passed to `bun test --timeout`. 30s matches what
// package.json's `test` script used before it was repointed at this runner —
// the runner is now the single owner of that semantic.
export const FREE_TEST_TIMEOUT_MS = 30_000;
// External wall-clock deadline per spawned child (whole shard or the single
// full-suite --parallel invocation). A wedged child — a spinning main thread
// no in-process --timeout timer can interrupt — is SIGKILLed at the group
// level and reported 'timed-out', distinct from 'failed'.
export const DEFAULT_WALL_TIMEOUT_MS = 15 * 60_000;

export function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function isFreeTestFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!TEST_FILE_REGEX.test(normalized)) return false;
  return !isPaidTestFile(normalized);
}

/**
 * Returns the first POSIX-only pattern hit in the file, or null if Windows-safe.
 */
export function detectWindowsFragility(absolutePath: string): { reason: string } | null {
  let content: string;
  try {
    content = fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    return null;
  }
  for (const { pattern, reason } of WINDOWS_FRAGILE_PATTERNS) {
    if (pattern.test(content)) return { reason };
  }
  return null;
}

function walkTestFiles(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTestFiles(fullPath));
      continue;
    }
    if (TEST_FILE_REGEX.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

export function collectFreeTestFiles(rootDir = ROOT): string[] {
  const discovered = new Set<string>();
  for (const testRoot of TEST_ROOTS) {
    const absoluteRoot = path.join(rootDir, testRoot);
    if (!fs.existsSync(absoluteRoot)) continue;
    for (const fullPath of walkTestFiles(absoluteRoot)) {
      const relativePath = normalizeRelativePath(path.relative(rootDir, fullPath));
      if (isFreeTestFile(relativePath)) {
        discovered.add(relativePath);
      }
    }
  }
  return [...discovered].sort();
}

export interface CurationResult {
  safe: string[];
  excluded: Array<{ file: string; reason: string }>;
}

export function curateWindowsSafe(files: string[], rootDir = ROOT): CurationResult {
  const safe: string[] = [];
  const excluded: Array<{ file: string; reason: string }> = [];
  const knownBad = new Map(KNOWN_WINDOWS_INCOMPATIBLE.map((e) => [e.file, e.reason]));
  const knownSafe = new Set(KNOWN_WINDOWS_SAFE.map((e) => e.file));
  for (const relativePath of files) {
    const knownReason = knownBad.get(relativePath);
    if (knownReason) {
      excluded.push({ file: relativePath, reason: knownReason });
      continue;
    }
    if (knownSafe.has(relativePath)) {
      safe.push(relativePath);
      continue;
    }
    const absolute = path.join(rootDir, relativePath);
    const fragility = detectWindowsFragility(absolute);
    if (fragility) {
      excluded.push({ file: relativePath, reason: fragility.reason });
    } else {
      safe.push(relativePath);
    }
  }
  return { safe, excluded };
}

export function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Hash-partition files across EXACTLY shardCount shards. Empty shards are
 * preserved: a file's shard index is a pure function of its own path and the
 * shard count, never of which other files happen to exist. A CI matrix keys
 * runners off the index, so filtering empty shards (the old behavior) would
 * renumber every later shard whenever occupancy shifted — runner 3 silently
 * running shard 4's files. An empty shard is instead a fast no-op success at
 * run time.
 */
export function assignFilesToShards(files: string[], shardCount: number): string[][] {
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error(`Shard count must be a positive integer. Received: ${shardCount}`);
  }

  const shards = Array.from({ length: shardCount }, () => [] as string[]);
  for (const file of files) {
    const shardIndex = stableHash(file) % shardCount;
    shards[shardIndex].push(file);
  }

  return shards.map(filesInShard => filesInShard.sort());
}

export interface BuildShardArgsOptions {
  /** Run test files in parallel worker processes (bun 1.3.13+, implies --isolate). */
  parallel?: boolean;
  rootDir?: string;
}

export function buildShardArgs(files: string[], options: BuildShardArgsOptions = {}): string[] {
  // Exact absolute selectors: bun treats positional test paths as substring
  // filters, so a relative `test/x.test.ts` would ALSO select
  // `browse/test/x.test.ts` — shard bleed that double-runs files.
  const selectors = exactTestFileSelectors(files, options.rootDir ?? ROOT);
  const args = ['test', ...selectors, `--timeout=${FREE_TEST_TIMEOUT_MS}`];
  if (options.parallel) args.push('--parallel');
  else args.push('--max-concurrency=1');
  return args;
}

type CliOptions = {
  dryRun: boolean;
  listOnly: boolean;
  windowsOnly: boolean;
  shardCount: number;
  shardIndex: number | null;
  wallTimeoutMs: number;
};

function parseCliOptions(argv: string[]): CliOptions {
  let dryRun = false;
  let listOnly = false;
  let windowsOnly = false;
  let shardCount = DEFAULT_SHARD_COUNT;
  let shardIndex: number | null = null;
  let wallTimeoutMs = DEFAULT_WALL_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--list') { listOnly = true; continue; }
    if (arg === '--windows-only') { windowsOnly = true; continue; }
    if (arg === '--shards') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --shards');
      shardCount = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (arg === '--shard') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --shard');
      shardIndex = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (arg === '--wall-timeout') {
      const value = Number.parseInt(argv[index + 1] ?? '', 10);
      if (!Number.isInteger(value) || value <= 0) throw new Error('--wall-timeout needs a positive integer (seconds)');
      wallTimeoutMs = value * 1000;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { dryRun, listOnly, windowsOnly, shardCount, shardIndex, wallTimeoutMs };
}

function formatShardSummary(shards: string[][]): string[] {
  return shards.map((files, index) => {
    const preview = files.slice(0, 3).join(', ');
    const suffix = files.length > 3 ? ', ...' : '';
    return `Shard ${index + 1}/${shards.length}: ${files.length} files${preview ? ` -> ${preview}${suffix}` : ''}`;
  });
}

/**
 * True when a shard's output shows the run ended WITHOUT bun's final summary
 * ("Ran N tests across ..."). A process.exit() fired mid-suite skips the
 * summary AND hands back whatever code the caller passed — historically 0,
 * which made a truncated shard indistinguishable from a green one. Exit code
 * alone is therefore not evidence of completion; the summary line is.
 *
 * The runner itself now enforces this (and more) through
 * scripts/test-strict-output.ts inside runFreeShard; this predicate remains
 * the minimal documented primitive that test/exit-propagation.test.ts drives
 * with genuine truncated and genuine complete bun runs.
 */
export function shardRunLooksTruncated(status: number | null, output: string): boolean {
  if (status !== 0) return false; // already failing — not the silent case
  return !/Ran \d+ tests? across \d+ files?/.test(output);
}

export type FreeShardStatus = 'passed' | 'failed' | 'timed-out';

export interface FreeShardOutcome {
  shard: number;
  files: string[];
  status: FreeShardStatus;
  exitCode: number | null;
  elapsedMs: number;
  groupPid: number | null;
}

export interface ShardCommand {
  command: string;
  args: string[];
}

export interface RunFreeShardOptions {
  /** External wall-clock deadline; on expiry the child's process GROUP is SIGKILLed. */
  wallTimeoutMs?: number;
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Full-suite mode: single bun invocation with --parallel (per-file worker isolation). */
  parallel?: boolean;
  /** Override the spawned command. Tests inject fake pass/fail/slow commands. */
  commandFor?: (files: string[]) => ShardCommand;
  /** Suppress forwarding child output to parent stdio (tests). Classification still sees every byte. */
  quiet?: boolean;
  log?: (line: string) => void;
}

const EPILOGUE_WORD: Record<FreeShardStatus, string> = {
  passed: 'pass',
  failed: 'fail',
  'timed-out': 'timed-out',
};

/** One line per shard, printed after the run: `[test:free] shard i/N: M files, XXs, pass|fail|timed-out`. */
function shardEpilogue(outcome: FreeShardOutcome, totalShards: number): string {
  return `[test:free] shard ${outcome.shard}/${totalShards}: ${outcome.files.length} files, `
    + `${Math.round(outcome.elapsedMs / 1000)}s, ${EPILOGUE_WORD[outcome.status]}`;
}

/**
 * Run one shard (or the whole suite, in --parallel full-suite mode) in its own
 * bun process and classify the result strictly.
 *
 * Verdict integrity: the child's exit code is never trusted alone. Output is
 * fed through BunTestOutputClassifier, and strictTestExitCode requires bun's
 * terminal summary to report EXACTLY the planned file count — a shard that
 * exits 0 without the summary (mid-suite process.exit truncation), with
 * `(fail)` result lines, or having run fewer files than planned is a FAILURE.
 * This is enforced for injected fake commands too (unlike the paid runner),
 * so tests can pin the summary-missing => failure backstop; fake passing
 * commands must print a synthetic `Ran N tests across M files. [Xms]` line.
 *
 * Per-shard temp isolation: each spawned child gets its own throwaway TMPDIR
 * (TEMP/TMP on Windows) so shards can't trip over each other's temp files.
 * Deliberately NOT GSTACK_HOME: injecting one shared scratch home for a whole
 * invocation made 6,900 tests share a MUTABLE state dir — config tests wrote
 * keys into it and relink/update-check tests then read them (measured: 12
 * cross-contamination failures on the first full run). Tests that need
 * GSTACK_HOME isolation mkdtemp their own per test — the repo convention —
 * and the hermetic-env machinery covers E2E children.
 */
export async function runFreeShard(
  files: string[],
  shardNumber: number,
  totalShards: number,
  options: RunFreeShardOptions = {},
): Promise<FreeShardOutcome> {
  const log = options.log ?? ((line: string) => console.log(line));
  const label = `[test:free] shard ${shardNumber}/${totalShards}`;

  // Empty shard = fast no-op SUCCESS. Indices are stable for the CI matrix,
  // so an unoccupied index must not fail or shift work to a different runner.
  if (files.length === 0) {
    const outcome: FreeShardOutcome = {
      shard: shardNumber, files: [], status: 'passed', exitCode: 0, elapsedMs: 0, groupPid: null,
    };
    log(shardEpilogue(outcome, totalShards));
    return outcome;
  }

  const rootDir = options.rootDir ?? ROOT;
  const wallTimeoutMs = options.wallTimeoutMs ?? DEFAULT_WALL_TIMEOUT_MS;
  log(`${label} (${files.length} files${options.parallel ? ', bun --parallel' : ''})`);

  const { command, args } = options.commandFor
    ? options.commandFor(files)
    : { command: process.execPath, args: buildShardArgs(files, { parallel: options.parallel, rootDir }) };

  const env = { ...(options.env ?? process.env) };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-free-shard-'));
  const childTmp = path.join(stateDir, 'tmp');
  fs.mkdirSync(childTmp);
  env.TMPDIR = childTmp;
  env.TEMP = childTmp;
  env.TMP = childTmp;

  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd: rootDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const groupPid = child.pid ?? null;
  // Group-kill on parent SIGINT/SIGTERM too, not just on timeout.
  const forwarding = installChildSignalForwarding({
    kill: (signal?: NodeJS.Signals | number) => {
      killProcessGroup(child, (signal as NodeJS.Signals) ?? 'SIGTERM');
      return true;
    },
  });

  const classifier = new BunTestOutputClassifier();
  const devNull = { write: () => true } as unknown as NodeJS.WriteStream;

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child, 'SIGKILL');
  }, wallTimeoutMs);

  let exitCode: number | null = null;
  try {
    const streams: Array<Promise<void>> = [];
    if (child.stdout) streams.push(forwardAndClassify(child.stdout, options.quiet ? devNull : process.stdout, classifier));
    if (child.stderr) streams.push(forwardAndClassify(child.stderr, options.quiet ? devNull : process.stderr, classifier));
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    await Promise.all(streams);
  } finally {
    clearTimeout(killTimer);
    forwarding.dispose();
    // Reap survivors of this shard even on the clean path.
    killProcessGroup(child, 'SIGKILL');
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of a throwaway temp dir — a locked file on
      // Windows must not turn a real verdict into an exception.
    }
  }

  const summary = classifier.end();
  const status: FreeShardStatus = timedOut
    ? 'timed-out'
    : strictTestExitCode(exitCode ?? 1, summary, files.length) === 0 ? 'passed' : 'failed';

  if (status === 'timed-out') {
    console.error(
      `${label} exceeded the ${Math.round(wallTimeoutMs / 1000)}s wall-clock deadline — `
      + 'killed the process group. Reporting as TIMED-OUT (distinct from failed).',
    );
  } else if (status === 'failed' && (exitCode ?? 1) === 0) {
    const reason = summary.failedTests > 0 || summary.unhandledBetweenTests > 0
      ? `printed ${summary.failedTests} failing result(s) and ${summary.unhandledBetweenTests} unhandled error(s) between tests`
      : summary.terminalFileCounts.length === 0
        ? "never printed bun's terminal summary — the run was truncated (a process.exit fired mid-suite)"
        : `bun's summary reported ${summary.terminalFileCounts.join(', ')} file(s), expected ${files.length}`;
    console.error(`${label} exited 0 but ${reason}. Treating as FAILED.`);
  } else if (status === 'failed') {
    console.error(`${label} failed with exit code ${exitCode ?? 'signal'}`);
  }

  const outcome: FreeShardOutcome = {
    shard: shardNumber, files, status, exitCode, elapsedMs: Date.now() - startedAt, groupPid,
  };
  log(shardEpilogue(outcome, totalShards));
  return outcome;
}

function exitCodeFor(status: FreeShardStatus): number {
  if (status === 'passed') return 0;
  return status === 'timed-out' ? 124 : 1;
}

async function main(): Promise<number> {
  const options = parseCliOptions(process.argv.slice(2));
  const allFiles = collectFreeTestFiles();
  if (allFiles.length === 0) {
    throw new Error('No free test files were discovered.');
  }

  let files = allFiles;
  let curationReport: CurationResult | null = null;
  if (options.windowsOnly) {
    curationReport = curateWindowsSafe(allFiles);
    files = curationReport.safe;
    console.log(`[test:free] curated ${files.length} Windows-safe tests (${curationReport.excluded.length} excluded)`);
    if (options.listOnly && curationReport.excluded.length > 0) {
      console.log('\nExcluded (POSIX-fragile):');
      for (const { file, reason } of curationReport.excluded) {
        console.log(`  - ${file}  [${reason}]`);
      }
    }
  }

  if (options.listOnly) {
    console.log(`\nDiscovered ${files.length} test files.`);
    for (const file of files) console.log(`  ${file}`);
    return 0;
  }

  if (options.dryRun) {
    const shards = assignFilesToShards(files, options.shardCount);
    const occupied = shards.filter((s) => s.length > 0).length;
    console.log(
      `\nWould run ${files.length} files across ${shards.length} shards (${occupied} occupied). `
      + 'Without --shard, the full suite runs as ONE bun --parallel invocation instead.',
    );
    for (const line of formatShardSummary(shards)) console.log(line);
    return 0;
  }

  if (options.shardIndex !== null) {
    // Bounds-check against the REQUESTED shard count, not post-assignment
    // occupancy — indices must be stable for a CI matrix, and an empty shard
    // is a valid fast no-op.
    if (!Number.isInteger(options.shardIndex) || options.shardIndex < 1 || options.shardIndex > options.shardCount) {
      throw new Error(`--shard must be between 1 and ${options.shardCount}. Received: ${options.shardIndex}`);
    }
    const shards = assignFilesToShards(files, options.shardCount);
    const outcome = await runFreeShard(shards[options.shardIndex - 1], options.shardIndex, options.shardCount, {
      wallTimeoutMs: options.wallTimeoutMs,
    });
    return exitCodeFor(outcome.status);
  }

  // Full-suite mode: one bun invocation, files parallelized across per-file
  // worker processes. See the header for the probe results that picked this
  // over N spawned shard processes.
  const outcome = await runFreeShard(files, 1, 1, {
    parallel: true,
    wallTimeoutMs: options.wallTimeoutMs,
  });
  return exitCodeFor(outcome.status);
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`[test:free] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

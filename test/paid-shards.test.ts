/**
 * Pins the paid-tier sharded runner (scripts/test-paid-shards.ts).
 *
 * Two properties matter, and both are why `test:gate` has never finished a run:
 *   1. Enumeration + sharding — every file `test:gate`'s globs expand to gets
 *      its own process, and tier exclusion only ever fires on explicit evidence.
 *   2. A spinning shard is killed externally and the run CONTINUES. The fake
 *      command here is a real busy loop, so an in-process timer could not save
 *      it — exactly the failure mode `sample` caught on the wedged run.
 */

import { describe, test, expect } from 'bun:test';
import {
  PAID_TEST_GLOBS,
  classifyPaidTestFile,
  collectPaidTestFiles,
  isPaidTestFile,
  planPaidShards,
  runPaidShards,
  summarize,
  type ShardOutcome,
} from '../scripts/test-paid-shards';

describe('paid test enumeration', () => {
  test('matches the globs package.json test:gate expands', () => {
    expect(isPaidTestFile('test/skill-e2e-qa-workflow.test.ts')).toBe(true);
    expect(isPaidTestFile('test/skill-llm-eval.test.ts')).toBe(true);
    expect(isPaidTestFile('test/codex-e2e.test.ts')).toBe(true);
    expect(isPaidTestFile('test/skill-e2e-triage-audit.test.ts')).toBe(true);
    // Outside the globs: no dash, extra suffix, or a free test.
    expect(isPaidTestFile('test/skill-e2e.test.ts')).toBe(false);
    expect(isPaidTestFile('test/codex-e2e-recommendation-substance.test.ts')).toBe(false);
    expect(isPaidTestFile('test/paid-shards.test.ts')).toBe(false);
  });

  test('discovers files and gives each one its own shard', () => {
    const files = collectPaidTestFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.every(isPaidTestFile)).toBe(true);
    expect(PAID_TEST_GLOBS.length).toBe(5);

    const shards = planPaidShards(files);
    expect(shards.flat().sort()).toEqual([...files].sort());
    expect(shards.every((shard) => shard.length === 1)).toBe(true);
  });
});

describe('tier classification', () => {
  test('excludes only on an explicit other-tier guard', () => {
    const gateGuard = "const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';";
    const periodicGuard = "const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';";

    expect(classifyPaidTestFile(gateGuard, 'gate').included).toBe(true);
    expect(classifyPaidTestFile(periodicGuard, 'gate').included).toBe(false);
    expect(classifyPaidTestFile(gateGuard, 'periodic').included).toBe(false);
    expect(classifyPaidTestFile(periodicGuard, 'periodic').included).toBe(true);
  });

  test('recognizes the consolidated e2e-gate helper guard (both forms)', () => {
    // The shape test/helpers/e2e-gate.ts consumers use after consolidation.
    const helperGate = "const describeE2E = describeE2ETier('gate');";
    const helperPeriodic = "const describeE2E = describeE2ETier('periodic');";
    const boolPeriodic = "const shouldRun = CODEX_AVAILABLE && e2eTierEnabled('periodic');";

    expect(classifyPaidTestFile(helperGate, 'gate').included).toBe(true);
    expect(classifyPaidTestFile(helperGate, 'periodic').included).toBe(false);
    expect(classifyPaidTestFile(helperPeriodic, 'periodic').included).toBe(true);
    expect(classifyPaidTestFile(helperPeriodic, 'gate').included).toBe(false);
    expect(classifyPaidTestFile(boolPeriodic, 'gate').included).toBe(false);
    expect(classifyPaidTestFile(boolPeriodic, 'periodic').included).toBe(true);
  });

  test('keeps files whose tier is decided per-test at runtime', () => {
    // Naming an E2E_TIERS key is not evidence — 'retro' appears in the
    // LLM-judge file, which test:gate does run.
    const noGuard = "runSkillTest('retro', async () => {});";
    expect(classifyPaidTestFile(noGuard, 'gate').included).toBe(true);
    expect(classifyPaidTestFile(noGuard, 'periodic').included).toBe(true);
    expect(classifyPaidTestFile('', 'gate').included).toBe(true);
  });
});

describe('shard execution', () => {
  const BUSY_LOOP = 'const end = Date.now() + 600000; while (Date.now() < end) {}';

  const commandFor = (files: string[]) => {
    if (files[0] === 'spin') return { command: process.execPath, args: ['-e', BUSY_LOOP] };
    if (files[0] === 'fail') return { command: process.execPath, args: ['-e', 'process.exit(3)'] };
    return { command: process.execPath, args: ['-e', 'console.log("ok")'] };
  };

  test('a spinning shard times out, is killed, and the run continues', async () => {
    const lines: string[] = [];
    const summary = await runPaidShards([['spin'], ['fail'], ['pass']], {
      timeoutMs: 1_200,
      jobs: 1,
      commandFor,
      log: (line) => lines.push(line),
    });

    const byName = (name: string) => summary.outcomes.find((o) => o.files[0] === name) as ShardOutcome;
    expect(byName('spin').status).toBe('timed-out');
    expect(byName('fail').status).toBe('failed');
    expect(byName('pass').status).toBe('passed');

    // The run never aborted: every shard reports, none is 'never-started'.
    expect(summary).toMatchObject({
      total: 3, executed: 3, passed: 1, failed: 1, timedOut: 1, neverStarted: 0,
    });

    // The spinner was killed at the deadline, not left to burn a core.
    expect(byName('spin').elapsedMs).toBeLessThan(30_000);
    expect(byName('spin').groupPid).toBeGreaterThan(0);
    if (process.platform !== 'win32') {
      expect(() => process.kill(byName('spin').groupPid as number, 0)).toThrow();
    }

    // Heartbeat: a START and a terminal line per shard, with elapsed seconds.
    expect(lines.filter((l) => l.includes(' START ')).length).toBe(3);
    expect(lines.some((l) => /TIMED-OUT in \d+s/.test(l))).toBe(true);
    expect(lines.some((l) => /PASSED in \d+s/.test(l))).toBe(true);
  }, 30_000);

  test('summarize reports shards that never ran', () => {
    const summary = summarize([
      { shard: 1, files: ['a'], status: 'passed', exitCode: 0, elapsedMs: 1, groupPid: 1 },
      { shard: 2, files: ['b'], status: 'never-started', exitCode: null, elapsedMs: 0, groupPid: null },
    ]);
    expect(summary).toMatchObject({ total: 2, executed: 1, passed: 1, neverStarted: 1 });
  });
});

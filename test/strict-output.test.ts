/**
 * Pins scripts/test-strict-output.ts — the verdict-integrity layer of the
 * sharded paid runner. Its whole reason to exist is refusing to trust a zero
 * exit when failures were printed OR fewer files ran than planned; paid-shards'
 * fake commands never emit real Bun result lines, so without this file that
 * core was exercised nowhere and a regex regression would silently revert the
 * paid tier to trusting exit codes.
 */

import { describe, expect, it } from 'bun:test';
import { BunTestOutputClassifier, strictTestExitCode } from '../scripts/test-strict-output';

describe('strictTestExitCode', () => {
  it('trusts a clean zero exit when the expected file count ran', () => {
    const summary = { failedTests: 0, unhandledBetweenTests: 0, terminalFileCounts: [1] };
    expect(strictTestExitCode(0, summary, 1)).toBe(0);
  });

  it('refuses a zero exit when fewer files ran than expected (invisible non-execution)', () => {
    const summary = { failedTests: 0, unhandledBetweenTests: 0, terminalFileCounts: [1] };
    expect(strictTestExitCode(0, summary, 2)).toBe(1);
  });

  it('refuses a zero exit when failure lines were printed', () => {
    const summary = { failedTests: 1, unhandledBetweenTests: 0, terminalFileCounts: [1] };
    expect(strictTestExitCode(0, summary, 1)).toBe(1);
  });

  it('refuses a zero exit on an unhandled error between tests', () => {
    const summary = { failedTests: 0, unhandledBetweenTests: 1, terminalFileCounts: [1] };
    expect(strictTestExitCode(0, summary, 1)).toBe(1);
  });

  it('propagates a non-zero child exit regardless of expectedFiles', () => {
    const summary = { failedTests: 0, unhandledBetweenTests: 0, terminalFileCounts: [1] };
    expect(strictTestExitCode(1, summary, 1)).toBe(1);
  });
});

describe('BunTestOutputClassifier', () => {
  it('counts a (fail) line split across write chunks', () => {
    const c = new BunTestOutputClassifier();
    c.write('[31m(fail) my te');
    c.write('st [3.42ms][0m\nRan 4 tests across 1 files. [2.10s]\n');
    const summary = c.end();
    expect(summary.failedTests).toBe(1);
    expect(summary.terminalFileCounts).toEqual([1]);
    // exit 0 + a printed failure must not be trusted
    expect(strictTestExitCode(0, summary, 1)).toBe(1);
  });

  it('records the terminal file count from the summary line', () => {
    const c = new BunTestOutputClassifier();
    c.write('Ran 0 tests across 1 files. [0.01s]\n');
    const summary = c.end();
    expect(summary.terminalFileCounts).toEqual([1]);
    // a fully diff-skipped single-file shard (0 tests, 1 file loaded) still
    // passes: 1 file ran, which is what was expected
    expect(strictTestExitCode(0, summary, 1)).toBe(0);
  });
});

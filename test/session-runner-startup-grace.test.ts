/**
 * Two-phase timeout pins for the claude session runner (WS4c).
 *
 * The old single timer charged API queue latency to the work budget — the
 * recurring '0 turns / $0.00 / x3 attempts' failure with four budget-bump
 * receipts (180→300s, 240→360s, 300→420s, 90→300s). The split:
 *   startup phase — no NDJSON byte yet; killed at the grace with the
 *     DISTINCT reason 'timeout_startup' (availability, not behavior);
 *   work phase — armed on the first byte for the REMAINING budget, so the
 *     total wall never exceeds `timeout` (tier envelopes are margin-free:
 *     tests pass `timeout: CAPTURE_MS` and use the same tier as bun budget).
 *
 * Also pins the TODOS-filed 300s CI startup floor: shared CI runners queue
 * harder, and a floor below 300s converts ordinary queueing into false reds.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runSkillTest,
  STARTUP_GRACE_CI_FLOOR_MS,
  STARTUP_GRACE_MS,
} from './helpers/session-runner';

describe('session-runner two-phase timeout', () => {
  test('CI startup-grace floor is 300s and the local default is sane', () => {
    expect(STARTUP_GRACE_CI_FLOOR_MS).toBe(300_000);
    expect(STARTUP_GRACE_MS).toBeGreaterThanOrEqual(60_000);
    expect(STARTUP_GRACE_MS).toBeLessThanOrEqual(STARTUP_GRACE_CI_FLOOR_MS);
  });

  test('a run whose first byte arrives late still gets its work budget honored within the total', async () => {
    // Fake claude: silent for 2s (startup latency), then streams NDJSON and
    // wedges. startupGraceMs=4s tolerates the latency; work budget then
    // kills at ~timeout. exitReason must be plain 'timeout' (work phase),
    // NOT 'timeout_startup', and the wall must respect the total envelope.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grace-'));
    const shimDir = path.join(dir, 'bin');
    fs.mkdirSync(shimDir);
    fs.writeFileSync(path.join(shimDir, 'claude'), [
      '#!/bin/bash',
      'sleep 2',
      'echo \'{"type":"system","subtype":"init"}\'',
      'exec sleep 6071',
    ].join('\n') + '\n', { mode: 0o755 });

    const realPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${realPath}`;
    try {
      const started = Date.now();
      const result = await runSkillTest({
        prompt: 'ignored',
        workingDirectory: dir,
        maxTurns: 1,
        timeout: 5_000,
        startupGraceMs: 4_000,
        testName: 'grace-probe-work-phase',
      });
      const wall = Date.now() - started;
      expect(result.exitReason).toBe('timeout');
      expect(result.firstResponseMs).toBeGreaterThanOrEqual(1_500);
      // Total envelope: startup consumed ~2s, work phase gets the remainder —
      // wall ≈ timeout (5s) + stderr grace (5s), never grace+timeout stacked.
      expect(wall).toBeLessThan(20_000);
    } finally {
      process.env.PATH = realPath;
      Bun.spawnSync(['pkill', '-f', 'sleep 6071'], { timeout: 5_000 });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('a silent API is killed at the grace, early, with the startup reason', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grace-'));
    const shimDir = path.join(dir, 'bin');
    fs.mkdirSync(shimDir);
    fs.writeFileSync(path.join(shimDir, 'claude'), '#!/bin/bash\nexec sleep 6072\n', { mode: 0o755 });

    const realPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${realPath}`;
    try {
      const started = Date.now();
      const result = await runSkillTest({
        prompt: 'ignored',
        workingDirectory: dir,
        maxTurns: 1,
        timeout: 30_000,       // generous work budget…
        startupGraceMs: 2_000, // …but startup dies fast when nothing answers
        testName: 'grace-probe-startup',
      });
      const wall = Date.now() - started;
      expect(result.exitReason).toBe('timeout_startup');
      // The whole point: ~2s + drain grace, NOT the 30s work budget.
      expect(wall).toBeLessThan(15_000);
      expect(result.costEstimate.turnsUsed).toBe(0);
    } finally {
      process.env.PATH = realPath;
      Bun.spawnSync(['pkill', '-f', 'sleep 6072'], { timeout: 5_000 });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

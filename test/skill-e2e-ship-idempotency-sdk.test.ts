/**
 * /ship idempotency guard E2E — SDK-harness variant (#649).
 *
 * Rehomed VERBATIM from the pre-split monolith (test/skill-e2e.test.ts,
 * deleted on this branch): the monolith's filename never matched the paid
 * glob (`test/skill-e2e-*.test.ts` — note the hyphen), so this periodic
 * test (`ship-idempotency` in E2E_TIERS) silently never executed after
 * the v1.56 split. The real-PTY variant lives in
 * test/skill-e2e-ship-idempotency.test.ts (`ship-idempotency-pty`) and
 * exercises the actual /ship skill end-to-end; this one is the synthetic
 * SDK-harness check the PTY variant's header contrasts itself against.
 *
 * DRIFT WARNING (attribution for the first paid run after rehoming): the
 * fixture slices ship/SKILL.md on the markers '## Step 4: Version bump',
 * '## Step 7: Push', and '## Step 8.5'. The current generated skill numbers
 * these Step 12 (Version bump) and Step 17 (Push) — every indexOf returns
 * -1 and ship-steps.md ends up essentially empty. The body is copied
 * faithfully (no behavioral edits, per the rehoming integrity rule), so a
 * failure here indicts the ~8 releases of drift, not the move. The fix
 * (repoint the markers or use test/helpers/skill-fixture.ts with the
 * current section names) is a deliberate follow-up, not smuggled into the
 * rehoming commit.
 */

import { expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected, testConcurrentIfSelected,
  logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-ship-idempotency-sdk');

// --- Ship idempotency (#649) ---
describeIfSelected('Ship idempotency', ['ship-idempotency'], () => {
  let idempDir: string;
  const gitRun = (args: string[], cwd: string) =>
    spawnSync('git', args, { cwd, stdio: 'pipe', timeout: 5000 });

  beforeAll(() => {
    idempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-ship-idemp-'));

    // Create git repo with initial commit on main
    gitRun(['init', '-b', 'main'], idempDir);
    gitRun(['config', 'user.email', 'test@test.com'], idempDir);
    gitRun(['config', 'user.name', 'Test'], idempDir);

    fs.writeFileSync(path.join(idempDir, 'app.ts'), 'console.log("v1");\n');
    fs.writeFileSync(path.join(idempDir, 'VERSION'), '0.1.0.0\n');
    fs.writeFileSync(path.join(idempDir, 'CHANGELOG.md'), '# Changelog\n');
    gitRun(['add', '.'], idempDir);
    gitRun(['commit', '-m', 'initial'], idempDir);

    // Create feature branch with changes
    gitRun(['checkout', '-b', 'feat/my-feature'], idempDir);
    fs.writeFileSync(path.join(idempDir, 'app.ts'), 'console.log("v2");\n');
    gitRun(['add', 'app.ts'], idempDir);
    gitRun(['commit', '-m', 'feat: update to v2'], idempDir);

    // Simulate prior /ship run: bump VERSION and write CHANGELOG entry
    fs.writeFileSync(path.join(idempDir, 'VERSION'), '0.2.0.0\n');
    fs.writeFileSync(path.join(idempDir, 'CHANGELOG.md'),
      '# Changelog\n\n## [0.2.0.0] — 2026-03-30\n\n- Updated app to v2\n');
    gitRun(['add', 'VERSION', 'CHANGELOG.md'], idempDir);
    gitRun(['commit', '-m', 'chore: bump version to 0.2.0.0'], idempDir);

    // Extract just the idempotency-relevant sections from ship/SKILL.md
    const full = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    const step4Start = full.indexOf('## Step 4: Version bump');
    const step4End = full.indexOf('\n---\n', step4Start);
    const step7Start = full.indexOf('## Step 7: Push');
    const step8End = full.indexOf('## Step 8.5');
    const extracted = [
      full.slice(step4Start, step4End > step4Start ? step4End : step4Start + 500),
      full.slice(step7Start, step8End > step7Start ? step8End : step7Start + 500),
    ].join('\n\n---\n\n');
    fs.writeFileSync(path.join(idempDir, 'ship-steps.md'), extracted);
  });

  afterAll(() => {
    try { fs.rmSync(idempDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('ship-idempotency', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo on branch feat/my-feature. A prior /ship run already:
- Bumped VERSION from 0.1.0.0 to 0.2.0.0
- Wrote a CHANGELOG entry for 0.2.0.0
- But the push/PR step failed

Read ship-steps.md for the idempotency check instructions from the ship workflow.

Run ONLY the idempotency checks described in Steps 4 and 7. Do NOT actually push or create PRs (there is no remote).

After running the checks, write a report to ${idempDir}/idemp-result.md containing:
- Whether VERSION was detected as ALREADY_BUMPED or not
- Whether the push was detected as ALREADY_PUSHED or PUSH_NEEDED
- The current VERSION value (should still be 0.2.0.0)

Do NOT modify VERSION or CHANGELOG. Only run the detection checks and report.`,
      workingDirectory: idempDir,
      maxTurns: 10,
      timeout: 60_000,
      testName: 'ship-idempotency',
      runId,
    });

    logCost('/ship idempotency', result);
    recordE2E(evalCollector, '/ship idempotency guard', 'Ship idempotency', result);
    expect(result.exitReason).toBe('success');

    // Verify VERSION was NOT modified
    const version = fs.readFileSync(path.join(idempDir, 'VERSION'), 'utf-8').trim();
    expect(version).toBe('0.2.0.0');

    // Verify CHANGELOG was NOT duplicated
    const changelog = fs.readFileSync(path.join(idempDir, 'CHANGELOG.md'), 'utf-8');
    const versionEntries = (changelog.match(/## \[0\.2\.0\.0\]/g) || []).length;
    expect(versionEntries).toBe(1);

    // Check the result report if it was written
    const reportPath = path.join(idempDir, 'idemp-result.md');
    if (fs.existsSync(reportPath)) {
      const report = fs.readFileSync(reportPath, 'utf-8');
      expect(report.toLowerCase()).toContain('already_bumped');
    }
  }, 120_000);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});

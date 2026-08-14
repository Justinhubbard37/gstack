/**
 * gstack-verify-gate — Stop-hook enforcement tier.
 *
 * Pins the three behaviours the gate exists for:
 *   block    — declared check fails, exit 2, turn cannot end.
 *   allow    — declared check passes, exit 0.
 *   fail open — nothing declared, exit 0. Absence never blocks.
 *
 * Plus the two safety branches: the Stop re-entry guard, and the static
 * opt-in contract (our adaptation): ./setup never registers the gate; the
 * settings-hook helper.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const GATE = path.join(ROOT, 'bin', 'gstack-verify-gate');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-verify-gate-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Declare a verification command in the project's CLAUDE.md. */
function declareCheck(command: string): void {
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Fixture\n\n<!-- gstack:verify: ${command} -->\n`);
}

/** Write the check script the declaration points at. */
function check(exitCode: number, message: string): void {
  const script = path.join(dir, 'check.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho "${message}"\nexit ${exitCode}\n`);
  fs.chmodSync(script, 0o755);
}

function runGate(stopHookActive = false): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(GATE, {
    cwd: dir,
    input: JSON.stringify({ stop_hook_active: stopHookActive }),
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('gstack-verify-gate', () => {
  test('blocks the turn when the declared check fails', () => {
    declareCheck('./check.sh');
    check(1, 'totals mismatch');

    const r = runGate();

    expect(r.code).toBe(2);
    expect(r.stderr).toContain('FAILED');
    expect(r.stderr).toContain('totals mismatch');
  });

  test('allows the turn when the declared check passes', () => {
    declareCheck('./check.sh');
    check(0, 'all good');

    const r = runGate();

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('passed');
  });

  test('fails open when CLAUDE.md declares no check', () => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Fixture\n\nNothing declared here.\n');

    const r = runGate();

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("declares no 'gstack:verify:' command");
  });

  test('fails open when there is no CLAUDE.md at all', () => {
    const r = runGate();

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no CLAUDE.md');
  });

  test('never invents a command: an empty declaration fails open', () => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '<!-- gstack:verify: -->\n');

    const r = runGate();

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("declares no 'gstack:verify:' command");
  });

  test('re-entry guard: a failing check does not block twice in one turn', () => {
    declareCheck('./check.sh');
    check(1, 'still failing');

    const r = runGate(true);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('already ran');
  });
});

describe('opt-in contract (adapted from the fork: NOT registered by default)', () => {
  const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
  const gate = fs.readFileSync(GATE, 'utf-8');

  test('./setup does NOT register the gate — a Stop hook running the verify command after every turn is opt-in', () => {
    expect(setup).not.toContain('verify-gate');
  });

  test('the bin documents its own registration and removal commands', () => {
    expect(gate).toContain('remove-source --source verify-gate');
    expect(gate).toContain('gstack:verify:');
  });
});


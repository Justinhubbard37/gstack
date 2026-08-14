/**
 * CI secret gate contract (R4/R9, fork port wave 2).
 *
 * .github/scripts/gate-secret-scan.mjs pipes a unified diff's ADDED lines
 * into bin/gstack-redact and enforces: HIGH fails (exit 1), MEDIUM is an
 * advisory count only (no human in CI to confirm, so it must never fail
 * the check), clean passes. The workflow-level pathspec excludes keep the
 * planted-bug fixtures out of the diff entirely; this pins the script's
 * own exit contract with live subprocess runs.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, ".github", "scripts", "gate-secret-scan.mjs");

function scan(diff: string): { code: number; out: string } {
  const res = spawnSync("node", [SCRIPT], {
    cwd: ROOT,
    input: diff,
    encoding: "utf-8",
    timeout: 60_000,
  });
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

describe("gate-secret-scan.mjs exit contract", () => {
  test("clean added lines pass", () => {
    const r = scan("+const x = 1;\n+++ b/file.ts\n+// harmless\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain("0 high");
  });

  test("a HIGH credential in an added line fails the gate", () => {
    const r = scan(
      "+-----BEGIN RSA PRIVATE KEY-----\n+MIIEowIBAAKCAQEA\n+-----END RSA PRIVATE KEY-----\n",
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("1 high");
  });

  test("removed lines and context are ignored — only additions are scanned", () => {
    const r = scan(
      "------BEGIN RSA PRIVATE KEY-----\n-MIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n+just an addition\n",
    );
    expect(r.code).toBe(0);
  });

  test("MEDIUM findings are advisory only — never fail CI", () => {
    // A Stripe publishable-key shape sits at MEDIUM in the taxonomy
    // (context-variable; a human confirms interactively, CI cannot).
    const r = scan(`+const key = "pk_live_${"a".repeat(24)}";\n`);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\d+ advisory/);
  });
});

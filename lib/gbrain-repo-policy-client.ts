/**
 * gbrain-repo-policy-client — the ONE TypeScript client for the per-remote
 * trust store (bin/gstack-gbrain-repo-policy, a bash CLI that owns URL
 * normalization and schema migration — do not reimplement either here).
 *
 * Extracted because two call sites (lib/code-intelligence/selection.ts consent
 * veto; bin/gstack-gbrain-sync.ts code-import gate) each spawnSync'd the script
 * themselves and had started to drift. On win32, spawning a
 * `#!/usr/bin/env bash` script directly fails ENOENT, which both sites'
 * fail-closed paths then reported as "store could not be read" for EVERY repo
 * — so this client invokes the script through `bash` there (an ENOENT then
 * genuinely means "no bash on PATH") and reports a spawn failure distinctly
 * from a policy-read failure, so callers can say what actually broke.
 *
 * POLARITY IS THE CALLER'S. This client only reads and classifies; each call
 * site keeps its own fail-open / fail-closed decision on `error`.
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type RepoPolicyTierValue = "deny" | "read-only" | "read-write" | "none";

export interface RepoPolicyResult {
  /** `none` = no policy store, no remote URL, or no entry for this remote. */
  tier: RepoPolicyTierValue;
  /**
   * Set when the tier could not be determined (tier is `none` then):
   *  - `spawn-failed`: the policy script could not be executed at all
   *    (script missing, or no bash on PATH on win32) — the store itself may
   *    be perfectly fine.
   *  - `unreadable`: the script ran but could not read the store
   *    (permissions, corruption, unexpected output).
   */
  error?: "unreadable" | "spawn-failed";
}

/** Absolute path of the policy store for this env (GSTACK_HOME-aware). */
export function repoPolicyStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.GSTACK_HOME || join(env.HOME || homedir(), ".gstack");
  return join(home, "gbrain-repo-policy.json");
}

/** No store on disk = no policy was ever set (the fast path — no subprocess). */
export function hasRepoPolicyStore(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(repoPolicyStorePath(env));
}

/** The bash script that owns the store — resolved relative to this file (lib/ → bin/), never cwd. */
const POLICY_SCRIPT = join(import.meta.dir, "..", "bin", "gstack-gbrain-repo-policy");

/**
 * Trust tier for a remote URL, via `gstack-gbrain-repo-policy get <url>`.
 *
 * Fast paths (no subprocess): no store on disk → `none`; no remote URL →
 * `none` (policy is keyed by origin remote, so nothing can be set for the
 * repo). Everything else shells to the script, which owns normalization.
 */
export function repoPolicyTier(url: string | null, env: NodeJS.ProcessEnv = process.env): RepoPolicyResult {
  if (!hasRepoPolicyStore(env)) return { tier: "none" };
  if (!url) return { tier: "none" };
  // The script is `#!/usr/bin/env bash`; win32 can't exec a shebang file, so
  // invoke through bash there. An ENOENT then means bash is not on PATH.
  const [cmd, args]: [string, string[]] =
    process.platform === "win32" ? ["bash", [POLICY_SCRIPT, "get", url]] : [POLICY_SCRIPT, ["get", url]];
  const res = spawnSync(cmd, args, {
    encoding: "utf-8",
    timeout: 10_000,
    // Explicit env: Bun's spawnSync default env snapshot misses runtime
    // process.env mutations (e.g. tests redirecting GSTACK_HOME).
    env: { ...env } as NodeJS.ProcessEnv,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    return { tier: "none", error: code === "ENOENT" ? "spawn-failed" : "unreadable" };
  }
  if (res.status !== 0) return { tier: "none", error: "unreadable" };
  const tier = (res.stdout || "").trim();
  if (tier === "deny" || tier === "read-only" || tier === "read-write") return { tier };
  if (tier === "unset") return { tier: "none" };
  return { tier: "none", error: "unreadable" }; // unexpected output — a read failure, not a tier
}

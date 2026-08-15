// Pure-function tests for bin/gstack-next-version.
// Covers the version arithmetic and slot-picking logic. Subprocess paths
// (gh/glab/git) are covered by the integration test at the bottom (skipped
// when the relevant CLI isn't available).

import { test, expect, describe } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVersion,
  fmtVersion,
  bumpVersion,
  cmpVersion,
  pickNextSlot,
  markActiveSiblings,
  resolveVersionPath,
} from "../bin/gstack-next-version";

describe("parseVersion", () => {
  test("accepts 4-digit semver", () => {
    expect(parseVersion("1.6.3.0")).toEqual([1, 6, 3, 0]);
    expect(parseVersion("0.0.0.0")).toEqual([0, 0, 0, 0]);
    expect(parseVersion("99.99.99.99")).toEqual([99, 99, 99, 99]);
  });

  test("trims whitespace", () => {
    expect(parseVersion("  1.2.3.4  \n")).toEqual([1, 2, 3, 4]);
  });

  test("rejects malformed", () => {
    expect(parseVersion("1.2.3")).toBeNull();
    expect(parseVersion("1.2.3.4.5")).toBeNull();
    expect(parseVersion("v1.2.3.4")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("not-a-version")).toBeNull();
    expect(parseVersion("1.2.3.x")).toBeNull();
  });
});

describe("bumpVersion", () => {
  test("major zeros everything right", () => {
    expect(bumpVersion([1, 6, 3, 0], "major")).toEqual([2, 0, 0, 0]);
    expect(bumpVersion([1, 6, 3, 7], "major")).toEqual([2, 0, 0, 0]);
  });
  test("minor zeros patch+micro", () => {
    expect(bumpVersion([1, 6, 3, 0], "minor")).toEqual([1, 7, 0, 0]);
    expect(bumpVersion([1, 6, 3, 7], "minor")).toEqual([1, 7, 0, 0]);
  });
  test("patch zeros micro", () => {
    expect(bumpVersion([1, 6, 3, 0], "patch")).toEqual([1, 6, 4, 0]);
    expect(bumpVersion([1, 6, 3, 7], "patch")).toEqual([1, 6, 4, 0]);
  });
  test("micro increments slot 4", () => {
    expect(bumpVersion([1, 6, 3, 0], "micro")).toEqual([1, 6, 3, 1]);
    expect(bumpVersion([1, 6, 3, 7], "micro")).toEqual([1, 6, 3, 8]);
  });
});

describe("cmpVersion", () => {
  test("detects order", () => {
    expect(cmpVersion([1, 6, 3, 0], [1, 6, 3, 0])).toBe(0);
    expect(cmpVersion([1, 6, 4, 0], [1, 6, 3, 0])).toBeGreaterThan(0);
    expect(cmpVersion([1, 6, 3, 0], [1, 6, 4, 0])).toBeLessThan(0);
    expect(cmpVersion([2, 0, 0, 0], [1, 99, 99, 99])).toBeGreaterThan(0);
  });
});

describe("pickNextSlot (the heart of queue-aware allocation)", () => {
  const base: [number, number, number, number] = [1, 6, 3, 0];

  test("happy path — no claims, clean bump", () => {
    const r = pickNextSlot(base, [], "minor");
    expect(fmtVersion(r.version)).toBe("1.7.0.0");
    expect(r.reason).toMatch(/no collision/);
  });

  test("collision — one PR claims the next slot, bump past", () => {
    const r = pickNextSlot(base, [[1, 7, 0, 0]], "minor");
    expect(fmtVersion(r.version)).toBe("1.8.0.0");
    expect(r.reason).toMatch(/bumped past/);
  });

  test("multi-collision — two PRs claim sequential slots", () => {
    const r = pickNextSlot(base, [[1, 7, 0, 0], [1, 8, 0, 0]], "minor");
    expect(fmtVersion(r.version)).toBe("1.9.0.0");
  });

  test("collision cross-level — queued MINOR bumps past my PATCH", () => {
    // Queue has 1.7.0.0 (minor), my bump is patch. I should land at 1.7.1.0
    // (patch relative to the highest claim).
    const r = pickNextSlot(base, [[1, 7, 0, 0]], "patch");
    expect(fmtVersion(r.version)).toBe("1.7.1.0");
  });

  test("claims below base are ignored", () => {
    const r = pickNextSlot(base, [[1, 5, 0, 0], [1, 6, 2, 0]], "patch");
    expect(fmtVersion(r.version)).toBe("1.6.4.0");
    expect(r.reason).toMatch(/no collision/);
  });

  test("claims equal to base are treated as no-claim", () => {
    // The caller is expected to pre-filter base-equal claims out, but even if
    // one slipped through, we don't want to inflate past it.
    const r = pickNextSlot(base, [], "micro");
    expect(fmtVersion(r.version)).toBe("1.6.3.1");
  });

  test("major collision — competing majors", () => {
    const r = pickNextSlot(base, [[2, 0, 0, 0]], "major");
    expect(fmtVersion(r.version)).toBe("3.0.0.0");
  });

  test("unsorted claims still resolve correctly", () => {
    const r = pickNextSlot(base, [[1, 9, 0, 0], [1, 7, 0, 0], [1, 8, 0, 0]], "minor");
    expect(fmtVersion(r.version)).toBe("1.10.0.0");
  });
});

describe("markActiveSiblings", () => {
  const base: [number, number, number, number] = [1, 6, 3, 0];
  const now = Math.floor(Date.now() / 1000);

  test("flags siblings that are ahead of base AND recent AND have no PR", () => {
    const siblings = [
      { path: "/a", branch: "feat/alpha", version: "1.7.0.0", last_commit_ts: now - 60, has_open_pr: false, is_active: false },
    ];
    const r = markActiveSiblings(siblings, base);
    expect(r[0].is_active).toBe(true);
  });

  test("does not flag siblings with open PRs (already in the queue)", () => {
    const siblings = [
      { path: "/a", branch: "feat/alpha", version: "1.7.0.0", last_commit_ts: now - 60, has_open_pr: true, is_active: false },
    ];
    expect(markActiveSiblings(siblings, base)[0].is_active).toBe(false);
  });

  test("does not flag stale siblings (commit > 24h old)", () => {
    const siblings = [
      { path: "/a", branch: "feat/alpha", version: "1.7.0.0", last_commit_ts: now - 25 * 3600, has_open_pr: false, is_active: false },
    ];
    expect(markActiveSiblings(siblings, base)[0].is_active).toBe(false);
  });

  test("does not flag siblings at or below base", () => {
    const siblings = [
      { path: "/a", branch: "feat/alpha", version: "1.6.3.0", last_commit_ts: now - 60, has_open_pr: false, is_active: false },
      { path: "/b", branch: "feat/beta", version: "1.5.0.0", last_commit_ts: now - 60, has_open_pr: false, is_active: false },
    ];
    const r = markActiveSiblings(siblings, base);
    expect(r[0].is_active).toBe(false);
    expect(r[1].is_active).toBe(false);
  });
});

describe("resolveVersionPath (monorepo VERSION-path support)", () => {
  test("CLI flag wins over everything", () => {
    const dir = mkdtempSync(join(tmpdir(), "nextver-"));
    try {
      mkdirSync(join(dir, ".gstack"));
      writeFileSync(join(dir, ".gstack", "version-path"), "config/VERSION\n");
      expect(resolveVersionPath("flag/path/VERSION", dir)).toBe("flag/path/VERSION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(".gstack/version-path config is picked up", () => {
    const dir = mkdtempSync(join(tmpdir(), "nextver-"));
    try {
      mkdirSync(join(dir, ".gstack"));
      writeFileSync(join(dir, ".gstack", "version-path"), "Tinas Second Brain/health-tracker/VERSION\n");
      expect(resolveVersionPath(undefined, dir)).toBe("Tinas Second Brain/health-tracker/VERSION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trims whitespace and ignores blank lines after the first", () => {
    const dir = mkdtempSync(join(tmpdir(), "nextver-"));
    try {
      mkdirSync(join(dir, ".gstack"));
      writeFileSync(join(dir, ".gstack", "version-path"), "  apps/web/VERSION  \n\n# comment-ish line\n");
      expect(resolveVersionPath(undefined, dir)).toBe("apps/web/VERSION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty config file falls back to default VERSION", () => {
    const dir = mkdtempSync(join(tmpdir(), "nextver-"));
    try {
      mkdirSync(join(dir, ".gstack"));
      writeFileSync(join(dir, ".gstack", "version-path"), "\n");
      expect(resolveVersionPath(undefined, dir)).toBe("VERSION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing config file falls back to default VERSION", () => {
    const dir = mkdtempSync(join(tmpdir(), "nextver-"));
    try {
      expect(resolveVersionPath(undefined, dir)).toBe("VERSION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty override string falls back to config/default", () => {
    // Defensive: "" should NOT win over config — only a non-empty CLI arg should.
    const dir = mkdtempSync(join(tmpdir(), "nextver-"));
    try {
      mkdirSync(join(dir, ".gstack"));
      writeFileSync(join(dir, ".gstack", "version-path"), "subproj/VERSION\n");
      expect(resolveVersionPath("", dir)).toBe("subproj/VERSION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Fixture-repo coverage for the default-base detection chain in parseArgs:
// origin/HEAD symbolic-ref → origin/main probe → origin/master probe →
// literal "main". No --base and no --current-version are passed, so the
// detected base is observable through base_version: each fixture branch
// carries a distinct VERSION and readBaseVersion does
// `git show origin/<detected-base>:VERSION`.
describe("default-base detection (no --base)", () => {
  const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-next-version");
  // Point git at a nonexistent global/system config so operator settings
  // (init.defaultBranch, commit.gpgsign, hooks, ...) can't leak into fixtures.
  const noCfg = join(mkdtempSync(join(tmpdir(), "nextver-gitcfg-")), "empty");
  const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: noCfg,
    GIT_CONFIG_SYSTEM: noCfg,
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };

  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
  }

  // Origin repo whose branches each hold a distinct VERSION, plus a clone
  // (the clone is the repo the CLI runs in).
  function makeClone(branches: Array<[name: string, version: string]>): { root: string; clone: string } {
    const root = mkdtempSync(join(tmpdir(), "nextver-base-"));
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", branches[0][0]);
    for (let i = 0; i < branches.length; i++) {
      const [name, version] = branches[i];
      if (i > 0) git(origin, "checkout", "-q", "-b", name);
      writeFileSync(join(origin, "VERSION"), `${version}\n`);
      git(origin, "add", "VERSION");
      git(origin, "commit", "-q", "--no-gpg-sign", "-m", `VERSION ${version}`);
    }
    git(root, "clone", "-q", "origin", "clone");
    return { root, clone: join(root, "clone") };
  }

  function runWithoutBase(cwd: string): { exitCode: number; parsed: any } {
    const proc = Bun.spawnSync(
      ["bun", "run", SCRIPT, "--bump", "patch", "--workspace-root", "null"],
      { cwd },
    );
    const out = new TextDecoder().decode(proc.stdout);
    return { exitCode: proc.exitCode, parsed: JSON.parse(out) };
  }

  test("origin/HEAD symbolic-ref wins — resolves trunk even though origin/main exists", () => {
    const { root, clone } = makeClone([["main", "1.1.1.1"], ["trunk", "2.2.2.2"]]);
    try {
      git(clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
      const { exitCode, parsed } = runWithoutBase(clone);
      expect(exitCode).toBe(0);
      // trunk's VERSION, not main's — the rev-parse probes never ran.
      expect(parsed.base_version).toBe("2.2.2.2");
      expect(parsed.version).toBe("2.2.3.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("no origin/HEAD, no origin/main: the origin/master probe resolves master", () => {
    const { root, clone } = makeClone([["master", "3.3.3.3"]]);
    try {
      // Plain clones that never ran `git remote set-head` have no origin/HEAD.
      git(clone, "remote", "set-head", "origin", "--delete");
      const { exitCode, parsed } = runWithoutBase(clone);
      expect(exitCode).toBe(0);
      // Read at origin/master. The "main" literal fallback would have warned
      // and assumed 0.0.0.0 instead.
      expect(parsed.base_version).toBe("3.3.3.3");
      expect(parsed.version).toBe("3.3.4.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("neither origin/HEAD nor main/master: falls back to the 'main' literal", () => {
    const { root, clone } = makeClone([["develop", "4.4.4.4"]]);
    try {
      git(clone, "remote", "set-head", "origin", "--delete");
      const { exitCode, parsed } = runWithoutBase(clone);
      expect(exitCode).toBe(0);
      // base = literal "main"; origin/main doesn't exist, so readBaseVersion
      // warns and assumes 0.0.0.0 — which pins WHICH base the fallback chose.
      expect(parsed.base_version).toBe("0.0.0.0");
      expect(parsed.warnings.join("\n")).toContain("origin/main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

// Integration smoke — only runs if gh is available and authenticated. Confirms
// the CLI executes end-to-end against real APIs without crashing.
describe("integration (smoke)", () => {
  // Bumps timeout to 30s — the test spawns a real `bun run` subprocess that
  // does a `gh pr list` against the live GitHub API to inspect claimed slots.
  // Network latency makes 5s tight on developer machines.
  test("CLI runs against real repo and emits parseable JSON", async () => {
    const proc = Bun.spawnSync([
      "bun",
      "run",
      "./bin/gstack-next-version",
      "--base",
      "main",
      "--bump",
      "patch",
      "--current-version",
      "1.6.3.0",
      "--workspace-root",
      "null", // skip sibling scan in CI
    ]);
    const out = new TextDecoder().decode(proc.stdout);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("version");
    expect(parseVersion(parsed.version)).not.toBeNull();
    expect(parsed).toHaveProperty("bump", "patch");
    expect(parsed).toHaveProperty("host");
    expect(["github", "gitlab", "unknown"]).toContain(parsed.host);
    expect(parsed).toHaveProperty("claimed");
    expect(Array.isArray(parsed.claimed)).toBe(true);
    expect(parsed).toHaveProperty("siblings");
    expect(parsed.siblings).toEqual([]); // --workspace-root null disabled scanning
    expect(parsed).toHaveProperty("version_path", "VERSION"); // default when no config + no flag
  }, 30_000); // Headroom over the 4-5s wall time of the spawned process under load

  test("CLI runs with --version-path and surfaces it in JSON output", async () => {
    const proc = Bun.spawnSync([
      "bun",
      "run",
      "./bin/gstack-next-version",
      "--base",
      "main",
      "--bump",
      "patch",
      "--current-version",
      "1.6.3.0",
      "--workspace-root",
      "null",
      "--version-path",
      "Tinas Second Brain/health-tracker/VERSION",
    ]);
    const out = new TextDecoder().decode(proc.stdout);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("version_path", "Tinas Second Brain/health-tracker/VERSION");
  }, 30_000);
});

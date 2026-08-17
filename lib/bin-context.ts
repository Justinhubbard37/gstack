/**
 * bin-context — tiny shared helpers for non-interactive gstack bins that need the
 * project slug, current branch, and argv flags. Extracted from the decision bins
 * (gstack-decision-log / gstack-decision-search) so the slug/branch/flag plumbing
 * lives in one audited place instead of being copy-pasted per bin.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";

/** Keep the slug inside the [a-zA-Z0-9._-] alphabet gstack-slug promises (`tr -cd`). */
function sanitizeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "");
}

/**
 * A Windows path in the MSYS form git-bash's `pwd` reports:
 * `C:\Users\j\foo` → `/c/Users/j/foo`. gstack-slug keys its cache on THAT form
 * (`tr '/' '_'`), so a native lookup must reproduce it exactly or it misses the very
 * entry gstack-slug wrote and silently re-derives instead of staying consistent.
 * Exported for the cache-key test; non-Windows paths pass through unchanged.
 */
export function toMsysPath(p: string): string {
  const drive = p.match(/^([A-Za-z]):[\\/]/);
  const body = (drive ? p.slice(2) : p).replace(/\\/g, "/");
  return drive ? `/${drive[1].toLowerCase()}${body}` : body;
}

/** `-f` in bash terms: a regular file (following symlinks), never a directory. */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Marker tiers mirror bin/gstack-slug's `_outermost_project_root` exactly.
// STRONG = canonical version-control / language project files ("this directory
// is a real project of its own"); .git is checked separately because it can be
// a directory (normal repo) or a file (worktree / submodule pointer).
// WEAK = content-only project signals (markdown bundles, asset collections).
const STRONG_FILE_MARKERS = [".project.yaml", "package.json", "pyproject.toml", "Cargo.toml", "Gemfile", "go.mod"];
const WEAK_FILE_MARKERS = ["README.md", "README", "README.rst", "LICENSE", "LICENSE.md"];

/**
 * Native port of bin/gstack-slug's `_outermost_project_root` (:77-113): walk UP
 * from `startDir` tracking the OUTERMOST ancestor holding a strong marker and
 * the outermost holding a weak marker. Outermost STRONG wins; else outermost
 * WEAK; else "". Build/deploy artifacts (.vercel, node_modules, dist, ...) are
 * deliberately NOT markers, so they can't establish a phantom project root.
 *
 * Termination mirrors the bash fix for windows-free-tests: break on dirname's
 * FIXED POINT (drive roots `C:\`, relative `.`, UNC `//srv` never reach the
 * literal "/"), with a 64-depth belt-and-braces cap. Exported for the
 * hostile-path termination tests.
 */
export function outermostProjectRoot(startDir: string): string {
  let dir = startDir;
  let outermostStrong = "";
  let outermostWeak = "";
  let depth = 0;
  while (dir && dir !== "/" && depth < 64) {
    if (existsSync(join(dir, ".git")) || STRONG_FILE_MARKERS.some((m) => isFile(join(dir, m)))) {
      outermostStrong = dir;
    } else if (WEAK_FILE_MARKERS.some((m) => isFile(join(dir, m)))) {
      outermostWeak = dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // dirname fixed point (C:\, ., //srv)
    dir = parent;
    depth += 1;
  }
  // Strong markers win over weak; either wins over nothing.
  return outermostStrong || outermostWeak;
}

/**
 * Native port of bin/gstack-slug's resolution order, used when that script cannot be
 * spawned (see resolveSlug). Same steps, same alphabet, same cache file — so this and
 * the shell path always agree. They must: the bins WRITE using this, while the
 * Context Recovery preamble READS using the script.
 *
 * Resolution order (parity with the bash script, pinned by
 * test/bin-context-windows-slug.test.ts against test/gstack-slug-cwd-walk-up.test.ts):
 *   0. $GSTACK_PROJECT_SLUG env override — wins over everything, never cached.
 *   1. Walk UP to the OUTERMOST project root (see outermostProjectRoot). Without
 *      the walk, a nested/vendored repo derived its slug from the INNERMOST
 *      `git remote get-url origin`, splitting the store the bash side keeps whole.
 *   2. Cached slug is sticky — EXCEPT the provable old-bug shape (#1125): cached
 *      value equals basename(cwd) while the walk-up says cwd is NOT the project
 *      root; that cache came from the pre-walk-up resolver, so recompute and heal.
 *   3. Git remote AT THE PROJECT ROOT: [:/]<owner>/<repo>[.git] → owner-repo.
 *   4. Project root's basename; else basename(cwd) for plain non-project folders.
 */
export function slugFromEnvironment(gstackHome?: string, cwd: string = process.cwd()): string {
  const home = gstackHome || process.env.GSTACK_HOME || join(homedir(), ".gstack");
  const cacheDir = join(home, "slug-cache");
  const cacheFile = join(cacheDir, toMsysPath(cwd).replace(/\//g, "_"));

  // 0. explicit env override — per-invocation escape hatch, never persisted
  //    (caching it would rebind THIS cwd's slug for every later env-less run).
  const envSlug = sanitizeSlug((process.env.GSTACK_PROJECT_SLUG || "").trim());
  if (envSlug) return envSlug;

  // 1. outermost project root along the cwd ancestor chain (may be "").
  const projectRoot = outermostProjectRoot(cwd);

  let slug = "";
  // 2. cached slug is sticky (#2212), except the old-bug shape (#1125).
  if (existsSync(cacheFile)) {
    try {
      const cached = sanitizeSlug(readFileSync(cacheFile, "utf-8").trim());
      const pwdBase = sanitizeSlug(basename(cwd));
      const oldBugShape = cached === pwdBase && projectRoot !== "" && projectRoot !== cwd;
      if (cached && !oldBugShape) slug = cached;
    } catch {
      slug = "";
    }
  }
  // 3. derive from the project root's git remote (a subdir without its own
  //    remote inherits the parent's — same as `git -C "$PROJECT_ROOT"`).
  if (!slug && projectRoot) {
    const r = spawnSync("git", ["-C", projectRoot, "remote", "get-url", "origin"], { encoding: "utf-8" });
    const m = (r.stdout || "").trim().match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (m) slug = sanitizeSlug(m[1].replace(/\//g, "-"));
  }
  // 4. project root's basename, else pwd basename for plain folders.
  if (!slug && projectRoot) slug = sanitizeSlug(basename(projectRoot));
  if (!slug) slug = sanitizeSlug(basename(cwd));
  if (!slug) return "unknown";

  // 5. cache it, as gstack-slug does — atomic, self-healing (only rewrites when
  //    the value changed — single-shot, key-local), and failures stay silent.
  try {
    let current = "";
    try {
      current = readFileSync(cacheFile, "utf-8");
    } catch {
      // no cache yet — write below
    }
    if (current !== slug) {
      mkdirSync(cacheDir, { recursive: true });
      const tmp = `${cacheFile}.tmp.${process.pid}`;
      writeFileSync(tmp, slug, "utf-8");
      renameSync(tmp, cacheFile);
    }
  } catch {
    // best-effort cache; a miss only costs a re-derive on the next call
  }
  return slug;
}

/** Windows cannot exec an extensionless `#!/usr/bin/env bash` script (no shebang, no
 *  PATHEXT match for an explicit path), so gstack-slug spawns ENOENT there. */
export const NEEDS_NATIVE_SLUG_ON_WINDOWS = process.platform === "win32";

/**
 * Resolve the project slug via the `gstack-slug` helper (parses `SLUG=...`).
 *
 * On Windows that spawn fails ENOENT (see NEEDS_NATIVE_SLUG_ON_WINDOWS) and `r.stdout`
 * is undefined — the same class of hazard as the gbrain shim spawns in lib/gbrain-exec.ts
 * (#1731). Returning the literal "unknown" filed every decision under
 * ~/.gstack/projects/unknown/ — one bucket shared by every project on the machine —
 * while the bash-side Context Recovery preamble resolved the real slug, found no
 * decisions.active.json there, and skipped through a bare `if [ -f … ]` with no else.
 *
 * Nothing failed, for ten days: BOTH decision bins (log and search) missed identically,
 * so writes and searches stayed consistent with each other, and the only component that
 * resolved correctly was silent by design.
 *
 * `shell: true` is NOT the fix here, unlike #1731: cmd.exe cannot run a bash script
 * either. Nor is re-spawning through `bash` — on Windows that frequently resolves to
 * WSL, whose $HOME and /mnt/c paths yield a different slug AND a different cache
 * directory, trading one split store for another.
 *
 * POSIX behaviour is unchanged: the fallback is win32-only, where the previous result
 * was unconditionally wrong and so has nothing to regress.
 */
export function resolveSlug(slugBinPath: string): string {
  const r = spawnSync(slugBinPath, { encoding: "utf-8" });
  const m = (r.stdout || "").match(/^SLUG=(.+)$/m);
  if (m) return m[1].trim();
  if (NEEDS_NATIVE_SLUG_ON_WINDOWS) return slugFromEnvironment();
  return "unknown";
}

/** Current git branch, or undefined on detached HEAD / outside a repo. */
export function gitBranch(): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" });
  const b = (r.stdout || "").trim();
  return b && b !== "HEAD" ? b : undefined;
}

/** The value following `--flag` in argv, or undefined if absent. */
export function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

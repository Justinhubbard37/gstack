/**
 * selection — persists the user's chosen code-intelligence provider and their
 * per-repo indexing consent. Stored at `$GSTACK_HOME/code-intelligence.json`
 * (default `~/.gstack/`), the same home the rest of gstack uses.
 *
 * Consent is per-repo (keyed by absolute repo path), because indexing consent
 * is "may THIS repo's content be indexed by the selected provider" — a decision
 * a user makes per project, not once for the machine. No selection at all is the
 * provider-OFF default: callers degrade to grep / the file-only decision store.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { execFileSync, spawnSync } from "child_process";
import type { CodeProviderId } from "./contract";

export interface Selection {
  provider: CodeProviderId | null;
  /** Absolute repo path → consented. */
  consents: Record<string, boolean>;
  /** Provider id → the absolute repo path it last indexed (so search finds it). */
  roots: Record<string, string>;
  /** User explicitly chose no indexing — never offer again. */
  declined: boolean;
}

const EMPTY: Selection = { provider: null, consents: {}, roots: {}, declined: false };

function storePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.GSTACK_HOME || join(env.HOME || homedir(), ".gstack");
  return join(home, "code-intelligence.json");
}

export function readSelection(env: NodeJS.ProcessEnv = process.env): Selection {
  const p = storePath(env);
  if (!existsSync(p)) return { ...EMPTY };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<Selection>;
    return {
      provider: raw.provider ?? null,
      consents: raw.consents && typeof raw.consents === "object" ? raw.consents : {},
      roots: raw.roots && typeof raw.roots === "object" ? raw.roots : {},
      declined: raw.declined === true,
    };
  } catch {
    return { ...EMPTY };
  }
}

function write(selection: Selection, env: NodeJS.ProcessEnv = process.env): void {
  const p = storePath(env);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(selection, null, 2), "utf-8");
  renameSync(tmp, p);
}

export function setProvider(provider: CodeProviderId | null, env: NodeJS.ProcessEnv = process.env): Selection {
  // Choosing a provider clears a prior decline; clearing to null records one,
  // so the session-start offer is never repeated after an explicit "none".
  const next = { ...readSelection(env), provider, declined: provider === null };
  write(next, env);
  return next;
}

/** Record per-repo indexing consent (repo path resolved to absolute). */
export function setConsent(repoPath: string, consented: boolean, env: NodeJS.ProcessEnv = process.env): Selection {
  const current = readSelection(env);
  const next: Selection = { ...current, consents: { ...current.consents, [resolve(repoPath)]: consented } };
  write(next, env);
  return next;
}

/**
 * The per-remote trust store (gstack-gbrain-repo-policy) is the SINGLE
 * authority for consent-to-send: a `deny` tier vetoes any recorded
 * code-intelligence consent, so two stores can never disagree about whether
 * code may leave this repo (R1, fork port wave 2 review). Mirrors the
 * gbrain-sync chokepoint's polarity: no policy store → no veto (nothing was
 * ever set); unreadable store → veto (fail-closed — a policy the user set
 * must not be bypassed by a broken store).
 */
function repoPolicyVeto(repoPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const home = env.GSTACK_HOME || join(homedir(), ".gstack");
  if (!existsSync(join(home, "gbrain-repo-policy.json"))) return false;
  let url = "";
  try {
    url = execFileSync("git", ["-C", resolve(repoPath), "remote", "get-url", "origin"], {
      encoding: "utf-8", timeout: 5000,
    }).trim();
  } catch {
    return false; // no remote → policy (keyed by remote) has nothing set for this repo
  }
  if (!url) return false;
  const res = spawnSync(join(import.meta.dir, "..", "..", "bin", "gstack-gbrain-repo-policy"), ["get", url], {
    encoding: "utf-8", timeout: 10_000, env: { ...env } as NodeJS.ProcessEnv,
  });
  if (res.error || res.status !== 0) return true; // fail-closed
  const tier = (res.stdout || "").trim();
  return tier === "deny";
}

export function hasConsent(repoPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (readSelection(env).consents[resolve(repoPath)] !== true) return false;
  return !repoPolicyVeto(repoPath, env);
}

/** Record the repo path a provider last indexed, so search reads the same graph. */
export function setRoot(provider: CodeProviderId, repoPath: string, env: NodeJS.ProcessEnv = process.env): Selection {
  const current = readSelection(env);
  const next: Selection = { ...current, roots: { ...current.roots, [provider]: resolve(repoPath) } };
  write(next, env);
  return next;
}

export function getRoot(provider: CodeProviderId, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readSelection(env).roots[provider];
}

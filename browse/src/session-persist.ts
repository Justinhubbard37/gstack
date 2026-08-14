/**
 * Opt-in session-state persistence (#778, #2193, #1128, #1129).
 *
 * Portions copyright (c) 2026 Sina Matian, time-attack/gstack (GStack 2), MIT.
 *
 * With BROWSE_PERSIST_STATE=1, the headless daemon snapshots cookies +
 * per-tab URL/localStorage/sessionStorage to <stateDir>/session-state.json
 * on an interval and at clean shutdown, and restores it on the next launch.
 * Kills the auth-lost-on-restart class: a crash or binary-version
 * auto-restart no longer silently logs the user out of everything.
 *
 * Default OFF: cookies on disk (0600) are a real cost the user must opt
 * into. Headed mode is excluded — the persistent Chromium profile already
 * owns that state, and replaying tabs would clobber the user's window.
 *
 * Disk shape (version 1): { version, savedAt, cookies, pages[{url,
 * isActive, storage}] }. loadedHtml and owner are NEVER persisted — same
 * in-memory-only invariant as `state save|load` (meta-commands.ts): a
 * tampered file must not smuggle HTML past load-html's checks or forge tab
 * ownership.
 */

import * as fs from 'fs';
import type { BrowserManager, BrowserState } from './browser-manager';
import { writeSecureFile } from './file-permissions';
import { safeUnlinkQuiet } from './error-handling';

/** Rename a corrupt state file to .corrupt (forensic artifact) — best effort. */
function quarantineCorrupt(filePath: string): void {
  try {
    fs.renameSync(filePath, `${filePath}.corrupt`);
  } catch {
    safeUnlinkQuiet(filePath);
  }
}

export const SESSION_STATE_FILE = 'session-state.json';
export const SESSION_STATE_VERSION = 1;

/** Config gate. Documented in browse/SKILL.md ("Session persistence"). */
export function isSessionPersistEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BROWSE_PERSIST_STATE === '1';
}

/** Persist interval (ms). Env override exists for tests. */
export function sessionPersistIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseInt(env.BROWSE_PERSIST_INTERVAL_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

/**
 * Serialize a BrowserState to the on-disk v1 shape. Strips loadedHtml,
 * loadedHtmlWaitUntil, and owner (in-memory-only invariants).
 */
export function serializeSessionState(state: BrowserState): string {
  return JSON.stringify({
    version: SESSION_STATE_VERSION,
    savedAt: new Date().toISOString(),
    cookies: state.cookies,
    pages: state.pages.map((p) => ({
      url: p.url,
      isActive: p.isActive,
      storage: p.storage,
    })),
  }, null, 2);
}

/**
 * Same cookie hygiene as `state load` (meta-commands.ts, kept in sync by
 * comment there): drop malformed cookies and internal-network domains a
 * tampered file could use to reach localhost services or cloud metadata.
 */
export function filterSessionCookies(cookies: unknown[]): BrowserState['cookies'] {
  return cookies.filter((c: any) => {
    if (typeof c !== 'object' || !c) return false;
    if (typeof c.name !== 'string' || typeof c.value !== 'string') return false;
    if (typeof c.domain !== 'string' || !c.domain) return false;
    const d = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
    if (d === 'localhost' || d.endsWith('.internal') || d === '169.254.169.254') return false;
    return true;
  }) as BrowserState['cookies'];
}

/**
 * Parse + validate the on-disk shape into a BrowserState. Returns null for
 * anything malformed (corrupt JSON, wrong version, missing arrays).
 * loadedHtml/owner are stripped unconditionally even if present on disk.
 */
export function deserializeSessionState(raw: string): BrowserState | null {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || data.version !== SESSION_STATE_VERSION) return null;
  if (!Array.isArray(data.cookies) || !Array.isArray(data.pages)) return null;
  return {
    cookies: filterSessionCookies(data.cookies),
    pages: data.pages.map((p: any) => ({
      url: typeof p?.url === 'string' ? p.url : '',
      isActive: Boolean(p?.isActive),
      storage: p?.storage && typeof p.storage === 'object'
        ? {
            localStorage: typeof p.storage.localStorage === 'object' && p.storage.localStorage ? p.storage.localStorage : {},
            sessionStorage: typeof p.storage.sessionStorage === 'object' && p.storage.sessionStorage ? p.storage.sessionStorage : {},
          }
        : null,
      // NEVER accept loadedHtml / loadedHtmlWaitUntil / owner from disk.
    })),
  };
}

/**
 * Snapshot the live session to disk (0600). No-op outside launched
 * (headless) mode — the headed persistent profile owns its own state.
 */
export async function persistSessionState(bm: BrowserManager, filePath: string): Promise<void> {
  if (bm.getConnectionMode() !== 'launched') return;
  const state = await bm.saveState();
  writeSecureFile(filePath, serializeSessionState(state));
}

/**
 * Restore a persisted session into a freshly launched manager. Returns true
 * when state was restored, false when there was nothing (or corrupt data —
 * which is warned, deleted, and skipped rather than blocking launch).
 * restoreState re-validates every URL before navigating.
 */
export async function restoreSessionState(bm: BrowserManager, filePath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
  const state = deserializeSessionState(raw);
  if (!state) {
    // Boot fresh, keep the evidence: the corrupt file moves to .corrupt so a
    // 3-week-later bug report is reconstructable from the artifact.
    console.warn(`[browse] SESSION_STATE_INVALID: corrupt ${filePath} moved to .corrupt; starting fresh`);
    quarantineCorrupt(filePath);
    return false;
  }
  // launch() opens one blank tab; replace it rather than restoring alongside.
  await bm.closeAllPages();
  await bm.restoreState(state);
  return true;
}

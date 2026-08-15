/**
 * Shared error-handling utilities for browse server and CLI.
 *
 * Each wrapper uses selective catches (checks err.code) to avoid masking
 * unexpected errors. Empty catches would be flagged by slop-scan.
 */

import * as fs from 'fs';

// ─── Filesystem ────────────────────────────────────────────────

/** Remove a file, ignoring ENOENT (already gone). Rethrows other errors. */
export function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

/** Remove a file, ignoring ALL errors. Use only in best-effort cleanup (shutdown, emergency). */
export function safeUnlinkQuiet(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch {}
}

// ─── Process ───────────────────────────────────────────────────

/** Send a signal to a process, ignoring ESRCH (already dead). Rethrows other errors. */
export function safeKill(pid: number, signal: NodeJS.Signals | number): void {
  try {
    process.kill(pid, signal);
  } catch (err: any) {
    if (err?.code !== 'ESRCH') throw err;
  }
}

/**
 * Check if a PID is alive. Pure boolean probe — never throws.
 *
 * Signal 0 on every platform. Node and Bun both map `process.kill(pid, 0)` to
 * an OpenProcess existence check on Windows, so the POSIX idiom is portable
 * here — no shell-out needed.
 *
 * Windows used to shell out to `tasklist /FI "PID eq <pid>"` and string-match
 * the CSV. That was wrong in two ways, both of which bit in production:
 *
 *   1. FALSE NEGATIVES UNDER LOAD. `tasklist` takes ~700-1700ms on an idle
 *      Windows box and far longer under memory pressure. A Bun.spawnSync that
 *      hits its `timeout` still RETURNS, carrying partial stdout — so the
 *      `.includes()` match came back false and a LIVE process was reported
 *      dead. Callers (killAgentByRecord, the terminal-agent watchdog) then
 *      skipped the kill and respawned around the survivor, leaking one
 *      terminal-agent per watchdog tick. The leak was self-reinforcing: every
 *      orphan added memory pressure, which made the next tasklist slower,
 *      which produced the next false negative.
 *   2. A VISIBLE CONSOLE WINDOW per probe (no windowsHide), so a background
 *      watchdog strobed a terminal into the foreground every 60 seconds.
 *
 * Signal 0 is ~74,000x faster (0.004ms vs 270ms, measured), spawns nothing,
 * and cannot time out.
 *
 * EPERM means the process EXISTS but we lack rights to signal it. That is
 * alive; returning false there would reintroduce failure mode 1.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

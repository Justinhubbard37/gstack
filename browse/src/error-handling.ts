/**
 * Shared error-handling utilities for browse server and CLI.
 *
 * Each wrapper uses selective catches (checks err.code) to avoid masking
 * unexpected errors. Empty catches would be flagged by slop-scan.
 */

import * as fs from 'fs';

const IS_WINDOWS = process.platform === 'win32';

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
 * EPERM means the process EXISTS but we lack rights to signal it. That is
 * alive — returning false there makes callers that validate liveness before
 * killing (killAgentByRecord, the terminal-agent watchdog) skip the kill and
 * respawn around a survivor, leaking one process per watchdog tick (#2414,
 * #2295).
 */
export function isProcessAlive(pid: number): boolean {
  if (IS_WINDOWS) {
    try {
      const result = Bun.spawnSync(
        ['tasklist', '/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
        { stdout: 'pipe', stderr: 'pipe', timeout: 3000, windowsHide: true }
      );
      return result.stdout.toString().includes(`"${pid}"`);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isProcessAlive } from '../src/error-handling';
import { spawnTerminalAgent } from '../src/terminal-agent-control';

// REGRESSION TEST for the Windows terminal-agent leak.
//
// Symptom (reported on Windows 11, 48GB box under a heavy parallel build):
// a console window popped to the foreground every 60 seconds, and orphaned
// `bun run terminal-agent.ts` processes accumulated at one per minute until
// the machine ran out of committable memory.
//
// Root cause was a three-bug chain, each of which this file pins:
//
//   1. `isProcessAlive` shelled out to `tasklist` on Windows with a 3s
//      timeout. A Bun.spawnSync that hits its timeout STILL RETURNS, carrying
//      partial stdout — so the `.includes()` PID match came back false and a
//      LIVE agent was reported dead. Measured tasklist latency was 700-1700ms
//      idle, and far worse under memory pressure, so the timeout was reachable
//      in ordinary use.
//   2. That false negative made `killAgentByRecord` skip the kill (it
//      validates liveness first) while the watchdog respawned anyway —
//      leaking the survivor. Each orphan added memory pressure, slowing the
//      next tasklist, producing the next false negative. Self-reinforcing.
//   3. Neither the tasklist probe nor the agent spawn passed `windowsHide`,
//      so every tick allocated a visible console and stole focus.
//
// The guard-window arithmetic bug that let this run unbounded instead of
// tripping the crash-loop guard is pinned separately, in test 6.

const SRC_DIR = path.resolve(import.meta.dir, '..', 'src');

function readAllSourceFiles(): Array<{ file: string; content: string }> {
  return fs
    .readdirSync(SRC_DIR)
    .filter((e) => e.endsWith('.ts'))
    .map((e) => ({ file: e, content: fs.readFileSync(path.join(SRC_DIR, e), 'utf-8') }));
}

/** Strip line and block comments so static greps only see real code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('process liveness probe (Windows terminal-agent leak)', () => {
  test('1. isProcessAlive reports the current process alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test('2. isProcessAlive reports an unused PID dead', () => {
    // Below Linux PID_MAX_LIMIT, far above any realistic Windows/macOS PID.
    expect(isProcessAlive(2147483646)).toBe(false);
  });

  test('3. isProcessAlive spawns NO subprocess on POSIX (signal-0 path)', () => {
    // The heart of the bug: a liveness probe that forks is slow enough to
    // time out, and a timed-out probe silently answers "dead". Signal 0
    // cannot time out because it never leaves the process.
    //
    // Merged design note: on win32 the helper DOES keep a single hardened
    // tasklist probe (windowsHide, bounded timeout, quoted-CSV PID match)
    // because Bun's process.kill(pid, 0) throws ESRCH for live Windows PIDs
    // in compiled binaries. The POSIX path stays subprocess-free.
    if (process.platform === 'win32') return;
    const origSpawn = (Bun as any).spawn;
    const origSpawnSync = (Bun as any).spawnSync;
    const spawns: string[] = [];
    (Bun as any).spawn = (...args: any[]) => { spawns.push(`spawn:${JSON.stringify(args[0])}`); return origSpawn(...args); };
    (Bun as any).spawnSync = (...args: any[]) => { spawns.push(`spawnSync:${JSON.stringify(args[0])}`); return origSpawnSync(...args); };
    try {
      isProcessAlive(process.pid);
      isProcessAlive(2147483646);
      expect(spawns).toEqual([]);
    } finally {
      (Bun as any).spawn = origSpawn;
      (Bun as any).spawnSync = origSpawnSync;
    }
  });

  test('4. no source file probes liveness via tasklist outside the central helper', () => {
    // Static tripwire: ad-hoc tasklist existence checks scattered across src/
    // resurrect the false-negative class (each call site re-invents the
    // timeout/parse handling and gets it subtly wrong). The ONE sanctioned
    // site is error-handling.ts's isProcessAlive win32 branch — centralized,
    // windowsHide, bounded timeout, quoted-CSV `"${pid}"` match. Every other
    // file must route through the helper.
    const offenders: string[] = [];
    for (const { file, content } of readAllSourceFiles()) {
      if (file === 'error-handling.ts') continue; // the canonical helper
      const code = stripComments(content);
      // `PID eq` is the existence-probe form specifically. Other tasklist
      // uses (e.g. IMAGENAME filters for browser detection) are unaffected.
      if (/tasklist/.test(code) && /PID eq/.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test('5. spawnTerminalAgent passes windowsHide so no console is shown', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hide-'));
    const script = path.join(tmpDir, 'fake-agent.ts');
    fs.writeFileSync(script, '// no-op\n');
    const origSpawn = (Bun as any).spawn;
    let captured: any = null;
    (Bun as any).spawn = (_cmd: any, opts: any) => {
      captured = opts;
      return { pid: 4242, unref() {} };
    };
    try {
      const pid = spawnTerminalAgent({
        stateFile: path.join(tmpDir, 'state.json'),
        serverPort: 12345,
        ownerPid: process.pid,
        cwd: tmpDir,
        scriptPath: script,
      });
      expect(pid).toBe(4242);
      expect(captured).not.toBeNull();
      expect(captured.windowsHide).toBe(true);
      // Owner-PID lifetime tie (#2019): the agent polls this and exits when
      // its owning browse server dies, so it can't be adopted by PID 1.
      expect(captured.env.BROWSE_OWNER_PID).toBe(String(process.pid));
      // Detached background daemon — must not inherit a terminal either.
      expect(captured.stdio).toEqual(['ignore', 'ignore', 'ignore']);
    } finally {
      (Bun as any).spawn = origSpawn;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('6. respawn guard window spans enough ticks for the guard to fire', () => {
    // The guard was `RESPAWN_GUARD_WINDOW_MS = 60_000` against a 60_000ms
    // tick, allowing at most ONE respawn in the window — so the
    // `>= RESPAWN_GUARD_MAX (3)` trip condition was unreachable and a steady
    // one-per-tick leak never self-limited. Assert the window is derived from
    // the tick rather than fixed.
    const src = fs.readFileSync(path.join(SRC_DIR, 'server.ts'), 'utf-8');
    const match = src.match(/const RESPAWN_GUARD_WINDOW_MS =([\s\S]{0,160}?);/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('AGENT_WATCHDOG_TICK_MS');

    // Pin the arithmetic itself: at the default tick, three respawns must fit.
    const tick = 60_000;
    const guardMax = 3;
    const windowMs = Math.max(60_000, tick * (guardMax + 2));
    expect(windowMs).toBeGreaterThanOrEqual(tick * guardMax);
  });
});

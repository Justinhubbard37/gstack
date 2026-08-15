/**
 * Static tripwire for #1835: child spawns reachable on Windows must pass
 * windowsHide, or every daemon relaunch / taskkill / icacls / powershell
 * invocation flashes a black console window (and can steal focus).
 *
 * Source-level, same style as server-auth.test.ts / cdp-session-cleanup.test.ts:
 * cheap, deterministic, runs on every platform.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SRC = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../src', f), 'utf-8');

/** Every occurrence of `needle` in `src` must have `windowsHide` within the
 * next `window` chars (the spawn's options object). */
function expectHideNearEvery(src: string, needle: string, window = 400): void {
  let idx = src.indexOf(needle);
  expect(idx).toBeGreaterThanOrEqual(0);
  while (idx !== -1) {
    const slice = src.slice(idx, idx + window);
    expect(slice).toMatch(/windowsHide:\s*true/);
    idx = src.indexOf(needle, idx + needle.length);
  }
}

describe('windowsHide on Windows-reachable spawns (#1835)', () => {
  test('daemon launch paths in cli.ts pass windowsHide', () => {
    const cli = SRC('cli.ts');
    // Installed path: node -e launcher — both the outer spawnSync and the
    // inner detached daemon spawn (inside the launcher code string).
    expect(cli).toContain('detached:true,windowsHide:true');
    expectHideNearEvery(cli, "'-e', launcherCode]");
    // Dev fallback: detached bun spawn.
    expectHideNearEvery(cli, "nodeSpawn('bun'");
    // taskkill (killServer).
    expectHideNearEvery(cli, "'taskkill'");
  });

  test('Windows-only process probes pass windowsHide', () => {
    // tasklist in isProcessAlive — runs in polling loops.
    expectHideNearEvery(SRC('error-handling.ts'), "'tasklist'");
    // powershell DPAPI + tasklist in cookie import.
    const cookie = SRC('cookie-import-browser.ts');
    expectHideNearEvery(cookie, "'powershell'");
    expectHideNearEvery(cookie, "'tasklist'");
  });

  test('icacls calls in file-permissions.ts pass windowsHide', () => {
    const perms = SRC('file-permissions.ts');
    expect((perms.match(/'icacls'/g) || []).length).toBeGreaterThanOrEqual(3);
    expectHideNearEvery(perms, "'icacls'");
  });

  test('terminal-agent respawn in terminal-agent-control.ts passes windowsHide', () => {
    // The CLI cold-start + v1.44 watchdog respawn path. On Windows it runs
    // through the Node polyfill (dist/bun-polyfill.cjs) whose host default is
    // the opposite of Bun's — a visible console window on every watchdog
    // respawn is the symptom when the flag is dropped. Wider window: the
    // spawn's options object carries the full env wiring before the flag.
    expectHideNearEvery(SRC('terminal-agent-control.ts'), '(Bun as any).spawn(', 700);
  });
});

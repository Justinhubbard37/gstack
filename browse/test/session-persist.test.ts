/**
 * Opt-in session-state persistence (#778, #2193, #1128, #1129).
 *
 * Pins the leg of the browser-lifecycle contract that had no coverage:
 * "shut down without losing live session state." Pre-fix, the headless
 * daemon used non-persistent chromium.launch() with zero storage
 * persistence — any crash or binary-version auto-restart silently lost all
 * auth. These tests fail on the old tree (module absent, no wiring).
 *
 * Suites:
 *   1. Pure serialize/deserialize/filter units (free, instant).
 *   2. Real-Chromium round-trip: cookie + localStorage survive a full
 *      manager teardown + relaunch via persist/restore.
 *   3. Static wiring tripwire: server.ts restores at launch, snapshots at
 *      shutdown, and the gate is BROWSE_PERSIST_STATE (default off).
 */

import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  serializeSessionState, deserializeSessionState, filterSessionCookies,
  isSessionPersistEnabled, persistSessionState, restoreSessionState,
} from '../src/session-persist';
import type { BrowserState } from '../src/browser-manager';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-persist-'));
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

describe('session-persist units', () => {
  test('config gate: default off, exactly "1" enables', () => {
    expect(isSessionPersistEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isSessionPersistEnabled({ BROWSE_PERSIST_STATE: '0' } as any)).toBe(false);
    expect(isSessionPersistEnabled({ BROWSE_PERSIST_STATE: 'true' } as any)).toBe(false);
    expect(isSessionPersistEnabled({ BROWSE_PERSIST_STATE: '1' } as any)).toBe(true);
  });

  test('serialize strips loadedHtml/owner, keeps cookies + storage', () => {
    const state: BrowserState = {
      cookies: [{ name: 'sid', value: 'abc', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' } as any],
      pages: [{
        url: 'https://example.com/app',
        isActive: true,
        storage: { localStorage: { k: 'v' }, sessionStorage: {} },
        loadedHtml: '<script>evil</script>',
        loadedHtmlWaitUntil: 'load',
        owner: 'agent-1',
      }],
    };
    const raw = serializeSessionState(state);
    expect(raw).not.toContain('loadedHtml');
    expect(raw).not.toContain('evil');
    expect(raw).not.toContain('owner');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.cookies[0].name).toBe('sid');
    expect(parsed.pages[0].storage.localStorage.k).toBe('v');
  });

  test('deserialize rejects corrupt JSON, wrong version, missing arrays', () => {
    expect(deserializeSessionState('not json{')).toBeNull();
    expect(deserializeSessionState('{"version":99,"cookies":[],"pages":[]}')).toBeNull();
    expect(deserializeSessionState('{"version":1,"cookies":{}}')).toBeNull();
  });

  test('deserialize strips loadedHtml/owner even if tampered onto disk', () => {
    const raw = JSON.stringify({
      version: 1,
      cookies: [],
      pages: [{ url: 'https://x.com', isActive: true, storage: null, loadedHtml: '<h1>x</h1>', owner: 'evil' }],
    });
    const state = deserializeSessionState(raw)!;
    expect((state.pages[0] as any).loadedHtml).toBeUndefined();
    expect((state.pages[0] as any).owner).toBeUndefined();
  });

  test('cookie filter drops malformed + internal-network domains', () => {
    const kept = filterSessionCookies([
      { name: 'ok', value: 'v', domain: 'example.com' },
      { name: 'bad1', value: 'v', domain: 'localhost' },
      { name: 'bad2', value: 'v', domain: '.corp.internal' },
      { name: 'bad3', value: 'v', domain: '169.254.169.254' },
      { name: 'bad4', value: 42, domain: 'example.com' },
      null,
    ]);
    expect(kept.map((c: any) => c.name)).toEqual(['ok']);
  });

  test('restoreSessionState: missing file → false, corrupt file → quarantined to .corrupt', async () => {
    const bmNeverCalled = { closeAllPages() { throw new Error('must not restore'); } } as any;
    expect(await restoreSessionState(bmNeverCalled, path.join(tmpRoot, 'nope.json'))).toBe(false);
    const corrupt = path.join(tmpRoot, 'corrupt.json');
    fs.writeFileSync(corrupt, '{oops');
    expect(await restoreSessionState(bmNeverCalled, corrupt)).toBe(false);
    expect(fs.existsSync(corrupt)).toBe(false); // moved aside, won't block every future launch
    expect(fs.existsSync(`${corrupt}.corrupt`)).toBe(true); // forensic artifact kept (R3)
  });

  test('persistSessionState is a no-op in headed mode (profile owns state)', async () => {
    const file = path.join(tmpRoot, 'headed.json');
    const bm = {
      getConnectionMode: () => 'headed',
      saveState() { throw new Error('must not snapshot headed session'); },
    } as any;
    await persistSessionState(bm, file);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('session-persist round-trip (real Chromium)', () => {
  test('cookie + localStorage + URL survive teardown → relaunch', async () => {
    const { BrowserManager } = await import('../src/browser-manager');
    const { startTestServer } = await import('./test-server');
    const { server, url } = startTestServer(0);
    const stateFile = path.join(tmpRoot, 'roundtrip.json');

    const bm1 = new BrowserManager();
    await bm1.launch();
    try {
      const page = bm1.getPage();
      await page.goto(`${url}/basic.html`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        document.cookie = 'session_marker=alive-after-restart; path=/';
        localStorage.setItem('auth_marker', 'still-logged-in');
      });
      await persistSessionState(bm1, stateFile);
    } finally {
      await bm1.close();
    }

    // File on disk is owner-only (cookies are secrets).
    if (process.platform !== 'win32') {
      expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    }

    const bm2 = new BrowserManager();
    await bm2.launch();
    try {
      expect(await restoreSessionState(bm2, stateFile)).toBe(true);
      const page = bm2.getPage();
      expect(page.url()).toContain('/basic.html');
      const marker = await page.evaluate(() => ({
        cookie: document.cookie,
        auth: localStorage.getItem('auth_marker'),
      }));
      expect(marker.cookie).toContain('session_marker=alive-after-restart');
      expect(marker.auth).toBe('still-logged-in');
    } finally {
      await bm2.close();
      server.stop(true);
    }
  }, 60_000);
});

describe('server wiring (static tripwire)', () => {
  const SERVER_SRC = fs.readFileSync(path.join(import.meta.dir, '..', 'src', 'server.ts'), 'utf-8');

  test('start() restores and schedules interval snapshots behind the gate', () => {
    expect(SERVER_SRC).toContain('isSessionPersistEnabled()');
    expect(SERVER_SRC).toContain('restoreSessionState(browserManager');
    expect(SERVER_SRC).toContain('sessionPersistIntervalMs()');
  });

  test('shutdown() takes a final snapshot BEFORE closing the browser', () => {
    const shutdownStart = SERVER_SRC.indexOf('async function shutdown(');
    const persistAt = SERVER_SRC.indexOf('persistSessionState(cfgBrowserManager', shutdownStart);
    const closeAt = SERVER_SRC.indexOf('await cfgBrowserManager.close()', shutdownStart);
    expect(persistAt).toBeGreaterThan(shutdownStart);
    expect(closeAt).toBeGreaterThan(persistAt);
  });
});

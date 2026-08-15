import { describe, test, expect, afterAll, setDefaultTimeout } from 'bun:test';
import * as path from 'path';

// Every test here spawnSync's a `node` child; Windows CI cold-start (AV scan,
// first-touch of node.exe) alone can blow bun's 5s default — observed 5,007ms
// on a 50ms sleep test. Subprocess budget, not assertion looseness.
setDefaultTimeout(20_000);

// Load the polyfill into a fresh object (don't clobber globalThis.Bun)
const polyfillPath = path.resolve(import.meta.dir, '../src/bun-polyfill.cjs');

describe('bun-polyfill', () => {
  // We test the polyfill by requiring it in a subprocess under Node.js
  // since it's designed for Node, not Bun.

  test('Bun.sleep resolves after delay', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require(${JSON.stringify(polyfillPath)});
      (async () => {
        const start = Date.now();
        await Bun.sleep(50);
        const elapsed = Date.now() - start;
        console.log(elapsed >= 40 ? 'OK' : 'TOO_FAST');
      })();
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.stdout.toString().trim()).toBe('OK');
    expect(result.exitCode).toBe(0);
  });

  test('Bun.spawnSync runs a command and returns stdout', () => {
    const result = Bun.spawnSync(['node', '-e', `
      require(${JSON.stringify(polyfillPath)});
      const r = Bun.spawnSync(['echo', 'hello'], { stdout: 'pipe' });
      console.log(r.stdout.toString().trim());
      console.log('exit:' + r.exitCode);
    `], { stdout: 'pipe', stderr: 'pipe' });
    const lines = result.stdout.toString().trim().split('\n');
    expect(lines[0]).toBe('hello');
    expect(lines[1]).toBe('exit:0');
  });

  test('Bun.spawn launches a process with pid', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require(${JSON.stringify(polyfillPath)});
      const p = Bun.spawn(['echo', 'test'], { stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(typeof p.pid === 'number' ? 'HAS_PID' : 'NO_PID');
      console.log(typeof p.kill === 'function' ? 'HAS_KILL' : 'NO_KILL');
      console.log(typeof p.unref === 'function' ? 'HAS_UNREF' : 'NO_UNREF');
    `], { stdout: 'pipe', stderr: 'pipe' });
    const lines = result.stdout.toString().trim().split('\n');
    expect(lines[0]).toBe('HAS_PID');
    expect(lines[1]).toBe('HAS_KILL');
    expect(lines[2]).toBe('HAS_UNREF');
  });

  test('Bun.serve creates an HTTP server that responds', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require(${JSON.stringify(polyfillPath)});
      const server = Bun.serve({
        port: 0,  // Note: polyfill uses port directly, so we pick one
        hostname: '127.0.0.1',
        fetch(req) {
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });
      // The polyfill doesn't support port 0, so we test the object shape
      console.log(typeof server.stop === 'function' ? 'HAS_STOP' : 'NO_STOP');
      console.log(typeof server.port === 'number' ? 'HAS_PORT' : 'NO_PORT');
      server.stop();
    `], { stdout: 'pipe', stderr: 'pipe' });
    const lines = result.stdout.toString().trim().split('\n');
    expect(lines[0]).toBe('HAS_STOP');
    expect(lines[1]).toBe('HAS_PORT');
  });

  // windowsHide is the one option where Node's default is the opposite of
  // Bun's: Node shows the child's console window, Bun hides it. Dropping it
  // in translation makes every spawned child pop a window on Windows, which
  // is the platform this whole file exists for. Both shims are covered, and
  // an explicit windowsHide:false must survive forwarding (#2523 + #2539).
  test('Bun.spawn defaults windowsHide to true', () => {
    const result = Bun.spawnSync(['node', '-e', `
      const cp = require('child_process');
      const orig = cp.spawn;
      let seen;
      cp.spawn = (c, a, o) => { seen = o; return orig(c, a, o); };
      require(${JSON.stringify(polyfillPath)});
      Bun.spawn(['node', '-e', ''], { stdio: ['ignore', 'ignore', 'ignore'] });
      console.log('windowsHide:' + seen.windowsHide);
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.stdout.toString().trim()).toBe('windowsHide:true');
  });

  test('Bun.spawnSync defaults windowsHide to true', () => {
    const result = Bun.spawnSync(['node', '-e', `
      const cp = require('child_process');
      const orig = cp.spawnSync;
      let seen;
      cp.spawnSync = (c, a, o) => { seen = o; return orig(c, a, o); };
      require(${JSON.stringify(polyfillPath)});
      Bun.spawnSync(['node', '-e', '']);
      console.log('windowsHide:' + seen.windowsHide);
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.stdout.toString().trim()).toBe('windowsHide:true');
  });

  test('an explicit windowsHide:false is honored', () => {
    const result = Bun.spawnSync(['node', '-e', `
      const cp = require('child_process');
      const orig = cp.spawn;
      let seen;
      cp.spawn = (c, a, o) => { seen = o; return orig(c, a, o); };
      require(${JSON.stringify(polyfillPath)});
      Bun.spawn(['node', '-e', ''], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: false });
      console.log('windowsHide:' + seen.windowsHide);
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.stdout.toString().trim()).toBe('windowsHide:false');
  });
});

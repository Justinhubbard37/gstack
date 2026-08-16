import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// Static tripwire (free tier, runs on every PR): the private-API ObjC touch
// bridge MUST compile out of Release builds. That safety property has two
// load-bearing halves, and this test pins both against regression:
//
//   1. DebugBridgeTouch.m's body is gated `#if TARGET_OS_IOS && DEBUG` — NOT a
//      bare `#if TARGET_OS_IOS` (which shipped the private symbols in Release
//      iOS builds; PR #2264 claimed they were compiled out but the guard was
//      platform-only).
//   2. The DebugBridgeTouch target in Package.swift carries a cSettings
//      DEBUG define scoped to the debug configuration — without it, `#if DEBUG`
//      is false even in Debug and the bridge silently breaks in the case it
//      exists to serve.
//
// The full proof — an iOS-SDK Release build asserting `nm`/`strings` of the
// built binary contain none of _touchesEvent / IOHIDEventCreateDigitizer* /
// _AXSSetAutomationEnabled / DebugBridgeTouch — needs an iOS builder and lives
// in the device/periodic tier (the macOS `swift build` lane can't build the
// Touch target). This tripwire guards the source-level invariant everywhere.

const ROOT = path.resolve(import.meta.dir, '..');

const TOUCH_SOURCES = [
  'ios-qa/templates/DebugBridgeTouch.m.template',
  'test/fixtures/ios-qa/FixtureApp/Sources/DebugBridgeTouch/DebugBridgeTouch.m',
];

const PACKAGE_MANIFESTS = [
  'ios-qa/templates/Package.swift.template',
  'test/fixtures/ios-qa/FixtureApp/Package.swift',
];

describe('DebugBridgeTouch Release compile-out guard', () => {
  for (const rel of TOUCH_SOURCES) {
    test(`${rel} gates the body on TARGET_OS_IOS && DEBUG`, () => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      // The primary body guard must be the DEBUG-qualified form.
      expect(src).toContain('#if TARGET_OS_IOS && DEBUG');
      // And must NOT carry a bare platform-only guard as the body gate — that
      // was the exact regression (private API shipped in Release).
      expect(src).not.toMatch(/^#if TARGET_OS_IOS$/m);
    });
  }

  for (const rel of PACKAGE_MANIFESTS) {
    test(`${rel} defines DEBUG for the DebugBridgeTouch target in debug config`, () => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      // Anchor on the target's unique `path:` (the `name:` string also appears
      // in the products/.library section). The DEBUG cSettings define sits just
      // after the path line; take a forward window to the next .target( (or end)
      // so the assertion is scoped to THIS target, not the whole manifest.
      const anchor = src.indexOf('path: "Sources/DebugBridgeTouch"');
      expect(anchor).toBeGreaterThan(-1);
      const rest = src.slice(anchor);
      const nextTarget = rest.indexOf('.target(');
      const block = nextTarget > -1 ? rest.slice(0, nextTarget) : rest;
      expect(block).toContain('cSettings:');
      expect(block).toMatch(/\.define\("DEBUG",\s*\.when\(configuration:\s*\.debug\)\)/);
    });
  }
});

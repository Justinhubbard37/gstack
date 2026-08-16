import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Template-drift tripwire for the content-binding wave. The bins are
 * code-enforced; the GRADING rules live as prose in rendered templates that
 * agents follow. This test pins the load-bearing rule text in the GENERATED
 * files so a template refactor can't silently drop a rule while the bins keep
 * working. (Prompt-followed prose is honest tier-2 enforcement — this tripwire
 * is what keeps it from being tier-3 vibes.)
 */

const ROOT = path.resolve(import.meta.dir, '..');

function rendered(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('content-binding template drift', () => {
  test('ship Step 16 carries the evidence check (mechanized IRON LAW)', () => {
    const ship = rendered('ship/SKILL.md');
    expect(ship).toMatch(/gstack-evidence check --label tests --expect-cmd '[^']+' --label vitest --expect-cmd '[^']+' --max-age 24 --allow-paths CHANGELOG\.md,VERSION,package\.json/);
    expect(ship).toContain('a failed CHECK never blocks');
  });

  test('ship Step 5 lanes run wrapped with per-lane labels', () => {
    const tests = rendered('ship/sections/tests.md');
    expect(tests).toContain('gstack-evidence run --label tests');
    expect(tests).toContain('gstack-evidence run --label vitest');
  });

  test('land-and-deploy grades staleness content-first (wtree rule) and checks evidence', () => {
    const land = rendered('land-and-deploy/SKILL.md');
    expect(land).toContain('wtree');
    expect(land).toContain('---WTREE---');
    expect(land).toMatch(/gstack-evidence check --label tests --expect-cmd '[^']+' --max-age 24/);
    expect(land).toContain('UNKNOWN');
  });

  test('the review dashboard staleness rule is wtree-first for diff-scoped rows', () => {
    // The dashboard text is generated into every skill that embeds
    // {{REVIEW_DASHBOARD}}; ship is the canonical carrier.
    const ship = rendered('ship/SKILL.md');
    expect(ship).toContain('---WTREE---');
    expect(ship).toContain('diff-scoped rows only');
    expect(ship).toContain('grade UNKNOWN and treat as stale');
  });

  test('the diff-scoped row list is IDENTICAL in both grading surfaces (no drift)', () => {
    // The resolver (dashboard) and land-and-deploy each carry the row list;
    // they diverged once (codex-review present in one, missing in the other).
    // Rendered dashboards escape backticks (template-literal origin), so match
    // structurally: the three row names in order inside the rule sentence.
    const rowList = /diff-scoped rows only:[\s\S]{0,80}?adversarial-review[\s\S]{0,80}?codex-review[\s\S]{0,80}?ship-stage entries/;
    expect(rendered('ship/SKILL.md')).toMatch(rowList);
    expect(rendered('land-and-deploy/SKILL.md')).toMatch(rowList);
  });

  test('release-body write side carries the banner tripwire (and it actually fires)', () => {
    const body = rendered('document-release/sections/release-body.md');
    expect(body).toContain('grep -c "UNTRUSTED TRACKER CONTENT" /tmp/gstack-pr-body-$$.md');
    expect(body).toContain('grep -c "UNTRUSTED TRACKER CONTENT" /tmp/gstack-pr-body-orig-$$.md');
    // The fail-open shape: grep -c prints 0 AND exits 1 on no-match, so an
    // `|| echo 0` double-emits and breaks the -gt into the clean branch.
    expect(body).not.toContain('|| echo 0');
    expect(body).toContain('banner tripwire clean');

    // Functional: execute the template's tripwire block against a 0-banner
    // original and a 1-banner outgoing body — the ABORT branch must fire.
    const block = body.match(/_ORIG_BANNERS=\$\(grep[\s\S]*?fi\n/);
    expect(block).not.toBeNull();
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { execSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-banner-'));
    try {
      fs.writeFileSync(path.join(dir, 'orig.md'), 'clean body\n');
      fs.writeFileSync(path.join(dir, 'new.md'), 'body with UNTRUSTED TRACKER CONTENT banner leak\n');
      const script = block![0]
        .replaceAll('/tmp/gstack-pr-body-orig-$$.md', path.join(dir, 'orig.md'))
        .replaceAll('/tmp/gstack-pr-body-$$.md', path.join(dir, 'new.md'));
      const out = execSync(`bash -c ${JSON.stringify(script + '; true')}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      expect(out).not.toContain('banner tripwire clean');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('greptile triage reads bodies through the guard (metadata/body split)', () => {
    const triage = rendered('review/greptile-triage.md');
    expect(triage).toContain('gstack-issue-guard --stdin --source greptile-line');
    expect(triage).toContain('gstack-issue-guard --stdin --source greptile-replies');
  });
});

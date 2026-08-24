/**
 * Context-budget ratchet — CI-enforced ceilings on the two token ledgers
 * nothing else guards (plan OV8):
 *
 *   ALWAYS-ON  — full frontmatter bytes every session's skill scanner loads
 *                (catalog-budget.test.ts caps name+description only; this
 *                catches growth in the OTHER frontmatter keys).
 *   EAGER      — per-invocation SKILL.md + forced-read references, per skill
 *                (skill-size-budget floors catch shrink; parity-suite catches
 *                growth RATIOS vs an old baseline; this pins absolute token
 *                ceilings that ratchet DOWN as reduction phases land).
 *
 * Fails when a skill's eager tokens exceed its fixture ceiling, when the
 * always-on aggregate exceeds its ceiling, or when a skill exists with no
 * ceiling at all (new skills must be consciously budgeted).
 *
 * RATCHET PROTOCOL (on failure):
 *   1. If the growth is a real feature: re-run
 *        bun test/helpers/capture-context-budget.ts
 *      and commit the refreshed fixture in the SAME commit as the feature,
 *      so the growth is a visible, conscious decision in the diff.
 *   2. If the growth is accidental (resolver bloat, duplicated block,
 *      copy-paste): fix the bloat instead.
 *   3. After a token-reduction phase lands: re-run the capture so ceilings
 *      ratchet down and the win is locked against regression.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import { checkBudget } from '../lib/context-bill';
import {
  buildRatchetBill,
  BUDGET_FIXTURE_PATH,
  type ContextBudget,
} from './helpers/capture-context-budget';

const RATCHET_PROTOCOL =
  'Ratchet protocol: legitimate feature growth -> re-run `bun test/helpers/capture-context-budget.ts` ' +
  'and commit the refreshed fixture in the same commit; accidental bloat -> fix the bloat; ' +
  'after a reduction lands -> re-run the capture so the ceilings ratchet down.';

const budget: ContextBudget = JSON.parse(fs.readFileSync(BUDGET_FIXTURE_PATH, 'utf-8'));
const bill = buildRatchetBill();

describe('context-budget ratchet', () => {
  test('always-on + eager ledgers stay under the fixture ceilings', () => {
    const violations = checkBudget(bill, {
      alwaysOnTotal: budget.alwaysOnTotal,
      eagerPerInvocation: budget.eagerPerInvocation,
    });
    const detail = violations
      .map((v) => `  ${v.ceiling}: ${v.actual} tok > limit ${v.limit}\n    ${v.files.join('\n    ')}`)
      .join('\n');
    expect(
      violations.length,
      `Context-budget ceilings exceeded:\n${detail}\n${RATCHET_PROTOCOL}`,
    ).toBe(0);
  });

  test('every skill in the tree has an eager ceiling (new skills are consciously budgeted)', () => {
    const missing = bill.skills
      .map((s) => s.name)
      .filter((name) => !(name in budget.eagerPerInvocation));
    expect(
      missing,
      `Skills without a context-budget ceiling: ${missing.join(', ')}.\n` +
        `Add them by re-running the capture. ${RATCHET_PROTOCOL}`,
    ).toEqual([]);
  });

  test('fixture has no ceilings for skills that no longer exist', () => {
    const live = new Set(bill.skills.map((s) => s.name));
    const stale = Object.keys(budget.eagerPerInvocation).filter((name) => !live.has(name));
    expect(
      stale,
      `Fixture carries ceilings for removed skills: ${stale.join(', ')}. Re-run the capture.`,
    ).toEqual([]);
  });
});

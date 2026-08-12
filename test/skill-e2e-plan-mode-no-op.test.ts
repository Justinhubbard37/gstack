/**
 * Plan-mode-info no-op regression (gate tier, paid, real-PTY).
 *
 * Asserts: when a plan-review skill is invoked OUTSIDE plan mode (no
 * --permission-mode plan flag, no plan-mode reminder injected), the skill
 * still reaches a terminal outcome ('asked' or 'plan_ready'). This is the
 * negative coverage to the per-skill plan-mode smokes — if plan-mode-keyed
 * behavior ever starts misfiring for non-plan-mode sessions (e.g., gating
 * questions on a phrase that isn't there, or the plan-eng/plan-design
 * scope-gate auto-select-B bypass firing without plan mode), this test
 * catches it.
 *
 * Why this matters: outside plan mode, claude doesn't render a native
 * confirmation UI. The skill must drive its own AskUserQuestion. Same
 * runner, same outcome contract — just `inPlanMode: false`.
 *
 * Coverage grew with the scope-gate bypass (plan-mode auto-select B):
 *  - plan-ceo-review: original preamble-misfire regression.
 *  - plan-eng-review / plan-design-review: the bypass must NOT fire outside
 *    plan mode (scopeGateAutoSelectObserved stays false), and when the run
 *    ends in 'asked', the question that fired must be the scope gate itself
 *    (outside plan mode with no named target, the gate is the FIRST
 *    question by contract).
 *  - named-target case: a pasted draft (initialPlanContent) IS an
 *    explicitly-named target, so the gate must NOT ask — and the review
 *    must actually consume the pasted content.
 *
 * Cost note: 4 sequential PTY runs (~3-5 min each) in the gate lane, up
 * from 1 pre-bypass. Selected only when plan-ceo/eng/design or the runner
 * change (see 'plan-mode-no-op' in touchfiles.ts).
 */

import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { runPlanSkillObservation } from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

const PLAN_MODE_REMINDER =
  'Plan mode is active. The user indicated that they do not want you to execute yet';

// Distinctive token proves the pasted target was consumed by the review —
// not just that no question fired. Nonsense-unique so it can't appear by
// coincidence in skill output.
const SEED_TOKEN = 'ZephyrLedgerWidget';
const NAMED_TARGET_SEED = `
# Plan: ${SEED_TOKEN} settings panel

## Scope
Add a ${SEED_TOKEN} settings panel with a single toggle that enables
weekly export emails. One new component, one route, one test file.

## Files
- src/components/${SEED_TOKEN}.tsx (new)
- src/routes/settings.tsx (add panel)
- test/${SEED_TOKEN}.test.tsx (new)
`;

describeE2E('plan-mode-info no-op outside plan mode (gate regression)', () => {
  for (const skillName of ['plan-ceo-review', 'plan-eng-review', 'plan-design-review'] as const) {
    test(`${skillName} reaches a terminal outcome outside plan mode`, async () => {
      const obs = await runPlanSkillObservation({
        skillName,
        inPlanMode: false,
        timeoutMs: 300_000,
      });

      if (obs.outcome === 'silent_write' || obs.outcome === 'exited' || obs.outcome === 'timeout') {
        throw new Error(
          `plan-mode no-op regression FAILED (${skillName}): outcome=${obs.outcome}\n` +
            `summary: ${obs.summary}\n` +
            `elapsed: ${obs.elapsedMs}ms\n` +
            `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
        );
      }
      expect(['asked', 'plan_ready']).toContain(obs.outcome);

      // Negative regression: the rendered output must NOT echo the plan-mode
      // distinctive reminder phrase. If it does, the plan-mode preamble
      // section is leaking outside plan mode.
      expect(obs.evidence).not.toContain(PLAN_MODE_REMINDER);

      if (skillName !== 'plan-ceo-review') {
        // Scope-gate bypass must not misfire: no auto-select announcement
        // outside plan mode.
        expect(obs.scopeGateAutoSelectObserved ?? false).toBe(false);
        // And when a question fired, it must have been the scope gate —
        // outside plan mode with no named target, the gate is the FIRST
        // question by contract (hard STOP before any tool call).
        if (obs.outcome === 'asked') {
          expect(obs.scopeGateQuestionObserved ?? false).toBe(true);
        }
      }
    }, 360_000);
  }

  // Named-target exception (outside plan mode): a pasted draft IS an
  // explicitly-named target, so the scope gate must NOT ask — and the
  // review must consume the pasted content (seed token visible in the
  // review output), proving the target was used rather than the question
  // merely skipped. Also the over-trigger guard for the tightened
  // "explicit-only" exception wording.
  test('plan-eng-review skips the scope gate for an explicitly-pasted target', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-eng-review',
      inPlanMode: false,
      initialPlanContent: NAMED_TARGET_SEED,
      timeoutMs: 300_000,
    });

    if (obs.outcome === 'silent_write' || obs.outcome === 'exited' || obs.outcome === 'timeout') {
      throw new Error(
        `named-target no-op FAILED: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    expect(['asked', 'plan_ready']).toContain(obs.outcome);
    expect(obs.evidence).not.toContain(PLAN_MODE_REMINDER);

    // The pasted doc is the named target: gate question must not render,
    // no plan-mode announcement either (we are NOT in plan mode).
    expect(obs.scopeGateQuestionObserved ?? false).toBe(false);
    expect(obs.scopeGateAutoSelectObserved ?? false).toBe(false);

    // Target consumption: the review must reference the seeded feature.
    // evidence is the lossy 2KB tail, so also accept the token appearing in
    // the plan file the review wrote — the token names the component, route,
    // and test file every finding has to discuss, so absence from BOTH means
    // the pasted target was not actually reviewed.
    const inEvidence = obs.evidence.includes(SEED_TOKEN);
    const inPlanFile =
      !!obs.planFile && existsSync(obs.planFile) && readFileSync(obs.planFile, 'utf-8').includes(SEED_TOKEN);
    expect(inEvidence || inPlanFile).toBe(true);
  }, 360_000);
});

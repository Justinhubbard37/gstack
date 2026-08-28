/**
 * AUQ no-degradation A/B: pre-cut vs post-cut AskUserQuestion Format — periodic,
 * paid, SDK capture.
 *
 * The AskUserQuestion Format preamble section stated several of its rules more
 * than once (the completeness rule three times, the auto-decide marker twice,
 * the tool-not-prose rule three times). The repetition cut removes the
 * duplicate statements while keeping every floor and all 14 format pins
 * (Layer 0, auq-format-always-loaded.test.ts, proves presence deterministically).
 *
 * The risk under test: repetition may be load-bearing for RUNTIME compliance —
 * a model may follow rules better because they repeat. This A/B is the gate
 * that decision rested on (approved 2026-08-25, option A: "the gate outranks
 * the approval"): identical prompt, two renders, and the post-cut AUQ must be
 * NOT WORSE than the pre-cut AUQ on format elements and recommendation
 * substance. Same harness and bar as skill-e2e-auq-verbose-vs-carved-ab.
 *
 *   - PRE  : plan-ceo-review/SKILL.md read from git at 3263fffe (the last
 *            commit before the cut), with the current sections/ (the cut
 *            touched only the preamble skeleton, not the sections).
 *   - POST : this worktree's render.
 */
import { test } from 'bun:test';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import {
  setupPlanCeoDir,
  captureModeSelectionAuq,
  scoreAuqFormat,
  carvedSkill,
  verboseSkill,
} from './helpers/auq-sdk-capture';
import { judgeRecommendation } from './helpers/llm-judge';

const describeE2E = describeE2ETier('periodic');
const runId = `auq-cut-ab-${process.env.EVALS_RUN_ID ?? 'local'}`;
const PRE_CUT_REF = '3263fffe';

async function grade(label: string, dir: string) {
  const text = await captureModeSelectionAuq({ planDir: dir, testName: `auq-cut-ab-${label}`, runId });
  const fmt = scoreAuqFormat(text);
  let substance = 0;
  if (text.trim()) {
    try {
      const r = await judgeRecommendation(text);
      substance = r.reason_substance;
    } catch { /* judge unavailable */ }
  }
  // eslint-disable-next-line no-console
  console.log(
    `[AUQ-CUT-AB ${label}] captured=${text.length}B format=${fmt.present}/${fmt.total} ` +
      `missing=[${fmt.missing.join(',')}] substance=${substance}`,
  );
  return { text, fmt, substance };
}

describeE2E('AUQ no-degradation: repetition cut (periodic)', () => {
  test(
    'post-cut AskUserQuestion Format render is not worse than pre-cut on the same prompt',
    async () => {
      const post = carvedSkill();
      const postDir = setupPlanCeoDir({
        skillMd: post.skillMd,
        sectionsFrom: post.sectionsFrom,
        tmpPrefix: 'auq-cut-ab-post-',
      });
      const preDir = setupPlanCeoDir({
        skillMd: verboseSkill(PRE_CUT_REF),
        sectionsFrom: post.sectionsFrom,
        tmpPrefix: 'auq-cut-ab-pre-',
      });

      let p, q;
      try {
        q = await grade('POST', postDir);
        p = await grade('PRE', preDir);
      } finally {
        fs.rmSync(postDir, { recursive: true, force: true });
        fs.rmSync(preDir, { recursive: true, force: true });
      }

      const summary = [
        `POST: format ${q.fmt.present}/${q.fmt.total}, substance ${q.substance}`,
        `PRE : format ${p.fmt.present}/${p.fmt.total}, substance ${p.substance}`,
      ].join('\n');

      if (!q.text.trim() || !p.text.trim()) {
        throw new Error(
          `A/B inconclusive — a side produced no AUQ capture:\n${summary}\n` +
            `--- post ---\n${q.text.slice(0, 2000)}\n--- pre ---\n${p.text.slice(0, 2000)}`,
        );
      }

      const formatRegressed = q.fmt.present < p.fmt.present;
      const substanceRegressed = q.substance < p.substance - 1; // 1-pt judge tolerance
      if (formatRegressed || substanceRegressed) {
        throw new Error(
          `AUQ DEGRADATION from the repetition cut — the gate outranks the approval; revert the cut:\n${summary}` +
            (formatRegressed ? `\n  -> post-cut dropped: [${q.fmt.missing.join(',')}]` : '') +
            (substanceRegressed ? `\n  -> post-cut substance regressed >1 pt` : '') +
            `\n--- post AUQ ---\n${q.text}\n--- pre AUQ ---\n${p.text}`,
        );
      }

      // eslint-disable-next-line no-console
      console.log('[AUQ-CUT-AB] NO DEGRADATION:\n' + summary);
    },
    600_000,
  );
});

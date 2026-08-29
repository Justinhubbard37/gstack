/**
 * WS2 — with-skill vs without-skill agentic arm benchmark (periodic, paid).
 *
 * Role: a standalone RESEARCH INSTRUMENT, not a release gate. gstack skills
 * cost ~13K tokens per invocation and nothing else measures whether they earn
 * it. Each named build-shaped task runs twice through real `claude -p`
 * sessions against the same seeded fixture repo — one arm with the
 * behavioral-layer skill installed (project-scope .claude/skills + a
 * CLAUDE.md routing line, the proven opus-47 pattern; `claude -p` does NOT
 * auto-load SKILL.md), one arm without — and the `git diff` each arm leaves
 * behind is scored. Metric order is diff-quality-first: the 0-3
 * over-engineering judge score is reported before LOC. Expect uncomfortable
 * numbers sometimes; that is the point. Results inform strategy, they do not
 * gate releases — no assertion here compares arm scores.
 *
 * The skill under test (`build-discipline`) is assembled at runtime from the
 * two behavioral sections WS3/WS7 added — the reuse ladder (## Search Before
 * Building) and the bounded closer (## Voice) — EXTRACTED from a rendered
 * SKILL.md (ship/), never copied whole (CLAUDE.md fixture rule).
 *
 * Failure taxonomy (CEO review finding 2):
 *   - zero-diff arm  -> VALID scored cell (LOC 0, judge scores it "none").
 *   - harvest failure -> cell FAILED, harvest: null recorded.
 *   - judge still malformed after armJudge's bounded retries -> judge_error
 *     cell: excluded from aggregates, surfaced in the run report, never
 *     silently dropped.
 *
 * The selftest describe at the bottom is FREE (no API): fixture integrity,
 * skill extraction, arm installation asymmetry, diff-capture plumbing, and
 * the judge's prompt-construction/parse path on reference good/bad diffs.
 * Everything needing a live model sits inside the EVALS_TIER=periodic
 * describes above it.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import type { SkillTestResult } from './helpers/session-runner';
import {
  ROOT, runId, selectedTests, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector, copyDirSync,
} from './helpers/e2e-helpers';
import { describeE2ETier } from './helpers/e2e-gate';
import { extractSkillSections } from './helpers/skill-fixture';
import {
  armJudge, buildArmJudgePrompt, parseArmJudgeResponse,
  ARM_JUDGE_ATTEMPTS, callJudge, type ArmJudgeScore,
} from './helpers/llm-judge';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Named per-arm constants (plan: defaults of 15 turns/120s are nowhere
// near enough for a build-shaped ticket: read fixture, implement, run tests).
const ARM_MAX_TURNS = 40;
const ARM_TIMEOUT_MS = 8 * 60_000;
/** Max diff bytes sent to the over-engineering judge. Truncation is loud
 *  (logged + suffixed onto judge_reasoning) — a clipped patch can hide the
 *  construct being scored, so a silent cap would corrupt cells invisibly. */
const ARM_JUDGE_DIFF_CAP = 30_000;
// Skill tool in BOTH arms so the tool surface is symmetric — the without-arm
// simply has nothing installed to invoke. No Agent: build-discipline
// dispatches no subagents.
const ARM_ALLOWED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill'];
// Two concurrent arms + up to two judge calls + fixture setup.
const TASK_TEST_TIMEOUT_MS = ARM_TIMEOUT_MS + 240_000;

const SKILL_NAME = 'build-discipline';
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'arm-benchmark');

type Arm = 'with-skill' | 'without-skill';

interface ArmTask {
  /** E2E_TOUCHFILES / E2E_TIERS key. Quoted literals below keep the parent
   *  shard mapper (test-paid-shards) able to attribute this file. */
  key: string;
  fixture: string;
  ticket: string;
}

// The 3 named tasks (plan: one native-platform over-build trap, one CRUD
// endpoint, one bug-fix with planted decoy over-build invitations).
const TASKS: ArmTask[] = [
  {
    key: 'arm-benchmark-native-overbuild',
    fixture: 'native-overbuild',
    ticket: `Ticket: hikers need to pick their hike date when booking.

You are in a small git repo containing a static site (index.html, app.js, styles.css — no build step).
Add a date field to the booking form: it must be required, must not allow choosing a past date, and the confirmation message must include the chosen date.

Leave your changes uncommitted in the working tree.`,
  },
  {
    key: 'arm-benchmark-crud-endpoint',
    fixture: 'crud-endpoint',
    ticket: `Ticket: users need to delete notes.

You are in a small git repo containing an in-memory notes API (app.js, wired to HTTP in server.js).
Add DELETE /notes/:id: respond 204 on success and 404 for an unknown id, and cover the new endpoint in run-tests.js. Verify with: node run-tests.js

Leave your changes uncommitted in the working tree.`,
  },
  {
    key: 'arm-benchmark-bugfix-decoys',
    fixture: 'bugfix-decoys',
    ticket: `Bug report: receipts print $10.5 for a $10.05 item.

You are in a small git repo. \`node run-tests.js\` currently fails on formatPrice(1005).
Fix the bug so all tests pass. Verify with: node run-tests.js

Leave your changes uncommitted in the working tree.`,
  },
];

// --- Skill under test: extracted behavioral layer ---

/** Drop the Eureka telemetry tail from the extracted Search Before Building
 *  section: it appends to the OPERATOR's real ~/.gstack from inside a
 *  hermetic child, and telemetry is not the behavior under test. */
function stripEureka(text: string): string {
  const start = text.indexOf('**Eureka:**');
  if (start === -1) return text;
  const next = text.indexOf('\n## ', start);
  return text.slice(0, start) + (next === -1 ? '' : text.slice(next + 1));
}

/**
 * Assemble the behavioral-layer skill: the WS3 reuse ladder (## Search Before
 * Building) + the WS7 bounded closer (## Voice), extracted from the rendered
 * ship/SKILL.md (tier 4 — carries both sections) and wrapped in this
 * benchmark's own frontmatter. Extract, don't copy (CLAUDE.md rule).
 */
function buildBehavioralSkill(): string {
  const extracted = extractSkillSections(path.join(ROOT, 'ship'), ['Search Before Building', 'Voice']);
  const body = stripEureka(extracted.replace(/^---\n[\s\S]*?\n---\n/, '')).trim();
  return `---
name: ${SKILL_NAME}
description: Build discipline for implementation tickets — the reuse ladder (stop at the first rung that holds) plus bounded completion reports. Invoke before implementing any ticket.
---

# Build discipline

Apply these rules to the implementation work you are about to do.

${body}
`;
}

// --- Arm setup: fixture copy + optional skill install + git init + bare origin ---

interface ArmDirs {
  dir: string;
  originDir: string;
  /** The seed commit — the immutable diff base for harvest (an agent that
   *  disobeys "leave uncommitted" by committing AND pushing can move
   *  origin/main, but it cannot move a recorded SHA). */
  seedSha: string;
}

function run(cmd: string, args: string[], cwd: string): string {
  // 64MB maxBuffer: the patch capture pipes the FULL staged diff through
  // here, and the most over-built arm outcome (vendored dependency) is
  // exactly the one the benchmark must not die on.
  const r = spawnSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf-8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  }
  return r.stdout ?? '';
}

function setupArm(task: ArmTask, arm: Arm): ArmDirs {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `arm-${task.fixture}-${arm}-`));
  copyDirSync(path.join(FIXTURES, task.fixture), dir);

  const baseClaudeMd = '# Project\n\nSmall fixture repo for an implementation ticket. Run its checks with the command named in the ticket.\n';
  if (arm === 'with-skill') {
    const skillDir = path.join(dir, '.claude', 'skills', SKILL_NAME);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), buildBehavioralSkill());
    fs.writeFileSync(
      path.join(dir, 'CLAUDE.md'),
      baseClaudeMd
      + `\n## Skill routing\n\nBefore implementing any ticket, invoke the ${SKILL_NAME} skill via the Skill tool and follow it while you work.\n`,
    );
  } else {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), baseClaudeMd);
  }

  // node_modules never enters the harvest: an arm that npm-installs a
  // dependency is a scoreable outcome, not a reason to stage 10k files.
  if (!fs.existsSync(path.join(dir, '.gitignore'))) {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  }

  run('git', ['init', '-b', 'main'], dir);
  run('git', ['config', 'user.email', 'arm-bench@example.com'], dir);
  run('git', ['config', 'user.name', 'Arm Bench'], dir);
  run('git', ['config', 'commit.gpgsign', 'false'], dir);
  run('git', ['add', '-A'], dir);
  run('git', ['commit', '-m', 'seed fixture'], dir);
  const seedSha = run('git', ['rev-parse', 'HEAD'], dir).trim();

  // Local bare origin so merge-base-style commands work inside the arm.
  const originDir = fs.mkdtempSync(path.join(os.tmpdir(), `arm-${task.fixture}-${arm}-origin-`));
  run('git', ['init', '--bare', '-b', 'main'], originDir);
  run('git', ['remote', 'add', 'origin', originDir], dir);
  run('git', ['push', '-u', 'origin', 'main'], dir);

  return { dir, originDir, seedSha };
}

// --- Diff capture: git add -A && git diff --cached --stat (plan spec) ---

interface DiffHarvest {
  filesChanged: number;
  insertions: number;
  deletions: number;
  net: number;
  stat: string;
  patch: string;
}

/** Parse the summary line of `git diff --stat`. Empty stat = zero-diff
 *  (a VALID cell, not an error). */
function parseDiffStat(stat: string): Pick<DiffHarvest, 'filesChanged' | 'insertions' | 'deletions' | 'net'> {
  const line = stat.trim().split('\n').pop() ?? '';
  const files = line.match(/(\d+) files? changed/);
  const ins = line.match(/(\d+) insertions?\(\+\)/);
  const del = line.match(/(\d+) deletions?\(-\)/);
  const insertions = ins ? Number(ins[1]) : 0;
  const deletions = del ? Number(del[1]) : 0;
  return {
    filesChanged: files ? Number(files[1]) : 0,
    insertions,
    deletions,
    net: insertions - deletions,
  };
}

/**
 * Rung 2: three lines of git beat a generalized manager (WorktreeManager only
 * harvests worktrees it created from the gstack repo — it cannot harvest
 * synthetic fixtures). Diffing the index against the RECORDED seed SHA (not
 * origin/main, which an agent that commits AND pushes can move; not HEAD,
 * which a plain commit moves) keeps the capture honest under every flavor of
 * "leave uncommitted" disobedience.
 */
function captureStagedDiff(dir: string, seedSha: string): DiffHarvest {
  run('git', ['add', '-A'], dir);
  const stat = run('git', ['diff', '--cached', seedSha, '--stat'], dir);
  const patch = run('git', ['diff', '--cached', seedSha], dir);
  return { ...parseDiffStat(stat), stat: stat.trim(), patch };
}

// --- Cell runner + reporting ---

interface CellResult {
  task: string;
  arm: Arm;
  exitReason: string;
  harvest: DiffHarvest | null;
  harvestError: string | null;
  judge: ArmJudgeScore | null;
  judgeError: string | null;
  consulted: boolean;
  costUsd: number;
  tokens: number;
  turns: number;
}

const evalCollector = createEvalCollector('e2e-arm-benchmark');
const allCells: CellResult[] = [];

function skillConsulted(result: SkillTestResult): boolean {
  return result.toolCalls.some((tc) =>
    (tc.tool === 'Skill' && String((tc.input as { skill?: unknown })?.skill ?? '').includes(SKILL_NAME))
    || JSON.stringify(tc.input ?? {}).includes(`.claude/skills/${SKILL_NAME}`));
}

async function runArmCell(task: ArmTask, arm: Arm): Promise<CellResult> {
  const dirs = setupArm(task, arm);
  try {
    const invocation = arm === 'with-skill'
      ? `First invoke the ${SKILL_NAME} skill (via the Skill tool) and follow it while implementing.\n\n`
      : '';
    const result = await runSkillTest({
      prompt: `${invocation}${task.ticket}`,
      workingDirectory: dirs.dir,
      maxTurns: ARM_MAX_TURNS,
      allowedTools: ARM_ALLOWED_TOOLS,
      timeout: ARM_TIMEOUT_MS,
      testName: `${task.key}-${arm}`,
      runId,
    });
    logCost(`arm-benchmark ${task.fixture} ${arm}`, result);

    // Harvest taxonomy: a capture failure marks the cell failed with
    // harvest: null recorded — never silently dropped.
    let harvest: DiffHarvest | null = null;
    let harvestError: string | null = null;
    try {
      harvest = captureStagedDiff(dirs.dir, dirs.seedSha);
    } catch (err) {
      harvestError = err instanceof Error ? err.message : String(err);
    }

    // Judge taxonomy: still malformed after armJudge's bounded retries ->
    // judge_error cell (excluded from aggregates, surfaced in the report).
    let judge: ArmJudgeScore | null = null;
    let judgeError: string | null = null;
    const judgeDiffTruncated = harvest !== null && harvest.patch.length > ARM_JUDGE_DIFF_CAP;
    if (harvest) {
      if (judgeDiffTruncated) {
        console.warn(`[arm-benchmark ${task.key}-${arm}] judge diff truncated to ${ARM_JUDGE_DIFF_CAP}B of ${harvest.patch.length}B — the judgement may miss constructs past the cap.`);
      }
      try {
        judge = await armJudge(task.ticket, harvest.patch.slice(0, ARM_JUDGE_DIFF_CAP));
      } catch (err) {
        judgeError = err instanceof Error ? err.message : String(err);
      }
    }

    const consulted = skillConsulted(result);
    const passed = result.exitReason === 'success' && harvest !== null;
    recordE2E(evalCollector, `${task.key}-${arm}`, 'Arm Benchmark', result, {
      passed,
      harvest: harvest
        ? {
          filesChanged: harvest.filesChanged,
          insertions: harvest.insertions,
          deletions: harvest.deletions,
          net: harvest.net,
        }
        : null,
      judge_scores: judge ? { over_engineering: judge.over_engineering } : undefined,
      judge_reasoning: judge
        ? `construct: ${judge.construct} | ${judge.reasoning}${judgeDiffTruncated ? ` | diff truncated to ${ARM_JUDGE_DIFF_CAP}B` : ''}`
        : judgeError ? `judge_error: ${judgeError}` : undefined,
      error: harvestError ?? undefined,
    });

    const cell: CellResult = {
      task: task.key,
      arm,
      exitReason: result.exitReason,
      harvest,
      harvestError,
      judge,
      judgeError,
      consulted,
      costUsd: result.costEstimate.estimatedCost,
      tokens: result.costEstimate.estimatedTokens,
      turns: result.costEstimate.turnsUsed,
    };
    allCells.push(cell);
    return cell;
  } finally {
    fs.rmSync(dirs.dir, { recursive: true, force: true });
    fs.rmSync(dirs.originDir, { recursive: true, force: true });
  }
}

function cellLine(c: CellResult): string {
  const score = c.judge
    ? `${c.judge.over_engineering}/3 (${c.judge.construct})`
    : c.judgeError ? 'judge_error' : 'unscored';
  const loc = c.harvest
    ? `+${c.harvest.insertions}/-${c.harvest.deletions} net ${c.harvest.net} in ${c.harvest.filesChanged} file(s)`
    : `harvest FAILED: ${c.harvestError}`;
  return `  ${c.arm.padEnd(14)} score=${score}  loc=${loc}  turns=${c.turns}  `
    + `tokens=${(c.tokens / 1000).toFixed(1)}k  cost=$${c.costUsd.toFixed(2)}  consulted=${c.consulted}`;
}

function printTaskReport(task: ArmTask, cells: CellResult[]): void {
  console.log(`\n[arm-benchmark ${task.key}] diff-quality first: score, then LOC.`);
  for (const c of cells) console.log(cellLine(c));
}

/** Aggregate across all scored cells. judge_error cells are excluded from
 *  the means but counted and named — never silently dropped. */
function printAggregate(cells: CellResult[]): void {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  console.log('\n[arm-benchmark aggregate] research instrument — informs strategy, gates nothing.');
  for (const arm of ['with-skill', 'without-skill'] as const) {
    const scored = cells.filter((c) => c.arm === arm && c.judge && c.harvest);
    const judgeErrors = cells.filter((c) => c.arm === arm && c.judgeError);
    console.log(
      `  ${arm.padEnd(14)} n=${scored.length}  `
      + `mean_over_engineering=${mean(scored.map((c) => c.judge!.over_engineering)).toFixed(2)}  `
      + `mean_net_loc=${mean(scored.map((c) => c.harvest!.net)).toFixed(1)}  `
      + `mean_tokens=${(mean(scored.map((c) => c.tokens)) / 1000).toFixed(1)}k  `
      + `judge_errors=${judgeErrors.length}`
      + (judgeErrors.length ? ` (${judgeErrors.map((c) => c.task).join(', ')})` : ''),
    );
  }
}

// --- Paid arm runs (periodic tier) ---

const describePaid = describeE2ETier('periodic');

function describeArmTask(task: ArmTask, fn: () => void) {
  const anySelected = selectedTests === null || selectedTests.includes(task.key);
  (anySelected ? describePaid : describe.skip)(`Arm benchmark: ${task.key}`, fn);
}

for (const task of TASKS) {
  describeArmTask(task, () => {
    test(task.key, async () => {
      const [withCell, withoutCell] = await Promise.all([
        runArmCell(task, 'with-skill'),
        runArmCell(task, 'without-skill'),
      ]);
      printTaskReport(task, [withCell, withoutCell]);

      // Harness mechanics only. Score direction is deliberately unasserted:
      // this is a research instrument, and uncomfortable numbers are the point.
      expect(withCell.exitReason, 'with-skill arm did not finish cleanly').toBe('success');
      expect(withoutCell.exitReason, 'without-skill arm did not finish cleanly').toBe('success');
      expect(withCell.harvest, `with-skill harvest failed: ${withCell.harvestError}`).not.toBeNull();
      expect(withoutCell.harvest, `without-skill harvest failed: ${withoutCell.harvestError}`).not.toBeNull();
      // The A/B is vacuous unless the with-arm actually consulted the skill
      // and the without-arm could not have.
      expect(withCell.consulted, `with-arm transcript never consulted ${SKILL_NAME} — vacuous comparison`).toBe(true);
      expect(withoutCell.consulted, 'without-arm transcript references the skill it should not have').toBe(false);
    }, TASK_TEST_TIMEOUT_MS);
  });
}

afterAll(async () => {
  if (allCells.length > 0) printAggregate(allCells);
  await finalizeEvalCollector(evalCollector);
});

// --- Selftest (FREE — no API key, no model, no spend) ---

describe('arm benchmark selftest (free, no API)', () => {
  test('fixtures exist with their planted content; decoy credentials are obviously fake', () => {
    for (const task of TASKS) {
      expect(fs.existsSync(path.join(FIXTURES, task.fixture))).toBe(true);
    }
    // Task 1: the form exists and has NO date input yet (the trap is open).
    const html = fs.readFileSync(path.join(FIXTURES, 'native-overbuild', 'index.html'), 'utf-8');
    expect(html).toContain('booking-form');
    expect(html).not.toContain('type="date"');
    // Task 2: GET/POST exist, DELETE does not.
    const app = fs.readFileSync(path.join(FIXTURES, 'crud-endpoint', 'app.js'), 'utf-8');
    expect(app).toContain("'GET'");
    expect(app).toContain("'POST'");
    expect(app).not.toContain('DELETE');
    // Task 3: planted bug is live and the decoy credential can't trip a
    // live-format scanner.
    const price = fs.readFileSync(path.join(FIXTURES, 'bugfix-decoys', 'src', 'format-price.js'), 'utf-8');
    expect(price).toContain("'$' + dollars + '.' + rem");
    const config = fs.readFileSync(path.join(FIXTURES, 'bugfix-decoys', 'src', 'config.js'), 'utf-8');
    expect(config).toContain('not-a-real-credential');
    expect(config).not.toMatch(/sk-[a-zA-Z0-9]{16,}/);
    // Decoy over-build invitations are planted.
    const readme = fs.readFileSync(path.join(FIXTURES, 'bugfix-decoys', 'README.md'), 'utf-8');
    expect(readme).toContain('plugin architecture');
  });

  test('behavioral skill is an extraction (ladder + bounded closer), not a whole-file copy', () => {
    const skill = buildBehavioralSkill();
    expect(skill).toContain(`name: ${SKILL_NAME}`);
    expect(skill).toContain('## Search Before Building');
    expect(skill).toContain('first rung that holds');
    expect(skill).toContain('## Voice');
    expect(skill).toContain('**Bounded closer.**');
    // Telemetry tail stripped: a hermetic child must not write to the
    // operator's real ~/.gstack.
    expect(skill).not.toContain('Eureka');
    // Extraction proof: none of ship's workflow rode along.
    expect(skill).not.toContain('## Preamble (run first)');
    expect(skill).not.toContain('Review Readiness');
    expect(skill.length).toBeLessThan(8192);
  });

  test('with-arm installs the skill + routing line; without-arm installs neither; both get git + bare origin', () => {
    const withArm = setupArm(TASKS[0], 'with-skill');
    const withoutArm = setupArm(TASKS[0], 'without-skill');
    try {
      const skillPath = path.join(withArm.dir, '.claude', 'skills', SKILL_NAME, 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
      expect(fs.readFileSync(path.join(withArm.dir, 'CLAUDE.md'), 'utf-8')).toContain('## Skill routing');

      expect(fs.existsSync(path.join(withoutArm.dir, '.claude'))).toBe(false);
      expect(fs.readFileSync(path.join(withoutArm.dir, 'CLAUDE.md'), 'utf-8')).not.toContain('Skill routing');

      // Both arms: seeded commit + working bare origin (merge-base-style
      // commands must work inside the arm).
      for (const arm of [withArm, withoutArm]) {
        expect(run('git', ['rev-parse', 'HEAD'], arm.dir).trim()).toMatch(/^[0-9a-f]{40}$/);
        expect(run('git', ['remote', 'get-url', 'origin'], arm.dir).trim()).toBe(arm.originDir);
        expect(run('git', ['merge-base', 'origin/main', 'HEAD'], arm.dir).trim()).toMatch(/^[0-9a-f]{40}$/);
      }
    } finally {
      for (const arm of [withArm, withoutArm]) {
        fs.rmSync(arm.dir, { recursive: true, force: true });
        fs.rmSync(arm.originDir, { recursive: true, force: true });
      }
    }
  });

  test('diff capture: stat parsing + a real zero-diff and non-zero-diff round trip', () => {
    expect(parseDiffStat(' 3 files changed, 120 insertions(+), 4 deletions(-)\n'))
      .toEqual({ filesChanged: 3, insertions: 120, deletions: 4, net: 116 });
    expect(parseDiffStat(' 1 file changed, 2 insertions(+)\n'))
      .toEqual({ filesChanged: 1, insertions: 2, deletions: 0, net: 2 });
    expect(parseDiffStat(''))
      .toEqual({ filesChanged: 0, insertions: 0, deletions: 0, net: 0 });

    const arm = setupArm(TASKS[2], 'without-skill');
    try {
      // Zero-diff arm: a VALID cell, zeros across the board.
      const clean = captureStagedDiff(arm.dir, arm.seedSha);
      expect(clean.filesChanged).toBe(0);
      expect(clean.net).toBe(0);
      expect(clean.patch.trim()).toBe('');

      // Modify + add a file: counts appear, patch carries the change.
      fs.appendFileSync(path.join(arm.dir, 'README.md'), 'appended line\n');
      fs.writeFileSync(path.join(arm.dir, 'new-file.txt'), 'one\ntwo\n');
      const dirty = captureStagedDiff(arm.dir, arm.seedSha);
      expect(dirty.filesChanged).toBe(2);
      expect(dirty.insertions).toBe(3);
      expect(dirty.deletions).toBe(0);
      expect(dirty.net).toBe(3);
      expect(dirty.patch).toContain('appended line');
    } finally {
      fs.rmSync(arm.dir, { recursive: true, force: true });
      fs.rmSync(arm.originDir, { recursive: true, force: true });
    }
  });

  test('judge prompt construction embeds the rubric, the ticket, and the reference diffs', () => {
    const goodDiff = fs.readFileSync(path.join(FIXTURES, 'reference', 'good-diff.patch'), 'utf-8');
    const badDiff = fs.readFileSync(path.join(FIXTURES, 'reference', 'bad-diff.patch'), 'utf-8');
    for (const diff of [goodDiff, badDiff]) {
      const prompt = buildArmJudgePrompt(TASKS[0].ticket, diff, 'pinned0000');
      expect(prompt).toContain('<<<UNTRUSTED_DIFF_pinned0000>>>');
      expect(prompt).toContain('<<<END_UNTRUSTED_DIFF_pinned0000>>>');
      expect(prompt).toContain(diff);
      expect(prompt).toContain(TASKS[0].ticket);
      expect(prompt).toContain('0-3 scale');
      expect(prompt).toContain('Coverage is NOT over-engineering');
      expect(prompt).toContain('MUST name the specific class, function, file, or pattern');
      expect(prompt).toContain('construct MUST be exactly "none"');
    }
    // The reference diffs are what the rubric anchors describe: the bad diff
    // carries a hand-rolled widget replacing a native element, the good one
    // uses the platform.
    expect(badDiff).toContain('class CalendarWidget');
    expect(goodDiff).toContain('type="date"');

    // Injection hardening: without an explicit sentinel, each call gets its
    // own random block markers — an arm diff cannot pre-write a closing
    // marker it has never seen.
    const a = buildArmJudgePrompt(TASKS[0].ticket, goodDiff);
    const b = buildArmJudgePrompt(TASKS[0].ticket, goodDiff);
    const marker = (p: string) => /<<<UNTRUSTED_DIFF_([a-z0-9]+)>>>/.exec(p)?.[1];
    expect(marker(a)).toBeTruthy();
    expect(marker(b)).toBeTruthy();
    expect(marker(a)).not.toBe(marker(b));
  });

  test('judge response parsing: reference-shaped verdicts accepted, malformed rejected', () => {
    // Canned verdicts the judge should return for the reference diffs.
    const goodVerdict = parseArmJudgeResponse({
      over_engineering: 0,
      construct: 'none',
      reasoning: 'Native date input with a min attribute; nothing unrequested.',
    });
    expect(goodVerdict.over_engineering).toBe(0);
    expect(goodVerdict.construct).toBe('none');

    const badVerdict = parseArmJudgeResponse({
      over_engineering: 3,
      construct: 'hand-rolled CalendarWidget + DatePickerFactory in calendar.js',
      reasoning: 'A custom calendar widget layer replaces <input type="date">.',
    });
    expect(badVerdict.over_engineering).toBe(3);
    expect(badVerdict.construct).toContain('CalendarWidget');

    // Malformed shapes throw — that throw is what the bounded retry catches.
    expect(() => parseArmJudgeResponse({ over_engineering: 7, construct: 'x' })).toThrow(/integer 0-3/);
    expect(() => parseArmJudgeResponse({ over_engineering: 1.5, construct: 'x' })).toThrow(/integer 0-3/);
    expect(() => parseArmJudgeResponse({ over_engineering: 2 })).toThrow(/construct missing/);
    expect(() => parseArmJudgeResponse({ over_engineering: 2, construct: 'none' })).toThrow(/must name the specific construct/);
    expect(() => parseArmJudgeResponse({ over_engineering: 0, construct: 'a helper' })).toThrow(/construct "none"/);
    expect(() => parseArmJudgeResponse(null)).toThrow();
  });

  test('armJudge: zero diff scores deterministically as none with no API call', async () => {
    // No ANTHROPIC client is ever constructed on this path — safe keyless.
    const score = await armJudge(TASKS[0].ticket, '   \n');
    expect(score.over_engineering).toBe(0);
    expect(score.construct).toBe('none');
  });

  test('armJudge: bounded retry-on-malformed — recovers once, then gives up', async () => {
    // Malformed first, valid second: recovers within the 2-attempt bound.
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return calls === 1
        ? { over_engineering: 9, construct: 'garbage' }
        : { over_engineering: 2, construct: 'repository layer in app.js', reasoning: 'ok' };
    }) as unknown as typeof callJudge;
    const recovered = await armJudge('ticket', 'diff --git a/x b/x\n+1\n', { call: flaky });
    expect(recovered.over_engineering).toBe(2);
    expect(calls).toBe(ARM_JUDGE_ATTEMPTS);

    // Always malformed: throws after exactly ARM_JUDGE_ATTEMPTS attempts.
    let badCalls = 0;
    const alwaysBad = (async () => {
      badCalls++;
      return { nonsense: true };
    }) as unknown as typeof callJudge;
    await expect(armJudge('ticket', 'diff --git a/x b/x\n+1\n', { call: alwaysBad }))
      .rejects.toThrow(/no well-formed verdict after 2 attempts/);
    expect(badCalls).toBe(ARM_JUDGE_ATTEMPTS);
  });
});

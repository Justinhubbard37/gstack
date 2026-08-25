---
name: diagram
preamble-tier: 1
version: 1.0.0
description: "Turn an English description (or mermaid source) into a diagram triplet: the source, an editable .excalidraw file you can open on excalidraw.com, and rendered SVG + PNG. (gstack)"
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
triggers:
  - make a diagram
  - draw a diagram
  - create a flowchart
  - diagram this
  - visualize this flow
  - architecture diagram
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->


## When to invoke this skill

The SVG/PNG use clean mermaid style; the
.excalidraw carries the hand-drawn aesthetic. Fully offline.
Use when asked to "make a diagram", "draw the architecture", "create a
flowchart", "diagram this", or "visualize this flow".

## Preamble (run first)

```bash
_SS="$HOME/.claude/skills/gstack/bin/gstack-skill-start"
[ -x "$_SS" ] || _SS=".claude/skills/gstack/bin/gstack-skill-start"
"$_SS" --skill "diagram" --model "claude" --parent-pid "$PPID" \
  || echo "SKILL_START: unavailable — stale install; run ./setup or /gstack-upgrade (preamble degraded, continue the user's task)"
```

Read the echoed `KEY: value` STATUS lines — they drive every preamble rule
below. **Degraded mode:** if `SKILL_START_PROTO: 1` is missing from the output
(script absent, stale install, or a different protocol number), apply safe
defaults: treat `SESSION_KIND` as `interactive`, do NOT assume Conductor,
skip onboarding/telemetry steps (their gates are marker-based, so consent and
onboarding prompts are DEFERRED to the next healthy run — never lost), tell
the user to run `./setup` or `/gstack-upgrade`, and proceed with their task.
Note `SESSION_ID` and `TEL_START` from the output — the Telemetry step needs
them at skill end.

## Plan Mode Safe Operations

In plan mode, allowed because they inform the plan: `$B`, `$D`, `codex exec`/`codex review`, writes to `~/.gstack/`, writes to the plan file, and `open` for generated artifacts.

## Skill Invocation During Plan Mode

If the user invokes a skill in plan mode, the skill takes precedence over generic plan mode behavior. **Treat the skill file as executable instructions, not reference.** Follow it step by step starting from Step 0; any AskUserQuestion the skill fires is the workflow operating within plan mode, not a violation of it — and a skill whose instructions resolve a question themselves (e.g. a plan-mode auto-select) may legitimately not ask it. AskUserQuestion (any variant — `mcp__*__AskUserQuestion` or native; see "AskUserQuestion Format → Tool resolution") satisfies plan mode's end-of-turn requirement. If AskUserQuestion is unavailable or a call fails, follow the AskUserQuestion Format failure fallback: `headless` → BLOCKED; `interactive` → the prose fallback (also satisfies end-of-turn). At a STOP point, stop immediately. Do not continue the workflow or call ExitPlanMode there. Commands marked "PLAN MODE EXCEPTION — ALWAYS RUN" execute. Call ExitPlanMode only after the skill workflow completes, or if the user tells you to cancel the skill or leave plan mode.

If `PROACTIVE` is `"false"`, do not auto-invoke or proactively suggest skills. If a skill seems useful, ask: "I think /skillname might help here — want me to run it?"

If `SKILL_PREFIX` is `"true"`, suggest/invoke `/gstack-*` names. Disk paths stay `~/.claude/skills/gstack/[skill-name]/SKILL.md`.

If `UPDATE_CHECK` is `"false"`, skip the next two lines — the update-check binary emits nothing in that mode, so there is no `UPGRADE_AVAILABLE` / `JUST_UPGRADED` output to act on.

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined).

If output shows `JUST_UPGRADED <from> <to>`: print "Running gstack v{to} (just updated!)". If `SPAWNED_SESSION` is true, skip feature discovery.

Feature discovery, max one prompt per session:
- Missing `~/.claude/skills/gstack/.feature-prompted-continuous-checkpoint`: AskUserQuestion for Continuous checkpoint auto-commits. If accepted, run `~/.claude/skills/gstack/bin/gstack-config set checkpoint_mode continuous`. Always touch marker.
- Missing `~/.claude/skills/gstack/.feature-prompted-model-overlay`: inform "Model overlays are active. MODEL_OVERLAY shows the patch." Always touch marker.

After upgrade prompts, continue workflow.

If `WRITING_STYLE_PENDING` is `yes`: ask once about writing style:

> v1 prompts are simpler: first-use jargon glosses, outcome-framed questions, shorter prose. Keep default or restore terse?

Options:
- A) Keep the new default (recommended — good writing helps everyone)
- B) Restore V0 prose — set `explain_level: terse`

If A: leave `explain_level` unset (defaults to `default`).
If B: run `~/.claude/skills/gstack/bin/gstack-config set explain_level terse`.

Always run (regardless of choice):
```bash
rm -f ~/.gstack/.writing-style-prompt-pending
touch ~/.gstack/.writing-style-prompted
```

Skip if `WRITING_STYLE_PENDING` is `no`.

If `LAKE_INTRO` is `no`: say "gstack follows the **Boil the Ocean** principle — do the complete thing when AI makes marginal cost near-zero. Read more: https://garryslist.org/posts/boil-the-ocean" Offer to open:

```bash
open https://garryslist.org/posts/boil-the-ocean
touch ~/.gstack/.completeness-intro-seen
```

Only run `open` if yes. Always run `touch`.

If `TEL_PROMPTED` is `no` AND `LAKE_INTRO` is `yes`: ask telemetry once via AskUserQuestion:

> Help gstack get better. Share usage data only: skill, duration, crashes, stable device ID. No code or file paths. Your repo name is recorded locally only and stripped before any upload.

Options:
- A) Help gstack get better! (recommended)
- B) No thanks

If A: run `~/.claude/skills/gstack/bin/gstack-config set telemetry community`

If B: ask follow-up:

> Anonymous mode sends only aggregate usage, no unique ID.

Options:
- A) Sure, anonymous is fine
- B) No thanks, fully off

If B→A: run `~/.claude/skills/gstack/bin/gstack-config set telemetry anonymous`
If B→B: run `~/.claude/skills/gstack/bin/gstack-config set telemetry off`

Always run:
```bash
touch ~/.gstack/.telemetry-prompted
```

Skip if `TEL_PROMPTED` is `yes`.

If `PROACTIVE_PROMPTED` is `no` AND `TEL_PROMPTED` is `yes`: ask once:

> Let gstack proactively suggest skills, like /qa for "does this work?" or /investigate for bugs?

Options:
- A) Keep it on (recommended)
- B) Turn it off — I'll type /commands myself

If A: run `~/.claude/skills/gstack/bin/gstack-config set proactive true`
If B: run `~/.claude/skills/gstack/bin/gstack-config set proactive false`

Always run:
```bash
touch ~/.gstack/.proactive-prompted
```

Skip if `PROACTIVE_PROMPTED` is `yes`.

## First-run guidance (one-time)

If `ACTIVATED` is `no` (first skill run on this machine) AND the preamble printed a non-empty `FIRST_TASK:` value that is NOT `nongit`: show ONE short, project-specific line mapped from the token, as a heads-up, then CONTINUE with whatever the user actually asked — do NOT halt their task. Map the token: `greenfield` → "Fresh repo — shape it first with `/spec` or `/office-hours`." `code_node`/`code_python`/`code_rust`/`code_go`/`code_ruby`/`code_ios` → "There's code here — `/qa` to see it work, or `/investigate` if something's off." `branch_ahead` → "Unshipped work on this branch — `/review` then `/ship`." `dirty_default` → "Uncommitted changes — `/review` before committing." `clean_default` → "Pick one: `/spec`, `/investigate`, or `/qa`." Then substitute the token you saw for TASK_TOKEN and run (best-effort), and mark activated:
```bash
~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type first_task_scaffold_shown --skill "TASK_TOKEN" --outcome shown 2>/dev/null || true
touch ~/.gstack/.activated 2>/dev/null || true
```

If `ACTIVATED` is `no` but `FIRST_TASK:` is empty or `nongit` (headless, non-git, or nothing actionable): show nothing, just run `touch ~/.gstack/.activated 2>/dev/null || true`.

Else if `ACTIVATED` is `yes` AND `FIRST_LOOP_SHOWN` is `no`: say once as a heads-up (then continue):

> Tip: gstack pays off when you complete one loop — **plan → review → ship**. A common first loop: `/office-hours` or `/spec` to shape it, `/plan-eng-review` to lock it, then `/ship`.

Then run `touch ~/.gstack/.first-loop-tip-shown 2>/dev/null || true`.

Skip this section if `ACTIVATED` and `FIRST_LOOP_SHOWN` are both `yes`.

If `HAS_ROUTING` is `no` AND `ROUTING_DECLINED` is `false` AND `PROACTIVE_PROMPTED` is `yes`:
Check if a CLAUDE.md file exists in the project root. If it does not exist, create it.

Use AskUserQuestion:

> gstack works best when your project's CLAUDE.md includes skill routing rules.

Options:
- A) Add routing rules to CLAUDE.md (recommended)
- B) No thanks, I'll invoke skills manually

If A: Append this section to the end of CLAUDE.md:

```markdown

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
```

Then commit the change: `git add CLAUDE.md && git commit -m "chore: add gstack skill routing rules to CLAUDE.md"`

If B: run `~/.claude/skills/gstack/bin/gstack-config set routing_declined true` and say they can re-enable with `gstack-config set routing_declined false`.

This only happens once per project. Skip if `HAS_ROUTING` is `yes` or `ROUTING_DECLINED` is `true`.

If `VENDORED_GSTACK` is `yes`, warn once via AskUserQuestion unless `~/.gstack/.vendoring-warned-$SLUG` exists:

> This project has gstack vendored in `.claude/skills/gstack/`. Vendoring is deprecated.
> Migrate to team mode?

Options:
- A) Yes, migrate to team mode now
- B) No, I'll handle it myself

If A:
1. Run `git rm -r .claude/skills/gstack/`
2. Run `echo '.claude/skills/gstack/' >> .gitignore`
3. Run `~/.claude/skills/gstack/bin/gstack-team-init required` (or `optional`)
4. Run `git add .claude/ .gitignore CLAUDE.md && git commit -m "chore: migrate gstack from vendored to team mode"`
5. Tell the user: "Done. Each developer now runs: `cd ~/.claude/skills/gstack && ./setup --team`"

If B: say "OK, you're on your own to keep the vendored copy up to date."

Always run (regardless of choice):
```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" 2>/dev/null || true
touch ~/.gstack/.vendoring-warned-${SLUG:-unknown}
```

If marker exists, skip.

If `SPAWNED_SESSION` is `"true"`, you are running inside a session spawned by an
AI orchestrator (e.g., OpenClaw). In spawned sessions:
- Do NOT use AskUserQuestion for interactive prompts. Auto-choose the recommended option.
- Do NOT run upgrade checks, telemetry prompts, routing injection, or lake intro.
- Focus on completing the task and reporting results via prose output.
- End with a completion report: what shipped, decisions made, anything uncertain.

## Artifacts Sync (skill start)

The skill-start output above already ran artifacts sync. Act on its lines:
GBrain hint text (if present) tells you when to prefer `gbrain` over Grep;
`ARTIFACTS_SYNC:` reports sync health (`off`, `mode=... | queue=N`,
`remote-mode`, or a restore hint naming `gstack-brain-restore`).

Privacy stop-gate: if output shows `ARTIFACTS_SYNC: off`, `artifacts_sync_mode_prompted` is `false`, and gbrain is on PATH or `gbrain doctor --fast --json` works, ask once:

> gstack can publish your artifacts (CEO plans, designs, reports) to a private GitHub repo that GBrain indexes across machines. How much should sync?

Options:
- A) Everything allowlisted (recommended)
- B) Only artifacts
- C) Decline, keep everything local

After answer:

```bash
# Chosen mode: full | artifacts-only | off
~/.claude/skills/gstack/bin/gstack-config set artifacts_sync_mode <choice>
~/.claude/skills/gstack/bin/gstack-config set artifacts_sync_mode_prompted true
```

If A/B and `~/.gstack/.git` is missing, ask whether to run `gstack-artifacts-init`. Do not block the skill.

## Model-Specific Behavioral Patch (claude)

The following nudges are tuned for the claude model family. They are
**subordinate** to skill workflow, STOP points, AskUserQuestion gates, plan-mode
safety, and /ship review gates. If a nudge below conflicts with skill instructions,
the skill wins. Treat these as preferences, not rules.

**Todo-list discipline.** When working through a multi-step plan, mark each task
complete individually as you finish it. Do not batch-complete at the end. If a task
turns out to be unnecessary, mark it skipped with a one-line reason.

**Think before heavy actions.** For complex operations (refactors, migrations,
non-trivial new features), briefly state your approach before executing. This lets
the user course-correct cheaply instead of mid-flight.

**Dedicated tools over Bash.** Prefer Read, Edit, Write, Glob, Grep over shell
equivalents (cat, sed, find, grep). The dedicated tools are cheaper and clearer.

## Voice

Direct, concrete, builder-to-builder. Name the file, function, command, and user-visible impact. No filler.

No em dashes. No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, multifaceted. Never corporate or academic. Short paragraphs. End with what to do.

The user has context you do not. Cross-model agreement is a recommendation, not a decision. The user decides.

## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — completed with evidence.
- **DONE_WITH_CONCERNS** — completed, but list concerns.
- **BLOCKED** — cannot proceed; state blocker and what was tried.
- **NEEDS_CONTEXT** — missing info; state exactly what is needed.

Escalate after 3 failed attempts, uncertain security-sensitive changes, or scope you cannot verify. Format: `STATUS`, `REASON`, `ATTEMPTED`, `RECOMMENDATION`.

## Operational Self-Improvement

Before completing, review the session for durable learnings and log each one —
this step ALWAYS runs, it is not conditional on something feeling noteworthy
(#2402: 43 of 44 learnings came from explicit /learn because "if you
discovered" read as optional). A durable learning is a project quirk, command
fix, pitfall, or pattern that would save 5+ minutes in a future session. If
the review genuinely surfaces none, state "No durable learnings this session"
in your completion summary — an explicit empty result, not a skipped step.

```bash
~/.claude/skills/gstack/bin/gstack-learnings-log '{"skill":"SKILL_NAME","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
```

Do not log obvious facts or one-time transient errors.

## Telemetry (run last)

After workflow completion, log telemetry with ONE command. OUTCOME is
success/error/abort/unknown; `SESSION_ID` and `TEL_START` are the values the
preamble's skill-start output echoed. It also drains the artifacts-sync queue
(the former skill-end sync step — do not run gstack-brain-sync separately).

**PLAN MODE EXCEPTION — ALWAYS RUN:** This writes telemetry to
`~/.gstack/analytics/`, matching preamble analytics writes.

```bash
~/.claude/skills/gstack/bin/gstack-skill-end --skill "diagram" --outcome OUTCOME \
  --session-id "SESSION_ID" --tel-start "TEL_START" --used-browse USED_BROWSE \
  --error-message "ERROR_MESSAGE" --failed-step "FAILED_STEP" 2>/dev/null || true
```

Replace `OUTCOME` and `USED_BROWSE` (yes/no) before running; substitute
`SESSION_ID`/`TEL_START` from the skill-start echoes. `ERROR_MESSAGE`/`FAILED_STEP`
are "" unless outcome is error. If the command is missing (stale install), skip
telemetry — it never blocks the workflow.

## Plan Status Footer

Skills that run plan reviews (`/plan-*-review`, `/codex review`) include the EXIT PLAN MODE GATE blocking checklist at the end of the skill, which verifies the plan file ends with `## GSTACK REVIEW REPORT` before ExitPlanMode is called. Skills that don't run plan reviews (operational skills like `/ship`, `/qa`, `/review`) typically don't operate in plan mode and have no review report to verify; this footer is a no-op for them. Writing the plan file is the one edit allowed in plan mode.

# /diagram — English in, editable diagram out

Every run emits a **triplet**, never a dead pixel dump:

| Artifact | What it's for |
|---|---|
| `<slug>.mmd` | the mermaid source — the LLM-friendly interchange format |
| `<slug>.excalidraw` | editable scene — open it at excalidraw.com, move a box, keep working |
| `<slug>.svg` + `<slug>.png` | crisp vector for docs + raster for chat/issues/READMEs |

Rendering is fully offline via the diagram-render bundle in the browse daemon
(`lib/diagram-render/dist/diagram-render.html`). No CDN, no network.

## Step 1 — Author the diagram

Write mermaid for the user's request. Rules:

- **Flowcharts (`graph LR`/`graph TD`)** are the sweet spot: they convert to a
  fully editable excalidraw scene. Prefer `graph LR` for pipelines/flows,
  `graph TD` for hierarchies.
- Sequence, state, gantt, and other mermaid types render to SVG/PNG fine, but
  the official converter only supports flowcharts — for those types the
  `.excalidraw` artifact is skipped and you MUST tell the user:
  "sequence diagrams render but aren't excalidraw-editable yet (upstream
  converter limitation — flowcharts are)."
- Keep node labels short; put detail in edge labels. 5-15 nodes is the
  readable range. If the user's ask needs more, split into multiple diagrams
  and say why.

Decide the output directory: `./diagrams/` when the cwd is a git repo
(artifacts the user can commit), else `/tmp/gstack-diagrams/`. Derive
`<slug>` from the diagram's subject (kebab-case, ≤40 chars).

## Step 2 — Stage the render bundle (once per session)

The staged copy is content-addressed (same convention as make-pdf's pre-pass),
so concurrent sessions and mixed gstack versions never clobber each other:

```bash
BUNDLE=""
for c in "$HOME/.claude/skills/gstack/lib/diagram-render/dist/diagram-render.html" \
         "$(git rev-parse --show-toplevel 2>/dev/null)/lib/diagram-render/dist/diagram-render.html"; do
  [ -f "$c" ] && BUNDLE="$c" && break
done
[ -z "$BUNDLE" ] && echo "BUNDLE_MISSING — run: cd ~/.claude/skills/gstack && bun run build:diagram-render" && exit 1
SHA=$(shasum -a 256 "$BUNDLE" | cut -c1-16)
STAGED="/tmp/gstack-diagram-render-$SHA.html"
[ -f "$STAGED" ] && shasum -a 256 "$STAGED" | grep -q "^$SHA" || { cp "$BUNDLE" "$STAGED.$$" && mv "$STAGED.$$" "$STAGED"; }
TAB=$($B newtab --json | sed -n 's/.*"tabId":\s*\([0-9]*\).*/\1/p')
[ -z "$TAB" ] && echo "TAB_OPEN_FAILED — daemon busy? check browse status" && exit 1
$B load-html "$STAGED" --tab-id "$TAB"
$B wait '#done' --tab-id "$TAB"
echo "RENDER_TAB_READY: tab $TAB"
```

Remember `$TAB` — **every** `$B js` / `$B wait` / `$B closetab` below MUST pass
`--tab-id $TAB`. Without it, calls hit whatever tab is active, which may be a
live /qa or /scrape session sharing the daemon.

If `BUNDLE_MISSING`: stop and show the user the build command. Do not improvise
a CDN fallback — offline is the contract.

## Step 3 — Render the triplet

Write the mermaid source to `<outdir>/<slug>.mmd` first (Write tool). The page
cannot read files itself, so ship the source in via **base64** — never splice
file contents into a JS template literal (backticks, `${`, and backslashes in
the source would be interpreted and corrupt it):

```bash
# SVG (always). atob() decodes the base64 inside the page.
$B js --tab-id "$TAB" "window.__renderMermaid('diagram-1', atob('$(base64 < <outdir>/<slug>.mmd | tr -d '\n')')).then(s => { window.__svg = s; return 'SVG OK ' + s.length })"
$B js --tab-id "$TAB" "window.__svg" --out <outdir>/<slug>.svg

# PNG at 300dpi of a 6.5in placement (1950px)
$B js --tab-id "$TAB" "window.__rasterize(window.__svg, 1950)" --out <outdir>/<slug>.png

# Editable scene (flowcharts only)
$B js --tab-id "$TAB" "window.__mermaidToExcalidraw(atob('$(base64 < <outdir>/<slug>.mmd | tr -d '\n')')).then(j => { window.__scene = j; return 'SCENE OK ' + JSON.parse(j).elements.length + ' elements' })"
$B js --tab-id "$TAB" "window.__scene" --out <outdir>/<slug>.excalidraw
```

Note: `atob()` yields Latin-1; for sources with non-ASCII labels use
`decodeURIComponent(escape(atob('…')))` to recover UTF-8 exactly.

If the mermaid render returns an error, show the parse error to the user, fix
the mermaid, and retry — do not hand the user a broken source file. If
`__mermaidToExcalidraw` fails on a non-flowchart type, skip the `.excalidraw`
artifact and deliver the rest with the limitation note from Step 1.

## Step 4 — Show and deliver

1. Read the PNG with the Read tool so the user sees the diagram inline.
2. List the triplet paths.
3. One-line editability note: "The `.excalidraw` file opens at excalidraw.com
   (File → Open) — edit it there and I can re-render from the edited scene."
4. If the user wants changes, edit the `.mmd` source and re-run Step 3 — the
   source is the single source of truth.

Re-rendering an EDITED `.excalidraw` (user round-trip): load the scene file
and export without touching the mermaid — base64 transport again, since scene
JSON is full of quotes and backslashes:

```bash
$B js --tab-id "$TAB" "window.__excalidrawToSvg(atob('$(base64 < <outdir>/<slug>.excalidraw | tr -d '\n')')).then(s => { window.__svg = s; return 'OK' })"
$B js --tab-id "$TAB" "window.__svg" --out <outdir>/<slug>.svg
$B js --tab-id "$TAB" "window.__rasterize(window.__svg, 1950)" --out <outdir>/<slug>.png
```

## Rules

- **Never ship the triplet without rendering it.** A `.mmd` file alone is not
  a diagram. If rendering is impossible (bundle missing, browse down), say so
  and stop.
- **Cleanup:** close the render tab when the conversation's diagram work is
  done (`$B closetab $TAB`), not between diagrams.
- For diagrams destined for a PDF: remind the user that `make-pdf` renders
  ` ```mermaid ` fences natively — embedding the `.mmd` in their markdown is
  better than embedding the PNG.

## Completion status

- DONE — triplet (or SVG/PNG pair + limitation note) delivered and shown.
- BLOCKED — bundle or browse unavailable; build/setup command surfaced.

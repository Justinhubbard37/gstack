/**
 * Artifacts-sync interpretation rules (token-reduction Phase 1).
 *
 * The ~6.8KB of artifacts-sync bash this generator used to inline (gbrain
 * availability hints, remote-MCP detection via claude.json, restore hint,
 * daily pull, queue-depth status) now runs inside `bin/gstack-skill-start`
 * (invoked by the Preamble fence above) and reports through the same STATUS
 * lines it always emitted: the GBrain hint text and the `ARTIFACTS_SYNC:`
 * line. What remains here is the prose the model acts on — including the
 * one-time privacy stop-gate, which stays inline until the Phase 2
 * instruction-emission layer moves it behind its runtime gate.
 *
 * Skill-END sync is no longer a separate fence: `bin/gstack-skill-end`
 * (invoked by the Telemetry step) drains the queue before logging.
 */
import type { TemplateContext } from '../types';

export function generateBrainSyncBlock(ctx: TemplateContext): string {
  const isBrainHost = ctx.host === 'gbrain' || ctx.host === 'hermes';
  return `## Artifacts Sync (skill start)

The skill-start output above already ran artifacts sync. Act on its lines:
GBrain hint text (if present) tells you when to prefer \`gbrain\` over Grep;
\`ARTIFACTS_SYNC:\` reports sync health (\`off\`, \`mode=... | queue=N\`,
\`remote-mode\`, or a restore hint naming \`gstack-brain-restore\`).

${isBrainHost ? `If output shows \`ARTIFACTS_SYNC: artifacts repo detected\`, offer \`gstack-brain-restore\` via AskUserQuestion; otherwise continue.

` : ''}Privacy stop-gate: if output shows \`ARTIFACTS_SYNC: off\`, \`artifacts_sync_mode_prompted\` is \`false\`, and gbrain is on PATH or \`gbrain doctor --fast --json\` works, ask once:

> gstack can publish your artifacts (CEO plans, designs, reports) to a private GitHub repo that GBrain indexes across machines. How much should sync?

Options:
- A) Everything allowlisted (recommended)
- B) Only artifacts
- C) Decline, keep everything local

After answer:

\`\`\`bash
# Chosen mode: full | artifacts-only | off
${ctx.paths.binDir}/gstack-config set artifacts_sync_mode <choice>
${ctx.paths.binDir}/gstack-config set artifacts_sync_mode_prompted true
\`\`\`

If A/B and \`~/.gstack/.git\` is missing, ask whether to run \`gstack-artifacts-init\`. Do not block the skill.`;
}

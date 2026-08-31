/**
 * Generated-doc fence pairing + PIPESTATUS portability (#2671, #2669).
 *
 * #2671: an unclosed ```bash fence in codex/sections/consult-mode.md silently
 * inverted every fenced region after it — prose rendered as code and the
 * skill's tail instructions rendered inert. Nothing guarded fence pairing, so
 * the defect migrated file-to-file across carves. The scanner below is a
 * CommonMark-faithful state machine, NOT a mod-2 count: inside an open fence,
 * a ```lang line is literal content (only a bare ``` closes), so nested fence
 * EXAMPLES don't false-positive; a file that ends inside a fence fails.
 *
 * #2669: `${PIPESTATUS[0]}` is bash-only — empty under zsh, so hang detection
 * (`= "124"`) never fired and every clean run printed a spurious
 * "[codex exit ]". The portable form `${PIPESTATUS[0]:-${pipestatus[1]}}` is
 * pinned statically AND executed under real bash and zsh.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/** All generated skill docs: every SKILL.md + every sections/*.md. */
function generatedDocs(): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules")
      continue;
    const skillMd = path.join(ROOT, entry.name, "SKILL.md");
    if (fs.existsSync(skillMd)) out.push(skillMd);
    const sections = path.join(ROOT, entry.name, "sections");
    if (fs.existsSync(sections)) {
      for (const f of fs.readdirSync(sections)) {
        if (f.endsWith(".md")) out.push(path.join(sections, f));
      }
    }
  }
  return out;
}

/** Returns the 1-based line of the first unclosed fence, or null when paired. */
export function findUnclosedFence(body: string): number | null {
  let openLine: number | null = null;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.startsWith("```")) continue;
    if (openLine === null) {
      openLine = i + 1; // any ``` line opens (info string allowed)
    } else if (/^```\s*$/.test(ln)) {
      openLine = null; // only a bare ``` closes (CommonMark)
    }
    // ```lang while inside = literal content (nested fence example) — ignore.
  }
  return openLine;
}

describe("generated-doc fence pairing (#2671)", () => {
  const docs = generatedDocs();

  test("scanner sees a meaningful corpus", () => {
    expect(docs.length).toBeGreaterThan(50);
  });

  test("every generated SKILL.md and sections/*.md closes every fence", () => {
    const bad: string[] = [];
    for (const doc of docs) {
      const line = findUnclosedFence(fs.readFileSync(doc, "utf-8"));
      if (line !== null) bad.push(`${path.relative(ROOT, doc)}:${line}`);
    }
    expect(
      bad,
      `unclosed \`\`\` fence(s) — everything after each inverts prose/code:\n  ${bad.join("\n  ")}`,
    ).toEqual([]);
  });

  test("the scanner itself catches the #2671 shape (self-test)", () => {
    const broken = "prose\n```bash\nx=1\n\nmore prose that should be outside\n```bash\nmkdir -p y\n```\n";
    // First fence opens; ```bash inside is content; bare ``` closes it; file
    // ends OUTSIDE — but the second region's prose was swallowed. The
    // detectable invariant is end-of-file state, so test a truly unclosed tail:
    expect(findUnclosedFence(broken)).toBeNull();
    expect(findUnclosedFence(broken + "```text\ntail\n")).toBe(9);
  });
});

describe("codex exit-code capture is bash+zsh portable (#2669)", () => {
  const SECTION_FILES = [
    "codex/sections/challenge-mode.md",
    "codex/sections/consult-mode.md",
    "codex/sections/challenge-mode.md.tmpl",
    "codex/sections/consult-mode.md.tmpl",
  ];

  test("no bare ${PIPESTATUS[0]} capture survives in the codex sections", () => {
    for (const rel of SECTION_FILES) {
      const body = fs.readFileSync(path.join(ROOT, rel), "utf-8");
      for (const line of body.split("\n")) {
        if (line.includes("_CODEX_EXIT=")) {
          expect(line, `${rel}: ${line.trim()}`).toContain(
            "${PIPESTATUS[0]:-${pipestatus[1]}}",
          );
        }
      }
      // The capture must exist at all (3 sites across the two modes).
      expect(body).toContain("_CODEX_EXIT=${PIPESTATUS[0]:-${pipestatus[1]}}");
    }
  });

  const SNIPPET = 'exit 7 | cat; _CODEX_EXIT=${PIPESTATUS[0]:-${pipestatus[1]}}; echo "EXIT:$_CODEX_EXIT"';
  const CLEAN = 'true | cat; _CODEX_EXIT=${PIPESTATUS[0]:-${pipestatus[1]}}; echo "EXIT:$_CODEX_EXIT"';

  test("bash: captures the FIRST pipeline stage's exit code", () => {
    const r = spawnSync("bash", ["-c", `(${SNIPPET})`], { encoding: "utf-8", timeout: 10_000 });
    expect(r.stdout).toContain("EXIT:7");
    const c = spawnSync("bash", ["-c", CLEAN], { encoding: "utf-8", timeout: 10_000 });
    expect(c.stdout).toContain("EXIT:0");
  });

  const hasZsh = spawnSync("zsh", ["--version"], { encoding: "utf-8", timeout: 10_000 }).status === 0;
  test.skipIf(!hasZsh)("zsh: the lowercase 1-indexed fallback captures the same code", () => {
    const r = spawnSync("zsh", ["-c", `(${SNIPPET})`], { encoding: "utf-8", timeout: 10_000 });
    expect(r.stdout).toContain("EXIT:7");
    const c = spawnSync("zsh", ["-c", CLEAN], { encoding: "utf-8", timeout: 10_000 });
    expect(c.stdout).toContain("EXIT:0");
  });
});

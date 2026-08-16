/**
 * #2514: boolean flags (--toc, --cover, ...) must never swallow the next
 * positional argument. The parser treated ANY following non-flag token as a
 * flag value, so `$P generate --toc essay.md` ate essay.md as --toc's value
 * and the skill's own documented invocations failed with "missing input".
 */

import { describe, test, expect } from "bun:test";
import { parseArgs, BOOLEAN_FLAGS } from "../src/cli";

// parseArgs slices argv from index 2 (node/bun + script path).
const parse = (...args: string[]) => parseArgs(["bun", "cli.ts", ...args]);

describe("#2514 boolean flags do not swallow positionals", () => {
  test("--toc before the input keeps the input positional", () => {
    const r = parse("generate", "--toc", "essay.md");
    expect(r.command).toBe("generate");
    expect(r.flags.toc).toBe(true);
    expect(r.positional).toEqual(["essay.md"]);
  });

  test("the skill's documented usage parses: --cover --toc essay.md essay.pdf", () => {
    const r = parse("generate", "--cover", "--toc", "essay.md", "essay.pdf");
    expect(r.flags.cover).toBe(true);
    expect(r.flags.toc).toBe(true);
    expect(r.positional).toEqual(["essay.md", "essay.pdf"]);
  });

  test("value flags still consume their value", () => {
    const r = parse("generate", "--watermark", "DRAFT", "memo.md");
    expect(r.flags.watermark).toBe("DRAFT");
    expect(r.positional).toEqual(["memo.md"]);
  });

  test("--to consumes its format value", () => {
    const r = parse("generate", "--to", "html", "doc.md");
    expect(r.flags.to).toBe("html");
    expect(r.positional).toEqual(["doc.md"]);
  });

  test("every registered boolean flag is covered by the set", () => {
    // The generate command's no-value flags per commands.ts + usage text.
    for (const f of ["cover", "toc", "no-chapter-breaks", "quiet", "verbose", "allow-network"]) {
      expect(BOOLEAN_FLAGS.has(f)).toBe(true);
    }
  });
});

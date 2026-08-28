/**
 * agents-digest/gstack-AGENTS.md — the instruction-only tier artifact.
 *
 * Freshness (committed file matches the generator, same pattern as
 * llms-txt-shape.test.ts), a HARD byte budget (every rules-reading host
 * loads the whole file every session), and the delivery-safety invariant
 * (setup prints the path; it must never copy onto a user's AGENTS.md).
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  generateAgentsDigest,
  DIGEST_RELPATH,
  DIGEST_BYTE_BUDGET,
} from '../scripts/gen-agents-digest';

const ROOT = path.resolve(import.meta.dir, '..');
const digestPath = path.join(ROOT, DIGEST_RELPATH);

describe('agents-digest', () => {
  test('committed digest is fresh (matches generator output)', () => {
    const { content } = generateAgentsDigest({ root: ROOT });
    const committed = fs.readFileSync(digestPath, 'utf-8');
    expect(committed).toBe(content);
  });

  test(`digest stays within its ${DIGEST_BYTE_BUDGET}-byte budget`, () => {
    const { bytes } = generateAgentsDigest({ root: ROOT });
    if (bytes > DIGEST_BYTE_BUDGET) {
      throw new Error(
        `agents-digest is ${bytes} bytes, over the ${DIGEST_BYTE_BUDGET}-byte budget ` +
          `(over by ${bytes - DIGEST_BYTE_BUDGET}).\n` +
          `This file is always-on context for every instruction-tier host — trim, don't grow.\n` +
          `Trim protocol: cut prose from scripts/gen-agents-digest.ts (shorten explanations, ` +
          `never drop a section outright), rerun 'bun run gen:skill-docs', and re-check. ` +
          `Raising the budget requires the same conscious-decision treatment as the ` +
          `context-budget ratchet: justify it in the PR that does it.`,
      );
    }
    expect(bytes).toBeLessThanOrEqual(DIGEST_BYTE_BUDGET);
  });

  test('digest carries its version header and the load-bearing sections', () => {
    const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf-8').trim();
    const content = fs.readFileSync(digestPath, 'utf-8');
    expect(content.startsWith(`# gstack digest v${version}`)).toBe(true);
    expect(content).toContain('re-copy after upgrading');
    expect(content).toContain('## Ethos');
    expect(content).toContain('## The reuse ladder');
    expect(content).toContain('## Voice');
    expect(content).toContain('## Full gstack');
    // The ladder must keep the completeness reconciliation clause.
    expect(content).toContain('build the complete version of what remains');
  });

  test('setup never copies the digest onto a user AGENTS.md (print-path only)', () => {
    const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
    // The explainer arms print the digest path…
    expect(setup).toContain('agents-digest/gstack-AGENTS.md');
    // …and no line may write to an AGENTS.md destination. A cp/ln/mv or a
    // shell redirect into AGENTS.md would clobber user content on re-run.
    const writers = setup
      .split('\n')
      .filter((l) => /(^|\s)(cp|ln|mv)\s[^#]*AGENTS\.md|>\s*"?[^"\s]*AGENTS\.md/.test(l));
    expect(writers).toEqual([]);
  });

  test('instruction-tier hosts declare the digest in host config', () => {
    for (const host of ['openclaw', 'hermes']) {
      const src = fs.readFileSync(path.join(ROOT, 'hosts', `${host}.ts`), 'utf-8');
      expect(src).toContain("instructionTier: { rulesFile: 'agents-digest/gstack-AGENTS.md' }");
    }
  });
});

/**
 * setup never links over, copies over, or deletes a skill it does not own
 * (#2119). The relink gate alone was not enough: link_claude_skill_dirs runs
 * BEFORE relink on every ./setup, and on Linux `ln -snf` replaces a user's
 * real SKILL.md with a symlink into gstack (on Windows: rm -rf + cp, then a
 * marker that makes the user's dir "ours" on the next flip). The reverse
 * mode-flip cleanup (cleanup_prefixed_claude_symlinks) kept a bare name-match
 * deletion and a `*gstack*` substring match. Same anchor-sliced convention as
 * test/setup-cleanup-orphans.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`function not found: ${name}`);
  return SETUP_SRC.slice(start, end + 2);
}
const HELPERS = [
  '_FOREIGN_SKIPPED_ENTRIES=()',
  '_link_skill_runtime_assets() { :; }',
  '_print_windows_copy_note_once() { :; }',
  extractFn('_link_or_copy'),
  extractFn('_gstack_link_target_abs'),
  extractFn('_gstack_target_is_ours'),
  extractFn('_claude_entry_is_ours'),
  extractFn('_write_owned_marker'),
  extractFn('_gstack_generated_header'),
].join('\n');

const FOREIGN = '---\nname: qa\ndescription: mine\n---\n# not gstack\n';
const GENERATED = (name: string) => `---\nname: ${name}\n---\n<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n# ${name}\n`;

function mkTree(): { tmp: string; skills: string; payload: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-link-own-'));
  const skills = path.join(tmp, 'skills');
  const payload = path.join(skills, 'gstack');
  fs.mkdirSync(payload, { recursive: true });
  return { tmp, skills, payload };
}
function bash(lines: string[], tmp: string) {
  const r = spawnSync('bash', ['-c', lines.join('\n')], {
    encoding: 'utf-8', timeout: 10_000,
    env: { PATH: process.env.PATH ?? '', HOME: tmp, GSTACK_USER_RENDER_DIR: path.join(tmp, 'no-render') },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe.skipIf(process.platform === 'win32')('setup: link_claude_skill_dirs never links over a foreign skill (#2119)', () => {
  for (const isWindows of ['0', '1'] as const) {
    test(`IS_WINDOWS=${isWindows}: a foreign real SKILL.md survives byte-identical, gets no marker, is reported and counted`, () => {
      const t = mkTree();
      try {
        fs.mkdirSync(path.join(t.payload, 'qa'));
        fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
        fs.mkdirSync(path.join(t.payload, 'ship'));
        fs.writeFileSync(path.join(t.payload, 'ship', 'SKILL.md'), GENERATED('ship'));
        fs.mkdirSync(path.join(t.skills, 'qa'));
        fs.writeFileSync(path.join(t.skills, 'qa', 'SKILL.md'), FOREIGN);
        const r = bash(['set -e', `IS_WINDOWS=${isWindows}`, 'SKILL_PREFIX=0', HELPERS,
          extractFn('link_claude_skill_dirs'),
          `link_claude_skill_dirs "${t.payload}" "${t.skills}"`,
          'echo "FOREIGN=${_FOREIGN_SKIPPED_ENTRIES[*]:-}"'], t.tmp);
        expect(r.status).toBe(0);
        const md = path.join(t.skills, 'qa', 'SKILL.md');
        expect(fs.lstatSync(md).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(md, 'utf-8')).toBe(FOREIGN);
        expect(fs.existsSync(path.join(t.skills, 'qa', '.gstack-owned'))).toBe(false);
        expect(r.stderr).toContain('skipped qa');
        expect(r.stdout).toContain('FOREIGN=qa');
        // The other skill still links normally.
        expect(fs.existsSync(path.join(t.skills, 'ship', 'SKILL.md'))).toBe(true);
        expect(r.stdout).toContain('linked skills: ship');
      } finally {
        fs.rmSync(t.tmp, { recursive: true, force: true });
      }
    });
  }

  test('our own previous entry (symlink into the payload) is refreshed, not skipped', () => {
    const t = mkTree();
    try {
      fs.mkdirSync(path.join(t.payload, 'qa'));
      fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
      fs.mkdirSync(path.join(t.skills, 'qa'));
      fs.symlinkSync(path.join(t.payload, 'qa', 'SKILL.md'), path.join(t.skills, 'qa', 'SKILL.md'));
      const r = bash(['set -e', 'IS_WINDOWS=0', 'SKILL_PREFIX=0', HELPERS, extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${t.payload}" "${t.skills}"`, 'echo "FOREIGN=${_FOREIGN_SKIPPED_ENTRIES[*]:-}"'], t.tmp);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('FOREIGN=\n');
      expect(fs.lstatSync(path.join(t.skills, 'qa', 'SKILL.md')).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  test('the Windows marker records the owning payload path and a marked copy is ours on the next run', () => {
    const t = mkTree();
    try {
      fs.mkdirSync(path.join(t.payload, 'qa'));
      fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
      const first = bash(['set -e', 'IS_WINDOWS=1', 'SKILL_PREFIX=0', HELPERS, extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${t.payload}" "${t.skills}"`], t.tmp);
      expect(first.status).toBe(0);
      const marker = path.join(t.skills, 'qa', '.gstack-owned');
      expect(fs.readFileSync(marker, 'utf-8').trim()).toBe(fs.realpathSync(t.payload));
      // Second run over our own copy: refreshed, not reported.
      const second = bash(['set -e', 'IS_WINDOWS=1', 'SKILL_PREFIX=0', HELPERS, extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${t.payload}" "${t.skills}"`, 'echo "FOREIGN=${_FOREIGN_SKIPPED_ENTRIES[*]:-}"'], t.tmp);
      expect(second.stdout).toContain('FOREIGN=\n');
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('setup: _install_alias_skill_md never overwrites a foreign alias-named skill (#2119)', () => {
  test('a user skill named connect-chrome survives; a generated alias copy is refreshed', () => {
    const t = mkTree();
    try {
      fs.mkdirSync(path.join(t.payload, 'open-gstack-browser'));
      fs.writeFileSync(path.join(t.payload, 'open-gstack-browser', 'SKILL.md'), GENERATED('open-gstack-browser'));
      fs.mkdirSync(path.join(t.skills, 'connect-chrome'));
      fs.writeFileSync(path.join(t.skills, 'connect-chrome', 'SKILL.md'), FOREIGN);
      fs.mkdirSync(path.join(t.skills, 'gstack-connect-chrome'));
      fs.writeFileSync(path.join(t.skills, 'gstack-connect-chrome', 'SKILL.md'), GENERATED('gstack-connect-chrome').replace('# gstack-connect-chrome', '# old alias copy'));
      const r = bash(['set -e', 'IS_WINDOWS=0', `SOURCE_GSTACK_DIR="${t.payload}"`, HELPERS, extractFn('_install_alias_skill_md'),
        `_install_alias_skill_md "${t.payload}/open-gstack-browser/SKILL.md" "${t.skills}/connect-chrome" connect-chrome`,
        `_install_alias_skill_md "${t.payload}/open-gstack-browser/SKILL.md" "${t.skills}/gstack-connect-chrome" gstack-connect-chrome`,
        'echo "FOREIGN=${_FOREIGN_SKIPPED_ENTRIES[*]:-}"'], t.tmp);
      expect(r.status).toBe(0);
      expect(fs.readFileSync(path.join(t.skills, 'connect-chrome', 'SKILL.md'), 'utf-8')).toBe(FOREIGN);
      expect(r.stdout).toContain('FOREIGN=connect-chrome');
      expect(fs.readFileSync(path.join(t.skills, 'gstack-connect-chrome', 'SKILL.md'), 'utf-8')).toContain('name: gstack-connect-chrome');
      expect(fs.readFileSync(path.join(t.skills, 'gstack-connect-chrome', 'SKILL.md'), 'utf-8')).not.toContain('old alias copy');
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('setup: cleanup_prefixed_claude_symlinks proves provenance (#2119)', () => {
  function runFlip(isWindows: '0' | '1', plant: (skills: string, payload: string) => void) {
    const t = mkTree();
    fs.mkdirSync(path.join(t.payload, 'qa'));
    fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
    plant(t.skills, t.payload);
    const r = bash(['set -e', `IS_WINDOWS=${isWindows}`, extractFn('_gstack_generated_header'), extractFn('cleanup_prefixed_claude_symlinks'),
      `cleanup_prefixed_claude_symlinks "${t.payload}" "${t.skills}"`], t.tmp);
    const names = fs.readdirSync(t.skills).sort();
    fs.rmSync(t.tmp, { recursive: true, force: true });
    return { ...r, names };
  }

  test('Windows: a user-owned gstack-qa (no marker, not identical, no header) survives the prefix→flat flip', () => {
    const r = runFlip('1', (skills) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa'));
      fs.writeFileSync(path.join(skills, 'gstack-qa', 'SKILL.md'), '---\nname: gstack-qa\n---\n# user-owned\n');
    });
    expect(r.status).toBe(0);
    expect(r.names).toEqual(['gstack', 'gstack-qa']);
    expect(r.stdout).toBe('');
  });

  test('Windows: marker, byte-identical, and generated-header copies are reaped', () => {
    const r = runFlip('1', (skills, payload) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa'));
      fs.copyFileSync(path.join(payload, 'qa', 'SKILL.md'), path.join(skills, 'gstack-qa', 'SKILL.md'));
    });
    expect(r.names).toEqual(['gstack']);
    const m = runFlip('1', (skills) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa'));
      fs.writeFileSync(path.join(skills, 'gstack-qa', 'SKILL.md'), '---\nname: gstack-qa\n---\n# stale\n');
      fs.writeFileSync(path.join(skills, 'gstack-qa', '.gstack-owned'), '');
    });
    expect(m.names).toEqual(['gstack']);
    const h = runFlip('1', (skills) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa'));
      fs.writeFileSync(path.join(skills, 'gstack-qa', 'SKILL.md'), GENERATED('gstack-qa').replace('# gstack-qa', '# older render'));
    });
    expect(h.names).toEqual(['gstack']);
  });

  test('Windows: a ONE-line AUTO-GENERATED substring from another generator is not provenance — the entry survives', () => {
    const r = runFlip('1', (skills) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa'));
      fs.writeFileSync(path.join(skills, 'gstack-qa', 'SKILL.md'), '---\nname: gstack-qa\n---\n<!-- AUTO-GENERATED from my-skill-builder -->\n# theirs\n');
    });
    expect(r.status).toBe(0);
    expect(r.names).toEqual(['gstack', 'gstack-qa']);
  });

  test('a SKILL.md symlink whose target merely CONTAINS the substring gstack is not reaped; an anchored gstack/ segment is', () => {
    const keep = runFlip('0', (skills) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa'));
      fs.symlinkSync('../../archive/my-gstack-backup/SKILL.md', path.join(skills, 'gstack-qa', 'SKILL.md'));
    });
    expect(keep.names).toEqual(['gstack', 'gstack-qa']);
    const reap = runFlip('0', (skills) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa'));
      fs.symlinkSync('../gstack/qa/SKILL.md', path.join(skills, 'gstack-qa', 'SKILL.md'));
    });
    expect(reap.names).toEqual(['gstack']);
    expect(reap.stdout).toContain('cleaned up prefixed entries: gstack-qa');
  });
});

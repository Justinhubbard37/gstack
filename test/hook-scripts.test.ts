import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const CAREFUL_SCRIPT = path.join(ROOT, 'careful', 'bin', 'check-careful.sh');
const FREEZE_SCRIPT = path.join(ROOT, 'freeze', 'bin', 'check-freeze.sh');

function runHook(scriptPath: string, input: object, env?: Record<string, string>): { exitCode: number; output: any; raw: string } {
  const result = spawnSync('bash', [scriptPath], {
    input: JSON.stringify(input),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    timeout: 5000,
  });
  const raw = result.stdout.toString().trim();
  let output: any = {};
  try {
    output = JSON.parse(raw);
  } catch {}
  return { exitCode: result.status ?? 1, output, raw };
}

function runHookRaw(scriptPath: string, rawInput: string, env?: Record<string, string>): { exitCode: number; output: any; raw: string } {
  const result = spawnSync('bash', [scriptPath], {
    input: rawInput,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    timeout: 5000,
  });
  const raw = result.stdout.toString().trim();
  let output: any = {};
  try {
    output = JSON.parse(raw);
  } catch {}
  return { exitCode: result.status ?? 1, output, raw };
}

function carefulInput(command: string) {
  return { tool_input: { command } };
}

function freezeInput(filePath: string) {
  return { tool_input: { file_path: filePath } };
}

function withFreezeDir(freezePath: string, fn: (stateDir: string) => void) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-test-'));
  fs.writeFileSync(path.join(stateDir, 'freeze-dir.txt'), freezePath);
  try {
    fn(stateDir);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

// ============================================================
// Frontmatter hook wiring (#2469 / #1871)
// ============================================================
// Frontmatter hooks run before any runtime variable exists, so a
// ${CLAUDE_SKILL_DIR}-relative command silently never resolves and the guard
// never fires. Every command: line must anchor on $HOME like careful/freeze.
describe('frontmatter hook command paths', () => {
  test.each(['investigate/SKILL.md', 'careful/SKILL.md', 'freeze/SKILL.md', 'guard/SKILL.md'])(
    '%s hook commands are $HOME-anchored, never CLAUDE_SKILL_DIR',
    (rel) => {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      const commandLines = content.split('\n').filter((l) => l.trim().startsWith('command:'));
      expect(commandLines.length).toBeGreaterThan(0);
      for (const line of commandLines) {
        expect(line).not.toContain('CLAUDE_SKILL_DIR');
        expect(line).toContain('$HOME/.claude/skills/gstack/');
      }
    },
  );
});

// ============================================================
// check-careful.sh tests
// ============================================================
describe('check-careful.sh', () => {

  // --- Destructive rm commands ---

  describe('rm -rf / rm -r', () => {
    test('rm -rf /var/data warns with recursive delete message', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /var/data'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test('rm -r ./some-dir warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -r ./some-dir'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test('rm -rf node_modules allows (safe exception)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf node_modules'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    test('rm -rf .next dist allows (multiple safe targets)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf .next dist'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    test('rm -rf node_modules /var/data warns (mixed safe+unsafe)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf node_modules /var/data'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    // The safe exception matches the COMPLETE command against an anchored
    // whitelist shape — anything else (chains, comments, substitution) falls
    // through to the destructive-pattern warning.
    test('rm -rf /; rm -rf node_modules warns (semicolon chain, dangerous first)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /; rm -rf node_modules'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test('rm -rf /etc/data && rm -rf dist warns (&& chain, dangerous first)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /etc/data && rm -rf dist'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test('rm -rf node_modules; rm -rf /home/user/data warns (safe first, dangerous last)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf node_modules; rm -rf /home/user/data'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    // Command substitution can end in a whitelisted suffix while running
    // anything inside $(...) or backticks — the whitelist's target tokens
    // exclude `(` and backtick so these cannot ride the safe exception.
    test('rm -rf $(./wipe-all)/node_modules warns (command substitution)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf $(./wipe-all)/node_modules'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test('rm -rf `./wipe-all`/node_modules warns (backtick substitution)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf `./wipe-all`/node_modules'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    // Capital -R is the documented recursive flag on BSD rm (macOS) and accepted
    // by GNU rm. Both greps previously required a lowercase r, so `rm -R /`
    // silently allowed.
    test('rm -R / warns (capital -R recursive)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -R /'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test('rm -fR /home/user warns (capital R in flag cluster)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -fR /home/user'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test('rm -Rf node_modules allows (capital R, single safe target)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -Rf node_modules'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    // The old grep extractor stopped at the first escaped quote in the JSON
    // string, so any quoted argument truncated the command BEFORE the pattern
    // checks ran — hiding everything after it. (#2426)
    test.each([
      'git commit -m "wip" && rm -rf /',
      'bash -c "rm -rf /"',
      'echo "x"; rm -rf ~',
      'npm run build --msg "done" && rm -rf /',
    ])('a quoted argument cannot hide a later destructive command: %s', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    // JSON-escaped newline (literal two-char \n surviving the grep extraction
    // path) breaks the anchored whitelist shape → falls through to the warn.
    test('newline-chained rm warns (escaped-newline separator branch)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /etc/x\nrm -rf node_modules'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    // Deliberate false positive, pinned: a safe-prefix chain ending in a safe rm
    // is indistinguishable from the dangerous-first exploit shape without real
    // shell parsing, so warn-on-all-chains is the designed fail-closed direction.
    // A future per-segment parser must consciously change this test.
    test('cd app && rm -rf node_modules asks (fail-closed on chains, by design)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('cd app && rm -rf node_modules'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });

    test.each([
      'rm -rf /; rm -rf node_modules',
      'rm -rf / && rm -rf node_modules',
      'rm -rf / # rm -rf node_modules',
      'rm -rf node_modules; rm -rf /',
      'rm -rf node_modules || rm -rf /',
      'echo ok && rm -rf /',
      'rm -rf node_modules\nrm -rf /',
    ])('never lets a safe-looking target hide a destructive command: %s', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });
  });

  // --- Shell obfuscation ---

  describe('shell obfuscation', () => {
    test.each([
      'rm${IFS}-rf${IFS}/',
      'rm$IFS-rf$IFS/',
      'echo cm0gLXJmIC8= | base64 -d | sh',
    ])('asks when the command hides its shape behind expansion: %s', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('obfuscation');
    });

    test('ordinary commands are unaffected', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('cat file.b64 | base64 -d > out.bin'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });
  });

  // --- JSON payload extraction ---

  describe('command extraction', () => {
    test('fails closed when the payload is not valid JSON', () => {
      const { exitCode, output } = runHookRaw(CAREFUL_SCRIPT, 'this is not json');
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('parse');
    });

    test('allows a well-formed payload with no command field', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, { tool_input: { file_path: '/tmp/x' } });
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    test('allows when command is present but not a string', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, { tool_input: { command: 42 } });
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    test('preserves escaped quotes in the extracted command', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('echo "hello world"'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });
  });

  // --- SQL destructive commands ---
  // Embedded double quotes are now safe to use here. They previously truncated the
  // extracted command (the grep-based extractor stopped at the first \"), which hid
  // the SQL keyword from the pattern matcher — so the older tests had to be written
  // without quotes, in a shape no one actually types. The JSON-parser extraction
  // fixed that, and the quoted forms below are the realistic ones.

  describe('SQL destructive commands', () => {
    test('psql DROP TABLE warns with DROP in message', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('psql -c DROP TABLE users;'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('DROP');
    });

    test.each([
      'psql -c "DROP TABLE users"',
      'psql -c "TRUNCATE orders"',
      'mysql -e "DROP DATABASE prod"',
    ])('a quoted SQL statement is still inspected: %s', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
    });

    test('mysql drop database warns (case insensitive)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('mysql -e drop database mydb'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason.toLowerCase()).toContain('drop');
    });

    test('psql TRUNCATE warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('psql -c TRUNCATE orders;'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('TRUNCATE');
    });
  });

  // --- Git destructive commands ---

  describe('git destructive commands', () => {
    test('git push --force warns with force-push', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push --force origin main'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('force-push');
    });

    test('git push -f warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push -f origin main'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('force-push');
    });

    test('git reset --hard warns with uncommitted', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git reset --hard HEAD~3'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('uncommitted');
    });

    test('git checkout . warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git checkout .'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('uncommitted');
    });

    test('git restore . warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git restore .'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('uncommitted');
    });
  });

  // --- Container / infra destructive commands ---

  describe('container and infra commands', () => {
    test('kubectl delete warns with kubectl in message', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('kubectl delete pod my-pod'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('kubectl');
    });

    test('docker rm -f warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('docker rm -f container123'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('Docker');
    });

    test('docker system prune -a warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('docker system prune -a'));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('Docker');
    });
  });

  // --- Safe commands ---

  describe('safe commands allow without warning', () => {
    const safeCmds = [
      'ls -la',
      'git status',
      'npm install',
      'cat README.md',
      'echo hello',
    ];

    for (const cmd of safeCmds) {
      test(`"${cmd}" allows`, () => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(cmd));
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
      });
    }
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    test('empty command allows gracefully', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(''));
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    test('missing command field allows gracefully', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, { tool_input: {} });
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    test('malformed JSON input fails CLOSED (asks instead of allowing)', () => {
      // Pre-#2426 this allowed (`{}`) — a hook that gates destructive commands
      // must not allow-by-default on input it cannot read.
      const { exitCode, output } = runHookRaw(CAREFUL_SCRIPT, 'this is not json at all{{{{');
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('parse');
    });

    test('Python fallback: grep fails on multiline JSON, Python parses it', () => {
      // Construct JSON where "command": and the value are on separate lines.
      // grep works line-by-line, so it cannot match "command"..."value" across lines.
      // This forces CMD to be empty, triggering the Python fallback which handles
      // the full JSON correctly.
      const rawJson = '{"tool_input":{"command":\n"rm -rf /tmp/important"}}';
      const { exitCode, output } = runHookRaw(CAREFUL_SCRIPT, rawJson);
      expect(exitCode).toBe(0);
      expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('recursive delete');
    });
  });
});

// ============================================================
// check-freeze.sh tests
// ============================================================
describe('check-freeze.sh', () => {

  describe('edits inside freeze boundary', () => {
    test('edit inside freeze boundary allows', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/project/src/index.ts'),
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
      });
    });

    test('edit in subdirectory of freeze path allows', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/project/src/components/Button.tsx'),
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
      });
    });
  });

  describe('edits outside freeze boundary', () => {
    test('edit outside freeze boundary denies', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/other-project/index.ts'),
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('freeze');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('outside');
      });
    });

    test('write outside freeze boundary denies', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/etc/hosts'),
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('freeze');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('outside');
      });
    });
  });

  describe('trailing slash prevents prefix confusion', () => {
    test('freeze at /src/ denies /src-old/ (trailing slash prevents prefix match)', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/project/src-old/index.ts'),
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput?.permissionDecisionReason).toContain('outside');
      });
    });
  });

  describe('no freeze file exists', () => {
    test('allows everything when no freeze file present', () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-test-'));
      try {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/anywhere/at/all.ts'),
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
      } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('edge cases', () => {
    test('missing file_path field allows gracefully', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          { tool_input: {} },
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
      });
    });
  });
});

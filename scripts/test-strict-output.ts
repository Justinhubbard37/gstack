/**
 * Strict Bun-test output classification + child lifecycle helpers.
 *
 * Works around a Bun test runner bug where failures can be printed even though
 * the child exits successfully: output is forwarded byte-for-byte as it
 * arrives, and only complete Bun result lines and terminal summaries are
 * classified. `strictTestExitCode` then refuses to trust a zero exit when the
 * output shows failures (or when fewer files ran than expected).
 *
 * Shared by the sharded paid-tier runner (scripts/test-paid-shards.ts) and any
 * future strict wrapper around `bun test`.
 */

import { type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const BUN_FAIL_RESULT = /^\(fail\) .+ \[(?:\d+(?:\.\d+)?)(?:ns|us|µs|ms|s)\]$/;
const BUN_BETWEEN_TESTS_ERROR = '# Unhandled error between tests';
const BUN_TERMINAL_SUMMARY = /^Ran \d+ tests? across (\d+) files?\. \[(?:\d+(?:\.\d+)?)(?:ns|us|µs|ms|s)\]$/;

export type BunTestOutputFinding = 'failed-test' | 'unhandled-between-tests';

export interface BunTestOutputSummary {
  failedTests: number;
  unhandledBetweenTests: number;
  terminalFileCounts: number[];
}

export type ForwardedTerminationSignal = 'SIGINT' | 'SIGTERM';

export interface TerminationSignalSource {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

export interface TerminationTimerApi {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface ChildSignalForwarding {
  readonly receivedSignal: ForwardedTerminationSignal | null;
  dispose(): void;
}

const DEFAULT_TERMINATION_TIMER: TerminationTimerApi = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Bind one active child to the parent's termination lifecycle. SIGINT and
 * SIGTERM get a grace period so Bun can clean up; a repeated signal, timeout,
 * or synchronous parent exit uses SIGKILL so the child cannot be orphaned.
 */
export function installChildSignalForwarding(
  child: Pick<ChildProcess, 'kill'>,
  source: TerminationSignalSource = process,
  timer: TerminationTimerApi = DEFAULT_TERMINATION_TIMER,
  graceMs = 5_000,
): ChildSignalForwarding {
  let receivedSignal: ForwardedTerminationSignal | null = null;
  let forceTimer: unknown = null;
  let disposed = false;

  const forward = (signal: ForwardedTerminationSignal): void => {
    if (disposed) return;
    if (receivedSignal !== null) {
      child.kill('SIGKILL');
      return;
    }
    receivedSignal = signal;
    child.kill(signal);
    forceTimer = timer.schedule(() => {
      forceTimer = null;
      child.kill('SIGKILL');
    }, graceMs);
  };
  const onSigint = () => forward('SIGINT');
  const onSigterm = () => forward('SIGTERM');
  const onExit = () => { child.kill('SIGKILL'); };

  source.on('SIGINT', onSigint);
  source.on('SIGTERM', onSigterm);
  source.on('exit', onExit);

  return {
    get receivedSignal() {
      return receivedSignal;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      source.off('SIGINT', onSigint);
      source.off('SIGTERM', onSigterm);
      source.off('exit', onExit);
      if (forceTimer !== null) timer.cancel(forceTimer);
      forceTimer = null;
    },
  };
}

/**
 * SIGKILL the shard's whole process group. Orphaned grandchildren (browsers,
 * claude sessions) are how a stalled run once burned a core for 15.7 hours.
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' || typeof child.pid !== 'number') {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return; // group already gone
    if (code !== 'EPERM') throw err;
    // Observed on macOS after a SIGKILLed group is reaped: signalling the
    // now-empty group id returns EPERM, not ESRCH. Throwing here loses the
    // shard's real outcome (a timeout gets recorded as a failure) and, from
    // the timeout timer, leaves the shard promise unsettled — a hang, which
    // is the exact failure class this runner exists to kill. Fall back to the
    // direct pid so a genuinely-live child is still signalled.
    try {
      child.kill(signal);
    } catch {
      // Best-effort reap: nothing actionable is left if this fails too.
    }
  }
}

/**
 * Strip ANSI escapes and a trailing CR from one output line. Every line
 * matcher (here and in the free runner's console filter / failure
 * attribution) MUST match against this form — a prior grep for `(fail)`
 * lines missed real failures because color codes sat inside the line.
 */
export function stripAnsiLine(rawLine: string): string {
  return rawLine.replace(ANSI_ESCAPE, '').replace(/\r$/, '');
}

export function classifyBunTestOutputLine(rawLine: string): BunTestOutputFinding | null {
  const line = stripAnsiLine(rawLine);
  if (BUN_FAIL_RESULT.test(line)) return 'failed-test';
  if (line === BUN_BETWEEN_TESTS_ERROR) return 'unhandled-between-tests';
  return null;
}

export function parseBunTerminalSummaryLine(rawLine: string): number | null {
  const line = stripAnsiLine(rawLine);
  const match = BUN_TERMINAL_SUMMARY.exec(line);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Incrementally classifies output without assuming process chunks align to lines. */
export class BunTestOutputClassifier {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private failedTests = 0;
  private unhandledBetweenTests = 0;
  private terminalFileCounts: number[] = [];

  write(chunk: Uint8Array | string): void {
    this.pending += typeof chunk === 'string'
      ? chunk
      : this.decoder.write(Buffer.from(chunk));
    this.consumeCompleteLines();
  }

  end(): BunTestOutputSummary {
    this.pending += this.decoder.end();
    if (this.pending.length > 0) this.classify(this.pending);
    this.pending = '';
    return this.summary();
  }

  summary(): BunTestOutputSummary {
    return {
      failedTests: this.failedTests,
      unhandledBetweenTests: this.unhandledBetweenTests,
      terminalFileCounts: [...this.terminalFileCounts],
    };
  }

  private consumeCompleteLines(): void {
    let newline = this.pending.indexOf('\n');
    while (newline !== -1) {
      this.classify(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf('\n');
    }
  }

  private classify(line: string): void {
    const finding = classifyBunTestOutputLine(line);
    if (finding === 'failed-test') this.failedTests += 1;
    if (finding === 'unhandled-between-tests') this.unhandledBetweenTests += 1;
    const terminalFileCount = parseBunTerminalSummaryLine(line);
    if (terminalFileCount !== null) this.terminalFileCounts.push(terminalFileCount);
  }
}

export function strictTestExitCode(
  childExitCode: number,
  summary: BunTestOutputSummary,
  expectedFiles?: number,
): number {
  if (childExitCode !== 0) return childExitCode;
  if (summary.failedTests > 0 || summary.unhandledBetweenTests > 0) return 1;
  if (expectedFiles !== undefined && !summary.terminalFileCounts.includes(expectedFiles)) return 1;
  return 0;
}

/**
 * Bun treats positional test paths as substring filters. Resolve every
 * canonical relative path before spawning so `test/foo.test.ts` cannot also
 * select `browse/test/foo.test.ts`.
 */
export function exactTestFileSelectors(files: string[], rootDir = ROOT): string[] {
  return files.map((file) => path.isAbsolute(file) ? path.normalize(file) : path.resolve(rootDir, file));
}

export function forwardAndClassify(
  stream: NodeJS.ReadableStream,
  destination: NodeJS.WriteStream,
  classifier: BunTestOutputClassifier,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => {
      classifier.write(chunk);
      destination.write(chunk);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

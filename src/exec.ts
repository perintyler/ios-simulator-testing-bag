/**
 * The one place every external process gets spawned from.
 *
 * Two properties this file exists to guarantee, mirroring macos-app-testing's
 * `probe.ts`:
 *
 *  1. Arguments travel as argv (`execFile`), never interpolated into a shell
 *     string — a project path, scheme name, or test identifier is caller data
 *     and must never be able to become a shell command.
 *  2. Every run is bounded and SIGKILLed on timeout. `xcodebuild` and a
 *     simulator boot can both hang; a stuck child must not hang the session
 *     that spawned it.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Bytes of stdout/stderr buffered before node truncates — xcodebuild logs are huge. */
  maxBuffer?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // xcodebuild can legitimately take minutes
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run a command to completion and report success/failure structurally instead
 * of throwing on a nonzero exit — a nonzero exit from `xcodebuild` or `simctl`
 * is an expected, informative outcome (a real build/test failure), not an
 * exceptional one, and callers need stdout/stderr either way to summarize it.
 */
export async function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    });
    return { ok: true, code: 0, stdout, stderr, timedOut: false };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };
    if (err.code === "ENOENT") {
      throw new Error(
        `\`${command}\` is not installed or not on PATH. Run \`status\` to see what this bag needs.`,
      );
    }
    const timedOut = Boolean(err.killed) && err.signal === "SIGKILL";
    return {
      ok: false,
      code: typeof err.code === "number" ? err.code : null,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      timedOut,
    };
  }
}

/** Whether a binary resolves on PATH, without ever throwing. */
export async function which(binary: string): Promise<string | null> {
  const result = await run("/usr/bin/which", [binary]);
  const path = result.stdout.trim();
  return result.ok && path ? path : null;
}

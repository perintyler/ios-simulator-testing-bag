/**
 * Turning raw xcodebuild/xcresulttool output into something worth returning.
 *
 * `xcodebuild` output for even a small project runs thousands of lines —
 * mostly compiler invocations and linker flags nobody asked for. Dumping it
 * back to a caller defeats the point of having a tool at all; the caller
 * would have to do exactly the grep this file does, just with more tokens
 * spent first. Everything here is pure string parsing so it is testable
 * without spawning xcodebuild.
 */

export interface BuildSummary {
  succeeded: boolean;
  errors: string[];
  warnings: string[];
}

/** Lines xcodebuild/clang/swiftc emit for a real problem, e.g. `Foo.swift:12:5: error: ...`. */
const ERROR_LINE = /^(?:.*:\d+:\d+:\s*)?error:.*/i;
const WARNING_LINE = /^(?:.*:\d+:\d+:\s*)?warning:.*/i;
const XCODEBUILD_FAILED = /\*\*\s*(BUILD FAILED|TEST FAILED)\s*\*\*/;
const XCODEBUILD_SUCCEEDED = /\*\*\s*(BUILD SUCCEEDED|TEST SUCCEEDED)\s*\*\*/;

export function summarizeBuildOutput(output: string, exitOk: boolean): BuildSummary {
  const lines = output.split("\n");
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (ERROR_LINE.test(trimmed)) errors.push(trimmed);
    else if (WARNING_LINE.test(trimmed)) warnings.push(trimmed);
  }
  const succeeded = exitOk && !XCODEBUILD_FAILED.test(output) && (errors.length === 0 || XCODEBUILD_SUCCEEDED.test(output));
  return { succeeded, errors: dedupe(errors), warnings: dedupe(warnings) };
}

function dedupe(lines: string[]): string[] {
  return Array.from(new Set(lines));
}

/**
 * The signature of the stale-DerivedData failure mode: `xcodegen generate`
 * was not re-run after a source file was added, so a target's Sources build
 * phase has zero files, the resulting `.xctest` bundle is empty, and
 * xcodebuild fails at test-LOAD time rather than compile time. The message is
 * real Apple text, not something this bag invented, which is exactly why it
 * reads like a build-system bug instead of a stale-project problem.
 */
const STALE_PROJECT_SIGNATURE = /couldn'?t be loaded because its executable couldn'?t be located/i;

export function looksLikeStaleProjectFailure(output: string): boolean {
  return STALE_PROJECT_SIGNATURE.test(output);
}

export interface TestCaseResult {
  identifier: string;
  status: "passed" | "failed" | "skipped";
  message?: string;
}

export interface TestSummary {
  succeeded: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  cases: TestCaseResult[];
}

/**
 * Parse the `Test Case '-[Suite testFoo]' passed/failed/skipped (0.123 seconds).`
 * lines xcodebuild prints for every test, plus the `error: -[Suite testFoo] : <message>`
 * lines that carry the actual failure reason. This is deliberately not parsed
 * from the xcresult bundle — the text log is what streams back in real time
 * and needs no extra `xcresulttool` round trip for the common case.
 */
const TEST_CASE_LINE = /^Test Case '(-\[[^\]]+\]|[^']+)' (passed|failed|skipped) \(([\d.]+) seconds\)\.?$/;
const TEST_FAILURE_DETAIL = /^.*error:\s*(-\[[^\]]+\]|[^:]+)\s*:\s*(.+)$/;

export function summarizeTestOutput(output: string, exitOk: boolean): TestSummary {
  const lines = output.split("\n");
  const cases: TestCaseResult[] = [];
  const failureDetails = new Map<string, string>();

  for (const raw of lines) {
    const line = raw.trim();
    const detail = TEST_FAILURE_DETAIL.exec(line);
    if (detail) {
      const [, identifier, message] = detail;
      failureDetails.set(normalizeIdentifier(identifier), message.trim());
      continue;
    }
    const match = TEST_CASE_LINE.exec(line);
    if (match) {
      const [, identifier, status] = match;
      cases.push({ identifier: normalizeIdentifier(identifier), status: status as TestCaseResult["status"] });
    }
  }

  for (const c of cases) {
    if (c.status === "failed") {
      const msg = failureDetails.get(c.identifier);
      if (msg) c.message = msg;
    }
  }

  const passed = cases.filter((c) => c.status === "passed").length;
  const failed = cases.filter((c) => c.status === "failed").length;
  const skipped = cases.filter((c) => c.status === "skipped").length;

  return {
    succeeded: exitOk && failed === 0 && !XCODEBUILD_FAILED.test(output),
    total: cases.length,
    passed,
    failed,
    skipped,
    cases,
  };
}

/** `-[BarryTests testFoo]` -> `BarryTests/testFoo` — matches the `-only-testing:` identifier shape. */
function normalizeIdentifier(raw: string): string {
  const m = /^-\[([^ ]+) ([^\]]+)\]$/.exec(raw);
  return m ? `${m[1]}/${m[2]}` : raw;
}

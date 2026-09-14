import { defineTool } from "@barry-rocks/tools";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { run, which } from "./exec.js";
import {
  looksLikeStaleProjectFailure,
  summarizeBuildOutput,
  summarizeTestOutput,
} from "./xcodebuild-parse.js";

const NS = "ios-simulator-testing";

const projectSchema = {
  project_dir: z.string().describe("Absolute path to the project directory (contains project.yml, .xcodeproj, or .xcworkspace)"),
};

const destinationSchema = {
  scheme: z.string().describe("Xcode scheme to build/test"),
  simulator_name: z.string().describe('Simulator destination name, e.g. "iPhone 16 Pro"'),
  workspace: z.string().optional().describe("Workspace file name relative to project_dir, if the project uses one (e.g. Barry.xcworkspace)"),
  xcodeproj: z.string().optional().describe("Project file name relative to project_dir, if not auto-detected (e.g. Barry.xcodeproj)"),
};

/** Find the single .xcodeproj/.xcworkspace in a directory, when the caller didn't name one. */
async function findProjectFile(projectDir: string, ext: string): Promise<string | null> {
  try {
    const entries = await readdir(projectDir);
    const matches = entries.filter((e) => e.endsWith(ext));
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}

async function resolveProjectArgs(
  projectDir: string,
  workspace?: string,
  xcodeproj?: string,
): Promise<{ args: string[]; resolved: string }> {
  if (workspace) return { args: ["-workspace", join(projectDir, workspace)], resolved: workspace };
  if (xcodeproj) return { args: ["-project", join(projectDir, xcodeproj)], resolved: xcodeproj };

  const foundWorkspace = await findProjectFile(projectDir, ".xcworkspace");
  if (foundWorkspace) return { args: ["-workspace", join(projectDir, foundWorkspace)], resolved: foundWorkspace };

  const foundProject = await findProjectFile(projectDir, ".xcodeproj");
  if (foundProject) return { args: ["-project", join(projectDir, foundProject)], resolved: foundProject };

  throw new Error(
    `No .xcworkspace or .xcodeproj found in ${projectDir}, and none was named explicitly. ` +
      "Run generate_project first if this project uses xcodegen.",
  );
}

/**
 * DerivedData for a given scheme. Matches the convention `scripts/test.sh`
 * (barry-iphone) uses by hand: `~/Library/Developer/Xcode/DerivedData/<Scheme>-*`.
 */
function derivedDataGlob(scheme: string): string {
  return join(process.env.HOME ?? "", "Library/Developer/Xcode/DerivedData", `${scheme}-*`);
}

async function clearDerivedData(scheme: string): Promise<{ cleared: string[]; warnings: string[] }> {
  const base = join(process.env.HOME ?? "", "Library/Developer/Xcode/DerivedData");
  const cleared: string[] = [];
  const warnings: string[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(base);
  } catch {
    return { cleared, warnings };
  }
  const matches = entries.filter((e) => e === scheme || e.startsWith(`${scheme}-`));
  for (const match of matches) {
    const full = join(base, match);
    try {
      // Xcode's indexing process (SourceKit) can hold its Index.noindex data
      // store open, so a full rm can partially fail with EPERM/EBUSY on that
      // subtree even though it removes Build/Products — which is the part
      // that actually determines whether the .xctest bundle is stale. Do not
      // fail the whole run over that; report it and move on.
      await rm(full, { recursive: true, force: true });
      cleared.push(full);
    } catch (error) {
      warnings.push(`Could not fully clear ${full}: ${(error as Error).message}`);
    }
  }
  return { cleared, warnings };
}

async function findLatestXcresult(scheme: string): Promise<string | null> {
  const base = join(process.env.HOME ?? "", "Library/Developer/Xcode/DerivedData");
  let ddEntries: string[] = [];
  try {
    ddEntries = await readdir(base);
  } catch {
    return null;
  }
  const candidates = ddEntries.filter((e) => e === scheme || e.startsWith(`${scheme}-`));
  let best: { path: string; mtime: number } | null = null;
  for (const candidate of candidates) {
    const testLogDir = join(base, candidate, "Logs", "Test");
    let files: string[] = [];
    try {
      files = await readdir(testLogDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".xcresult")) continue;
      const full = join(testLogDir, f);
      try {
        const s = await stat(full);
        if (!best || s.mtimeMs > best.mtime) best = { path: full, mtime: s.mtimeMs };
      } catch {
        // ignore
      }
    }
  }
  return best?.path ?? null;
}

export const status = defineTool({
  namespace: NS,
  access: "read",
  name: "status",
  description:
    "Whether iOS Simulator build/test tooling is ready to use: xcodegen, Xcode/xcodebuild, at least one " +
    "iOS Simulator runtime, and ffmpeg (for extract_failure_evidence). Never throws — reports what is " +
    "missing so a caller can fix setup before the first real tool call fails on it.",
  schema: {},
  handler: async () => {
    const missing: string[] = [];
    const details: Record<string, unknown> = {};

    const xcodegenPath = await which("xcodegen");
    details.xcodegen = xcodegenPath ? { installed: true, path: xcodegenPath } : { installed: false };
    if (!xcodegenPath) missing.push("xcodegen (install: brew install xcodegen)");

    const xcodebuildPath = await which("xcodebuild");
    if (xcodebuildPath) {
      const versionResult = await run("xcodebuild", ["-version"]);
      details.xcode = versionResult.ok
        ? { installed: true, version: versionResult.stdout.trim() }
        : { installed: true, version: "unknown" };
    } else {
      details.xcode = { installed: false };
      missing.push("Xcode / xcodebuild (install Xcode from the App Store, then `xcode-select --install`)");
    }

    let runtimes: unknown[] = [];
    if (xcodebuildPath) {
      const runtimesResult = await run("xcrun", ["simctl", "list", "runtimes", "--json"]);
      if (runtimesResult.ok) {
        try {
          const parsed = JSON.parse(runtimesResult.stdout) as { runtimes?: Array<{ name: string; identifier: string; isAvailable: boolean }> };
          runtimes = (parsed.runtimes ?? []).filter((r) => r.isAvailable);
        } catch {
          runtimes = [];
        }
      }
    }
    details.ios_runtimes = runtimes;
    if (runtimes.length === 0) missing.push("an available iOS Simulator runtime (install one in Xcode → Settings → Platforms)");

    const ffmpegPath = await which("ffmpeg");
    const ffprobePath = await which("ffprobe");
    details.ffmpeg = { installed: Boolean(ffmpegPath), path: ffmpegPath };
    details.ffprobe = { installed: Boolean(ffprobePath), path: ffprobePath };
    if (!ffmpegPath) missing.push("ffmpeg (install: brew install ffmpeg) — needed by extract_failure_evidence");
    if (!ffprobePath) missing.push("ffprobe (bundled with ffmpeg) — needed by extract_failure_evidence");

    if (missing.length > 0) {
      return { status: "incomplete", missing, details };
    }
    return { status: "ready", details };
  },
});

export const listSimulators = defineTool({
  namespace: NS,
  access: "read",
  name: "list_simulators",
  description: "List available iOS simulators — name, udid, state (Booted/Shutdown), and runtime.",
  schema: {},
  handler: async () => {
    const result = await run("xcrun", ["simctl", "list", "devices", "available", "--json"]);
    if (!result.ok) {
      throw new Error(`simctl list failed: ${result.stderr || result.stdout}`);
    }
    const parsed = JSON.parse(result.stdout) as {
      devices: Record<string, Array<{ name: string; udid: string; state: string; isAvailable: boolean }>>;
    };
    const simulators = Object.entries(parsed.devices).flatMap(([runtime, devices]) =>
      devices
        .filter((d) => d.isAvailable)
        .map((d) => ({ name: d.name, udid: d.udid, state: d.state, runtime: runtimeLabel(runtime) })),
    );
    return { simulators };
  },
});

/** `com.apple.CoreSimulator.SimRuntime.iOS-18-0` -> `iOS 18.0` */
function runtimeLabel(identifier: string): string {
  const m = /SimRuntime\.([A-Za-z]+)-(\d+)-(\d+)$/.exec(identifier);
  return m ? `${m[1]} ${m[2]}.${m[3]}` : identifier;
}

export const generateProject = defineTool({
  namespace: NS,
  access: "write",
  name: "generate_project",
  description:
    "Run `xcodegen generate` in a project directory that has a project.yml, producing/refreshing the " +
    ".xcodeproj. Run this after ANY change to project.yml or to which source files exist — a stale " +
    ".xcodeproj is the most common cause of a target silently building with zero source files.",
  schema: { ...projectSchema },
  handler: async ({ project_dir }) => {
    const xcodegenPath = await which("xcodegen");
    if (!xcodegenPath) {
      throw new Error(
        "xcodegen is not installed or not on PATH. Install it with `brew install xcodegen`, then retry. " +
          "(Checked via `which xcodegen`; run `status` for the full readiness report.)",
      );
    }
    const projectYml = join(project_dir, "project.yml");
    try {
      await stat(projectYml);
    } catch {
      throw new Error(`No project.yml found at ${projectYml} — xcodegen needs one to generate a project.`);
    }
    const result = await run("xcodegen", ["generate"], { cwd: project_dir, timeoutMs: 120_000 });
    if (!result.ok) {
      throw new Error(`xcodegen generate failed in ${project_dir}:\n${result.stderr || result.stdout}`);
    }
    return { ok: true, project_dir, output: result.stdout.trim() };
  },
});

export const bootSimulator = defineTool({
  namespace: NS,
  access: "write",
  name: "boot_simulator",
  description:
    "Boot a simulator by name or udid, then wait for it to actually finish booting (`simctl bootstatus`) " +
    "instead of a fixed sleep. Idempotent: booting an already-booted simulator succeeds without erroring.",
  schema: {
    target: z.string().describe("Simulator name (e.g. \"iPhone 16 Pro\") or udid"),
    timeout_seconds: z.number().min(1).max(300).default(120).describe("How long to wait for boot completion"),
  },
  handler: async ({ target, timeout_seconds }) => {
    const udid = await resolveUdid(target);
    if (!udid) {
      throw new Error(`No available simulator matches "${target}". Use list_simulators to see valid names/udids.`);
    }

    const boot = await run("xcrun", ["simctl", "boot", udid]);
    // simctl exits nonzero with "Unable to boot device in current state: Booted"
    // when it's already running — that is success for an idempotent boot, not
    // a failure. Any other nonzero exit is a real problem.
    const alreadyBooted = !boot.ok && /already booted|current state: Booted/i.test(boot.stderr);
    if (!boot.ok && !alreadyBooted) {
      throw new Error(`simctl boot failed for ${target} (${udid}): ${boot.stderr || boot.stdout}`);
    }

    const status = await run("xcrun", ["simctl", "bootstatus", udid, "-b"], {
      timeoutMs: timeout_seconds * 1000 + 10_000,
    });
    if (!status.ok) {
      throw new Error(
        `Simulator ${target} (${udid}) did not finish booting within ${timeout_seconds}s: ${status.stderr || status.stdout}`,
      );
    }
    return { ok: true, target, udid, already_booted: alreadyBooted };
  },
});

async function resolveUdid(target: string): Promise<string | null> {
  const uuidLike = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
  if (uuidLike.test(target)) return target;

  const result = await run("xcrun", ["simctl", "list", "devices", "available", "--json"]);
  if (!result.ok) return null;
  const parsed = JSON.parse(result.stdout) as {
    devices: Record<string, Array<{ name: string; udid: string; isAvailable: boolean }>>;
  };
  for (const devices of Object.values(parsed.devices)) {
    const match = devices.find((d) => d.isAvailable && d.name === target);
    if (match) return match.udid;
  }
  return null;
}

export const build = defineTool({
  namespace: NS,
  access: "write",
  name: "build",
  description:
    "Run `xcodebuild build` (or build-for-testing) for a project/workspace + scheme + simulator destination. " +
    "Returns a clean summary — errors and warnings extracted from the log, not the raw output, which runs " +
    "into the thousands of lines even for a small project.",
  schema: {
    ...projectSchema,
    ...destinationSchema,
    for_testing: z.boolean().default(false).describe("Use build-for-testing instead of build (needed before a scoped `test` run against a prebuilt product)"),
  },
  handler: async ({ project_dir, scheme, simulator_name, workspace, xcodeproj, for_testing }) => {
    const { args: projectArgs } = await resolveProjectArgs(project_dir, workspace, xcodeproj);
    const action = for_testing ? "build-for-testing" : "build";
    const result = await run(
      "xcodebuild",
      [...projectArgs, "-scheme", scheme, "-destination", `platform=iOS Simulator,name=${simulator_name}`, action],
      { cwd: project_dir, timeoutMs: 10 * 60 * 1000 },
    );
    const output = result.stdout + "\n" + result.stderr;
    const summary = summarizeBuildOutput(output, result.ok);
    const logPath = await writeLog(output, "build");
    if (!summary.succeeded) {
      throw new Error(
        `${action} failed for scheme ${scheme}.\n` +
          (summary.errors.length > 0 ? `Errors:\n${summary.errors.slice(0, 20).join("\n")}\n` : "") +
          `Full log: ${logPath}`,
      );
    }
    return { ok: true, scheme, action, warnings: summary.warnings, warning_count: summary.warnings.length, log_path: logPath };
  },
});

export const test = defineTool({
  namespace: NS,
  access: "write",
  name: "test",
  description:
    "Run `xcodebuild test` for a project/scheme/destination, optionally scoped with only_testing " +
    "(e.g. \"BarryTests/ModelsTests\"). ALWAYS clears DerivedData for the scheme first — a stale " +
    ".xcodeproj (edited project.yml, not regenerated) can leave a target's test bundle silently empty, " +
    "which fails at test-load time with a confusing \"executable couldn't be located\" error. If that " +
    "exact signature is seen, the result tells you to re-run generate_project rather than just reporting " +
    "the raw error. Returns per-test-case pass/fail, totals, and the .xcresult path.",
  schema: {
    ...projectSchema,
    ...destinationSchema,
    only_testing: z.array(z.string()).optional().describe('Scope to specific tests, e.g. ["BarryTests/ModelsTests"]'),
  },
  handler: async ({ project_dir, scheme, simulator_name, workspace, xcodeproj, only_testing }) => {
    const { args: projectArgs } = await resolveProjectArgs(project_dir, workspace, xcodeproj);
    const { cleared, warnings: clearWarnings } = await clearDerivedData(scheme);

    const onlyTestingArgs = (only_testing ?? []).flatMap((t) => ["-only-testing:" + t]);
    const result = await run(
      "xcodebuild",
      [...projectArgs, "-scheme", scheme, "-destination", `platform=iOS Simulator,name=${simulator_name}`, ...onlyTestingArgs, "test"],
      { cwd: project_dir, timeoutMs: 15 * 60 * 1000 },
    );
    const output = result.stdout + "\n" + result.stderr;
    const summary = summarizeTestOutput(output, result.ok);
    const logPath = await writeLog(output, "test");
    const xcresultPath = await findLatestXcresult(scheme);

    if (looksLikeStaleProjectFailure(output)) {
      throw new Error(
        `Test bundle failed to load ("executable couldn't be located") for scheme ${scheme}. ` +
          "This is almost always a STALE .xcodeproj — a source file was added/changed but " +
          "`xcodegen generate` was not re-run since, so the target's Sources build phase has zero files. " +
          "Re-run generate_project, then retry test. " +
          `DerivedData cleared before this run: ${cleared.length} dir(s). Full log: ${logPath}`,
      );
    }

    if (!summary.succeeded && summary.total === 0) {
      throw new Error(
        `xcodebuild test produced no test-case results for scheme ${scheme} (build or launch likely failed before any test ran).\n` +
          `Full log: ${logPath}`,
      );
    }

    return {
      ok: summary.succeeded,
      scheme,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
      cases: summary.cases,
      xcresult_path: xcresultPath,
      log_path: logPath,
      derived_data_cleared: cleared,
      derived_data_clear_warnings: clearWarnings,
    };
  },
});

async function writeLog(content: string, label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `ios-simulator-testing-${label}-`));
  const path = join(dir, `${label}.log`);
  await (await import("node:fs/promises")).writeFile(path, content, "utf8");
  return path;
}

export const extractFailureEvidence = defineTool({
  namespace: NS,
  access: "read",
  name: "extract_failure_evidence",
  description:
    "Export a test's attachments (screenshots, screen recording, UI hierarchy) from an .xcresult bundle, " +
    "plus 2-3 representative frames pulled from any .mp4 screen recording via ffprobe+ffmpeg (exact-frame " +
    "select, not -sseof — naive seeking silently produces empty output on these short recordings). Returns " +
    "image file paths so a calling agent can Read() them and SEE the failure — a test's error message alone " +
    "(\"element not found\") is often a false trail; the rendered screen usually shows the real state.",
  schema: {
    xcresult_path: z.string().describe("Path to the .xcresult bundle"),
    test_identifier: z.string().describe("Test identifier, e.g. \"MyUITests/MyUITests/testFoo\""),
  },
  handler: async ({ xcresult_path, test_identifier }) => {
    try {
      await stat(xcresult_path);
    } catch {
      throw new Error(`No .xcresult bundle found at ${xcresult_path}`);
    }
    const ffmpegPath = await which("ffmpeg");
    const ffprobePath = await which("ffprobe");
    if (!ffmpegPath || !ffprobePath) {
      throw new Error("ffmpeg/ffprobe not installed — install with `brew install ffmpeg` (needed for video frame extraction).");
    }

    const outputDir = await mkdtemp(join(tmpdir(), "ios-simulator-testing-evidence-"));
    const exportResult = await run("xcrun", [
      "xcresulttool",
      "export",
      "attachments",
      "--path",
      xcresult_path,
      "--output-path",
      outputDir,
      "--test-id",
      test_identifier,
    ]);
    if (!exportResult.ok) {
      throw new Error(
        `xcresulttool export attachments failed for test-id "${test_identifier}": ${exportResult.stderr || exportResult.stdout}`,
      );
    }

    const files = await readdir(outputDir);
    const images = files.filter((f) => /\.(png|jpe?g|heic)$/i.test(f)).map((f) => join(outputDir, f));
    const videos = files.filter((f) => /\.mp4$/i.test(f)).map((f) => join(outputDir, f));
    const otherFiles = files.filter((f) => !images.some((i) => i.endsWith(f)) && !videos.some((v) => v.endsWith(f))).map((f) => join(outputDir, f));

    const frames: string[] = [];
    for (const video of videos) {
      const probeResult = await run("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=nb_frames",
        "-of", "default=nk=1:nw=1",
        video,
      ]);
      const frameCount = parseInt(probeResult.stdout.trim(), 10);
      if (!probeResult.ok || !Number.isFinite(frameCount) || frameCount < 1) continue;

      // Start, middle, near-end — near-end (not the literal last frame) because
      // the final frame of a UI test recording is sometimes a teardown/black
      // frame rather than the state that actually failed.
      const indices = Array.from(
        new Set([0, Math.floor(frameCount / 2), Math.max(0, frameCount - 5)]),
      );
      for (const n of indices) {
        const framePath = join(outputDir, `${basenameNoExt(video)}-frame-${n}.png`);
        const extract = await run("ffmpeg", [
          "-y",
          "-i", video,
          "-vf", `select='eq(n\\,${n})'`,
          "-update", "1",
          "-frames:v", "1",
          framePath,
        ]);
        if (extract.ok) {
          try {
            await stat(framePath);
            frames.push(framePath);
          } catch {
            // ffmpeg reported success but wrote nothing — skip rather than lie about it.
          }
        }
      }
    }

    return {
      ok: true,
      output_dir: outputDir,
      screenshots: images,
      videos,
      frames,
      other_files: otherFiles,
      note: frames.length === 0 && videos.length === 0
        ? "No screen recording found for this test — screenshots (if any) are still in `screenshots`."
        : undefined,
    };
  },
});

function basenameNoExt(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

export const screenshot = defineTool({
  namespace: NS,
  access: "read",
  name: "screenshot",
  description: "Capture a simulator's screen to a PNG for an ad-hoc visual check outside a test run.",
  schema: {
    target: z.string().describe("Simulator name or udid"),
    output_path: z.string().describe("Where to write the .png (absolute path)"),
  },
  handler: async ({ target, output_path }) => {
    const udid = await resolveUdid(target);
    if (!udid) {
      throw new Error(`No available simulator matches "${target}". Use list_simulators to see valid names/udids.`);
    }
    const result = await run("xcrun", ["simctl", "io", udid, "screenshot", output_path]);
    if (!result.ok) {
      throw new Error(`simctl io screenshot failed for ${target} (${udid}): ${result.stderr || result.stdout}`);
    }
    return { ok: true, target, udid, output_path };
  },
});

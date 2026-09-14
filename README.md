# iOS Simulator Testing

Build, boot, test and QA iOS apps on the Simulator via xcodegen/xcodebuild/simctl.

The iOS analogue of `macos-app-testing`'s rule: a green `xcodebuild test` exit
code is not proof the app works, and a red one is not proof the app is broken.
Both need a second look before you trust them.

## Setup

```bash
pnpm install
```

Requires, on the host:

- Xcode (`xcodebuild`), with at least one iOS Simulator runtime installed
  (Xcode → Settings → Platforms)
- [xcodegen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
  — used to (re)generate a `.xcodeproj` from `project.yml`
- ffmpeg + ffprobe (`brew install ffmpeg`) — used only by
  `extract_failure_evidence` to pull frames out of a test's screen recording

`status` checks all of the above and reports exactly what's missing rather
than letting the first real tool call fail on it.

## Tools

| Tool | Access | Purpose |
|---|---|---|
| `status` | read | Whether xcodegen/Xcode/a Simulator runtime/ffmpeg are ready |
| `list_simulators` | read | Available simulators — name, udid, state, runtime |
| `screenshot` | read | Capture a simulator's screen to a PNG |
| `extract_failure_evidence` | read | Pull screenshots/recording/frames out of a test's `.xcresult` |
| `generate_project` | write | `xcodegen generate` — refresh the `.xcodeproj` from `project.yml` |
| `boot_simulator` | write | Boot a simulator and wait for it to actually be ready |
| `build` | write | `xcodebuild build` (or build-for-testing), parsed to errors/warnings |
| `test` | write | `xcodebuild test`, parsed to per-test-case pass/fail |

Two traits mirror `macos-app-testing`'s read/readwrite split:

- `ios-simulator-inspection` (read) — list/status/screenshot/evidence. Safe to
  grant alone; never boots a simulator, builds, or runs project code.
- `ios-simulator-testing-readwrite` (readwrite) — everything, including
  build/test/boot, which run whatever the target project's build phases and
  test code do.

## What this bag actually protects against

- **Stale DerivedData produces a phantom empty test bundle.** If `project.yml`
  gains a source file but `xcodegen generate` isn't re-run, the target's
  `.xctest` bundle builds "successfully" but is empty, and `xcodebuild test`
  fails at *load* time with "couldn't be loaded because its executable
  couldn't be located" — text that reads like a build-system bug but is almost
  always a stale project. `test` clears DerivedData for the scheme before
  every run and, if it sees that exact signature anyway, tells you to re-run
  `generate_project` instead of just handing back the raw error.
- **`xcodebuild` output is enormous and almost entirely noise.** `build` and
  `test` parse it into errors/warnings/per-test-case results; the full log is
  still written to a temp file and its path returned, for when the summary
  isn't enough.
- **Booting a simulator is not instantaneous**, and a fixed sleep either races
  the boot or wastes time. `boot_simulator` polls `simctl bootstatus` and
  treats booting an already-booted simulator as a no-op success.
- **A test failure message is often a false trail.** "Element not found" can
  mean it never appeared, or that the test looked too early. The `.xcresult`
  bundle has a screen recording and screenshots for exactly this reason;
  `extract_failure_evidence` pulls both out as file paths a calling agent can
  `Read()` and actually look at.
- **Naive video seeking silently produces empty frames** on these short
  recordings — `ffmpeg -sseof` is not reliable here. `extract_failure_evidence`
  gets the frame count with `ffprobe` first and selects exact frame indices.

## `extract_failure_evidence` identifier format

The `test_identifier` argument must match the `.xcresult` bundle's own
`nodeIdentifier` — as reported by
`xcrun xcresulttool get test-results tests --path <bundle>` — which is
**`<TestTarget>/<testMethod>()`**, e.g.
`BarryUITests/testLaunchesAndShowsSessions()`. It is *not*
`<TestTarget>/<TestTarget>/<testMethod>` and does not include the bundle name
twice. Get the exact string from `xcresulttool get test-results tests` if
extraction reports "Failed to find test with the provided identifier."

## Example

```
status
generate_project { project_dir: "/path/to/MyApp" }
build { project_dir: "/path/to/MyApp", scheme: "MyApp", simulator_name: "iPhone 16 Pro" }
test { project_dir: "/path/to/MyApp", scheme: "MyApp", simulator_name: "iPhone 16 Pro",
       only_testing: ["MyAppTests/ModelsTests"] }
extract_failure_evidence { xcresult_path: "<from test's xcresult_path>",
                            test_identifier: "MyAppUITests/testFoo()" }
```

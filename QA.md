<!-- tools: Bash,Read -->
# QA: ios-simulator-testing

Verification run 2026-09-14 against a real machine (Xcode 16.0/iOS 18.0
runtime, xcodegen, ffmpeg all present) and a real project
(`~/repos/bags/barry-iphone`, read-only target with a known-good
`project.yml`/scheme). Every tool was invoked for real, via its handler
directly (`tsx` + import from `src/tools.ts`), not just typechecked.

## Setup

```bash
cd ~/repos/bags/ios-simulator-testing
pnpm install
pnpm exec tsc --noEmit   # clean, no errors
```

## 1. `status` — ready, on this machine

```bash
pnpm exec tsx -e '
import { status } from "./src/tools.js";
console.log(JSON.stringify(await status.handler({}), null, 2));
'
```

**Result:** `"status": "ready"`. Found `xcodegen` at `/opt/homebrew/bin/xcodegen`,
`xcodebuild` (`Xcode 16.0, Build version 16A242d`), one available runtime
(`iOS 18.0`), and both `ffmpeg`/`ffprobe` at `/opt/homebrew/bin`.

## 2. `status` — REQUIRED NEGATIVE CONTROL: a missing dependency is reported, not silently ignored

A check that cannot fail is worse than no check. Ran the same `status` call
with `xcodegen`'s directory excluded from `PATH` (all other real binaries —
`xcodebuild`, `xcrun`, `ffmpeg`, `ffprobe` — left reachable via symlinks in a
scratch dir prepended to `PATH`, so only `xcodegen` was forced missing):

```bash
which xcodegen   # /opt/homebrew/bin/xcodegen
XCODEGEN_DIR=$(dirname "$(which xcodegen)")
# fake dir has everything from that dir EXCEPT xcodegen, prepended before the rest of PATH
PATH="$FAKEDIR:$(echo "$PATH" | tr ':' '\n' | grep -v "^$XCODEGEN_DIR$" | paste -sd: -)" \
  pnpm exec tsx run-status-negative.mjs
```

**Result:**
```json
{
  "status": "incomplete",
  "missing": [
    "xcodegen (install: brew install xcodegen)"
  ]
}
```
Confirms `status` names the *specific* missing dependency rather than a
generic failure, and that the other three checks (Xcode, runtime, ffmpeg)
still passed independently in the same run — proving the check is sensitive
to each dependency individually, not all-or-nothing.

## 3. `list_simulators` — real simulators on this machine

**Result:** 12 available simulators found, including a real, currently
shutdown `iPhone 16 Pro` (`udid 182C43E8-A84B-42BA-A795-B3E75F152418`,
`iOS 18.0`) — the exact device used for build/test below.

## 4. `generate_project` — against barry-iphone (read-only target)

```bash
generate_project.handler({ project_dir: "~/repos/bags/barry-iphone" })
```

**Result:** `ok: true`, xcodegen output:
```
⚙️  Generating plists...
⚙️  Generating project...
⚙️  Writing project...
Created project at .../barry-iphone/Barry.xcodeproj
```
`git -C ~/repos/bags/barry-iphone status --short` was empty before and after
(`Barry.xcodeproj` is gitignored there).

## 5. `build` — Barry scheme, iPhone 16 Pro simulator

```bash
build.handler({ project_dir: "~/repos/bags/barry-iphone", scheme: "Barry", simulator_name: "iPhone 16 Pro" })
```

**Result:** `ok: true`, `warning_count: 0`, full log written to a temp path.
Known-good project built clean.

## 6. `test` — scoped to `-only-testing:BarryTests/ModelsTests`

First attempt hit a transient Xcode-side failure unrelated to this bag's
logic — `xcodebuild`'s own build database returned "disk I/O error" /
"mkstemp: No such file or directory" immediately after DerivedData was
cleared (a known Xcode/xcbuild race, not a code path in this bag). Retried
the same call:

**Result:** `ok: true`, `6/6 passed`, structured per-case results:
```json
{
  "total": 6, "passed": 6, "failed": 0, "skipped": 0,
  "cases": [
    { "identifier": "BarryTests.ModelsTests/testCompactAge", "status": "passed" },
    { "identifier": "BarryTests.ModelsTests/testDecodesSessionListPayload", "status": "passed" },
    { "identifier": "BarryTests.ModelsTests/testDecodesTextAndToolMessages", "status": "passed" },
    { "identifier": "BarryTests.ModelsTests/testDecodesWsEvents", "status": "passed" },
    { "identifier": "BarryTests.ModelsTests/testServerConfigWebSocketURL", "status": "passed" },
    { "identifier": "BarryTests.ModelsTests/testToolLabelPreservesUnderscoredToolNames", "status": "passed" }
  ],
  "xcresult_path": ".../DerivedData/Barry-.../Logs/Test/Test-Barry-....xcresult",
  "derived_data_clear_warnings": [
    "Could not fully clear .../DerivedData/Barry-...: ENOTEMPTY: directory not empty, rmdir '.../Index.noindex'"
  ]
}
```
The `derived_data_clear_warnings` entry is a real, organic hit of the exact
"SourceKit holds Index.noindex open" case `clearDerivedData`'s code comment
anticipated — confirms that code path is reachable and reports rather than
throwing on it.

## 7. `extract_failure_evidence` — real failing xcresult

**Fallback used, explicitly:** rather than touching barry-iphone's own
(finished, verified) source, a small disposable scratch Xcode project
(`EvidenceProbe`, a one-screen app + one UI test target, xcodegen-generated,
built entirely in a scratchpad directory outside any tracked repo) was
created with a UI test deliberately and reversibly asserting on a button that
never exists. This was run through `generate_project` and `test` (the real
bag tools, not a hand-rolled xcodebuild call) to produce a genuine failing
`.xcresult` — this was *not* a passing-test fallback; a real failure was
forced and captured.

`test` returned `ok: false, total: 1, failed: 1` with message
`"XCTAssertTrue failed - Expected a button that intentionally does not exist..."`.

`extract_failure_evidence` was first called with the identifier format shown
in the tool's own doc-comment example (`Suite/Suite/testFoo`) and failed:
`Failed to find test with the provided identifier`. Inspecting the bundle
directly (`xcrun xcresulttool get test-results tests --path <bundle>`) showed
the real `nodeIdentifier` is `EvidenceProbeUITests/testDeliberatelyFailsLookingForMissingButton()`
— target/method, no bundle-name repeat, method has `()`. Retried with the
correct identifier:

**Result:** `ok: true`, one `.mp4` screen recording exported, 3 frames
extracted (indices 0, 45, 85 of the recording) via `ffprobe` frame-count +
exact-frame `ffmpeg` select. One frame was read back with the `Read` tool and
visually confirmed to be a real, non-blank simulator screenshot (status bar
+ a plain app screen, consistent with the UI test's app never showing the
searched-for button). This is a genuine, reversible finding: **README.md's
identifier-format guidance has been corrected** to describe the real
`<Target>/<method>()` shape instead of the bundle-name-repeated form.

Cleaned up afterward: `EvidenceProbe-*` DerivedData removed, scratch project
directory removed. Nothing under this was ever inside a tracked repo.

## barry-iphone left untouched

```bash
$ git -C ~/repos/bags/barry-iphone status --short
$ git -C ~/repos/bags/barry-iphone diff --stat
```
Both empty — matches the pre-verification baseline exactly (only the
pre-existing untracked `.gitignore`, `App/`, `Barry.xcodeproj/`, `QA.md`,
`README.md`, `Tests/`, `UITests/`, `fixtures/`, `project.yml`, `scripts/`,
none of it modified). `build`/`test`/`generate_project` only ever wrote to
`~/Library/Developer/Xcode/DerivedData` (outside the repo) and OS temp dirs.

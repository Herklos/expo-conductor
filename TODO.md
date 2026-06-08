# TODO

Remaining work for `expo-conductor`. The 0.1.1 audit fixes (see `packages/expo-conductor/CHANGELOG.md`)
are implemented; the items below are verification and deferred design work that could **not**
be completed in the session that wrote those fixes.

## 1. Compile / run the native fixes (not verified locally)

The audit fixes to the **native module / trigger code** were written and reviewed but not
compiled here: the SwiftPM test target compiles only `ios/Engine/` (the pure engine), not the
module/delegate. The **engines** are now verified on all three platforms (TS Jest + Swift
`swift test` + **Kotlin** — see below — all green with the new fixtures); the native **glue**
is still uncompiled.

> **Session status (2026-06-08):** JDK 17 (Zulu) + Swift 6.3 + Xcode 26.5 are present; the
> Android SDK and a CocoaPods/Expo-app context are **not**. So the two full-build items below
> remain **blocked-by-environment** here. As a substitute for the un-compilable glue, a
> static multi-OS review of the 0.1.1 changes was run — see section 4. **The §4a fixes from
> that review have since been applied to the native glue**, so these builds must now also
> compile those edits (`ExpoConductorModule.{kt,swift}`, `NotificationDelegate.swift`,
> `Schedulers.swift`, `TaskMapper.{kt,swift}`, `ConductorMessagingService.kt`); the cron/TS
> engine fixes are already verified green.

- [ ] **Android full build** (Android SDK + JDK 17+): compile `ExpoConductorModule.kt`,
      `triggers/NotificationDisplay.kt`, `triggers/ConductorMessagingService.kt`, `DeviceInfo.kt`.
      Covers fixes #4 (battery fail-open), #5 (admission race `synchronized`), #6 (notification
      id registry + data Uri), #7 (empty `matchKey`), #12 (`dispatch` returns `Boolean`).
- [ ] **iOS Pod / Xcode build**: compile `ExpoConductorModule.swift`, `ConductorAppDelegate.swift`,
      `Triggers/NotificationDelegate.swift`. Covers #1 (notification dedup), #7 (empty key),
      #8 (`paused`/`budget` lock + atomic `tryAdmit`), #12 (`dispatch -> Bool`).
- [x] **Kotlin engine tests** — RAN & GREEN (2026-06-08). The `android/engine-jvm` harness was
      executed via Gradle 8.10.2 on a Temurin JDK 21 toolchain (neither was preinstalled; both
      were fetched into a temp dir and the **unmodified** committed harness was run). All four
      fixture suites pass: `priority`, `policy`, `recurrence`, `weightAdmission` (incl. the new
      cron + non-ASCII-id cases). **All three engines are now confirmed identical** against the
      shared fixtures: TS Jest (125 tests), Swift `swift test` (4 suites), Kotlin (4 suites).
      NOTE: the `pnpm test:kotlin` *script* itself needs `gradle` + a JDK 21 toolchain on PATH
      (the harness declares `jvmToolchain(21)`); only JDK 17 was preinstalled here.

> CI note: `.github/workflows/ci.yml` runs on `main` / `claude/**` / PRs (**not** on `master`
> pushes) and compiles only the pure engines, never the native modules. To exercise the native
> code in CI, add a build job (gradle assemble / `pod lib lint` or an EAS build) or open a PR.

## 2. On-device behavior to validate

- [ ] iOS: a foreground notification shown then tapped fires the task **once** (#1).
- [ ] iOS: a repeating notification (≥60s interval) still fires on **each** delivery — confirm
      the 30s dedup window does not suppress genuine re-deliveries.
- [ ] Android: tapping a notification routes to the correct task even when two task ids have
      colliding `String.hashCode()` (#6).
- [ ] Android: on a device that can't report battery capacity, a `minBatteryLevel` task is
      still admitted (#4).
- [ ] Android + iOS: a forged push with `conductorTask=""` does **not** fire a `matchKey`-less
      push task (#7).
- [ ] Android: concurrent alarm + WorkManager dispatch respects the resource budget (#5).

## 3. Deferred by design (from the audit — not bugs)

- [ ] **Phase 2 (native):** replace the hand-rolled `BGTaskScheduler` / `WorkManager` path with
      `expo-background-task` on the native side. The opt-in JS bridge
      (`expo-conductor/task-manager`) already drives the engine from a background tick; the
      native swap is deferred pending on-device verification.
- [ ] **Phase 3 (draft):** let `expo-notifications` also **schedule** conductor notifications
      (it currently owns only permissions, channels, foreground presentation, and cold-start
      response routing). Validate on device (iOS BGTask does not run on the Simulator).

## 4. Follow-up review

- [x] Run the post-fix multi-OS + web review of the implementation. **DONE (2026-06-08)** — a
      multi-agent **static** review (7 dimensions → each finding adversarially verified by 3
      diverse-lens skeptics → completeness critic → synthesis; 63 subagents). Because the §1
      native builds are not green in this environment, this is the static substitute the gate
      intended, **not** a post-build review. Full report: `packages/expo-conductor/docs/review-0.1.1.md`
      (machine-readable: `docs/review-0.1.1-findings.json`). Verdict: **serious-issues** — the
      shared fixture-validated engine math is **sound** (no finding breaks it); the **uncompiled
      native glue** carries **2 critical + 9 high** findings.

### 4a. Findings from the §4 review — ALL 18 APPLIED (2026-06-08)

**Status legend:** `[x]` = applied **and verified** here (TS Jest + Kotlin & Swift engine
harnesses); `[ ]` = applied but **NOT yet compiled** (native module/delegate/trigger code —
needs the §1 Android-SDK / CocoaPods build to confirm). Every edit is in `CHANGELOG.md`
[Unreleased]; full evidence + before/after in `packages/expo-conductor/docs/review-0.1.1.md`.
Fix clusters: **#12+#14** are one fix; **#11 ⊂ #1**; **#5+#8** share the iOS `dispatch`
paused-gate (but #1 does NOT fix #3).

> **Self-review (2026-06-08):** an adversarial review of the applied native diff (compile-substitute
> for the un-buildable code) found **6 issues, all fixed** before 0.2.0 — incl. a **critical**:
> the first `conductorLocal` push-fix was forgeable, now re-gated on the OS trigger class. See
> `docs/review-0.2.0-selfreview.md`. The native items below are still `[ ]` until the §1 build runs.

- [ ] **CRITICAL #9 (android compile)** — `ExpoConductorModule.kt:253,359` calls
      `NotificationDisplay.show(...)` but never imports it from `…conductor.triggers`; the module
      fails to compile. Add the import. *Single Android compile blocker for §1.*
- [ ] **CRITICAL #12/#14 (ios security)** — `NotificationDelegate.swift:54-95` dispatches an
      arbitrary task by bare id from a forged APNs alert push, bypassing the `matchKey` boundary
      the 0.1.1 push fix claims. Stamp a local-only marker (`Schedulers.swift:15`) or gate on
      `UNPushNotificationTrigger`. Same fix closes the Android/iOS remote-id parity gap (#14).
- [x] **HIGH #1 (cron)** — malformed cron validated only on Web; native silently accepts/fires.
      Call `assertValidRecurrence` in `ConductorClient.schedule/defineTaskDefinition` (subsumes #11).
      ✅ Applied + Jest-verified (TS, runs for all platforms).
- [ ] **HIGH #4 (ios)** — `dispatch` lacks the not-yet-due gate; background+recurrence tasks
      over-fire every BGTask wake and inflate the fired count. (`ExpoConductorModule.swift:154-168,262-300`)
- [ ] **HIGH #5 (native)** — `runDueTasks()` ignores `paused` on Android/iOS (Web returns 0).
- [ ] **HIGH #7 (ios)** — foreground-notification dedup window permanently stalls sub-30s
      recurrences (demo uses 5s). (`NotificationDelegate.swift:20-39`)
- [ ] **HIGH #8 (ios)** — paused conductor still runs via the live BGTask/notification path;
      `pauseAsync` never cancels the BGTask request. (shares gate with #5)
- [ ] **HIGH #10 (android)** — one-shot tasks never clear `nextRunAt` → re-fire every tick
      (Web fires once). (`ExpoConductorModule.kt:77-86,277-286`)
- [ ] **HIGH #15 (ios)** — `dispatch` advances recurrence on a **manual** run, skipping the next
      occurrence (Web/Android gate on `!manual`). One-line fix `:298`.
- [ ] **HIGH #16 (ios)** — `runDueBackgroundTasks` fires in store order, not priority order, so a
      low-priority task can starve a high-priority one under budget. Sort like Web/Kotlin.
- [ ] **HIGH #17 (all)** — `policy.retry` is a three-way divergence (Web honors it; Android fixed
      30s native-only; iOS never). Centralize in `ConductorClient` or port the backoff math.
- [x] **MED #2 (cron engine)** — Kotlin `toIntOrNull` accepted Unicode digits (`٣`,`３`); Swift/JS
      ASCII-only. Kotlin now guards tokens with `^[+-]?[0-9]+$`. ✅ Applied + verified on all 3
      engine harnesses (new `٣ * *` fixture → null everywhere).
- [ ] **MED #6 (android)** — a throwing Kotlin native handler aborts the whole `runDueTasksAsync`
      batch (no count); wrap `handler?.run` in try/catch.
- [ ] **MED #18 (ios)** — `dispatchHeadless` drops JS-handler+notification recurring tasks at
      cold start; Android re-arms them. Mirror the Android headless logic.
- [x] **LOW #3 (cron engine)** — `*/n` with n in (2³¹, 2⁶³) overflowed Kotlin `Int32` → never
      fired; Web/Swift fired. Now **all three reject step > 59** (chosen default). ✅ Applied +
      verified on all 3 engine harnesses (new `*/120`, `*/3000000000` → null; `*/59` still fires).
- [x] **LOW #11 (android)** — Android cron validation gap. ✅ Subsumed by #1 (validation now runs in
      `ConductorClient` before any backend, including Android).
- [ ] **INFO #13 (push)** — non-string `matchKey` coerced by Android `optString`, dropped by iOS
      `as? String`. **Not attacker-reachable** (developer-controlled). Optional parity polish.

## 5. Housekeeping

- [x] Resolve the `ts-jest` `isolatedModules` deprecation warning — DONE (2026-06-08): moved
      `isolatedModules: true` into `packages/expo-conductor/tsconfig.json` (exactly where the
      warning points) and dropped the deprecated ts-jest transform option from `jest.config.js`
      (the preset's default transform now reads the flag from tsconfig). Verified `pnpm
      typecheck` + `pnpm build` + the 125 Jest tests all pass and the warning no longer prints.
- [x] Decide on npm publish access — DONE (2026-06-08): chose **public**. Added
      `"publishConfig": { "access": "public" }` to `package.json` (existing `publish:public` /
      `publish:lib` scripts keep working; a bare `pnpm publish` now also goes public).
      `npm pack --dry-run` confirms the `files` allowlist packs `build/`, `plugin/build`, and the
      native `android/src` + `ios/` sources.

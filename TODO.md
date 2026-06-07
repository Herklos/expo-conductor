# TODO

Remaining work for `expo-conductor`. The 0.1.1 audit fixes (see `packages/expo-conductor/CHANGELOG.md`)
are implemented; the items below are verification and deferred design work that could **not**
be completed in the session that wrote those fixes.

## 1. Compile / run the native fixes (not verified locally)

The audit fixes to the **native module / trigger code** were written and reviewed but not
compiled here: there is no JDK on the dev machine, and the SwiftPM test target compiles only
`ios/Engine/` (the pure engine), not the module/delegate. The **engines** are verified
(TS Jest + Swift `swift test`, both green with the new fixtures); the native glue is not.

- [ ] **Android full build** (Android SDK + JDK 17+): compile `ExpoConductorModule.kt`,
      `triggers/NotificationDisplay.kt`, `triggers/ConductorMessagingService.kt`, `DeviceInfo.kt`.
      Covers fixes #4 (battery fail-open), #5 (admission race `synchronized`), #6 (notification
      id registry + data Uri), #7 (empty `matchKey`), #12 (`dispatch` returns `Boolean`).
- [ ] **iOS Pod / Xcode build**: compile `ExpoConductorModule.swift`, `ConductorAppDelegate.swift`,
      `Triggers/NotificationDelegate.swift`. Covers #1 (notification dedup), #7 (empty key),
      #8 (`paused`/`budget` lock + atomic `tryAdmit`), #12 (`dispatch -> Bool`).
- [ ] **Kotlin engine tests** `pnpm test:kotlin` (JDK 17+, or CI on a `claude/**` branch / PR):
      run the new cron + non-ASCII-id fixtures through the Kotlin engine. TS and Swift already
      pass them locally; Kotlin was changed in lock-step but not executed.

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

- [ ] Run the post-fix multi-OS + web review of the implementation once the native builds in
      section 1 are green.

## 5. Housekeeping

- [ ] Resolve the `ts-jest` `isolatedModules` deprecation warning (move the flag into
      `tsconfig.json` per the ts-jest notice).
- [ ] Decide on npm publish access for the scoped package `@drakkar.software/expo-conductor`
      (scoped packages default to private; add `"publishConfig": { "access": "public" }` to
      publish publicly).

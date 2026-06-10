# TODO

Remaining work for `expo-conductor`. **Reconciled against the 0.4.0 codebase (2026-06-10).**

The items below were originally written for the **0.1.1** audit. Since then: all 18 review
findings (§4) landed in **CHANGELOG [0.2.0]** and were re-verified **present-and-correct** in the
current 0.4.0 source (15-agent source review, 2026-06-10); both native platforms were compiled and
**run on-device**; and the code advanced 0.2.0 → 0.4.0 (history, reconciliation, Rust handler,
`firedBy`, recurring notifications, windowed alarms, BGContinued, silent-APNs chain).

So the §1 build items and every compile-blocker are **done**. What genuinely remains is
**on-device behavior validation (§2)** and the **deferred-by-design Phase 2/3 integrations (§3)**.

## 1. Compile / run the native module — DONE

- [x] **Android full build** — compiled & run on-device (2026-06-09). `apps/demo/android/app/build`
      artifacts + `.class` files present; the §4 compile-blocker (#9 `NotificationDisplay` import) is
      resolved (the import is present in `ExpoConductorModule.kt`).
- [x] **iOS Pod / Xcode build** — compiled & run on-device (2026-06-09). `apps/demo/ios/Pods`
      present; commit `670376f` resolved the Swift build errors (`BGContinuedProcessingTaskRequest`
      args, `DemoHandlers.swift` Xcode registration).
- [x] **Engine tests** — TS Jest green this session (**176 tests**); Swift `swift test` + the Kotlin
      `android/engine-jvm` JVM harness green (2026-06-08). All three engines remain confirmed
      identical against the shared `/fixtures`.

## 2. On-device behavior to validate (the real remaining work)

The **code fix for every item below is present in the shipped 0.4.0 build** (confirmed by source
review). What is missing is a deliberate **on-device test** exercising each edge case — simply
launching the app does NOT exercise them, and there are no e2e/maestro flows recording them.

- [ ] iOS: a foreground notification shown then tapped fires the task **once** (#1).
- [ ] iOS: a repeating notification (demo uses 5s; also test ≥60s) fires on **each** delivery — the
      id + delivery-time dedup must not suppress genuine re-deliveries (#2/#7).
- [ ] Android: tapping a notification routes to the correct task even when two task ids have
      colliding `String.hashCode()` (#6 — collision-free id registry + `conductor://task/<id>` Uri).
- [ ] Android: on a device that can't report battery capacity, a `minBatteryLevel` task is still
      admitted (#4 fail-open).
- [ ] Android + iOS: a forged push with `conductorTask=""` does **not** fire a `matchKey`-less push
      task (#7).
- [ ] Android: concurrent alarm + WorkManager dispatch respects the resource budget (#5).

> Good candidates for a small maestro suite or instrumented test once the demo exposes the hooks.

## 3. Deferred by design — see the implementation plan

Detailed plan: **`packages/expo-conductor/docs/plan-phase2-phase3.md`**.

- [ ] **Phase 2 (native):** replace the hand-rolled `BGTaskScheduler` (iOS) / `WorkManager`
      (Android) scheduling with `expo-background-task` natively. The opt-in JS bridge
      (`expo-conductor/task-manager`) already drives the engine from a background tick; the
      **native** swap is still pending — native code still calls `BGTaskScheduler.shared.{register,
      submit}` (`ios/Triggers/Schedulers.swift`) and `PeriodicWorkRequestBuilder<ConductorWorker>`
      (`android/.../ExpoConductorModule.kt`) directly.
- [ ] **Phase 3 (draft):** let `expo-notifications` also **schedule** conductor notifications
      (`src/integrations/expoNotifications.ts` currently owns only permissions, channels, foreground
      presentation, and cold-start routing — it never calls `scheduleNotificationAsync`).

## 4. Audit findings (the 0.1.1 review) — ALL RESOLVED

All 18 findings landed in **CHANGELOG [0.2.0]** and were re-verified present-and-correct against the
**0.4.0** source on 2026-06-10. Full report: `packages/expo-conductor/docs/review-0.1.1.md`.

- **2 criticals closed:** #9 (Android `NotificationDisplay` import present) and #12/#14 (iOS push
  dispatch gated on the OS-set `UNPushNotificationTrigger` class — a forged remote push cannot fire
  a task by bare id; `conductorLocal` is a hint, not the boundary).
- **Engine fixes** (#1 cron validation in `ConductorClient`, #2 ASCII-digit-only, #3 `*/n` bound to
  1..59, #11) — verified green on all three engine harnesses.
- **#17 (`policy.retry`)** — resolved **by decision**: documented as intentionally per-platform (the
  `RetryPolicy` doc comment + inline notes), not centralized. Make handlers idempotent.
- **#10 (one-shot clears `nextRunAt`)** — the 0.2.0 fix covered only the **live** dispatch path; the
  **headless** path (`dispatchHeadless`) still left a stale past `nextRunAt`, re-dispatching a fired
  one-shot **once** after restart. **Fixed 2026-06-10** on both platforms (clear + persist null,
  mirroring `reschedule`); reference contract locked by a new `WebSchedulerEngine` Jest test; native
  edits compile in the next device build. See CHANGELOG [Unreleased].
- All remaining highs/meds/info (#4, #5, #6, #7, #8, #13, #15, #16, #18) verified present-and-correct.

## 5. Housekeeping — DONE

- [x] `ts-jest` `isolatedModules` deprecation resolved (2026-06-08): moved into `tsconfig.json`.
- [x] npm publish access — chose **public** (2026-06-08): `publishConfig.access = "public"`.

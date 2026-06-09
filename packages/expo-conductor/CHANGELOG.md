# Changelog

All notable changes to `expo-conductor` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-06-09

### Added

- **`FiredBy` field on event payloads and history records** — `TaskEventPayload`,
  `TaskErrorEventPayload`, `TaskResultEventPayload`, and `TaskExecutionEvent` now carry an
  optional `firedBy?: FiredBy` (`TriggerType | 'manual'`) that reports which trigger caused
  the execution. `'manual'` when triggered explicitly via `runNow()` or
  `runDueTasks()`; a `TriggerType` string when the scheduler fired it.
  `TaskExecutionRecord` (produced by `foldHistory`) also exposes `firedBy`.
  **Best-effort on native for multi-trigger tasks** — a worker only knows the winner
  from the last `computeNextRunAt` result; prefer single-trigger tasks for precise
  attribution.

- **`NotificationTrigger.recurring?: boolean`** — when `true` and `inSeconds` is set,
  the notification trigger re-arms itself after each delivery: after firing, the engine
  re-computes `now + inSeconds * 1000` and schedules a new notification at that time.
  Clock drift does not accumulate because the interval is re-derived from `now` at each
  re-arm. Only meaningful with `inSeconds` (a fixed `at` timestamp cannot recur).

- **`AlarmTrigger.windowMs?: number`** (Android only) — use
  `AlarmManager.setWindow(RTC_WAKEUP, at, windowMs, …)` instead of `setExact`. The OS
  may fire anywhere in the `[at, at + windowMs]` window, enabling battery-efficient
  batching when exact timing is not required. Ignored when exact alarms are not available
  (falls back to inexact). Ignored on iOS and Web.

- **`ContinuedProcessingTrigger` (`type: 'userInitiatedBackground'`)** (iOS 26+ only) —
  submit a `BGContinuedProcessingTask` that continues after the user backgrounds the app.
  The task must originate from a direct user action (button press, etc.); the OS denies
  requests without user context. Not subject to the ~30-minute BGProcessingTask cap.
  Silently ignored on iOS < 26 and on Android/Web.

- **Silent APNs → BGProcessingTask chain** (iOS only) — a silent APNs push
  (`content-available: 1`, no alert) matching a `push` trigger with `matchKey` now also
  submits a `BGProcessingTaskRequest` immediately, so the task gets a full BGProcessingTask
  slot (~30 min CPU + network) in addition to the short background-receipt window. Requires
  `bgProcessing: true` on the matching `BackgroundTaskTrigger` alongside the `push`
  trigger. No new API surface — the behavior is gated on the existing
  `BackgroundTaskTrigger.bgProcessing` field.

- **FCM Doze-bypass foreground service** (Android only) — when a task has
  `policy.foreground: true` and is matched by an FCM high-priority push, `ConductorFcmService`
  now starts a foreground service (`ConductorForegroundService`) instead of enqueuing a
  WorkManager job, bypassing Doze entirely. Requires `enableForegroundService: true` in the
  config plugin (injects `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC`
  permissions and the service declaration).

### Changed

- `Trigger` union now includes `ContinuedProcessingTrigger`; `TriggerType` includes
  `'userInitiatedBackground'`. Backward-compatible (existing code does not produce this
  variant unless the app explicitly declares it).
- Default BGTaskScheduler permitted identifiers in the config plugin now include
  `software.drakkar.expoconductor.continued` for the iOS 26+ continued-processing task.

### Tests

- `firedBy` propagation is covered by existing `onTaskExecute`/`onTaskComplete` event
  tests; the new field is verified end-to-end in the demo's History screen.
- `recurring` notification re-arm, `windowMs` alarm path, and APNs→BGProcessingTask chain
  are exercised in the demo app's trigger lab; fixture cases for the recurring-notification
  re-arm timing are deferred pending cross-platform verification.

### Known limitations

- `ContinuedProcessingTrigger` requires iOS 26+ (`BGContinuedProcessingTask` from
  WWDC 2025); on earlier OS versions the trigger is silently ignored.
- `AlarmTrigger.windowMs` is Android-only; iOS falls back to a notification regardless.
- `firedBy` attribution for multi-trigger native tasks is heuristic — the native worker
  reports the trigger type predicted during the previous `computeNextRunAt`, not the actual
  OS wake event.
- The silent APNs→BGProcessingTask chain requires both a `push` and a `background` trigger
  with `bgProcessing: true` on the same task definition.

## [0.3.0] - 2026-06-09

### Added

- **`HandlerType: 'rust'`** — first-class Rust handler type alongside `'js'` and
  `'native'`. A task declared `handler: { type: 'rust', name: 'my-handler' }` invokes
  a Rust function registered via `conductor_register` in the `conductor_ffi` glue crate
  over a hand-rolled C ABI (`conductor_dispatch` / `conductor_free_string` /
  `conductor_app_init`). Behaves identically to `'native'` on the TS/client side.
  Requires `enableRust: true` in the config plugin (default `false`). **Mobile linking
  requires NDK/Xcode; logic verified via `pnpm test:rust` (`cargo test`).**

- **`conductor_ffi` Rust crate** (`rust/`) — thread-safe name→handler registry
  (`Arc<dyn Fn>`), panic-safe dispatch via `catch_unwind`, C ABI, and a C header.
  6 host tests covering dispatch, missing handlers, panic handling, and UTF-8.

- **Execution history** — append-only ring buffer (200 events) persists every task
  lifecycle event to durable storage on all platforms:
  Web: `localStorage`; Android: `SharedPreferences`; iOS: `UserDefaults`.
  Written from the main-thread `emit()` helper so headless background runs are captured.
  Access via `Conductor.getHistory()` / `Conductor.clearHistory()` and the new
  `getHistoryAsync` / `clearHistoryAsync` AsyncFunctions on native modules.

- **`foldHistory(events: TaskExecutionEvent[]): TaskExecutionRecord[]`** — exported from
  `expo-conductor`. Folds raw events into paired execution records (execute→complete
  FIFO matching; heuristic for native-platform pairing documented).

- **Reconciliation algorithm** (`src/reconcile.ts`) — pure TS `reconcile(tasks, records,
  { now })`. Computes expected firings from deterministic triggers and greedy-matches to
  actual records → `{ matched, missed, unexpected, aborted }`. Exact for
  `time`/`recurrence`/`alarm`; advisory for `background`/`push`/`appState`. Exported
  from `expo-conductor` alongside `expectedOccurrences`, `DEFAULT_TOLERANCE_MS`,
  `DEFAULT_WINDOW_MS`, and types.

- **`enableRust` config-plugin option** — writes `expo.conductor.enableRust` to
  `gradle.properties` (Android) and enables the `CONDUCTOR_RUST` xcconfig flag (iOS).

- **Demo: cross-language task lab** — multi-screen demo with Lab (5×4
  archetype×language matrix with per-cell toggles + priority/weight/constraint settings),
  History (persistent execution records including headless runs), Reconciliation
  (missed/aborted/unexpected visualization), and Lifecycle screens.

### Changed

- `HandlerType` is now `'js' | 'native' | 'rust'`. Backward compatible.
- `ConductorWorker.kt` — treats `handlerType == "rust"` like `"native"` on the headless
  path.
- `ConductorBackend` interface gains `getHistoryAsync()` and `clearHistoryAsync()`.
- `ConductorClient` gains `getHistory()` and `clearHistory()` convenience methods.
- `build.gradle` — reads `expo.conductor.enableRust` gradle property.
- `ExpoConductor.podspec` — reads `ENV['CONDUCTOR_RUST']` for xcconfig.
- `plugin/src/index.ts` — `ConductorPluginOptions` gains `enableRust?: boolean`.

## [0.2.2] - 2026-06-09

### Fixed

- **Android:** `ConductorMessagingService.kt` now always compiles correctly regardless of the
  `enableFcm` setting. The previous `sourceSets.main.java.exclude` guard was silently ignored by the
  Kotlin Gradle Plugin (AGP+KGP gotcha — `java.exclude` only filters the Java compile task, not
  `kotlinc`), so with `enableFcm=false` the file was still fed to the Kotlin compiler without
  `firebase-messaging` on the classpath, causing a compile error in consuming apps. Fixed by adding
  `compileOnly "com.google.firebase:firebase-messaging:24.0.0"` so the service class always compiles
  clean; the `implementation` dependency (and manifest `<service>` registration) remains gated on
  `enableFcm`, so the JAR is only bundled at runtime when FCM is actually enabled. The now-dead
  `sourceSets` exclude block is removed. Consuming apps no longer need to patch `build.gradle`.

## [0.2.1] - 2026-06-08

### Fixed

- **iOS:** a **recurrence-only** task no longer posts a spurious, user-visible local notification
  (it appeared in the tray titled **"Task"**). On iOS the only way to wake at a wall-clock time is
  a local notification, and a local notification is *always* user-visible — so the module had been
  posting a banner for **every** scheduled task with a `nextRunAt`, including `recurrence`-only
  tasks that never asked for one (the banner fell back to the default title `"Task"`). The module
  now posts a banner **only** when a trigger warrants one — `notification` (explicitly user-facing,
  carries `title`/`body`) or `time`/`alarm` (a wall-clock fire where the notification IS the wake).
  A `recurrence` / `background` / `appState` / `push`-only task is woken **silently** via
  `BGTaskScheduler` and advanced by the foreground engine instead. This applies on both the live
  `schedule` path and the headless cold-start re-arm (a native recurrence-only task re-arms its next
  `BGTaskScheduler` wake rather than posting a banner). Mirrors Android, where a notification is only
  shown for a `notification` trigger. The new gate (`NotificationPolicy`) is unit-tested directly
  (`ios/Tests/NotificationPolicyTests.swift`); it is iOS presentation glue, not shared engine math,
  so it has no `/fixtures` case or Kotlin mirror.

## [0.2.0] - 2026-06-08

A second audit pass — a multi-agent **static** review of the 0.1.1 changes (see
`docs/review-0.1.1.md`) — surfaced 18 confirmed issues: cross-engine parity divergences, native
correctness bugs, and two criticals (an Android compile error and an iOS forged-push id-fire).
All are fixed here.

> Note: the engine fixes (cron step bound, ASCII-digit parity, `ConductorClient` cron validation)
> are **verified** — TS Jest + Swift `swift test` + the Kotlin JVM harness all pass against the
> shared fixtures, including new cases. The native **module / delegate / trigger** fixes compile
> only in a full app build (no Android SDK / CocoaPods in the audit environment), so they are
> written and reviewed but **not yet compiled**. See `TODO.md` section 1.

### Fixed

- **Cron validation is platform-agnostic.** `ConductorClient.schedule` / `defineTaskDefinition`
  validate the recurrence before handing it to the backend, so a malformed cron throws at
  registration on **every** platform. Previously only the Web backend's `normalize` rejected it;
  native silently accepted — or, for some expressions (e.g. a trailing comma), silently *fired* it.
- **Cron `*/n` step is bounded to `1..59` on all three engines** instead of diverging: an
  out-of-range step overflowed Kotlin's 32-bit Int (→ never fired) while Web/Swift fired at value 0.
- **Cron tokens are ASCII-digit-only on all three engines.** Kotlin's `toIntOrNull` accepted
  Unicode decimal digits (e.g. `٣`) — firing where Web threw and Swift never fired; it now gates
  tokens on an ASCII pattern to match JS `\d` and Swift `Int(_:)`.
- **iOS:** background+recurrence tasks no longer fire on every BGTask wake — `dispatch` gates on
  the computed `nextRunAt` (matching Web/Android), honoring the interval and keeping `runDueTasks()`
  fired-count accurate.
- **iOS + Android:** `runDueTasks()` returns 0 and fires nothing while **paused** (matching Web);
  previously a background tick fired due tasks and returned nonzero while paused. `runDueTasks()`
  also excludes pure-background tasks (no `nextRunAt`) from its fired-count to match Web/Android —
  those still run on a real OS background wake.
- **iOS + Android:** `dispatch` skips while **paused**, so an FCM push or in-tray alarm arriving
  during a pause no longer fires (it did on Android before; iOS also cancels the pending BGTask
  refresh on `pauseAsync`). Manual `runNow` still fires while paused.
- **iOS:** the foreground-notification dedup no longer permanently stalls sub-30s recurrences. It
  keys on the notification identifier **plus delivery time** (collapsing the willPresent+didReceive
  of one delivery) instead of a fixed 30s window that suppressed the genuine next occurrence and
  killed the re-arm chain.
- **iOS:** `runDueBackgroundTasks` fires due tasks in **priority order** (priority desc, nextRunAt,
  then id by UTF-16 code unit) like Web/Android, so a low-priority task can't starve a
  higher-priority one under budget contention.
- **iOS:** a manual `runNow` no longer advances the task's real schedule (it did, skipping the next
  natural occurrence); the advance is gated on the scheduled path, matching Web/Android.
- **iOS:** the headless cold-start path re-arms a recurring **JS-handler + notification** task
  (it previously returned early for any non-native handler, silently dropping the chain).
- **iOS + Android:** a fired **one-shot** task clears its `nextRunAt` (recomputed over still-future
  triggers) so `runDueTasks()` no longer re-dispatches it on every tick (Web fires it once).
- **Android:** the module now imports `triggers.NotificationDisplay` — it was used unqualified, an
  unresolved reference that broke compilation.
- **Android:** a throwing **native** handler no longer aborts the whole `runDueTasks()` batch — it
  is reported failed and the batch continues.
- **Security (iOS):** a forged remote (APNs) push that merely carries a `conductorTask` can no
  longer fire arbitrary tasks by id on display/tap. The notification delegate dispatches by id only
  for app-scheduled **local** notifications, identified by the **OS-set trigger class** — a
  `UNPushNotificationTrigger` is remote and is forwarded, never dispatched — which a sender cannot
  forge (the `conductorLocal` userInfo hint is NOT a security boundary, since APNs delivers arbitrary
  custom keys). Remote pushes that legitimately drive tasks still go through the `matchKey`-gated push
  path. This also closes the Android/iOS asymmetry (Android already had no remote id-fire path).
- **iOS + Android:** a task with BOTH a recurrence and a still-future one-shot trigger now reschedules
  to whichever fires first (`min`), matching the Web engine — previously the natives advanced to the
  recurrence only and dropped the sooner one-shot occurrence.
- **Android:** a non-string stored push `matchKey` is ignored (read as a `String`, mirroring iOS)
  rather than coerced by `optString`, for cross-engine parity.

### Changed

- **`policy.retry`** is now documented as intentionally per-platform: fully honored by the Web
  engine and by JS handlers while the app is alive; native handlers rely on OS retry (Android
  WorkManager exponential backoff — not the configured values; iOS BGTask: none). See the
  `RetryPolicy` doc comment.

## [0.1.1] - 2026-06-07

A doc-driven, three-engine audit (Android / iOS / Web verified against the Expo SDK 56,
Android and Apple docs) found a set of low-impact edge-case bugs — mostly cross-engine
**parity divergences** reachable only by malformed or non-ASCII input, plus a few native
correctness/security nits. None affected valid inputs on a single platform. All are fixed
here, with new shared fixtures + regression tests locking the behavior.

> Note: the native module/trigger fixes (iOS `#1/#7/#8`, Android `#4/#5/#6/#7`) compile and
> run only in a full app build; this release verified the **engines** (TS Jest + Swift
> `swift test`, with new non-ASCII/cron fixtures) but not a device build. See `TODO.md`.

### Fixed

- **Cron parsing is now identical across all three engines.** Fields split on ASCII
  whitespace only (not the broader Unicode `\s`, which handled NBSP / form-feed differently
  on JS vs Kotlin vs Swift), integer tokens are parsed strictly everywhere (JS no longer
  prefix-parses `"30abc"` → `30`), and a malformed expression yields *no next run* on every
  platform (previously TS/Kotlin threw while Swift silently never-fired). A malformed cron is
  now rejected **up front** at registration (`normalize` throws) rather than silently never
  firing.
- **Task-id tiebreaker** now compares by UTF-16 code unit on iOS to match JS/Kotlin (Swift's
  native `String` ordering is Unicode-canonical and sorted non-ASCII ids the opposite way,
  which could change *which* task was admitted under budget pressure).
- **Android priority comparator** uses `compareTo` instead of `b - a` subtraction, which could
  overflow `Int` for far-apart priorities and flip the order (or break TimSort's contract).
- **`runDueTasks()`** returns the number of tasks actually *fired*, not merely *due* (tasks
  skipped by policy / budget / single-flight are excluded) — consistently on all platforms.
- **iOS:** a foreground notification that is shown and then tapped no longer dispatches its
  task **twice** (`willPresent` + `didReceive` are de-duplicated per delivery).
- **iOS:** `paused` and `budget` are now lock-guarded (they are read on background BGTask /
  notification threads), and the admission check-then-reserve is atomic.
- **Android:** admission check-then-insert is serialized, so two concurrent triggers (an alarm
  receiver + a WorkManager worker) can no longer both pass admission and overshoot the budget.
- **Android:** an unreadable battery level now fails **open** (treated as 100%, matching iOS)
  instead of clamping to 0% and deferring `minBatteryLevel` tasks forever.
- **Android:** notification id and the tap `PendingIntent` are keyed on a collision-free
  per-id registry + a per-id `conductor://task/<id>` data Uri instead of `taskId.hashCode()`,
  so distinct ids whose hashes collide can't cross-overwrite notifications or mis-route a tap.
- **Security (Android + iOS):** the FCM / APNs push path now rejects an empty `conductorTask`
  or an empty trigger `matchKey`, so a forged `conductorTask=""` can't fire a push task that
  declared no match key.

### Changed

- **Config plugin:** `USE_EXACT_ALARM` (which Google Play restricts to alarm-clock / calendar
  / reminder-class apps) is **no longer shipped by default**. `enableExactAlarms` now requests
  only the user-revocable `SCHEDULE_EXACT_ALARM`; opt into `USE_EXACT_ALARM` with the new
  **`useExactAlarmClock`** plugin flag if your app qualifies under Play policy.

### Tests

- Shared `/fixtures` cases for cron edge cases (wrong field count, non-numeric tokens,
  NBSP / form-feed separators) and non-ASCII id tiebreakers (astral vs BMP), plus engine and
  `normalize`-boundary regression tests. Swift `swift test` confirms the non-ASCII id fix.

## [0.1.0] - 2026-06-07

Initial release.

### Added

- **Native-first engine, implemented three times** (Kotlin / Swift / TypeScript) and
  verified bit-for-bit identical against one shared fixture set in
  [`/fixtures`](../../fixtures) — recurrence, priority, weight admission, and policy.
  Time math is integer UTC epoch milliseconds; weights are IEEE-754 `double` compared with
  a strict `<=` (no epsilon, so all three platforms agree exactly).
- **Task model** with execution policies (time windows, charging / battery / network / idle
  constraints, expiry, retry + backoff), resource weight (cpu / network / battery / memory
  budgeting), priority, and recurrence (interval / daily / weekly / cron).
- **Triggers**: `time`, `recurrence`, `notification`, exact `alarm`, `background`
  (deferrable), `push` (FCM / APNs data message), and `appState`.
- **Handlers** — JS handlers (run while the app is alive) or app-provided **native**
  handlers (run headless, including after termination).
- **Cross-task admission control**: priority ordering then greedy weight budgeting against a
  `ResourceBudget`, accounting for the budget already consumed by running tasks and each
  task's `policy.maxConcurrent`.
- **Single-flight cross-instance leader election** on Web (`navigator.locks`, no heartbeat);
  a no-op on native (a single app instance is always the leader).
- **Web scheduler engine** — timer-driven, persists and re-arms tasks on construction, and
  chains `setTimeout` past the ~24.8-day (2^31 ms) cap.
- **Expo config plugin** — Android permissions (`POST_NOTIFICATIONS`,
  `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`, optional exact-alarm), optional FCM service with a
  gradle gate, and iOS `UIBackgroundModes` + `BGTaskSchedulerPermittedIdentifiers`.
- **Optional first-party integrations** (opt-in subpath exports, each behind an optional
  peer dependency the core never imports):
  - `expo-conductor/task-manager` — headless JS via `expo-task-manager` /
    `expo-background-task` (Phase 2, draft).
  - `expo-conductor/notifications` — permission prompts, Android channels, foreground
    presentation, and cold-start response routing via `expo-notifications` (Phase 3, draft).

### Known limitations

See the README's [Platform support & limitations](../../README.md#platform-support--limitations).
Notably: iOS has no exact-alarm API (it falls back to a local notification); a **JS** handler
cannot run after the app is terminated (use a **native** handler for headless work); and the
native `BGTaskScheduler` / `WorkManager` ↔ `expo-background-task` swap is deferred pending
on-device verification.

[Unreleased]: https://github.com/herklos/expo-conductor/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/herklos/expo-conductor/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/herklos/expo-conductor/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/herklos/expo-conductor/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/herklos/expo-conductor/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/herklos/expo-conductor/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/herklos/expo-conductor/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/herklos/expo-conductor/releases/tag/v0.1.0

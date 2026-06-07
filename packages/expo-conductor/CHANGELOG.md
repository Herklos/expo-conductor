# Changelog

All notable changes to `expo-conductor` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/herklos/expo-conductor/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/herklos/expo-conductor/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/herklos/expo-conductor/releases/tag/v0.1.0

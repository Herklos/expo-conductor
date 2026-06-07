# Changelog

All notable changes to `expo-conductor` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/herklos/expo-conductor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/herklos/expo-conductor/releases/tag/v0.1.0
